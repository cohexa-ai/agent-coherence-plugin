/**
 * The route door: every hook route that takes a file name reaches the one row
 * for that file under any spelling the workspace disk treats as the same,
 * answers in the request's own spelling, and keeps a key (a name that is not a
 * file) exactly as sent.
 *
 * Most tests run on the real disk's profile, probed as the coordinator probes
 * it: case-insensitive APFS folds case and accent forms, a Linux disk folds
 * nothing. Where an outcome depends on the disk, each test states both: one
 * file on a disk that folds case, two files on one that does not.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import BetterSqlite3 from 'better-sqlite3';
import { ArtifactRegistry } from '../registry.js';
import { PolicyRef } from '../policy.js';
import { SessionRegistry } from '../sessions.js';
import { createServer, type ServerOptions } from '../server.js';
import { probeFoldProfile, type FoldProfileResult } from '../fs_profile.js';
import { prepareFoldIndex } from '../fold_merge.js';
import type { FoldProfile } from '../path_fold.js';
import { MESIState } from '../states.js';
import { detectTrackedPaths } from '../hooks/bash_path_detector.js';
import type { HookDeps } from '../hooks/_common.js';
import { tokenRequest } from '../hooks/door.js';
import { killAndWait } from './pid_lock_fixture.js';
import { serving, startCoordinator } from './coordinator_process_fixture.js';

const SECRET = 's'.repeat(32);
const SID_A = '44444444-4444-4444-8444-444444444444';
const SID_B = '55555555-5555-5555-8555-555555555555';
const SID_C = '66666666-6666-6666-8666-666666666666';
const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);
const PATH_ERROR = { error: 'missing or empty path' };
const TRACK_DATA = { 'tracked.yaml': '- "data/**"\n' };
const TRACK_ALL = { 'tracked.yaml': '- "**"\n' };
const CANNOT_TELL: FoldProfileResult = { profile: 'none', status: 'cannot_tell', reason: 'test' };
const UNLOCKED: FoldProfileResult = { profile: 'none', status: 'cannot_tell', reason: 'unlocked' };
const CASELESS: FoldProfileResult = { profile: 'caseless', status: 'classified' };

type Answer = { status: number; body: Record<string, unknown> };

interface Door {
  readonly registry: ArtifactRegistry;
  readonly sessions: SessionRegistry;
  /** The profile names are keyed under, or null when the start built no index. */
  readonly indexProfile: FoldProfile | null;
  post(route: string, body: unknown): Promise<Answer>;
  get(route: string): Promise<Answer>;
  close(): Promise<void>;
}

interface DoorOptions {
  /** The start's probe result; the real disk is probed when absent. */
  readonly foldProfile?: FoldProfileResult;
  /** False builds no index, as a start without the single-writer lock. */
  readonly lockHeld?: boolean;
}

function makeWorkspace(t: TestContext, policy: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'door-fold-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.coherence'));
  for (const [name, text] of Object.entries(policy)) {
    writeFileSync(join(root, '.coherence', name), text, 'utf8');
  }
  return root;
}

function writeWorkspaceFile(root: string, name: string, text = 'x\n'): void {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), text);
}

function probeDisk(root: string): FoldProfileResult {
  const coherenceDir = join(root, '.coherence');
  return probeFoldProfile({ root, coherenceDir, lockState: 'held', log: () => {} });
}

async function request(port: number, route: string, init: RequestInit): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      Host: '127.0.0.1',
      'Content-Type': 'application/json',
    },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function serverOptions(
  root: string,
  options: DoorOptions,
  registry: ArtifactRegistry
): ServerOptions {
  const foldProfile = options.foldProfile ?? probeDisk(root);
  prepareFoldIndex({
    registry,
    root,
    foldProfile,
    lockHeld: options.lockHeld ?? true,
    log: () => {},
  });
  return {
    secret: SECRET,
    startedAtMs: Date.now(),
    version: 'test',
    registry,
    policy: PolicyRef.load(root),
    sessions: new SessionRegistry(),
    foldProfile,
    canonicalRoot: realpathSync.native(root),
  };
}

/** A server over `root`'s store, started the way the coordinator starts. */
async function openDoor(t: TestContext, root: string, options: DoorOptions = {}): Promise<Door> {
  const registry = new ArtifactRegistry(join(root, '.coherence', 'state.db'));
  const opts = serverOptions(root, options, registry);
  const server = createServer(opts);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  let closed = false;
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((resolve) =>
      server.close(() => {
        registry.close();
        resolve();
      })
    );
  };
  t.after(close);
  return {
    registry,
    sessions: opts.sessions,
    indexProfile: registry.foldIndexProfile(),
    post: (route, body) => request(port, route, { method: 'POST', body: JSON.stringify(body) }),
    get: (route) => request(port, route, { method: 'GET' }),
    close,
  };
}

function foldsCase(door: Door): boolean {
  return door.indexProfile === 'caseless';
}

function rowNames(door: Door): string[] {
  return door.registry
    .listArtifacts()
    .map((artifact) => artifact.name)
    .sort();
}

function agentOf(door: Door, sessionId: string): string {
  return door.sessions.registerSession(sessionId, null);
}

function stateOf(door: Door, name: string, sessionId: string): MESIState | null {
  const row = door.registry.listArtifacts().find((artifact) => artifact.name === name);
  assert.ok(row !== undefined, `no row named ${name}: ${JSON.stringify(rowNames(door))}`);
  return door.registry.getAgentState(row.id, agentOf(door, sessionId));
}

function contextOf(answer: Answer): string {
  const output = answer.body['hookSpecificOutput'] as Record<string, unknown> | undefined;
  return String(output?.['additionalContext'] ?? '');
}

function summaryPath(answer: Answer): unknown {
  return (answer.body['summary'] as Record<string, unknown> | undefined)?.['path'];
}

/** Session B commits `name`, so a session that read it before holds a stale copy. */
async function commitAsB(door: Door, name: string): Promise<void> {
  assert.equal(
    (await door.post('/hooks/pre-edit', { session_id: SID_B, path: name })).body['ok'],
    true
  );
  const committed = await door.post('/hooks/post-edit', {
    session_id: SID_B,
    path: name,
    success: true,
    content_hash: HASH_2,
  });
  assert.deepEqual(committed.body, { ok: true });
}

/** The requests one session sends through `door`. */
function sessionOf(door: Door, sessionId: string) {
  return (route: string, fields: Record<string, unknown>): Promise<Answer> =>
    door.post(route, { session_id: sessionId, ...fields });
}

/** A door over a workspace that tracks data/** and holds data/x.txt. */
async function dataDoor(t: TestContext): Promise<Door> {
  const root = makeWorkspace(t, TRACK_DATA);
  writeWorkspaceFile(root, 'data/x.txt');
  return openDoor(t, root);
}

// ------------------------------------------------------------------ aliases

test('an alias pre-edit meets the holder of the file as its own spelling would', async (t) => {
  const door = await dataDoor(t);
  const [a, b, c] = [SID_A, SID_B, SID_C].map((sessionId) => sessionOf(door, sessionId));
  const held = await a('/hooks/pre-edit', { path: 'data/x.txt' });
  const optedIn = await b('/hooks/pre-edit', { path: 'DATA/X.TXT', if_unheld: true });
  const ordinary = await c('/hooks/pre-edit', { path: 'DATA/X.TXT' });

  assert.deepEqual(held.body, { ok: true });
  assert.deepEqual(rowNames(door), ['data/x.txt']);
  if (!foldsCase(door)) {
    // Another file on this disk, and one data/** does not name.
    assert.deepEqual([optedIn.body, ordinary.body], [{ ok: true }, { ok: true }]);
    assert.equal(stateOf(door, 'data/x.txt', SID_A), MESIState.EXCLUSIVE);
    return;
  }
  const holder = agentOf(door, SID_A);
  assert.deepEqual(optedIn.body, { ok: false, reason: 'other_holder', holder_agent_id: holder });
  assert.deepEqual([ordinary.body['ok'], ordinary.body['collision']], [true, true]);
  assert.match(contextOf(ordinary), /DATA\/X\.TXT/);
  assert.equal(stateOf(door, 'data/x.txt', SID_A), MESIState.INVALID);
  assert.equal(stateOf(door, 'data/x.txt', SID_C), MESIState.EXCLUSIVE);
});

test("an ordinary pre-edit meets a write holder on its fold bucket's other row", async (t) => {
  const root = makeWorkspace(t, TRACK_ALL);
  // Two rows for one file, as a build that folds nothing keeps them.
  const split = await openDoor(t, root, { foldProfile: CANNOT_TELL });
  const seen = { path: 'data/x.txt', content_hash: HASH_1 };
  await split.post('/hooks/pre-read', { session_id: SID_A, ...seen });
  await split.post('/hooks/pre-edit', { session_id: SID_C, path: 'DATA/X.TXT' });
  await split.close();
  // The file is missing at this start, so the rows stay apart as one bucket.
  const door = await openDoor(t, root, { foldProfile: CASELESS });
  writeWorkspaceFile(root, 'data/x.txt');

  const edit = await door.post('/hooks/pre-edit', { session_id: SID_B, path: 'data/x.txt' });

  assert.equal(door.indexProfile, 'caseless');
  assert.deepEqual(rowNames(door), ['DATA/X.TXT', 'data/x.txt']);
  assert.deepEqual([edit.body['ok'], edit.body['collision']], [true, true]);
  // C's write may still be landing, so a disk unlike the record proves nothing.
  assert.equal(edit.body['disk_differs'], undefined);
  assert.equal(stateOf(door, 'DATA/X.TXT', SID_C), MESIState.INVALID);
  assert.equal(stateOf(door, 'data/x.txt', SID_B), MESIState.EXCLUSIVE);
});

test('post-edit-cas and post-edit through an alias commit the file the alias names', async (t) => {
  const door = await dataDoor(t);
  const [a, b] = [SID_A, SID_B].map((sessionId) => sessionOf(door, sessionId));
  const read = await b('/hooks/pre-read', { path: 'data/x.txt', content_hash: HASH_1 });
  const casFields = { path: 'DATA/x.txt', content_hash: HASH_2, expected_version: 1 };
  const cas = await b('/hooks/post-edit-cas', casFields);
  const edit = await a('/hooks/pre-edit', { path: 'DATA/X.TXT' });
  const commitFields = { path: 'Data/x.TXT', success: true, content_hash: HASH_1 };
  const commit = await a('/hooks/post-edit', commitFields);

  assert.deepEqual([read.body, commit.body], [{ status: 'fresh', version: 1 }, { ok: true }]);
  const versions = door.registry.listArtifacts().map((row) => [row.name, row.version]);
  if (!foldsCase(door)) {
    // The aliases name other files, which data/** does not track.
    assert.deepEqual([cas.body, edit.body], [{ ok: true }, { ok: true }]);
    assert.deepEqual(versions, [['data/x.txt', 1]]);
    return;
  }
  assert.deepEqual(cas.body, { ok: true, version: 2 });
  assert.equal(edit.body['ok'], true);
  assert.deepEqual(versions, [['data/x.txt', 3]]);
  assert.equal(stateOf(door, 'data/x.txt', SID_B), MESIState.INVALID);
});

test('an answer repeats the path in the bytes the request sent', async (t) => {
  const door = await dataDoor(t);
  const a = sessionOf(door, SID_A);
  await a('/hooks/pre-read', { path: 'data/x.txt', content_hash: HASH_1 });
  await commitAsB(door, 'data/x.txt');

  const untidy = await a('/hooks/pre-read', { path: './/data/x.txt' });
  const bash = await sessionOf(door, SID_C)('/hooks/pre-bash', { command: 'cat ./data//x.txt' });
  assert.equal(untidy.body['status'], 'stale');
  assert.equal(summaryPath(untidy), './/data/x.txt');
  assert.deepEqual(bash.body['stale_paths'], ['./data//x.txt']);

  if (foldsCase(door)) {
    assert.equal((await a('/hooks/pre-read', { path: 'DATA/X.TXT' })).body['status'], 'fresh');
    await commitAsB(door, 'data/x.txt');
    const stale = await a('/hooks/pre-read', { path: 'DATA/X.TXT' });
    assert.equal(summaryPath(stale), 'DATA/X.TXT');
  }
  assert.deepEqual(rowNames(door), ['data/x.txt']);
});

const DOOR_MODES: ReadonlyArray<[string, DoorOptions]> = [
  ["the disk's own profile", {}],
  ['a start that cannot tell', { foldProfile: CANNOT_TELL }],
  ['a start without the single-writer lock', { foldProfile: UNLOCKED, lockHeld: false }],
];

for (const [mode, options] of DOOR_MODES) {
  test(`.//data/x.txt and ././data/x.txt reach data/x.txt (${mode})`, async (t) => {
    const root = makeWorkspace(t, TRACK_DATA);
    writeWorkspaceFile(root, 'data/x.txt');
    const door = await openDoor(t, root, options);
    await door.post('/hooks/pre-read', {
      session_id: SID_A,
      path: 'data/x.txt',
      content_hash: HASH_1,
    });

    const read = await door.post('/hooks/pre-read', { session_id: SID_B, path: './/data/x.txt' });
    const edit = await door.post('/hooks/pre-edit', { session_id: SID_C, path: '././data/x.txt' });

    assert.equal(read.body['status'], 'stale');
    assert.equal(edit.body['ok'], true);
    assert.deepEqual(rowNames(door), ['data/x.txt']);
    assert.equal(stateOf(door, 'data/x.txt', SID_A), MESIState.INVALID);
    assert.equal(stateOf(door, 'data/x.txt', SID_C), MESIState.EXCLUSIVE);
  });
}

test('a strict plan.md denies a stale edit spelled PLAN.MD where the disk folds case', async (t) => {
  const root = makeWorkspace(t, { 'strict_mode.yaml': '- "plan.md"\n' });
  writeWorkspaceFile(root, 'plan.md');
  const door = await openDoor(t, root);
  await door.post('/hooks/pre-read', { session_id: SID_A, path: 'plan.md', content_hash: HASH_1 });
  await commitAsB(door, 'plan.md');

  const edit = await door.post('/hooks/pre-edit', { session_id: SID_A, path: 'PLAN.MD' });

  if (!foldsCase(door)) {
    assert.deepEqual(edit.body, { ok: true });
    return;
  }
  assert.equal(edit.body['ok'], false);
  assert.equal(edit.body['status'], 'stale');
  assert.equal(summaryPath(edit), 'PLAN.MD');
  const output = edit.body['hookSpecificOutput'] as Record<string, unknown>;
  assert.equal(output['permissionDecision'], 'deny');
  assert.equal(stateOf(door, 'plan.md', SID_A), MESIState.INVALID);
});

// ------------------------------------------------------------------ pre-bash

test('pre-bash collapses two spellings of one file into one token and one grant', async (t) => {
  const root = makeWorkspace(t);
  writeWorkspaceFile(root, 'plan.md');
  writeWorkspaceFile(root, 'spec.md');
  const door = await openDoor(t, root);

  // A second token for a file the first token just registered would read as
  // stale: its grant is applied only after the deny decision.
  const tidy = await door.post('/hooks/pre-bash', {
    session_id: SID_A,
    command: 'cat .//plan.md plan.md',
  });
  const cased = await door.post('/hooks/pre-bash', {
    session_id: SID_B,
    command: 'cat spec.md SPEC.MD',
  });

  assert.deepEqual(tidy.body, { status: 'fresh' });
  assert.deepEqual(cased.body, { status: 'fresh' });
  assert.deepEqual(rowNames(door), ['plan.md', 'spec.md']);
  assert.equal(stateOf(door, 'spec.md', SID_B), MESIState.SHARED);
  assert.equal(
    door.registry.artifactsHeldByAgent(agentOf(door, SID_B), [MESIState.SHARED]).length,
    1
  );
});

test('the bash detector keeps the first tracked spelling of each key', () => {
  const lower = (path: string): string => path.toLowerCase();
  assert.deepEqual(
    detectTrackedPaths('cat plan.md PLAN.MD', () => true, lower),
    ['plan.md']
  );
  // An untracked first spelling does not hide a tracked later one.
  const onlyUpper = (path: string): boolean => path === 'A.MD';
  assert.deepEqual(detectTrackedPaths('cat a.md A.MD', onlyUpper, lower), ['A.MD']);
});

test('a bash token over the fold limit is matched exactly as typed', async (t) => {
  const root = makeWorkspace(t);
  const door = await openDoor(t, root);
  const long = `${'d/'.repeat(520)}plan.md`;

  const first = await door.post('/hooks/pre-bash', { session_id: SID_A, command: `cat ${long}` });
  const dotted = await door.post('/hooks/pre-bash', {
    session_id: SID_A,
    command: `cat ./${long}`,
  });

  assert.deepEqual(first.body, { status: 'fresh' });
  assert.deepEqual(dotted.body, { status: 'fresh' });
  assert.deepEqual(rowNames(door), [`./${long}`, long]);
});

test('a bash token over the fold limit only by ./ padding reaches the file it tidies to', async (t) => {
  const root = makeWorkspace(t, { 'strict_mode.yaml': '- "plan.md"\n' });
  writeWorkspaceFile(root, 'plan.md');
  const door = await openDoor(t, root);
  await door.post('/hooks/pre-read', { session_id: SID_A, path: 'plan.md', content_hash: HASH_1 });
  await commitAsB(door, 'plan.md');
  const padded = `${'./'.repeat(520)}plan.md`;

  const bash = await door.post('/hooks/pre-bash', { session_id: SID_A, command: `cat ${padded}` });

  assert.deepEqual(rowNames(door), ['plan.md']);
  assert.equal(bash.body['status'], 'stale');
  assert.deepEqual(bash.body['stale_paths'], [padded]);
  const output = bash.body['hookSpecificOutput'] as Record<string, unknown>;
  assert.equal(output['permissionDecision'], 'deny');
});

// ------------------------------------------------------------------ disk spelling

test('a new row for an existing file is named as the disk spells it', async (t) => {
  const root = makeWorkspace(t, TRACK_DATA);
  writeWorkspaceFile(root, 'Data/X.txt');
  const door = await openDoor(t, root);

  await door.post('/hooks/pre-read', {
    session_id: SID_A,
    path: 'data/x.txt',
    content_hash: HASH_1,
  });
  await door.post('/hooks/pre-read', {
    session_id: SID_B,
    path: 'DATA/x.txt',
    content_hash: HASH_1,
  });

  assert.deepEqual(rowNames(door), foldsCase(door) ? ['Data/X.txt'] : ['data/x.txt']);
});

test('a new file takes the disk spelling of the directories it is created in', async (t) => {
  const root = makeWorkspace(t, TRACK_ALL);
  mkdirSync(join(root, 'Data'));
  const door = await openDoor(t, root);

  await door.post('/hooks/pre-edit', { session_id: SID_A, path: 'DATA/New.txt' });

  assert.deepEqual(rowNames(door), [foldsCase(door) ? 'Data/New.txt' : 'DATA/New.txt']);
});

const UNFOLDED_STARTS: ReadonlyArray<[string, DoorOptions]> = [
  ['a start that cannot tell', { foldProfile: CANNOT_TELL }],
  ['a start without the single-writer lock', { foldProfile: UNLOCKED, lockHeld: false }],
];

for (const [mode, options] of UNFOLDED_STARTS) {
  test(`${mode} advertises cannot_tell and names rows as requested`, async (t) => {
    const root = makeWorkspace(t, TRACK_ALL);
    writeWorkspaceFile(root, 'Data/X.txt');
    const door = await openDoor(t, root, options);

    await door.post('/hooks/pre-edit', { session_id: SID_A, path: 'data/x.txt' });
    const commit = await door.post('/hooks/post-edit', {
      session_id: SID_A,
      path: 'data/x.txt',
      success: true,
      content_hash: HASH_1,
    });
    await door.post('/hooks/pre-read', {
      session_id: SID_B,
      path: 'DATA/X.TXT',
      content_hash: HASH_1,
    });

    assert.equal((await door.get('/status')).body['fold_profile'], 'cannot_tell');
    assert.deepEqual(commit.body, { ok: true });
    assert.deepEqual(rowNames(door), ['DATA/X.TXT', 'data/x.txt']);
  });
}

test('a request through a link keeps its own name: the link reaches another file', async (t) => {
  const root = makeWorkspace(t, TRACK_ALL);
  writeWorkspaceFile(root, 'plan.md');
  mkdirSync(join(root, 'data'));
  symlinkSync('../plan.md', join(root, 'data', 'link.md'));
  const door = await openDoor(t, root);

  await door.post('/hooks/pre-read', {
    session_id: SID_A,
    path: 'data/link.md',
    content_hash: HASH_1,
  });

  assert.deepEqual(rowNames(door), ['data/link.md']);
});

test('a disk spelling outside the workspace root is never kept', async (t) => {
  const root = makeWorkspace(t);
  writeWorkspaceFile(root, 'Inside.md');
  const registry = new ArtifactRegistry(join(root, '.coherence', 'state.db'));
  t.after(() => registry.close());
  prepareFoldIndex({ registry, root, foldProfile: probeDisk(root), lockHeld: true, log: () => {} });
  const deps: HookDeps = {
    registry,
    policy: PolicyRef.load(root),
    sessions: new SessionRegistry(),
    canonicalRoot: realpathSync.native(root),
  };

  // A Bash token is not refused for `..`: it resolves beside the root.
  assert.equal(tokenRequest(deps, '../outside.md').file.diskSpelling, undefined);
  const inside = tokenRequest(deps, 'inside.md').file.diskSpelling;
  assert.equal(inside, registry.foldIndexProfile() === 'caseless' ? 'Inside.md' : undefined);
});

test('the coordinator names a new row as the disk spells it, however its root is spelled', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'door-fold-root-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  // tmpdir() is /var/... on macOS, a link to /private/var.
  const given = await coordinatorRowNames(seededWorkspace(join(base, 'ws')));
  assert.deepEqual(given.names, given.profile === 'caseless' ? ['Data/X.txt'] : ['data/x.txt']);
  if (given.profile !== 'caseless') return;
  seededWorkspace(join(base, 'cased'));
  const cased = await coordinatorRowNames(join(realpathSync.native(base), 'CASED'));
  assert.deepEqual(cased.names, ['Data/X.txt']);
});

function seededWorkspace(root: string): string {
  mkdirSync(join(root, '.coherence'), { recursive: true });
  writeFileSync(join(root, '.coherence', 'tracked.yaml'), '- "data/**"\n');
  writeWorkspaceFile(root, 'Data/X.txt');
  return root;
}

/** Start the real coordinator on `root`, pre-read data/x.txt through it, stop it, and list its rows. */
async function coordinatorRowNames(root: string): Promise<{ profile: string; names: string[] }> {
  const coordinator = startCoordinator(root);
  try {
    await serving(root, coordinator);
    const answer = await coordinatorPost(root, '/hooks/pre-read', {
      session_id: SID_A,
      path: 'data/x.txt',
      content_hash: HASH_1,
    });
    assert.equal(answer.status, 200, coordinator.stderr());
  } finally {
    await killAndWait(coordinator.child);
  }
  const profile = /workspace disk fold profile: (\w+)/.exec(coordinator.stderr())?.[1] ?? '';
  const store = new BetterSqlite3(join(root, '.coherence', 'state.db'), { readonly: true });
  try {
    const rows = store.prepare('SELECT name FROM artifacts ORDER BY name').all() as {
      name: string;
    }[];
    return { profile, names: rows.map((row) => row.name) };
  } finally {
    store.close();
  }
}

async function coordinatorPost(root: string, route: string, body: unknown): Promise<Answer> {
  const port = readFileSync(join(root, '.coherence', 'server.pid'), 'utf8').split('\n')[1];
  const secret = readFileSync(join(root, '.coherence', 'hook.secret'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      Host: '127.0.0.1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ------------------------------------------------------------------ keys

const KEY_ROUTES: ReadonlyArray<[string, Record<string, unknown>]> = [
  ['/hooks/pre-read', {}],
  ['/hooks/pre-edit', {}],
  ['/hooks/post-edit', { success: true, content_hash: HASH_1 }],
  ['/hooks/post-edit-cas', { content_hash: HASH_1, expected_version: 1 }],
];

test('keys that differ only by case are two rows, before and after a restart', async (t) => {
  const root = makeWorkspace(t, TRACK_ALL);
  const before = await openDoor(t, root);
  const lower = { session_id: SID_A, path: 'ws-42', name_kind: 'key', content_hash: HASH_1 };
  const upper = { session_id: SID_A, path: 'WS-42', name_kind: 'key', content_hash: HASH_2 };
  await before.post('/hooks/pre-read', lower);
  await before.post('/hooks/pre-read', upper);
  assert.deepEqual(rowNames(before), ['WS-42', 'ws-42']);
  await before.close();

  const after = await openDoor(t, root);
  const cas = await after.post('/hooks/post-edit-cas', {
    session_id: SID_A,
    path: 'WS-42',
    name_kind: 'key',
    content_hash: HASH_1,
    expected_version: 1,
  });
  assert.deepEqual(cas.body, { ok: true, version: 2 });
  const versions = after.registry.listArtifacts().map((a) => [a.name, a.version]);
  assert.deepEqual(versions.sort(), [
    ['WS-42', 2],
    ['ws-42', 1],
  ]);
});

test('a key keeps every byte it was sent with', async (t) => {
  const root = makeWorkspace(t, TRACK_ALL);
  const door = await openDoor(t, root);
  const key = 's3://bucket//Key';

  const read = await door.post('/hooks/pre-read', {
    session_id: SID_A,
    path: key,
    name_kind: 'key',
    content_hash: HASH_1,
  });
  const cas = await door.post('/hooks/post-edit-cas', {
    session_id: SID_A,
    path: key,
    name_kind: 'key',
    content_hash: HASH_2,
    expected_version: 1,
  });
  const asFile = await door.post('/hooks/pre-read', {
    session_id: SID_B,
    path: key,
    content_hash: HASH_1,
  });

  assert.deepEqual(read.body, { status: 'fresh', version: 1 });
  assert.deepEqual(cas.body, { ok: true, version: 2 });
  assert.deepEqual(asFile.body, { status: 'fresh', version: 1 });
  assert.deepEqual(rowNames(door), [key, 's3:/bucket/Key']);
});

test("a file edit of a key row's exact name commits to the row the key shares", async (t) => {
  const root = makeWorkspace(t, TRACK_ALL);
  const door = await openDoor(t, root, { foldProfile: CASELESS });
  const key = { path: 'docs/plan.md', name_kind: 'key' };
  await door.post('/hooks/pre-read', { session_id: SID_A, ...key, content_hash: HASH_1 });

  const edit = await door.post('/hooks/pre-edit', { session_id: SID_B, path: 'docs/plan.md' });
  const commit = await door.post('/hooks/post-edit', {
    session_id: SID_B,
    path: 'docs/plan.md',
    success: true,
    content_hash: HASH_2,
  });
  const keyRead = await door.post('/hooks/pre-read', { session_id: SID_A, ...key });

  assert.deepEqual([edit.body, commit.body], [{ ok: true }, { ok: true }]);
  assert.equal(keyRead.body['status'], 'stale');
  const versions = door.registry.listArtifacts().map((row) => [row.name, row.version]);
  assert.deepEqual(versions, [['docs/plan.md', 2]]);
});

test('a name_kind other than file or key is refused with the route path error', async (t) => {
  const root = makeWorkspace(t, TRACK_ALL);
  const door = await openDoor(t, root);
  for (const [route, extra] of KEY_ROUTES) {
    for (const nameKind of ['blob', 'KEY', 7]) {
      const body = { session_id: SID_A, path: 'data/x.txt', name_kind: nameKind, ...extra };
      assert.deepEqual(
        await door.post(route, body),
        { status: 400, body: PATH_ERROR },
        `${route} ${nameKind}`
      );
    }
    const file = { session_id: SID_A, path: 'data/x.txt', name_kind: 'file', ...extra };
    assert.equal((await door.post(route, file)).status, 200, route);
  }
  assert.deepEqual(rowNames(door), ['data/x.txt']);
});

// ------------------------------------------------------------------ the limit

test('a path over 1024 code points is refused with the route path error, as a file or a key', async (t) => {
  const root = makeWorkspace(t, TRACK_ALL);
  const door = await openDoor(t, root);
  const long = 'a'.repeat(1025);
  for (const [route, extra] of KEY_ROUTES) {
    for (const kind of [{}, { name_kind: 'key' }]) {
      const body = { session_id: SID_A, path: long, ...kind, ...extra };
      assert.deepEqual(await door.post(route, body), { status: 400, body: PATH_ERROR }, route);
    }
  }
  const grep = await door.post('/hooks/pre-grep', { session_id: SID_A, search_root: long });
  assert.deepEqual(grep, { status: 400, body: PATH_ERROR });
  // Counted in code points: 1024 of them take 2048 UTF-16 units.
  const astral = await door.post('/hooks/pre-read', {
    session_id: SID_A,
    path: '\u{1F600}'.repeat(1024),
  });
  assert.equal(astral.status, 200);
  assert.deepEqual(rowNames(door), ['\u{1F600}'.repeat(1024)]);
});

// ------------------------------------------------------------------ pre-grep

async function seedGrepRows(door: Door): Promise<void> {
  // Registered out of name order: an answer lists them in name order.
  for (const path of ['data/b.md', '\u00e9t\u00e9/d.md', 'database/c.md', 'data/a.md']) {
    await door.post('/hooks/pre-read', { session_id: SID_A, path, content_hash: HASH_1 });
  }
}

function stalePaths(answer: Answer): unknown {
  return answer.body['stale_paths'] ?? [];
}

test('pre-grep under DATA reaches data/ rows, and under an accented root reaches them on a folding disk', async (t) => {
  const root = makeWorkspace(t, TRACK_ALL);
  const door = await openDoor(t, root);
  await seedGrepRows(door);

  const upper = await door.post('/hooks/pre-grep', { session_id: SID_B, search_root: 'DATA' });
  const accented = await door.post('/hooks/pre-grep', {
    session_id: SID_C,
    search_root: '\u00c9T\u00c9',
  });

  const file = await door.post('/hooks/pre-grep', { session_id: SID_A, search_root: 'DATA/A.MD' });

  assert.deepEqual(stalePaths(upper), ['data/a.md', 'data/b.md']);
  assert.deepEqual(stalePaths(accented), foldsCase(door) ? ['\u00e9t\u00e9/d.md'] : []);
  // A root that is a file reaches that file. Session A read it, so it is fresh.
  assert.deepEqual(file.body, { status: 'fresh' });
  await commitAsB(door, 'data/a.md');
  const stale = await door.post('/hooks/pre-grep', { session_id: SID_A, search_root: 'DATA/A.MD' });
  assert.deepEqual(stalePaths(stale), foldsCase(door) ? ['data/a.md'] : []);
});

test('pre-grep on a disk that folds nothing finds what the SQL prefix match always found', async (t) => {
  const root = makeWorkspace(t, TRACK_ALL);
  const door = await openDoor(t, root, { foldProfile: CANNOT_TELL });
  await seedGrepRows(door);

  const upper = await door.post('/hooks/pre-grep', { session_id: SID_B, search_root: 'DATA' });
  const accented = await door.post('/hooks/pre-grep', {
    session_id: SID_C,
    search_root: '\u00c9T\u00c9',
  });
  const all = await door.post('/hooks/pre-grep', { session_id: SID_C, search_root: '' });

  // SQLite's LIKE folds ASCII case only.
  assert.deepEqual(stalePaths(upper), ['data/a.md', 'data/b.md']);
  assert.deepEqual(stalePaths(accented), []);
  assert.deepEqual(stalePaths(all), [
    'data/a.md',
    'data/b.md',
    'database/c.md',
    '\u00e9t\u00e9/d.md',
  ]);
});

// ------------------------------------------------------------------ policy routes

test('untrack refuses a spelling of a strict path where the disk folds case', async (t) => {
  const root = makeWorkspace(t, { 'strict_mode.yaml': '- "plan.md"\n' });
  const door = await openDoor(t, root);

  const answer = await door.post('/policy/untrack', { paths: ['PLAN.MD'] });

  if (!foldsCase(door)) {
    assert.deepEqual(answer, {
      status: 200,
      body: { ok: true, removed: ['PLAN.MD'], rejected: [] },
    });
    return;
  }
  assert.equal(answer.status, 409);
  assert.equal(answer.body['reason'], 'untrack_strict_path');
  assert.deepEqual(answer.body['refused'], [{ path: 'PLAN.MD', strict_patterns: ['plan.md'] }]);
});

// ------------------------------------------------------------------ /status

test('/status names the fold profile and the fold table Unicode version', async (t) => {
  const probed = await openDoor(t, makeWorkspace(t));
  const status = (await probed.get('/status')).body;
  const disk = probeDisk(makeWorkspace(t));
  assert.equal(status['fold_profile'], disk.status === 'classified' ? disk.profile : 'cannot_tell');
  assert.equal(status['fold_table_unicode'], '17.0.0');

  const cannotTell = (
    await (await openDoor(t, makeWorkspace(t), { foldProfile: CANNOT_TELL })).get('/status')
  ).body;
  assert.equal(cannotTell['fold_profile'], 'cannot_tell');
  assert.equal(cannotTell['fold_table_unicode'], '17.0.0');

  // Every tier names them, so a client reading either tier folds alike.
  const metrics = (await probed.get('/status?detail=metrics')).body;
  assert.equal(metrics['fold_profile'], status['fold_profile']);
  assert.equal(metrics['fold_table_unicode'], '17.0.0');
});

test('/status of a server started with no probe result names none', async (t) => {
  const root = makeWorkspace(t);
  const registry = new ArtifactRegistry(join(root, '.coherence', 'state.db'));
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: 'test',
    registry,
    policy: PolicyRef.load(root),
    sessions: new SessionRegistry(),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(
    () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          registry.close();
          resolve();
        })
      )
  );
  const status = await request((server.address() as AddressInfo).port, '/status', {
    method: 'GET',
  });
  assert.equal(status.body['fold_profile'], 'none');
  assert.equal(status.body['fold_table_unicode'], '17.0.0');
});
