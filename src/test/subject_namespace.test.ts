/**
 * Names under the reserved `subject:` prefix on the Node coordinator, which
 * does not support subjects.
 *
 * The edit routes (pre-edit, post-edit, post-edit-cas) answer such a name with
 * a typed 400, so a client that means a subject is never told it acquired or
 * committed one. A file name is refused when it reaches the prefix in any form
 * the coordinator reads it in: as sent, tidied, or folded by the workspace
 * disk. A key is refused only where no tracked pattern covers it; a covered
 * key stays coordinated. The policy reads a file name under the prefix as
 * untracked and not strict, so the read routes keep no row for one. Each
 * route's own request-shape 400s come first.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ArtifactRegistry } from '../registry.js';
import { PolicyRef, type PolicyMatchContext } from '../policy.js';
import { SessionRegistry } from '../sessions.js';
import { createServer } from '../server.js';
import type { FoldProfileResult } from '../fs_profile.js';
import { prepareFoldIndex } from '../fold_merge.js';
import { killAndWait } from './pid_lock_fixture.js';
import { serving, startCoordinator } from './coordinator_process_fixture.js';

const SECRET = 's'.repeat(32);
const SID_A = '44444444-4444-4444-8444-444444444444';
const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);
const CASELESS: FoldProfileResult = { profile: 'caseless', status: 'classified' };
const NO_FOLD: FoldProfileResult = { profile: 'none', status: 'classified' };

/** Tracked and strict everywhere, so only the prefix can explain a refusal. */
const ALL_STRICT = { tracked: ['**'], strict: ['**'] };

const SUBJECT_UNSUPPORTED = {
  error:
    'subject: names are reserved for subjects, which this coordinator does not support ' +
    '(subject_unsupported)',
  reason: 'subject_unsupported',
};

/** Each edit route with the fields that make its request well-formed apart from the name. */
const EDIT_ROUTES: ReadonlyArray<[string, Record<string, unknown>]> = [
  ['/hooks/pre-edit', {}],
  ['/hooks/post-edit', { success: true, content_hash: HASH_1 }],
  ['/hooks/post-edit-cas', { content_hash: HASH_1, expected_version: 0 }],
];

type Answer = { status: number; body: Record<string, unknown> };

interface PolicyFiles {
  readonly tracked: string[];
  readonly strict?: string[];
}

interface Door {
  readonly registry: ArtifactRegistry;
  post(route: string, body: unknown): Promise<Answer>;
}

function makeWorkspace(t: TestContext, policy: PolicyFiles): string {
  const root = mkdtempSync(join(tmpdir(), 'subject-namespace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.coherence'));
  const write = (file: string, entries: string[] | undefined): void => {
    if (entries === undefined) return;
    const text = entries.map((entry) => `- ${JSON.stringify(entry)}`).join('\n') + '\n';
    writeFileSync(join(root, '.coherence', file), text, 'utf8');
  };
  write('tracked.yaml', policy.tracked);
  write('strict_mode.yaml', policy.strict);
  return root;
}

async function post(port: number, secret: string, route: string, body: unknown): Promise<Answer> {
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

/** An in-process server over a fresh workspace, its names keyed under `foldProfile`. */
async function openDoor(
  t: TestContext,
  policy: PolicyFiles,
  foldProfile: FoldProfileResult
): Promise<Door> {
  const root = makeWorkspace(t, policy);
  const registry = new ArtifactRegistry(join(root, '.coherence', 'state.db'));
  prepareFoldIndex({ registry, root, foldProfile, lockHeld: true, log: () => {} });
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: 'test',
    registry,
    policy: PolicyRef.load(root),
    sessions: new SessionRegistry(),
    foldProfile,
    canonicalRoot: realpathSync.native(root),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  t.after(
    () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          registry.close();
          resolve();
        })
      )
  );
  return { registry, post: (route, body) => post(port, SECRET, route, body) };
}

function rowNames(door: Door): string[] {
  return door.registry
    .listArtifacts()
    .map((artifact) => artifact.name)
    .sort();
}

/** Send `path` to every edit route and expect the typed refusal from each. */
async function assertRefusedOnEveryEditRoute(
  door: Door,
  path: string,
  kind: Record<string, unknown> = {}
): Promise<void> {
  for (const [route, extra] of EDIT_ROUTES) {
    const answer = await door.post(route, { session_id: SID_A, path, ...kind, ...extra });
    assert.deepEqual(answer, { status: 400, body: SUBJECT_UNSUPPORTED }, `${route} ${path}`);
  }
}

test('subject:x gets the typed 400 on every edit route, and no row', async (t) => {
  const door = await openDoor(t, ALL_STRICT, CASELESS);
  await assertRefusedOnEveryEditRoute(door, 'subject:x');
  assert.deepEqual(rowNames(door), []);
});

test('on a disk that folds case, every spelling that reaches the prefix is refused', async (t) => {
  const door = await openDoor(t, ALL_STRICT, CASELESS);
  for (const path of ['./subject:x', 'Subject:x', 'SUBJECT:x', 'subject:']) {
    await assertRefusedOnEveryEditRoute(door, path);
  }
  assert.deepEqual(rowNames(door), []);
});

test('on a disk that folds nothing, Subject:x is an ordinary file', async (t) => {
  const door = await openDoor(t, ALL_STRICT, NO_FOLD);
  await assertRefusedOnEveryEditRoute(door, 'subject:x');

  const edit = await door.post('/hooks/pre-edit', { session_id: SID_A, path: 'Subject:x' });
  const commit = await door.post('/hooks/post-edit', {
    session_id: SID_A,
    path: 'Subject:x',
    success: true,
    content_hash: HASH_1,
  });

  assert.deepEqual(
    [edit, commit],
    [
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
    ]
  );
  assert.deepEqual(rowNames(door), ['Subject:x']);
});

test('a file under a directory named subject:x is an ordinary file', async (t) => {
  const door = await openDoor(t, ALL_STRICT, CASELESS);
  const edit = await door.post('/hooks/pre-edit', { session_id: SID_A, path: 'docs/subject:x' });
  const commit = await door.post('/hooks/post-edit', {
    session_id: SID_A,
    path: 'docs/subject:x',
    success: true,
    content_hash: HASH_1,
  });

  assert.deepEqual(
    [edit, commit],
    [
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
    ]
  );
  const versions = door.registry.listArtifacts().map((row) => [row.name, row.version]);
  assert.deepEqual(versions, [['docs/subject:x', 2]]);
});

test('an untracked subject: key is refused; a key a tracked glob covers is coordinated', async (t) => {
  // A managed glob that covers numbered subjects only, so `subject:k` is untracked.
  const door = await openDoor(t, { tracked: ['subject:[0-9]*'] }, CASELESS);
  const asKey = { name_kind: 'key' };
  await assertRefusedOnEveryEditRoute(door, 'subject:k', asKey);

  const read = await door.post('/hooks/pre-read', {
    session_id: SID_A,
    path: 'subject:42',
    content_hash: HASH_1,
    ...asKey,
  });
  const cas = await door.post('/hooks/post-edit-cas', {
    session_id: SID_A,
    path: 'subject:42',
    content_hash: HASH_2,
    expected_version: 1,
    ...asKey,
  });

  assert.deepEqual(read, { status: 200, body: { status: 'fresh', version: 1 } });
  assert.deepEqual(cas, { status: 200, body: { ok: true, version: 2 } });
  const versions = door.registry.listArtifacts().map((row) => [row.name, row.version]);
  assert.deepEqual(versions, [['subject:42', 2]]);
});

test("each route's own request-shape 400 wins over the subject refusal", async (t) => {
  const door = await openDoor(t, ALL_STRICT, CASELESS);
  const malformedId = await door.post('/hooks/pre-edit', {
    session_id: SID_A,
    path: 'subject:x',
    if_unheld: true,
    agent_id: 'bad id!',
  });
  const noHash = await door.post('/hooks/post-edit', {
    session_id: SID_A,
    path: 'subject:x',
    success: true,
  });
  const noVersion = await door.post('/hooks/post-edit-cas', {
    session_id: SID_A,
    path: 'subject:x',
    content_hash: HASH_1,
  });

  assert.deepEqual(malformedId, {
    status: 400,
    body: { error: 'agent_id must be 1-64 chars of [A-Za-z0-9_-]' },
  });
  assert.deepEqual(noHash, {
    status: 400,
    body: { error: 'content_hash required when success=true (64-char hex)' },
  });
  assert.deepEqual(noVersion, {
    status: 400,
    body: { error: 'expected_version must be a non-negative integer' },
  });
});

test('a pre-read or a Bash read of subject:y keeps no row', async (t) => {
  const door = await openDoor(t, ALL_STRICT, CASELESS);
  const reads = [
    await door.post('/hooks/pre-read', {
      session_id: SID_A,
      path: 'subject:y',
      content_hash: HASH_1,
    }),
    await door.post('/hooks/pre-bash', { session_id: SID_A, command: 'cat subject:y' }),
    // Ordinary names on the same routes keep rows, so an empty store is not vacuous.
    await door.post('/hooks/pre-read', {
      session_id: SID_A,
      path: 'notes.md',
      content_hash: HASH_1,
    }),
    await door.post('/hooks/pre-bash', { session_id: SID_A, command: 'cat plan.md' }),
  ];

  assert.deepEqual(
    reads.map((answer) => answer.status),
    [200, 200, 200, 200]
  );
  assert.deepEqual(rowNames(door), ['notes.md', 'plan.md']);
});

test('the policy reads a file under subject: as untracked and not strict, and a key as before', (t) => {
  const root = makeWorkspace(t, ALL_STRICT);
  const policy = PolicyRef.load(root);
  const caselessFile: PolicyMatchContext = { profile: 'caseless', kind: 'file' };
  const unfoldedFile: PolicyMatchContext = { profile: 'none', kind: 'file' };
  const key: PolicyMatchContext = { profile: 'caseless', kind: 'key' };
  const readings = (name: string, context: PolicyMatchContext): [boolean, boolean] => [
    policy.isTracked(name, context),
    policy.isStrictMode(name, context),
  ];

  for (const name of ['subject:x', './subject:x', 'Subject:x', 'SUBJECT:x', 'subject:']) {
    assert.deepEqual(readings(name, caselessFile), [false, false], name);
  }
  assert.deepEqual(readings('subject:x', unfoldedFile), [false, false]);
  assert.deepEqual(readings('Subject:x', unfoldedFile), [true, true]);
  assert.deepEqual(readings('docs/subject:x', caselessFile), [true, true]);
  assert.deepEqual(readings('subject:x', key), [true, true]);
});

test('a real coordinator refuses subject:x on pre-edit', async (t) => {
  const root = makeWorkspace(t, ALL_STRICT);
  const coordinator = startCoordinator(root);
  try {
    await serving(root, coordinator);
    const port = Number(
      readFileSync(join(root, '.coherence', 'server.pid'), 'utf8').split('\n')[1]
    );
    const secret = readFileSync(join(root, '.coherence', 'hook.secret'), 'utf8').trim();
    const answer = await post(port, secret, '/hooks/pre-edit', {
      session_id: SID_A,
      path: 'subject:x',
    });
    assert.deepEqual(answer, { status: 400, body: SUBJECT_UNSUPPORTED }, coordinator.stderr());
  } finally {
    await killAndWait(coordinator.child);
  }
});
