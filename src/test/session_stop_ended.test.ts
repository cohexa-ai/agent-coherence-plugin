/**
 * A session-stop that carries `ended: true` and an `agent_id` reports a
 * `CoherentVolume` attempt that is over: after its grants are released, the
 * coordinator forgets the identity, so its records and its `/status` row go.
 * It forgets nothing while the identity still holds a write grant. A parent
 * Stop and a plain SubagentStop keep every row, as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ArtifactRegistry } from '../registry.js';
import { CoherenceError } from '../coherence_error.js';
import { PolicyRef } from '../policy.js';
import { SessionRegistry } from '../sessions.js';
import { createServer } from '../server.js';
import { sessionToAgentId } from '../agent_id.js';
import { MESIState } from '../states.js';

const SECRET = 's'.repeat(32);
const SID_A = '44444444-4444-4444-8444-444444444444';
const SID_B = '55555555-5555-5555-8555-555555555555';
const ATTEMPT = 'volume-attempt-1';
const SUB = 'a0826622451ec196f';
const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);
const HASH_3 = '3'.repeat(64);
/** Strict mode covers plan.md only; task.md is tracked and warn-only. */
const STRICT = 'plan.md';
const WARN = 'task.md';

async function makeServer() {
  const tmp = mkdtempSync(join(tmpdir(), 'session-stop-ended-test-'));
  mkdirSync(join(tmp, '.coherence'), { recursive: true });
  writeFileSync(join(tmp, '.coherence', 'strict_mode.yaml'), `- ${STRICT}\n`, 'utf8');
  const registry = new ArtifactRegistry(join(tmp, '.coherence', 'state.db'));
  const sessions = new SessionRegistry();
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: 'test',
    registry,
    policy: PolicyRef.load(tmp),
    sessions,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const request = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SECRET}`,
        Host: '127.0.0.1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const post = async (path: string, body: unknown) => (await request(path, body)).body;
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { Authorization: `Bearer ${SECRET}`, Host: '127.0.0.1' },
    });
    return (await res.json()) as Record<string, unknown>;
  };
  const cleanup = () =>
    new Promise<void>((r) => {
      server.close(() => {
        registry.close();
        rmSync(tmp, { recursive: true, force: true });
        r();
      });
    });
  return { registry, sessions, request, post, get, cleanup };
}

type Server = Awaited<ReturnType<typeof makeServer>>;

/** One committed edit: pre-edit, then a successful post-edit with `hash`. */
async function editAndCommit(s: Server, who: Record<string, unknown>, hash: string): Promise<void> {
  assert.equal((await s.post('/hooks/pre-edit', who)).ok, true);
  assert.deepEqual(
    await s.post('/hooks/post-edit', { ...who, success: true, content_hash: hash }),
    { ok: true }
  );
}

function stateOf(s: Server, path: string, agentId: string): MESIState | null {
  return s.registry.getAgentState(s.registry.getArtifactByName(path)!.id, agentId);
}

/** The `/status` row for `agentId`, or undefined when it is not listed. */
async function statusRow(s: Server, agentId: string): Promise<Record<string, unknown> | undefined> {
  const rows = (await s.get('/status')).sessions as Array<Record<string, unknown>>;
  return rows.find((row) => row.agent_id === agentId);
}

function denyReason(body: Record<string, unknown>): string {
  const hso = body.hookSpecificOutput as Record<string, unknown>;
  assert.equal(hso.permissionDecision, 'deny');
  return hso.permissionDecisionReason as string;
}

/** The attempt commits an edit of STRICT and reads WARN. */
async function attemptEditsAndReads(s: Server): Promise<string> {
  const attempt = sessionToAgentId(SID_A, ATTEMPT);
  await editAndCommit(s, { session_id: SID_A, agent_id: ATTEMPT, path: STRICT }, HASH_2);
  const read = await s.post('/hooks/pre-read', {
    session_id: SID_A,
    agent_id: ATTEMPT,
    path: WARN,
    content_hash: HASH_1,
  });
  assert.deepEqual(read, { status: 'fresh', version: 1 });
  return attempt;
}

// ------------------------------------------------------------ an ended attempt is forgotten

test("a stop with ended: true releases the attempt's grants, then forgets its rows and its session entry", async () => {
  const s = await makeServer();
  try {
    const attempt = await attemptEditsAndReads(s);
    const peer = sessionToAgentId(SID_B);
    assert.equal(
      (await s.post('/hooks/pre-edit', { session_id: SID_B, path: 'AGENTS.md' })).ok,
      true
    );
    assert.deepEqual((await statusRow(s, attempt))?.states, {
      [STRICT]: MESIState.MODIFIED,
      [WARN]: MESIState.SHARED,
    });

    const stop = await s.post('/hooks/session-stop', {
      session_id: SID_A,
      agent_id: ATTEMPT,
      ended: true,
    });

    assert.deepEqual(stop, { ok: true, released_artifacts: [STRICT] });
    assert.equal(stateOf(s, STRICT, attempt), null);
    assert.equal(stateOf(s, WARN, attempt), null);
    assert.equal(s.sessions.knownAgentIds().includes(attempt), false);
    assert.equal(s.sessions.agentIdToName(attempt), null);
    assert.equal(await statusRow(s, attempt), undefined);
    assert.deepEqual((await statusRow(s, peer))?.states, { 'AGENTS.md': MESIState.EXCLUSIVE });
    // No cached entry is left behind: the identity registers afresh.
    s.sessions.registerSession(SID_A, ATTEMPT);
    assert.equal(s.sessions.knownAgentIds().includes(attempt), true);
  } finally {
    await s.cleanup();
  }
});

test('a stop with ended: true keeps every row while a release fails and the attempt still holds its grant', async () => {
  const s = await makeServer();
  try {
    const attempt = sessionToAgentId(SID_A, ATTEMPT);
    assert.equal(
      (await s.post('/hooks/pre-edit', { session_id: SID_A, agent_id: ATTEMPT, path: STRICT })).ok,
      true
    );
    await s.post('/hooks/pre-read', {
      session_id: SID_A,
      agent_id: ATTEMPT,
      path: WARN,
      content_hash: HASH_1,
    });
    Object.defineProperty(s.registry, 'releaseToReader', {
      configurable: true,
      value: () => {
        throw new CoherenceError('release refused for the test');
      },
    });

    const stop = await s.post('/hooks/session-stop', {
      session_id: SID_A,
      agent_id: ATTEMPT,
      ended: true,
    });

    assert.deepEqual(stop, { ok: true, released_artifacts: [] });
    assert.equal(stateOf(s, STRICT, attempt), MESIState.EXCLUSIVE);
    assert.equal(stateOf(s, WARN, attempt), MESIState.SHARED);
    assert.equal(s.sessions.knownAgentIds().includes(attempt), true);
    assert.deepEqual((await statusRow(s, attempt))?.states, {
      [STRICT]: MESIState.EXCLUSIVE,
      [WARN]: MESIState.SHARED,
    });
  } finally {
    await s.cleanup();
  }
});

// ------------------------------------------------------------ a malformed end is refused

test('ended that is not a boolean, or is true without an agent_id, answers 400 and releases nothing', async () => {
  const s = await makeServer();
  try {
    const attempt = sessionToAgentId(SID_A, ATTEMPT);
    const parent = sessionToAgentId(SID_A);
    assert.equal(
      (await s.post('/hooks/pre-edit', { session_id: SID_A, agent_id: ATTEMPT, path: STRICT })).ok,
      true
    );
    assert.equal((await s.post('/hooks/pre-edit', { session_id: SID_A, path: WARN })).ok, true);

    for (const ended of ['yes', 1, null, {}]) {
      const stop = await s.request('/hooks/session-stop', {
        session_id: SID_A,
        agent_id: ATTEMPT,
        ended,
      });
      assert.equal(stop.status, 400, `ended ${JSON.stringify(ended)}`);
      assert.deepEqual(stop.body, { error: 'ended must be a boolean' });
    }
    for (const body of [
      { session_id: SID_A, ended: true },
      { session_id: SID_A, agent_id: '', ended: true },
    ]) {
      const stop = await s.request('/hooks/session-stop', body);
      assert.equal(stop.status, 400, JSON.stringify(body));
      assert.deepEqual(stop.body, { error: 'ended requires agent_id' });
    }

    assert.equal(stateOf(s, STRICT, attempt), MESIState.EXCLUSIVE);
    assert.equal(stateOf(s, WARN, parent), MESIState.EXCLUSIVE);
  } finally {
    await s.cleanup();
  }
});

// ------------------------------------------------------------ every other stop keeps the rows

for (const [name, extra] of [
  ['no ended', {}],
  ['ended: false', { ended: false }],
] as const) {
  test(`a stop with ${name} answers as before and keeps the attempt's rows`, async () => {
    const s = await makeServer();
    try {
      const attempt = await attemptEditsAndReads(s);

      const stop = await s.post('/hooks/session-stop', {
        session_id: SID_A,
        agent_id: ATTEMPT,
        ...extra,
      });

      assert.deepEqual(stop, { ok: true, released_artifacts: [STRICT] });
      assert.equal(stateOf(s, STRICT, attempt), MESIState.SHARED);
      assert.equal(stateOf(s, WARN, attempt), MESIState.SHARED);
      assert.equal(s.sessions.knownAgentIds().includes(attempt), true);
      assert.deepEqual((await statusRow(s, attempt))?.states, {
        [STRICT]: MESIState.SHARED,
        [WARN]: MESIState.SHARED,
      });
    } finally {
      await s.cleanup();
    }
  });
}

for (const [name, who] of [
  ['a parent Stop', { session_id: SID_A }],
  ['a plain SubagentStop', { session_id: SID_A, agent_id: SUB }],
] as const) {
  test(`after ${name}, a peer's commit of a strict file the stopped identity read still denies its edit`, async () => {
    const s = await makeServer();
    try {
      const read = await s.post('/hooks/pre-read', { ...who, path: STRICT, content_hash: HASH_1 });
      assert.deepEqual(read, { status: 'fresh', version: 1 });
      assert.deepEqual(await s.post('/hooks/session-stop', who), {
        ok: true,
        released_artifacts: [],
      });
      await editAndCommit(s, { session_id: SID_B, path: STRICT }, HASH_3);

      const edit = await s.post('/hooks/pre-edit', { ...who, path: STRICT });

      assert.equal(edit.ok, false);
      assert.match(denyReason(edit), /^Stale read denied: plan\.md was updated by agent /);
    } finally {
      await s.cleanup();
    }
  });
}
