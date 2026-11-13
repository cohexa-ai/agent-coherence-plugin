/**
 * A fresh pre-read answer for a tracked file carries `version`: the version
 * of the record the read was classified against, so an optimistic writer can
 * send it back as the version it expects (`post-edit-cas`). The library's
 * coordinator answers the same on its first-read and re-read arms. An
 * untracked read still answers `{status: "fresh"}` alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ArtifactRegistry } from '../registry.js';
import { PolicyRef } from '../policy.js';
import { SessionRegistry } from '../sessions.js';
import { createServer } from '../server.js';

const SECRET = 'v'.repeat(32);
const SID_A = '66666666-6666-4666-8666-666666666666';
const SID_B = '77777777-7777-4777-8777-777777777777';
const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);

async function makeServer() {
  const root = mkdtempSync(join(tmpdir(), 'pre-read-version-test-'));
  mkdirSync(join(root, '.coherence'), { recursive: true });
  const registry = new ArtifactRegistry(join(root, '.coherence', 'state.db'));
  const sessions = new SessionRegistry();
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: 'test',
    registry,
    policy: PolicyRef.load(root),
    sessions,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const read = async (sessionId: string, path: string, contentHash: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks/pre-read`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SECRET}`,
        Host: '127.0.0.1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session_id: sessionId, path, content_hash: contentHash }),
    });
    return (await res.json()) as Record<string, unknown>;
  };
  const cleanup = () =>
    new Promise<void>((r) => {
      server.close(() => {
        registry.close();
        rmSync(root, { recursive: true, force: true });
        r();
      });
    });
  return { registry, sessions, read, cleanup };
}

/** Queue a preemption notice for A: A held `other.md` and B took it. */
function queueNoticeForA(registry: ArtifactRegistry, sessions: SessionRegistry): void {
  const other = registry.resolveOrRegisterArtifact('other.md', HASH_1);
  registry.acquireExclusive(other, sessions.registerSession(SID_A), 10);
  registry.acquireExclusive(other, sessions.registerSession(SID_B), 11);
}

/** B writes CLAUDE.md to v2 and hands it back as a reader. */
function commitByB(registry: ArtifactRegistry, sessions: SessionRegistry, id: string): void {
  const agentB = sessions.registerSession(SID_B);
  registry.acquireExclusive(id, agentB, 20);
  registry.commit(id, agentB, HASH_2, 21);
  registry.releaseToReader(id, agentB, 22);
}

test('the first read of a tracked file with no record answers fresh with the version of the record it creates', async () => {
  const { registry, read, cleanup } = await makeServer();
  try {
    assert.equal(registry.getArtifactByName('CLAUDE.md'), null);
    const answer = await read(SID_A, 'CLAUDE.md', HASH_1);
    assert.deepEqual(answer, { status: 'fresh', version: 1 });
    assert.equal(registry.getArtifactByName('CLAUDE.md')?.version, 1);
  } finally {
    await cleanup();
  }
});

test("a re-read with a live grant answers fresh with the record's current version", async () => {
  const { registry, sessions, read, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact('CLAUDE.md', HASH_1);
    commitByB(registry, sessions, id);
    registry.grantShared(id, sessions.registerSession(SID_A), 30);
    assert.deepEqual(await read(SID_A, 'CLAUDE.md', HASH_2), { status: 'fresh', version: 2 });
  } finally {
    await cleanup();
  }
});

test('a first read that drains a queued notice still carries the version', async () => {
  const { registry, sessions, read, cleanup } = await makeServer();
  try {
    queueNoticeForA(registry, sessions);
    const answer = await read(SID_A, 'CLAUDE.md', HASH_1);
    assert.equal(answer.status, 'fresh');
    assert.equal(answer.version, 1);
    const hso = answer.hookSpecificOutput as Record<string, unknown>;
    assert.equal(hso.permissionDecision, 'allow');
    assert.ok(String(hso.additionalContext).includes('other.md'), String(hso.additionalContext));
  } finally {
    await cleanup();
  }
});

test('a re-read that drains a queued notice still carries the version', async () => {
  const { registry, sessions, read, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact('CLAUDE.md', HASH_1);
    commitByB(registry, sessions, id);
    registry.grantShared(id, sessions.registerSession(SID_A), 30);
    queueNoticeForA(registry, sessions);
    const answer = await read(SID_A, 'CLAUDE.md', HASH_2);
    assert.equal(answer.status, 'fresh');
    assert.equal(answer.version, 2);
    const hso = answer.hookSpecificOutput as Record<string, unknown>;
    assert.ok(String(hso.additionalContext).includes('other.md'), String(hso.additionalContext));
  } finally {
    await cleanup();
  }
});

test('an untracked read answers fresh with no version', async () => {
  const { registry, read, cleanup } = await makeServer();
  try {
    assert.deepEqual(await read(SID_A, 'src/untracked.ts', HASH_1), { status: 'fresh' });
    assert.equal(registry.getArtifactByName('src/untracked.ts'), null);
  } finally {
    await cleanup();
  }
});

test("after another session commits, the reader's next answers carry the new version, never the one it read", async () => {
  const { registry, sessions, read, cleanup } = await makeServer();
  try {
    assert.deepEqual(await read(SID_A, 'CLAUDE.md', HASH_1), { status: 'fresh', version: 1 });
    const id = registry.getArtifactByName('CLAUDE.md')!.id;
    commitByB(registry, sessions, id);
    const stale = await read(SID_A, 'CLAUDE.md', HASH_2);
    assert.equal(stale.status, 'stale');
    assert.equal((stale.summary as Record<string, unknown>).current_version, 2);
    assert.deepEqual(await read(SID_A, 'CLAUDE.md', HASH_2), { status: 'fresh', version: 2 });
  } finally {
    await cleanup();
  }
});
