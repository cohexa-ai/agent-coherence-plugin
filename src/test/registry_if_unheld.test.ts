/**
 * registry.acquireExclusiveIfUnheld — the opted-in pre-edit's check and
 * grant in one transaction, and the 30-minute reclaim.
 *
 * Ticks are explicit: every call passes `nowTick`, so the 1799 / 1800 s
 * boundary needs no clock mock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { v5 as uuidv5 } from "uuid";
import { ArtifactRegistry } from "../registry.js";
import { MESIState } from "../states.js";
import { MAX_HOLD_SEC, RECLAMATION_PREEMPTER_ID } from "../acquire_or_fail.js";

const AGENT_A = "a".repeat(32);
const AGENT_B = "b".repeat(32);
const AGENT_C = "c".repeat(32);
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const T = 1_000_000;

interface Fixture {
  registry: ArtifactRegistry;
  id: string;
  raw: Database;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "if-unheld-test-"));
  const dbPath = join(tmp, "state.db");
  const registry = new ArtifactRegistry(dbPath);
  const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
  const raw = new BetterSqlite3(dbPath);
  return {
    registry,
    id,
    raw,
    cleanup: () => {
      raw.close();
      registry.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Rows that a refusal must leave byte-for-byte as they were. */
function snapshot(raw: Database, artifactId: string): unknown {
  return {
    states: raw
      .prepare(`SELECT * FROM agent_states WHERE artifact_id = ? ORDER BY agent_id`)
      .all(artifactId),
    notices: raw.prepare(`SELECT * FROM pending_notices ORDER BY agent_id, artifact_id`).all(),
    artifact: raw.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(artifactId),
  };
}

/** Row changes the registry's own connection makes inside `fn`. */
function rowChanges(registry: ArtifactRegistry, fn: () => void): number {
  const db = (registry as unknown as { db: Database }).db;
  const read = (): number =>
    (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;
  const before = read();
  fn();
  return read() - before;
}

function reclaimSlot(
  raw: Database,
  artifactId: string,
  agentId: string,
): { trigger: string | null; tick: number | null } {
  const row = raw
    .prepare(
      `SELECT last_reclaim_trigger AS trigger, last_reclaim_tick AS tick
       FROM agent_states WHERE artifact_id = ? AND agent_id = ?`,
    )
    .get(artifactId, agentId) as { trigger: string | null; tick: number | null };
  return row;
}

/** Store-wide facts every test here must leave true. */
function assertStoreInvariants(raw: Database): void {
  const writers = raw
    .prepare(
      `SELECT artifact_id, COUNT(*) AS n FROM agent_states
       WHERE state IN ('MODIFIED', 'EXCLUSIVE') GROUP BY artifact_id HAVING n > 1`,
    )
    .all();
  assert.deepEqual(writers, [], "at most one writer per artifact");
  const slotOnWriter = raw
    .prepare(
      `SELECT agent_id FROM agent_states
       WHERE state IN ('MODIFIED', 'EXCLUSIVE') AND last_reclaim_trigger IS NOT NULL`,
    )
    .all();
  assert.deepEqual(slotOnWriter, [], "no reclaim record on a writer");
  const writerWithoutTick = raw
    .prepare(
      `SELECT agent_id FROM agent_states
       WHERE state IN ('MODIFIED', 'EXCLUSIVE') AND granted_at_tick IS NULL`,
    )
    .all();
  assert.deepEqual(writerWithoutTick, [], "every writer has a grant tick");
  const halfSlot = raw
    .prepare(
      `SELECT agent_id FROM agent_states
       WHERE (last_reclaim_trigger IS NULL) != (last_reclaim_tick IS NULL)`,
    )
    .all();
  assert.deepEqual(halfSlot, [], "reclaim trigger and tick are set together");
}

test("the reclamation preempter id is the sweep's uuid5", () => {
  const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
  const derived = uuidv5("ccs-coordinator-sweep:stable-grant-reclamation", NAMESPACE_URL);
  assert.equal(RECLAMATION_PREEMPTER_ID, derived.replace(/-/g, ""));
  assert.equal(RECLAMATION_PREEMPTER_ID, "e91bfe9cc2855071bf958d64a2bde624");
});

test("an EXCLUSIVE holder refuses another agent and nothing changes", () => {
  const f = makeFixture();
  try {
    f.registry.acquireExclusive(f.id, AGENT_A, T);
    const before = snapshot(f.raw, f.id);
    let out: ReturnType<ArtifactRegistry["acquireExclusiveIfUnheld"]> | undefined;
    const changes = rowChanges(f.registry, () => {
      out = f.registry.acquireExclusiveIfUnheld(f.id, AGENT_B, T + 5);
    });
    assert.deepEqual(out, { kind: "other_holder", holderAgentId: AGENT_A });
    assert.equal(changes, 0);
    assert.deepEqual(snapshot(f.raw, f.id), before);
    assertStoreInvariants(f.raw);
  } finally {
    f.cleanup();
  }
});

test("a MODIFIED holder refuses another agent and stays MODIFIED", () => {
  const f = makeFixture();
  try {
    f.registry.acquireExclusive(f.id, AGENT_A, T);
    f.registry.commit(f.id, AGENT_A, HASH_2, T + 1);
    const before = snapshot(f.raw, f.id);
    const out = f.registry.acquireExclusiveIfUnheld(f.id, AGENT_B, T + 5);
    assert.deepEqual(out, { kind: "other_holder", holderAgentId: AGENT_A });
    assert.equal(f.registry.getAgentState(f.id, AGENT_A), MESIState.MODIFIED);
    assert.deepEqual(snapshot(f.raw, f.id), before);
    assertStoreInvariants(f.raw);
  } finally {
    f.cleanup();
  }
});

test("an unheld path is granted EXCLUSIVE with nothing reclaimed", () => {
  const f = makeFixture();
  try {
    const out = f.registry.acquireExclusiveIfUnheld(f.id, AGENT_B, T);
    assert.deepEqual(out, { kind: "granted", reclaimed: null });
    assert.equal(f.registry.getAgentState(f.id, AGENT_B), MESIState.EXCLUSIVE);
    assertStoreInvariants(f.raw);
  } finally {
    f.cleanup();
  }
});

test("the holder's own call is granted and keeps EXCLUSIVE or MODIFIED", () => {
  const f = makeFixture();
  try {
    f.registry.acquireExclusive(f.id, AGENT_A, T);
    assert.deepEqual(f.registry.acquireExclusiveIfUnheld(f.id, AGENT_A, T + 1), {
      kind: "granted",
      reclaimed: null,
    });
    assert.equal(f.registry.getAgentState(f.id, AGENT_A), MESIState.EXCLUSIVE);
    f.registry.commit(f.id, AGENT_A, HASH_2, T + 2);
    assert.deepEqual(f.registry.acquireExclusiveIfUnheld(f.id, AGENT_A, T + 3), {
      kind: "granted",
      reclaimed: null,
    });
    assert.equal(f.registry.getAgentState(f.id, AGENT_A), MESIState.MODIFIED);
    assertStoreInvariants(f.raw);
  } finally {
    f.cleanup();
  }
});

test("over SHARED readers only, the caller is granted and readers go INVALID with no notice", () => {
  const f = makeFixture();
  try {
    f.registry.grantShared(f.id, AGENT_A, T);
    f.registry.grantShared(f.id, AGENT_C, T);
    const out = f.registry.acquireExclusiveIfUnheld(f.id, AGENT_B, T + 1);
    assert.deepEqual(out, { kind: "granted", reclaimed: null });
    assert.equal(f.registry.getAgentState(f.id, AGENT_A), MESIState.INVALID);
    assert.equal(f.registry.getAgentState(f.id, AGENT_C), MESIState.INVALID);
    assert.deepEqual(f.registry.peekPendingNoticesForAgent(AGENT_A), []);
    assert.deepEqual(f.registry.peekPendingNoticesForAgent(AGENT_C), []);
    assertStoreInvariants(f.raw);
  } finally {
    f.cleanup();
  }
});

test("a holder 1799 s old refuses; at 1800 s it is reclaimed and the caller granted", () => {
  const f = makeFixture();
  try {
    assert.equal(MAX_HOLD_SEC, 1800);
    f.registry.acquireExclusive(f.id, AGENT_A, T);
    let early: ReturnType<ArtifactRegistry["acquireExclusiveIfUnheld"]> | undefined;
    const earlyChanges = rowChanges(f.registry, () => {
      early = f.registry.acquireExclusiveIfUnheld(f.id, AGENT_B, T + 1799);
    });
    assert.deepEqual(early, { kind: "other_holder", holderAgentId: AGENT_A });
    assert.equal(earlyChanges, 0);

    const out = f.registry.acquireExclusiveIfUnheld(f.id, AGENT_B, T + 1800);
    assert.deepEqual(out, { kind: "granted", reclaimed: { agentId: AGENT_A, heldForSec: 1800 } });
    assert.equal(f.registry.getAgentState(f.id, AGENT_A), MESIState.INVALID);
    assert.equal(f.registry.getAgentState(f.id, AGENT_B), MESIState.EXCLUSIVE);
    assert.deepEqual(reclaimSlot(f.raw, f.id, AGENT_A), {
      trigger: "reclaim_max_hold",
      tick: T + 1800,
    });
    assert.deepEqual(f.registry.peekPendingNoticesForAgent(AGENT_A), [
      { artifactId: f.id, preempterAgentId: RECLAMATION_PREEMPTER_ID, preemptedAtUnixTs: T + 1800 },
    ]);
    assertStoreInvariants(f.raw);
  } finally {
    f.cleanup();
  }
});

test("the reclaim notice replaces an older notice queued for the same path", () => {
  const f = makeFixture();
  try {
    f.registry.acquireExclusive(f.id, AGENT_A, T);
    f.registry.acquireExclusive(f.id, AGENT_C, T + 1); // A preempted by C, notice queued
    f.registry.acquireExclusive(f.id, AGENT_A, T + 2); // A holds again, notice still queued
    const out = f.registry.acquireExclusiveIfUnheld(f.id, AGENT_B, T + 2 + 1800);
    assert.equal(out.kind, "granted");
    assert.deepEqual(f.registry.peekPendingNoticesForAgent(AGENT_A), [
      {
        artifactId: f.id,
        preempterAgentId: RECLAMATION_PREEMPTER_ID,
        preemptedAtUnixTs: T + 2 + 1800,
      },
    ]);
    assertStoreInvariants(f.raw);
  } finally {
    f.cleanup();
  }
});

test("a holder with no recorded grant tick is never reclaimed", () => {
  const f = makeFixture();
  try {
    f.registry.acquireExclusive(f.id, AGENT_A, T);
    f.raw
      .prepare(`UPDATE agent_states SET granted_at_tick = NULL WHERE artifact_id = ? AND agent_id = ?`)
      .run(f.id, AGENT_A);
    const before = snapshot(f.raw, f.id);
    const out = f.registry.acquireExclusiveIfUnheld(f.id, AGENT_B, T + 1_000_000);
    assert.deepEqual(out, { kind: "other_holder", holderAgentId: AGENT_A });
    assert.deepEqual(snapshot(f.raw, f.id), before);
  } finally {
    f.cleanup();
  }
});

test("the reclaim record survives a re-read and its invalidation, and clears on the next write grant", () => {
  const f = makeFixture();
  try {
    f.registry.acquireExclusive(f.id, AGENT_A, T);
    f.registry.acquireExclusiveIfUnheld(f.id, AGENT_B, T + 1800);
    const reclaimed = { trigger: "reclaim_max_hold", tick: T + 1800 };
    f.registry.invalidate(f.id, AGENT_B, T + 1801, "session_stop");

    f.registry.grantShared(f.id, AGENT_A, T + 1802);
    assert.deepEqual(reclaimSlot(f.raw, f.id, AGENT_A), reclaimed);

    const cas = f.registry.commitCas(f.id, AGENT_C, 1, HASH_2, T + 1803);
    assert.equal(cas.kind, "win");
    assert.equal(f.registry.getAgentState(f.id, AGENT_A), MESIState.INVALID);
    assert.deepEqual(reclaimSlot(f.raw, f.id, AGENT_A), reclaimed);

    f.registry.acquireExclusive(f.id, AGENT_A, T + 1804);
    assert.deepEqual(reclaimSlot(f.raw, f.id, AGENT_A), { trigger: null, tick: null });
    assertStoreInvariants(f.raw);
  } finally {
    f.cleanup();
  }
});

test("ordinary releases never write a reclaim record", () => {
  const f = makeFixture();
  try {
    const empty = { trigger: null, tick: null };
    f.registry.acquireExclusive(f.id, AGENT_A, T);
    f.registry.acquireExclusive(f.id, AGENT_C, T + 1); // A displaced by an ordinary acquire
    assert.deepEqual(reclaimSlot(f.raw, f.id, AGENT_A), empty);
    f.registry.invalidate(f.id, AGENT_C, T + 2, "session_stop");
    assert.deepEqual(reclaimSlot(f.raw, f.id, AGENT_C), empty);
    f.registry.acquireExclusive(f.id, AGENT_B, T + 3);
    f.registry.invalidate(f.id, AGENT_B, T + 4, "post_edit_failure");
    assert.deepEqual(reclaimSlot(f.raw, f.id, AGENT_B), empty);
    assertStoreInvariants(f.raw);
  } finally {
    f.cleanup();
  }
});
