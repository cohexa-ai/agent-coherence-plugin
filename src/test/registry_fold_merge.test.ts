/**
 * One identity per file in the registry: the in-memory fold index, names
 * kept exact as keys, the bucket rule, and the start-time merge of file rows
 * an older build split for one file.
 *
 * Older-shape stores are built the way an older build left them: the
 * migrations alone (no side table), then rows written directly.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { v5 as uuidv5 } from 'uuid';
import { ArtifactRegistry } from '../registry.js';
import { runPendingMigrations, SCHEMA_USER_VERSION } from '../migrations.js';
import { MESIState } from '../states.js';
import { foldKey, type FoldProfile } from '../path_fold.js';
import type { FoldProfileResult } from '../fs_profile.js';
import { MAX_HOLD_SEC, RECLAIM_MAX_HOLD_TRIGGER } from '../acquire_or_fail.js';
import {
  FOLD_MERGE_PREEMPTER_ID,
  FOLD_MERGE_TRIGGER,
  prepareFoldIndex,
  sameFileGroups,
  type FoldGroup,
  type FoldRow,
} from '../fold_merge.js';
import { killAndWait } from './pid_lock_fixture.js';
import { serving, startCoordinator } from './coordinator_process_fixture.js';

const AGENT_A = 'a'.repeat(32);
const AGENT_B = 'b'.repeat(32);
const AGENT_C = 'c'.repeat(32);
const NFC = 'data/caf\u00e9.txt';
const NFD = 'data/cafe\u0301.txt';
const NOW = 1_000_000;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface Store {
  root: string;
  dbPath: string;
}

/** A workspace whose store has the schema an older build created: migrations only, no side table. */
function makeStore(t: TestContext): Store {
  const base = tmpdir();
  assert.ok(isAbsolute(base) && base !== '/', `refusing to use ${JSON.stringify(base)}`);
  const root = mkdtempSync(join(base, 'fold-merge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.coherence'), { mode: 0o700 });
  const dbPath = join(root, '.coherence', 'state.db');
  const db = new BetterSqlite3(dbPath);
  runPendingMigrations(db);
  db.close();
  return { root, dbPath };
}

function openRaw(t: TestContext, dbPath: string): Database {
  const db = new BetterSqlite3(dbPath);
  db.pragma('foreign_keys = ON');
  t.after(() => db.close());
  return db;
}

function openRegistry(t: TestContext, dbPath: string): ArtifactRegistry {
  const registry = new ArtifactRegistry(dbPath);
  t.after(() => registry.close());
  return registry;
}

function writeWorkspaceFile(root: string, name: string, text: string): void {
  const path = join(root, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

interface SeedRow {
  name: string;
  version?: number;
  hash?: string;
  updatedAt?: number;
  lastWriter?: string | null;
  sizeTokens?: number | null;
}

function seedArtifact(db: Database, row: SeedRow): string {
  const id = randomUUID().replace(/-/g, '');
  db.prepare(
    `INSERT INTO artifacts (id, name, version, content_hash, size_tokens, last_writer_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    row.name,
    row.version ?? 1,
    row.hash ?? '',
    row.sizeTokens ?? null,
    row.lastWriter ?? null,
    row.updatedAt ?? 1
  );
  return id;
}

interface SeedState {
  artifactId: string;
  agentId: string;
  state: MESIState;
  grantedAt?: number | null;
  observed?: number | null;
}

function seedState(db: Database, seed: SeedState): void {
  db.prepare(
    `INSERT INTO agent_states (artifact_id, agent_id, state, granted_at_tick, last_observed_version)
     VALUES (?, ?, ?, ?, ?)`
  ).run(seed.artifactId, seed.agentId, seed.state, seed.grantedAt ?? null, seed.observed ?? null);
}

function seedNotice(
  db: Database,
  notice: { agentId: string; artifactId: string; preempter: string; at: number }
): void {
  db.prepare(
    `INSERT INTO pending_notices (agent_id, artifact_id, preempter_agent_id, preempted_at_unix_ts)
     VALUES (?, ?, ?, ?)`
  ).run(notice.agentId, notice.artifactId, notice.preempter, notice.at);
}

/** Every row a merge can touch, in a stable order. */
function tables(db: Database): unknown {
  return {
    artifacts: db.prepare(`SELECT rowid AS rowid, * FROM artifacts ORDER BY rowid`).all(),
    states: db.prepare(`SELECT * FROM agent_states ORDER BY artifact_id, agent_id`).all(),
    notices: db.prepare(`SELECT * FROM pending_notices ORDER BY agent_id, artifact_id`).all(),
  };
}

function names(db: Database): string[] {
  return (db.prepare(`SELECT name FROM artifacts ORDER BY rowid`).all() as { name: string }[]).map(
    (row) => row.name
  );
}

interface StateView {
  state: string;
  granted_at_tick: number | null;
  last_observed_version: number | null;
  last_reclaim_trigger: string | null;
  last_reclaim_tick: number | null;
}

function statesOf(db: Database, agentId: string): Array<StateView & { artifact_id: string }> {
  return db
    .prepare(
      `SELECT artifact_id, state, granted_at_tick, last_observed_version,
              last_reclaim_trigger, last_reclaim_tick
       FROM agent_states WHERE agent_id = ? ORDER BY artifact_id`
    )
    .all(agentId) as Array<StateView & { artifact_id: string }>;
}

function noticesOf(
  db: Database,
  agentId: string
): Array<{ artifact_id: string; preempter_agent_id: string; preempted_at_unix_ts: number }> {
  return db
    .prepare(
      `SELECT artifact_id, preempter_agent_id, preempted_at_unix_ts
       FROM pending_notices WHERE agent_id = ? ORDER BY artifact_id`
    )
    .all(agentId) as Array<{
    artifact_id: string;
    preempter_agent_id: string;
    preempted_at_unix_ts: number;
  }>;
}

function assertAtMostOneWriter(registry: ArtifactRegistry, artifactId: string): void {
  const writers = [...registry.getStateMap(artifactId).values()].filter(
    (state) => state === MESIState.MODIFIED || state === MESIState.EXCLUSIVE
  );
  assert.ok(writers.length <= 1, `writers: ${writers.join(', ')}`);
}

function classified(profile: FoldProfile): FoldProfileResult {
  return { profile, status: 'classified' };
}

function groupOf(
  profile: FoldProfile,
  rows: { ids: string[]; name: string },
  facts: { diskSpelling: string | null; diskHash: string | null }
): FoldGroup {
  return { profile, key: foldKey(rows.name, profile), ids: rows.ids, ...facts };
}

/** The ids the registry's index lists under `key`, read from its private state. */
function indexedIds(registry: ArtifactRegistry, key: string): readonly string[] {
  const index = (
    registry as unknown as { foldIndex: { byKey: Map<string, readonly string[]> } | null }
  ).foldIndex;
  assert.ok(index !== null, 'the fold index was not built');
  return index.byKey.get(key) ?? [];
}

// ---------------------------------------------------------------------------
// Identity: the fold index
// ---------------------------------------------------------------------------

test('two spellings of one name give one artifact under caseless, and two under none', (t) => {
  const caseless = openRegistry(t, makeStore(t).dbPath);
  caseless.buildFoldIndex('caseless');
  const first = caseless.resolveOrRegisterArtifact('data/x.txt', '');
  assert.equal(caseless.resolveOrRegisterArtifact('DATA/X.TXT', ''), first);
  assert.equal(caseless.getArtifactByName('Data/X.txt')?.id, first);
  assert.equal(caseless.listArtifacts().length, 1);

  const none = openRegistry(t, makeStore(t).dbPath);
  none.buildFoldIndex('none');
  const lower = none.resolveOrRegisterArtifact('data/x.txt', '');
  assert.notEqual(none.resolveOrRegisterArtifact('DATA/X.TXT', ''), lower);
  assert.equal(none.listArtifacts().length, 2);
});

test('a new row takes the disk spelling the caller found, and every spelling finds it', (t) => {
  const registry = openRegistry(t, makeStore(t).dbPath);
  registry.buildFoldIndex('caseless');
  const id = registry.resolveOrRegisterFile(
    { key: foldKey('DATA/x.txt', 'caseless'), tidied: 'DATA/x.txt', diskSpelling: 'data/x.txt' },
    ''
  );
  assert.equal(registry.getArtifactById(id)?.name, 'data/x.txt');
  assert.equal(registry.getArtifactByName('Data/X.TXT')?.id, id);
  assert.equal(
    registry.findFileArtifact({ key: foldKey('DATA/X.txt', 'caseless'), tidied: 'DATA/X.txt' })?.id,
    id
  );
});

test('a name with no disk spelling is stored as tidied', (t) => {
  const registry = openRegistry(t, makeStore(t).dbPath);
  registry.buildFoldIndex('caseless');
  const id = registry.resolveOrRegisterArtifact('./new//./f.txt', '');
  assert.equal(registry.getArtifactById(id)?.name, 'new/f.txt');
});

test('a bucket resolves every spelling to its lowest-rowid row and never mints another', (t) => {
  const store = makeStore(t);
  const raw = openRaw(t, store.dbPath);
  const first = seedArtifact(raw, { name: 'data/x.txt' });
  const second = seedArtifact(raw, { name: 'DATA/X.TXT' });
  const registry = openRegistry(t, store.dbPath);
  assert.deepEqual(registry.buildFoldIndex('caseless'), [
    { key: 'data/x.txt', ids: [first, second] },
  ]);
  assert.equal(registry.getArtifactByName('DATA/X.TXT')?.id, first);
  assert.equal(registry.resolveOrRegisterArtifact('Data/x.Txt', ''), first);
  assert.deepEqual(names(raw), ['data/x.txt', 'DATA/X.TXT']);
});

test('an insert that rolls back leaves no index entry', (t) => {
  const store = makeStore(t);
  const registry = openRegistry(t, store.dbPath);
  registry.buildFoldIndex('caseless');
  const raw = openRaw(t, store.dbPath);
  raw.exec(
    `CREATE TRIGGER refuse_insert BEFORE INSERT ON artifacts
     BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`
  );
  assert.throws(() => registry.resolveOrRegisterArtifact('data/x.txt', ''), /injected/);
  assert.deepEqual(indexedIds(registry, 'data/x.txt'), []);

  raw.exec(`DROP TRIGGER refuse_insert`);
  const id = registry.resolveOrRegisterArtifact('DATA/X.TXT', '');
  assert.deepEqual(indexedIds(registry, 'data/x.txt'), [id]);
  assert.deepEqual(names(raw), ['DATA/X.TXT']);
});

test('an index hit is re-checked by id: a row deleted under the index gives way to one fresh row', (t) => {
  const store = makeStore(t);
  const raw = openRaw(t, store.dbPath);
  const deleted = seedArtifact(raw, { name: 'data/x.txt' });
  const registry = openRegistry(t, store.dbPath);
  registry.buildFoldIndex('caseless');
  raw.prepare(`DELETE FROM artifacts WHERE id = ?`).run(deleted);

  assert.equal(registry.getArtifactByName('data/x.txt'), null);
  const fresh = registry.resolveOrRegisterArtifact('DATA/X.TXT', '');
  assert.notEqual(fresh, deleted);
  assert.equal(registry.getArtifactById(fresh)?.name, 'DATA/X.TXT');
  assert.equal(registry.resolveOrRegisterArtifact('data/x.txt', ''), fresh);
  assert.deepEqual(names(raw), ['DATA/X.TXT']);
  assert.deepEqual(indexedIds(registry, 'data/x.txt'), [fresh]);
});

// ---------------------------------------------------------------------------
// Names kept exact as keys
// ---------------------------------------------------------------------------

test('a key keeps its exact name, is listed as a key, and stays out of the index', (t) => {
  const store = makeStore(t);
  const registry = openRegistry(t, store.dbPath);
  registry.buildFoldIndex('caseless');
  const upper = registry.resolveOrRegisterKey('WS-42', '');
  const lower = registry.resolveOrRegisterKey('ws-42', '');
  assert.notEqual(upper, lower);
  assert.equal(registry.resolveOrRegisterKey('WS-42', ''), upper);
  assert.equal(registry.findKeyArtifact('ws-42')?.id, lower);
  // Out of the index: a file spelling that is not the key's exact name misses it.
  assert.equal(registry.findFileArtifact({ key: 'ws-42', tidied: 'Ws-42' }), null);

  const raw = openRaw(t, store.dbPath);
  const listed = raw
    .prepare(`SELECT artifact_id, kind FROM artifact_name_kinds ORDER BY artifact_id`)
    .all();
  assert.deepEqual(
    listed,
    [upper, lower].sort().map((id) => ({ artifact_id: id, kind: 'key' }))
  );
  // A later start keys the file rows only.
  const reopened = openRegistry(t, store.dbPath);
  assert.deepEqual(reopened.buildFoldIndex('caseless'), []);
  assert.deepEqual(indexedIds(reopened, 'ws-42'), []);
});

test('a key request meeting a file row of the same exact name shares it', (t) => {
  const store = makeStore(t);
  const registry = openRegistry(t, store.dbPath);
  registry.buildFoldIndex('caseless');
  const file = registry.resolveOrRegisterArtifact('data/x.txt', '');
  assert.equal(registry.resolveOrRegisterKey('data/x.txt', ''), file);
  assert.equal(registry.findKeyArtifact('data/x.txt')?.id, file);
  const raw = openRaw(t, store.dbPath);
  assert.deepEqual(raw.prepare(`SELECT * FROM artifact_name_kinds`).all(), []);
});

test("a file request of a key row's exact name finds the row its register returns, holder and all", (t) => {
  const registry = openRegistry(t, makeStore(t).dbPath);
  registry.buildFoldIndex('caseless');
  const key = registry.resolveOrRegisterKey('docs/plan.md', '');
  const file = { key: foldKey('docs/plan.md', 'caseless'), tidied: 'docs/plan.md' };

  assert.equal(registry.findFileArtifact(file)?.id, key);
  const registered = registry.resolveOrRegisterFile(file, '');
  assert.equal(registered, key);
  registry.acquireExclusive(registered, AGENT_A, NOW);
  const found = registry.findFileArtifact(file);
  assert.ok(found !== null, 'the file lookup missed the row its register returned');
  assert.deepEqual(registry.acquireExclusiveIfUnheld(found.id, AGENT_B, NOW), {
    kind: 'other_holder',
    holderAgentId: AGENT_A,
  });
  assert.equal(registry.listArtifacts().length, 1);
});

test("a file request whose disk spelling is a key row's exact name finds the row its register returns", (t) => {
  const registry = openRegistry(t, makeStore(t).dbPath);
  registry.buildFoldIndex('caseless');
  const key = registry.resolveOrRegisterKey('Docs/plan.md', '');
  const file = {
    key: foldKey('docs/plan.md', 'caseless'),
    tidied: 'docs/plan.md',
    diskSpelling: 'Docs/plan.md',
  };

  assert.equal(registry.findFileArtifact(file)?.id, key);
  assert.equal(registry.resolveOrRegisterFile(file, ''), key);
  assert.equal(registry.findFileArtifact(file)?.id, key);
  assert.equal(registry.listArtifacts().length, 1);
});

test('the side table is created at open with no user_version change, and the foreign-ledger guard accepts it', (t) => {
  const store = makeStore(t);
  const hasSideTable = (db: Database): boolean =>
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artifact_name_kinds'`)
      .get() !== undefined;
  const before = new BetterSqlite3(store.dbPath);
  assert.equal(hasSideTable(before), false);
  before.close();

  new ArtifactRegistry(store.dbPath).close();
  const raw = openRaw(t, store.dbPath);
  assert.equal(hasSideTable(raw), true);
  assert.equal(raw.pragma('user_version', { simple: true }), SCHEMA_USER_VERSION);
  assert.deepEqual(runPendingMigrations(raw).applied, []);
});

// ---------------------------------------------------------------------------
// The bucket rule: rows the merge left apart act as one file
// ---------------------------------------------------------------------------

function bucketWithHolder(
  t: TestContext,
  grantedAt: number
): { registry: ArtifactRegistry; raw: Database; first: string; second: string } {
  const store = makeStore(t);
  const raw = openRaw(t, store.dbPath);
  const first = seedArtifact(raw, { name: 'data/x.txt' });
  const second = seedArtifact(raw, { name: 'DATA/X.TXT' });
  seedState(raw, {
    artifactId: second,
    agentId: AGENT_C,
    state: MESIState.EXCLUSIVE,
    grantedAt,
    observed: 1,
  });
  const registry = openRegistry(t, store.dbPath);
  registry.buildFoldIndex('caseless');
  return { registry, raw, first, second };
}

test("an opted-in alias acquire is refused while another agent holds the bucket's other row", (t) => {
  const { registry, raw, first } = bucketWithHolder(t, NOW - 10);
  const alias = registry.getArtifactByName('Data/X.txt');
  assert.equal(alias?.id, first);
  const before = tables(raw);
  assert.deepEqual(registry.acquireExclusiveIfUnheld(first, AGENT_A, NOW), {
    kind: 'other_holder',
    holderAgentId: AGENT_C,
  });
  assert.deepEqual(tables(raw), before);
});

test("an opted-in acquire reclaims a holder of the bucket's other row past the hold ceiling", (t) => {
  const { registry, raw, first, second } = bucketWithHolder(t, NOW - MAX_HOLD_SEC);
  assert.deepEqual(registry.acquireExclusiveIfUnheld(first, AGENT_A, NOW), {
    kind: 'granted',
    reclaimed: { agentId: AGENT_C, heldForSec: MAX_HOLD_SEC },
  });
  assert.deepEqual(statesOf(raw, AGENT_C), [
    {
      artifact_id: second,
      state: MESIState.INVALID,
      granted_at_tick: null,
      last_observed_version: 1,
      last_reclaim_trigger: RECLAIM_MAX_HOLD_TRIGGER,
      last_reclaim_tick: NOW,
    },
  ]);
  assert.equal(registry.getAgentState(first, AGENT_A), MESIState.EXCLUSIVE);
});

test('an ordinary acquire in a bucket demotes write holders on its other rows as the merge does', (t) => {
  const { registry, raw, first, second } = bucketWithHolder(t, NOW - 10);
  const invalidated = registry.acquireExclusive(first, AGENT_A, NOW);
  assert.deepEqual(invalidated, [AGENT_C]);
  assert.equal(registry.getAgentState(first, AGENT_A), MESIState.EXCLUSIVE);
  assert.deepEqual(statesOf(raw, AGENT_C), [
    {
      artifact_id: second,
      state: MESIState.INVALID,
      granted_at_tick: null,
      last_observed_version: 1,
      last_reclaim_trigger: FOLD_MERGE_TRIGGER,
      last_reclaim_tick: NOW,
    },
  ]);
  assert.deepEqual(noticesOf(raw, AGENT_C), [
    { artifact_id: second, preempter_agent_id: FOLD_MERGE_PREEMPTER_ID, preempted_at_unix_ts: NOW },
  ]);
  assert.throws(() => registry.commit(second, AGENT_C, sha256('C'), NOW + 1), /commit_not_allowed/);
});

// ---------------------------------------------------------------------------
// The merge: survivor, values, keeper, demotion
// ---------------------------------------------------------------------------

test('the merge keeps the grant of the holder whose commit the disk holds', (t) => {
  const store = makeStore(t);
  const raw = openRaw(t, store.dbPath);
  const bytesOfB = sha256('written by B at t=250\n');
  // B acquired the NFD spelling at t=100 and committed it at t=250; A
  // acquired the NFC spelling at t=200, so A never read what the disk holds.
  const nfd = seedArtifact(raw, {
    name: NFD,
    version: 2,
    hash: bytesOfB,
    updatedAt: 250,
    lastWriter: AGENT_B,
  });
  const nfc = seedArtifact(raw, { name: NFC, version: 1, hash: '', updatedAt: 200 });
  seedState(raw, {
    artifactId: nfd,
    agentId: AGENT_B,
    state: MESIState.MODIFIED,
    grantedAt: 100,
    observed: 2,
  });
  seedState(raw, {
    artifactId: nfc,
    agentId: AGENT_A,
    state: MESIState.EXCLUSIVE,
    grantedAt: 200,
    observed: 1,
  });
  const registry = openRegistry(t, store.dbPath);

  const outcome = registry.mergeFoldGroup(
    groupOf('caseless', { ids: [nfd, nfc], name: NFC }, { diskSpelling: NFC, diskHash: bytesOfB }),
    300
  );
  assert.deepEqual(outcome, {
    kind: 'merged',
    survivorId: nfc,
    removedIds: [nfd],
    keeperAgentId: AGENT_B,
    demotedWriters: [AGENT_A],
  });
  assert.equal(registry.getArtifactById(nfd), null);
  assert.deepEqual(
    { ...registry.getArtifactById(nfc) },
    {
      id: nfc,
      name: NFC,
      version: 3,
      content_hash: bytesOfB,
      size_tokens: null,
      last_writer_id: AGENT_B,
      updated_at: 250,
    }
  );
  assert.deepEqual(statesOf(raw, AGENT_B), [
    {
      artifact_id: nfc,
      state: MESIState.MODIFIED,
      granted_at_tick: 100,
      last_observed_version: 3,
      last_reclaim_trigger: null,
      last_reclaim_tick: null,
    },
  ]);
  assert.deepEqual(statesOf(raw, AGENT_A), [
    {
      artifact_id: nfc,
      state: MESIState.INVALID,
      granted_at_tick: null,
      last_observed_version: 1,
      last_reclaim_trigger: FOLD_MERGE_TRIGGER,
      last_reclaim_tick: 300,
    },
  ]);
  assert.deepEqual(noticesOf(raw, AGENT_A), [
    { artifact_id: nfc, preempter_agent_id: FOLD_MERGE_PREEMPTER_ID, preempted_at_unix_ts: 300 },
  ]);
  assert.deepEqual(noticesOf(raw, AGENT_B), []);
  assertAtMostOneWriter(registry, nfc);

  assert.throws(() => registry.commit(nfc, AGENT_A, sha256('A'), 301), /^.*commit_not_allowed/);
  const next = registry.commit(nfc, AGENT_B, sha256('B again'), 302);
  assert.equal(next.artifact.version, 4);
  assertAtMostOneWriter(registry, nfc);
});

function splitPairWithWriters(
  t: TestContext,
  hashes: { first: string; second: string }
): { registry: ArtifactRegistry; raw: Database; first: string; second: string } {
  const store = makeStore(t);
  const raw = openRaw(t, store.dbPath);
  const first = seedArtifact(raw, {
    name: 'data/x.txt',
    version: 1,
    hash: hashes.first,
    updatedAt: 100,
    lastWriter: AGENT_A,
  });
  const second = seedArtifact(raw, {
    name: 'DATA/X.TXT',
    version: 3,
    hash: hashes.second,
    updatedAt: 150,
    lastWriter: AGENT_B,
    sizeTokens: 7,
  });
  seedState(raw, {
    artifactId: first,
    agentId: AGENT_A,
    state: MESIState.EXCLUSIVE,
    grantedAt: 90,
    observed: 1,
  });
  seedState(raw, {
    artifactId: second,
    agentId: AGENT_B,
    state: MESIState.MODIFIED,
    grantedAt: 120,
    observed: 3,
  });
  return { registry: openRegistry(t, store.dbPath), raw, first, second };
}

function demotedAt(
  artifactId: string,
  observed: number,
  tick: number
): StateView & { artifact_id: string } {
  return {
    artifact_id: artifactId,
    state: MESIState.INVALID,
    granted_at_tick: null,
    last_observed_version: observed,
    last_reclaim_trigger: FOLD_MERGE_TRIGGER,
    last_reclaim_tick: tick,
  };
}

test("when no row's hash matches the disk, nobody keeps a write grant", (t) => {
  const { registry, raw, first, second } = splitPairWithWriters(t, {
    first: sha256('one'),
    second: sha256('two'),
  });
  const outcome = registry.mergeFoldGroup(
    groupOf(
      'caseless',
      { ids: [first, second], name: 'data/x.txt' },
      { diskSpelling: null, diskHash: sha256('neither') }
    ),
    NOW
  );
  assert.equal(outcome.kind, 'merged');
  assert.equal(outcome.kind === 'merged' && outcome.keeperAgentId, null);
  // No disk spelling: the lowest rowid survives, carrying the latest write's values.
  assert.deepEqual(
    { ...registry.getArtifactById(first) },
    {
      id: first,
      name: 'data/x.txt',
      version: 4,
      content_hash: sha256('two'),
      size_tokens: 7,
      last_writer_id: AGENT_B,
      updated_at: 150,
    }
  );
  assert.equal(registry.getArtifactById(second), null);
  assert.deepEqual(statesOf(raw, AGENT_A), [demotedAt(first, 1, NOW)]);
  assert.deepEqual(statesOf(raw, AGENT_B), [demotedAt(first, 3, NOW)]);
  for (const agent of [AGENT_A, AGENT_B]) {
    assert.deepEqual(noticesOf(raw, agent), [
      {
        artifact_id: first,
        preempter_agent_id: FOLD_MERGE_PREEMPTER_ID,
        preempted_at_unix_ts: NOW,
      },
    ]);
  }
  assertAtMostOneWriter(registry, first);
});

test('when several rows match the disk hash, nobody keeps a write grant', (t) => {
  const same = sha256('same bytes');
  const { registry, raw, first, second } = splitPairWithWriters(t, { first: same, second: same });
  const outcome = registry.mergeFoldGroup(
    groupOf(
      'caseless',
      { ids: [first, second], name: 'data/x.txt' },
      { diskSpelling: 'DATA/X.TXT', diskHash: same }
    ),
    NOW
  );
  assert.equal(outcome.kind === 'merged' && outcome.survivorId, second);
  assert.equal(outcome.kind === 'merged' && outcome.keeperAgentId, null);
  assert.deepEqual(statesOf(raw, AGENT_A), [demotedAt(second, 1, NOW)]);
  assert.deepEqual(statesOf(raw, AGENT_B), [demotedAt(second, 3, NOW)]);
  assertAtMostOneWriter(registry, second);
});

test('when several rows match the disk hash and only one has a write holder, nobody keeps it', (t) => {
  const store = makeStore(t);
  const raw = openRaw(t, store.dbPath);
  const same = sha256('same bytes');
  // The grant goes only to the single holder of the single row whose hash is
  // the disk's; with two such rows, a lone holder on one of them does not fit.
  const first = seedArtifact(raw, { name: 'data/x.txt', hash: same, updatedAt: 50 });
  const second = seedArtifact(raw, { name: 'DATA/X.TXT', hash: same, updatedAt: 100 });
  seedState(raw, {
    artifactId: first,
    agentId: AGENT_A,
    state: MESIState.EXCLUSIVE,
    grantedAt: 40,
    observed: 1,
  });
  seedState(raw, { artifactId: second, agentId: AGENT_B, state: MESIState.SHARED, observed: 1 });
  const registry = openRegistry(t, store.dbPath);
  const outcome = registry.mergeFoldGroup(
    groupOf(
      'caseless',
      { ids: [first, second], name: 'data/x.txt' },
      { diskSpelling: null, diskHash: same }
    ),
    NOW
  );
  assert.equal(outcome.kind === 'merged' && outcome.keeperAgentId, null);
  assert.deepEqual(outcome.kind === 'merged' && outcome.demotedWriters, [AGENT_A]);
  assert.deepEqual(statesOf(raw, AGENT_A), [demotedAt(first, 1, NOW)]);
  assert.deepEqual(noticesOf(raw, AGENT_A), [
    { artifact_id: first, preempter_agent_id: FOLD_MERGE_PREEMPTER_ID, preempted_at_unix_ts: NOW },
  ]);
  assert.throws(() => registry.commit(first, AGENT_A, sha256('A'), NOW + 1), /commit_not_allowed/);
  assertAtMostOneWriter(registry, first);
});

test('when the row matching the disk has no write holder, nobody keeps a write grant', (t) => {
  const store = makeStore(t);
  const raw = openRaw(t, store.dbPath);
  const disk = sha256('on disk');
  // The row the disk matches is not the latest write: its values still win.
  const first = seedArtifact(raw, { name: 'data/x.txt', hash: disk, updatedAt: 50 });
  const second = seedArtifact(raw, { name: 'DATA/X.TXT', hash: sha256('other'), updatedAt: 100 });
  seedState(raw, { artifactId: first, agentId: AGENT_A, state: MESIState.SHARED, observed: 1 });
  seedState(raw, {
    artifactId: second,
    agentId: AGENT_B,
    state: MESIState.EXCLUSIVE,
    grantedAt: 40,
    observed: 1,
  });
  const registry = openRegistry(t, store.dbPath);
  const outcome = registry.mergeFoldGroup(
    groupOf(
      'caseless',
      { ids: [first, second], name: 'data/x.txt' },
      { diskSpelling: null, diskHash: disk }
    ),
    NOW
  );
  assert.equal(outcome.kind === 'merged' && outcome.keeperAgentId, null);
  assert.deepEqual(statesOf(raw, AGENT_B), [demotedAt(first, 1, NOW)]);
  assert.deepEqual(statesOf(raw, AGENT_A), [
    {
      artifact_id: first,
      state: MESIState.INVALID,
      granted_at_tick: null,
      last_observed_version: 1,
      last_reclaim_trigger: null,
      last_reclaim_tick: null,
    },
  ]);
  assert.deepEqual(noticesOf(raw, AGENT_A), []);
  assert.equal(registry.getArtifactById(first)?.content_hash, disk);
});

test('one agent with rows on both spellings ends with one state row and one notice', (t) => {
  const store = makeStore(t);
  const raw = openRaw(t, store.dbPath);
  const disk = sha256('on disk');
  const first = seedArtifact(raw, { name: 'data/x.txt', version: 4, hash: disk, updatedAt: 100 });
  const second = seedArtifact(raw, { name: 'DATA/X.TXT', version: 2, updatedAt: 90 });
  // C read both spellings and was preempted on each; B holds the matching row and reads the other.
  seedState(raw, { artifactId: first, agentId: AGENT_C, state: MESIState.SHARED, observed: 4 });
  seedState(raw, { artifactId: second, agentId: AGENT_C, state: MESIState.INVALID, observed: 1 });
  seedNotice(raw, { agentId: AGENT_C, artifactId: first, preempter: AGENT_A, at: 50 });
  seedNotice(raw, { agentId: AGENT_C, artifactId: second, preempter: AGENT_B, at: 80 });
  seedState(raw, {
    artifactId: first,
    agentId: AGENT_B,
    state: MESIState.EXCLUSIVE,
    grantedAt: 60,
    observed: 4,
  });
  seedState(raw, { artifactId: second, agentId: AGENT_B, state: MESIState.SHARED, observed: 2 });
  const registry = openRegistry(t, store.dbPath);

  const outcome = registry.mergeFoldGroup(
    groupOf(
      'caseless',
      { ids: [first, second], name: 'data/x.txt' },
      { diskSpelling: 'data/x.txt', diskHash: disk }
    ),
    NOW
  );
  assert.equal(outcome.kind === 'merged' && outcome.keeperAgentId, AGENT_B);
  assert.deepEqual(statesOf(raw, AGENT_C), [
    {
      artifact_id: first,
      state: MESIState.INVALID,
      granted_at_tick: null,
      last_observed_version: 1,
      last_reclaim_trigger: null,
      last_reclaim_tick: null,
    },
  ]);
  assert.deepEqual(noticesOf(raw, AGENT_C), [
    { artifact_id: first, preempter_agent_id: AGENT_B, preempted_at_unix_ts: 80 },
  ]);
  assert.deepEqual(statesOf(raw, AGENT_B), [
    {
      artifact_id: first,
      state: MESIState.EXCLUSIVE,
      granted_at_tick: 60,
      last_observed_version: 5,
      last_reclaim_trigger: null,
      last_reclaim_tick: null,
    },
  ]);
  assertAtMostOneWriter(registry, first);
});

test('the merge preempter id is the uuid5 of its name', () => {
  const derived = uuidv5('ccs-coordinator-fold-merge:merged-spellings', uuidv5.URL).replace(
    /-/g,
    ''
  );
  assert.equal(FOLD_MERGE_PREEMPTER_ID, derived);
});

test('a merge whose rows changed since detection is skipped and changes nothing', (t) => {
  const store = makeStore(t);
  const raw = openRaw(t, store.dbPath);
  const first = seedArtifact(raw, { name: 'data/x.txt' });
  const second = seedArtifact(raw, { name: 'DATA/X.TXT' });
  const third = seedArtifact(raw, { name: 'Data/X.Txt' });
  const registry = openRegistry(t, store.dbPath);
  const group = groupOf(
    'caseless',
    { ids: [first, second], name: 'data/x.txt' },
    { diskSpelling: null, diskHash: null }
  );
  raw.prepare(`INSERT INTO artifact_name_kinds (artifact_id, kind) VALUES (?, 'key')`).run(second);
  const before = tables(raw);
  assert.equal(registry.mergeFoldGroup(group, NOW).kind, 'skipped');
  assert.deepEqual(tables(raw), before);

  raw.prepare(`DELETE FROM artifacts WHERE id = ?`).run(third);
  const gone = groupOf(
    'caseless',
    { ids: [first, third], name: 'data/x.txt' },
    { diskSpelling: null, diskHash: null }
  );
  const remaining = tables(raw);
  assert.equal(registry.mergeFoldGroup(gone, NOW).kind, 'skipped');
  assert.deepEqual(tables(raw), remaining);
});

test('the merge rolls back when the survivor would end with two write holders', (t) => {
  const store = makeStore(t);
  const raw = openRaw(t, store.dbPath);
  const disk = sha256('on disk');
  const first = seedArtifact(raw, { name: 'data/x.txt', hash: disk });
  const second = seedArtifact(raw, { name: 'DATA/X.TXT' });
  seedState(raw, {
    artifactId: first,
    agentId: AGENT_B,
    state: MESIState.EXCLUSIVE,
    grantedAt: 10,
    observed: 1,
  });
  const registry = openRegistry(t, store.dbPath);
  // Each time the keeper's row is written, a second writer appears beside it.
  raw.exec(
    `CREATE TRIGGER second_writer AFTER INSERT ON agent_states WHEN NEW.agent_id = '${AGENT_B}'
     BEGIN INSERT INTO agent_states (artifact_id, agent_id, state) VALUES (NEW.artifact_id, '${AGENT_C}', 'EXCLUSIVE'); END`
  );
  const before = tables(raw);
  assert.throws(
    () =>
      registry.mergeFoldGroup(
        groupOf(
          'caseless',
          { ids: [first, second], name: 'data/x.txt' },
          { diskSpelling: null, diskHash: disk }
        ),
        NOW
      ),
    /single_writer_violated/
  );
  assert.deepEqual(tables(raw), before);
});

// ---------------------------------------------------------------------------
// Groups and the start
// ---------------------------------------------------------------------------

test('rows that fold together but resolve to different files, or to none, are not grouped', () => {
  const rows: FoldRow[] = [
    { rowid: 1, id: 'one', name: 'data/x.txt' },
    { rowid: 2, id: 'two', name: 'DATA/X.TXT' },
  ];
  const file = (ino: bigint) => ({
    dev: 1n,
    ino,
    realPath: `/w/${ino}`,
    diskSpelling: 'data/x.txt',
  });
  assert.deepEqual(sameFileGroups(rows, [file(10n), file(11n)]), []);
  assert.deepEqual(sameFileGroups(rows, [file(10n), null]), []);
  assert.deepEqual(sameFileGroups(rows, [{ ...file(10n), dev: 2n }, file(10n)]), []);
  assert.deepEqual(sameFileGroups(rows, [file(10n), file(10n)]), [{ rows, file: file(10n) }]);
});

interface StartRun {
  registry: ArtifactRegistry;
  logged: string[];
}

function startFold(
  t: TestContext,
  store: Store,
  options: { profile: FoldProfileResult; lockHeld?: boolean }
): StartRun {
  const registry = openRegistry(t, store.dbPath);
  const logged: string[] = [];
  prepareFoldIndex({
    registry,
    root: store.root,
    foldProfile: options.profile,
    lockHeld: options.lockHeld ?? true,
    log: (line) => logged.push(line),
  });
  return { registry, logged };
}

function tidySplit(t: TestContext): { store: Store; raw: Database; untidy: string; tidy: string } {
  const store = makeStore(t);
  writeWorkspaceFile(store.root, 'data/x.txt', 'bytes on disk\n');
  const raw = openRaw(t, store.dbPath);
  const untidy = seedArtifact(raw, { name: './data/x.txt', hash: sha256('bytes on disk\n') });
  const tidy = seedArtifact(raw, { name: 'data/x.txt', version: 2 });
  return { store, raw, untidy, tidy };
}

test('a tidy-only split merges at start under none, and the row with the disk spelling survives', (t) => {
  const { store, raw, untidy, tidy } = tidySplit(t);
  const { registry, logged } = startFold(t, store, { profile: classified('none') });
  assert.deepEqual(names(raw), ['data/x.txt']);
  assert.equal(registry.getArtifactById(untidy), null);
  assert.deepEqual(
    { ...registry.getArtifactById(tidy), updated_at: 0 },
    {
      id: tidy,
      name: 'data/x.txt',
      version: 3,
      content_hash: sha256('bytes on disk\n'),
      size_tokens: null,
      last_writer_id: null,
      updated_at: 0,
    }
  );
  assert.equal(registry.getArtifactByName('./data//x.txt')?.id, tidy);
  assert.equal(registry.foldIndexProfile(), 'none');
  assert.equal(logged.filter((line) => line.includes(`merged`)).length, 1, logged.join('\n'));
});

test('rows listed as keys are not merged', (t) => {
  const store = makeStore(t);
  writeWorkspaceFile(store.root, 'data/x.txt', 'bytes\n');
  const first = new ArtifactRegistry(store.dbPath);
  const key = first.resolveOrRegisterKey('./data/x.txt', '');
  const file = first.resolveOrRegisterArtifact('data/x.txt', '');
  first.close();
  const raw = openRaw(t, store.dbPath);
  const before = tables(raw);

  const { registry, logged } = startFold(t, store, { profile: classified('none') });
  assert.deepEqual(tables(raw), before);
  assert.deepEqual(logged, []);
  assert.equal(registry.getArtifactByName('./data/x.txt')?.id, file);
  assert.equal(registry.findKeyArtifact('./data/x.txt')?.id, key);
});

test('rows whose file resolves outside the workspace root are not merged', (t) => {
  const store = makeStore(t);
  const outside = mkdtempSync(join(tmpdir(), 'fold-merge-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'x.txt'), 'outside\n');
  symlinkSync(join(outside, 'x.txt'), join(store.root, 'out.txt'));
  const raw = openRaw(t, store.dbPath);
  const first = seedArtifact(raw, { name: './out.txt' });
  const second = seedArtifact(raw, { name: 'out.txt' });
  const before = tables(raw);

  const { registry, logged } = startFold(t, store, { profile: classified('none') });
  assert.deepEqual(tables(raw), before);
  assert.equal(registry.getArtifactByName('out.txt')?.id, first);
  const bucketLines = logged.filter((line) => line.includes(JSON.stringify('out.txt')));
  assert.equal(bucketLines.length, 1, logged.join('\n'));
  assert.ok(bucketLines[0]!.includes(`${first}, ${second}`), bucketLines[0]);
});

test('a start with no groups leaves the store file byte-identical', (t) => {
  const store = makeStore(t);
  const seeding = new BetterSqlite3(store.dbPath);
  seedArtifact(seeding, { name: 'docs/a.md', hash: sha256('a') });
  // Two spellings of a file that is not on disk: a bucket, never a group.
  seedArtifact(seeding, { name: 'gone.md' });
  seedArtifact(seeding, { name: './GONE.md' });
  seedState(seeding, {
    artifactId: seedArtifact(seeding, { name: 'docs/b.md' }),
    agentId: AGENT_A,
    state: MESIState.EXCLUSIVE,
    grantedAt: 5,
  });
  seeding.close();
  // The first open of this build adds the side table; the start measured is the next one.
  new ArtifactRegistry(store.dbPath).close();
  const before = readFileSync(store.dbPath);

  const registry = new ArtifactRegistry(store.dbPath);
  const logged: string[] = [];
  prepareFoldIndex({
    registry,
    root: store.root,
    foldProfile: classified('caseless'),
    lockHeld: true,
    log: (line) => logged.push(line),
  });
  registry.close();
  assert.ok(readFileSync(store.dbPath).equals(before), 'the store file changed');
  assert.equal(logged.filter((line) => line.includes(JSON.stringify('gone.md'))).length, 1);
});

test('a merge that throws mid-transaction leaves the store unchanged, is logged, and keeps the profile', (t) => {
  const { store, raw, untidy } = tidySplit(t);
  raw.exec(
    `CREATE TRIGGER refuse_delete BEFORE DELETE ON artifacts
     BEGIN SELECT RAISE(ABORT, 'injected merge failure'); END`
  );
  const before = tables(raw);
  const { registry, logged } = startFold(t, store, { profile: classified('caseless') });

  assert.deepEqual(tables(raw), before);
  const failures = logged.filter((line) => line.includes('injected merge failure'));
  assert.equal(failures.length, 1, logged.join('\n'));
  assert.match(failures[0]!, /rolled back/);
  assert.equal(registry.foldIndexProfile(), 'caseless');
  assert.equal(registry.getArtifactByName('DATA/X.TXT')?.id, untidy);
  assert.equal(registry.resolveOrRegisterArtifact('Data/x.txt', ''), untidy);
  assert.equal(logged.filter((line) => line.includes(JSON.stringify('data/x.txt'))).length, 1);
});

test('an unlocked start merges nothing and builds no index', (t) => {
  const { store, raw, tidy } = tidySplit(t);
  const before = tables(raw);
  const { registry, logged } = startFold(t, store, {
    profile: { profile: 'none', status: 'cannot_tell', reason: 'unlocked' },
    lockHeld: false,
  });
  assert.deepEqual(tables(raw), before);
  assert.equal(registry.foldIndexProfile(), null);
  // Exact: tidied, then looked up by name in SQL.
  assert.equal(registry.getArtifactByName('./data/x.txt')?.id, tidy);
  assert.equal(registry.getArtifactByName('DATA/X.TXT'), null);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /single-writer lock/);
});

test('an older build opening the merged store finds the survivor under its unchanged name', (t) => {
  const { store, tidy } = tidySplit(t);
  startFold(t, store, { profile: classified('caseless') }).registry.close();

  // What an older build runs at open: the migrations and the foreign-ledger guard.
  const older = openRaw(t, store.dbPath);
  assert.deepEqual(runPendingMigrations(older).applied, []);
  const row = older.prepare(`SELECT id FROM artifacts WHERE name = ?`).get('data/x.txt') as
    { id: string } | undefined;
  assert.equal(row?.id, tidy);
  assert.deepEqual(names(older), ['data/x.txt']);
});

test('a coordinator start merges split rows of one file before it serves', async (t) => {
  const store = makeStore(t);
  writeWorkspaceFile(store.root, 'data/x.txt', 'tidy\n');
  writeWorkspaceFile(store.root, NFC, 'composed\n');
  const seeding = new BetterSqlite3(store.dbPath);
  const untidy = seedArtifact(seeding, { name: './data/x.txt' });
  const tidy = seedArtifact(seeding, { name: 'data/x.txt' });
  const nfd = seedArtifact(seeding, { name: NFD });
  const nfc = seedArtifact(seeding, { name: NFC });
  seeding.close();

  const coordinator = startCoordinator(store.root);
  try {
    await serving(store.root, coordinator);
  } finally {
    await killAndWait(coordinator.child);
  }
  const profile = /workspace disk fold profile: (\w+)/.exec(coordinator.stderr())?.[1];
  assert.ok(profile !== undefined, coordinator.stderr());
  const raw = openRaw(t, store.dbPath);
  const ids = (
    raw.prepare(`SELECT id FROM artifacts ORDER BY rowid`).all() as { id: string }[]
  ).map((row) => row.id);
  // The disk holds one entry per name, spelled as created; a disk that folds
  // NFC and NFD together makes the two accent spellings one file.
  assert.ok(!ids.includes(untidy));
  assert.deepEqual(ids, profile === 'none' ? [tidy, nfd, nfc] : [tidy, nfc], coordinator.stderr());
});
