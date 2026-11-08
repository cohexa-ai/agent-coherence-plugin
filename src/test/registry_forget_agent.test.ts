/**
 * registry.forgetAgent — an identity that has ended leaves the store: its
 * agent_states rows, its heartbeat and its queued notices are deleted in one
 * transaction. Nothing is deleted while it holds a write grant, and a row
 * that carries a reclaim record stays.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { ArtifactRegistry } from '../registry.js';
import { CoherenceError } from '../coherence_error.js';
import { MAX_HOLD_SEC, RECLAIM_MAX_HOLD_TRIGGER } from '../acquire_or_fail.js';
import { MESIState } from '../states.js';

const AGENT_A = 'a'.repeat(32);
const AGENT_B = 'b'.repeat(32);
const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);

interface Fixture {
  registry: ArtifactRegistry;
  raw: Database;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), 'forget-agent-test-'));
  const dbPath = join(tmp, 'state.db');
  const registry = new ArtifactRegistry(dbPath);
  const raw = new BetterSqlite3(dbPath);
  return {
    registry,
    raw,
    cleanup: () => {
      raw.close();
      registry.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function recordHeartbeat(raw: Database, agentId: string, tick: number): void {
  raw.prepare(`INSERT INTO heartbeats (agent_id, last_tick) VALUES (?, ?)`).run(agentId, tick);
}

/** Every row the store keeps for one agent, keyed by table. */
function rowsOf(raw: Database, agentId: string): Record<string, unknown[]> {
  return {
    agent_states: raw
      .prepare(`SELECT * FROM agent_states WHERE agent_id = ? ORDER BY artifact_id`)
      .all(agentId),
    heartbeats: raw.prepare(`SELECT * FROM heartbeats WHERE agent_id = ?`).all(agentId),
    pending_notices: raw
      .prepare(`SELECT * FROM pending_notices WHERE agent_id = ? ORDER BY artifact_id`)
      .all(agentId),
  };
}

/**
 * A holds SHARED on `read.md` and INVALID on `lost.md`, with the notice B's
 * take of `lost.md` queued for it, and a heartbeat. B holds EXCLUSIVE on
 * `lost.md`, SHARED on `read.md` and a heartbeat.
 */
function seedEndedAgent(f: Fixture): { read: string; lost: string } {
  const read = f.registry.resolveOrRegisterArtifact('read.md', HASH_1);
  const lost = f.registry.resolveOrRegisterArtifact('lost.md', HASH_1);
  f.registry.grantShared(read, AGENT_A, 10);
  f.registry.grantShared(read, AGENT_B, 10);
  f.registry.acquireExclusive(lost, AGENT_A, 11);
  f.registry.acquireExclusive(lost, AGENT_B, 12);
  recordHeartbeat(f.raw, AGENT_A, 12);
  recordHeartbeat(f.raw, AGENT_B, 12);
  return { read, lost };
}

test('forgetting an agent deletes its SHARED and INVALID rows, its heartbeat and its notices', () => {
  const f = makeFixture();
  try {
    const { read, lost } = seedEndedAgent(f);
    assert.equal(f.registry.getAgentState(lost, AGENT_A), MESIState.INVALID);
    assert.equal(f.registry.peekPendingNoticesForAgent(AGENT_A).length, 1);

    assert.equal(f.registry.forgetAgent(AGENT_A), 2);

    assert.deepEqual(rowsOf(f.raw, AGENT_A), {
      agent_states: [],
      heartbeats: [],
      pending_notices: [],
    });
    assert.equal(f.registry.getAgentState(read, AGENT_A), null);
    assert.equal(f.registry.getAgentState(lost, AGENT_A), null);
  } finally {
    f.cleanup();
  }
});

test("forgetting an agent leaves every other agent's rows, including a notice it caused", () => {
  const f = makeFixture();
  try {
    seedEndedAgent(f);
    // B loses `taken.md` to A, so B's queued notice names A as the preempter.
    const taken = f.registry.resolveOrRegisterArtifact('taken.md', HASH_1);
    f.registry.acquireExclusive(taken, AGENT_B, 13);
    f.registry.acquireExclusive(taken, AGENT_A, 14);
    f.registry.releaseToReader(taken, AGENT_A, 15);
    const peerBefore = rowsOf(f.raw, AGENT_B);
    assert.equal(peerBefore.pending_notices.length, 1);

    assert.equal(f.registry.forgetAgent(AGENT_A), 3);

    assert.deepEqual(rowsOf(f.raw, AGENT_B), peerBefore);
  } finally {
    f.cleanup();
  }
});

for (const writer of [MESIState.EXCLUSIVE, MESIState.MODIFIED]) {
  test(`forgetting an agent with a row in ${writer} deletes nothing and is refused`, () => {
    const f = makeFixture();
    try {
      seedEndedAgent(f);
      const held = f.registry.resolveOrRegisterArtifact('held.md', HASH_1);
      f.registry.acquireExclusive(held, AGENT_A, 20);
      if (writer === MESIState.MODIFIED) f.registry.commit(held, AGENT_A, HASH_2, 21);
      assert.equal(f.registry.getAgentState(held, AGENT_A), writer);
      const before = rowsOf(f.raw, AGENT_A);

      assert.throws(
        () => f.registry.forgetAgent(AGENT_A),
        (err: unknown) => {
          assert.ok(err instanceof CoherenceError);
          assert.match(err.message, /^forget_not_allowed: agent=a{32} /);
          return true;
        }
      );

      assert.deepEqual(rowsOf(f.raw, AGENT_A), before);
    } finally {
      f.cleanup();
    }
  });
}

test('a second forget of the same agent deletes nothing and returns 0', () => {
  const f = makeFixture();
  try {
    seedEndedAgent(f);
    assert.equal(f.registry.forgetAgent(AGENT_A), 2);
    const peerBefore = rowsOf(f.raw, AGENT_B);

    assert.equal(f.registry.forgetAgent(AGENT_A), 0);

    assert.deepEqual(rowsOf(f.raw, AGENT_B), peerBefore);
  } finally {
    f.cleanup();
  }
});

test('a row that carries a reclaim record stays when its agent is forgotten', () => {
  const f = makeFixture();
  try {
    const read = f.registry.resolveOrRegisterArtifact('read.md', HASH_1);
    const reclaimed = f.registry.resolveOrRegisterArtifact('reclaimed.md', HASH_1);
    f.registry.grantShared(read, AGENT_A, 10);
    f.registry.acquireExclusive(reclaimed, AGENT_A, 10);
    const outcome = f.registry.acquireExclusiveIfUnheld(reclaimed, AGENT_B, 10 + MAX_HOLD_SEC);
    assert.equal(outcome.kind, 'granted');

    assert.equal(f.registry.forgetAgent(AGENT_A), 1);

    const rows = rowsOf(f.raw, AGENT_A);
    assert.equal(rows.agent_states.length, 1);
    assert.deepEqual(
      f.raw
        .prepare(
          `SELECT artifact_id, state, last_reclaim_trigger, last_reclaim_tick FROM agent_states WHERE agent_id = ?`
        )
        .get(AGENT_A),
      {
        artifact_id: reclaimed,
        state: MESIState.INVALID,
        last_reclaim_trigger: RECLAIM_MAX_HOLD_TRIGGER,
        last_reclaim_tick: 10 + MAX_HOLD_SEC,
      }
    );
    assert.deepEqual(rows.pending_notices, []);
    assert.equal(f.registry.getAgentState(read, AGENT_A), null);
  } finally {
    f.cleanup();
  }
});
