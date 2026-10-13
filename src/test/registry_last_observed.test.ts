/**
 * Unit U5 — per-(agent, artifact) `last_observed_version` (SB-10 R6/R7/R9).
 *
 * Node mirror of the Python coordinator's v6 column (agent-coherence commit
 * 8d5dcfe): migration v4 adds a nullable INTEGER column on `agent_states`;
 * every upsert whose TARGET state is non-INVALID records the artifact's
 * current version in the SAME transaction; a transition TO INVALID preserves
 * the stored value; the commit paths advance the COMMITTER's value to the
 * NEW version; never-observed rows stay NULL (accessor returns null — no
 * 0-sentinel). The post-compaction staleness comparand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPendingMigrations, SCHEMA_USER_VERSION } from "../migrations.js";
import { V1_INITIAL } from "../migrations/v1_initial.js";
import { V2_VALIDATE_PENDING_NOTICES } from "../migrations/v2_validate_pending_notices.js";
import { V3_WATCHDOG_DEADLINE } from "../migrations/v3_watchdog_deadline.js";
import { V4_LAST_OBSERVED } from "../migrations/v4_last_observed.js";
import { ArtifactRegistry } from "../registry.js";
import { MESIState } from "../states.js";

function makeRegistry(): { registry: ArtifactRegistry; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "lov-test-"));
  const registry = new ArtifactRegistry(join(tmp, "state.db"));
  return {
    registry,
    cleanup: () => {
      registry.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function tmpDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lov-mig-"));
  return {
    path: join(dir, "state.db"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

function userVersion(db: Database.Database): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function agentStatesColumns(db: Database.Database): string[] {
  const rows = db.prepare(`PRAGMA table_info(agent_states)`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

const AGENT_A = "a".repeat(32);
const AGENT_B = "b".repeat(32);
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const HASH_3 = "3".repeat(64);

// ------------------------------------------------------------------
// Migration v4 (KTD9)
// ------------------------------------------------------------------

test("fresh db lands last_observed_version and the derived head version", () => {
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);
  try {
    const result = runPendingMigrations(db);
    assert.equal(SCHEMA_USER_VERSION, 5, "MIGRATIONS list must derive head=5");
    assert.equal(result.current, SCHEMA_USER_VERSION);
    assert.equal(userVersion(db), SCHEMA_USER_VERSION);
    assert.ok(
      agentStatesColumns(db).includes("last_observed_version"),
      "agent_states must carry last_observed_version",
    );
  } finally {
    db.close();
    cleanup();
  }
});

test("v4: a v3 db upgrades; upgraded and fresh agent_states columns identical", () => {
  const upgraded = tmpDbPath();
  const fresh = tmpDbPath();
  const upDb = new Database(upgraded.path);
  const freshDb = new Database(fresh.path);
  try {
    // Build an honest v3-origin db by applying the real v1..v3 migrations.
    V1_INITIAL.apply(upDb);
    V2_VALIDATE_PENDING_NOTICES.apply(upDb);
    V3_WATCHDOG_DEADLINE.apply(upDb);
    assert.equal(userVersion(upDb), 3);
    assert.ok(!agentStatesColumns(upDb).includes("last_observed_version"));

    const result = runPendingMigrations(upDb);
    assert.equal(result.applied.length, 2, "v4 and v5 should be pending");
    assert.equal(userVersion(upDb), SCHEMA_USER_VERSION);

    runPendingMigrations(freshDb);
    assert.deepEqual(
      agentStatesColumns(upDb),
      agentStatesColumns(freshDb),
      "ALTER-appended column order must match the fresh path",
    );
  } finally {
    upDb.close();
    freshDb.close();
    upgraded.cleanup();
    fresh.cleanup();
  }
});

// ------------------------------------------------------------------
// Recording (R6 / R7 recording half)
// ------------------------------------------------------------------

test("never-observed pair → null (no 0-sentinel)", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), null);
  } finally {
    cleanup();
  }
});

test("SHARED grant records the artifact's current version", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 1);
  } finally {
    cleanup();
  }
});

test("EXCLUSIVE grant records the artifact's current version", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.acquireExclusive(id, AGENT_A, 10);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 1);
  } finally {
    cleanup();
  }
});

test("transition to INVALID preserves the prior recorded value", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 1);

    // B's write invalidates A — A keeps the last version it actually observed.
    registry.acquireExclusive(id, AGENT_B, 20);
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.INVALID);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 1);

    // B commits v2: the invalidated peer STILL keeps its prior value.
    registry.commit(id, AGENT_B, HASH_2, 30);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 1);
  } finally {
    cleanup();
  }
});

test("invalidate() (Stop-hook release) preserves the prior recorded value", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10);
    registry.invalidate(id, AGENT_A, 20);
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.INVALID);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 1);
  } finally {
    cleanup();
  }
});

test("re-grant after invalidation re-records the (newer) current version", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10);
    registry.acquireExclusive(id, AGENT_B, 20);
    registry.commit(id, AGENT_B, HASH_2, 30); // artifact now v2; A stuck at 1
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 1);

    registry.grantShared(id, AGENT_A, 40); // A re-reads the fresh bytes
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 2);
  } finally {
    cleanup();
  }
});

test("grantShared(observed=false) grants but keeps the prior value; the default still records", () => {
  // Both directions on the very same transition: asserting only the preserve
  // side cannot tell a working flag from a registry that stopped recording.
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10);
    registry.acquireExclusive(id, AGENT_B, 20);
    registry.commit(id, AGENT_B, HASH_2, 30); // v2; A INVALID, observed 1
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.INVALID);

    registry.grantShared(id, AGENT_A, 40, "post_stale_bash", false);
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.SHARED);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 1);

    registry.acquireExclusive(id, AGENT_B, 50); // A INVALID again, still at 1
    registry.grantShared(id, AGENT_A, 60, "post_stale_bash");
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 2);
  } finally {
    cleanup();
  }
});

test("grantShared(observed=false) on a never-observed pair records nothing", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10, "first_bash_read", false);
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.SHARED);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), null);
  } finally {
    cleanup();
  }
});

test("recordObservation credits a SHARED row the deny left behind, and moves nothing else", () => {
  // The row a denied bash leaves: SHARED on v2 with the baseline still at 1.
  // grantShared is a no-op on SHARED, so the retry's read lands only here.
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10);
    registry.acquireExclusive(id, AGENT_B, 20);
    registry.commit(id, AGENT_B, HASH_2, 30); // v2; A INVALID, observed 1
    registry.grantShared(id, AGENT_A, 40, "post_stale_bash", false);

    registry.grantShared(id, AGENT_A, 50, "post_stale_bash");
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 1, "grantShared is a no-op on SHARED");

    assert.equal(registry.recordObservation(id, AGENT_A), true);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 2);
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.SHARED);
    assert.equal(registry.recordObservation(id, AGENT_A), false, "already current: no write");
  } finally {
    cleanup();
  }
});

test("recordObservation credits a never-observed SHARED row with the current version", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10, "first_bash_read", false);
    assert.equal(registry.recordObservation(id, AGENT_A), true);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 1);
  } finally {
    cleanup();
  }
});

test("recordObservation leaves INVALID, EXCLUSIVE and absent rows alone", () => {
  // INVALID: crediting it would restore a grant a peer revoked and clear the
  // stale flag the session has not seen. EXCLUSIVE: a write grant is never
  // rewritten by a read. Absent: there is no grant to credit.
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10);
    registry.acquireExclusive(id, AGENT_B, 20);
    registry.commit(id, AGENT_B, HASH_2, 30); // v2; A INVALID at 1, B MODIFIED
    registry.grantShared(id, AGENT_A, 40, "post_stale_bash", false);
    registry.acquireExclusive(id, AGENT_B, 50); // A INVALID again, still at 1

    assert.equal(registry.recordObservation(id, AGENT_A), false);
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.INVALID);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 1);

    const other = registry.resolveOrRegisterArtifact("notes.md", HASH_1);
    registry.acquireExclusive(other, AGENT_A, 60);
    registry.acquireExclusive(id, AGENT_A, 70);
    assert.equal(registry.getAgentState(other, AGENT_A), MESIState.EXCLUSIVE);
    assert.equal(registry.recordObservation(other, AGENT_A), false);
    assert.equal(registry.getAgentState(other, AGENT_A), MESIState.EXCLUSIVE);

    assert.equal(registry.recordObservation(other, AGENT_B), false);
    assert.equal(registry.getAgentState(other, AGENT_B), null);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------
// Commit paths advance the committer (R6)
// ------------------------------------------------------------------

test("commit (E→M) advances the committer to the NEW version", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.acquireExclusive(id, AGENT_A, 10);
    const { artifact } = registry.commit(id, AGENT_A, HASH_2, 20);
    assert.equal(artifact.version, 2);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 2);
  } finally {
    cleanup();
  }
});

test("repeat commit on a held MODIFIED grant (M→M, no upsert) still advances", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.acquireExclusive(id, AGENT_A, 10);
    registry.commit(id, AGENT_A, HASH_2, 20); // E→M, v2
    const { artifact } = registry.commit(id, AGENT_A, HASH_3, 30); // M→M, v3
    assert.equal(artifact.version, 3);
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.MODIFIED);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 3);
  } finally {
    cleanup();
  }
});

test("commitCas WIN advances an already-SHARED committer (no upsert) to the NEW version", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 1);

    const out = registry.commitCas(id, AGENT_A, 1, HASH_2, 20);
    assert.equal(out.kind, "win");
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.SHARED);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 2);
  } finally {
    cleanup();
  }
});

test("commitCas WIN from an absent committer records the NEW version; losing peers keep theirs", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_B, 10); // B observed v1
    const out = registry.commitCas(id, AGENT_A, 1, HASH_2, 20);
    assert.equal(out.kind, "win");
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 2);
    // B was invalidated by the WIN — its recorded value stays at v1.
    assert.equal(registry.getAgentState(id, AGENT_B), MESIState.INVALID);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_B), 1);
  } finally {
    cleanup();
  }
});

test("commitCas conflict (no mutation) records nothing for the loser", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    assert.equal(registry.commitCas(id, AGENT_A, 1, HASH_2, 10).kind, "win");
    const out = registry.commitCas(id, AGENT_B, 1, HASH_3, 20);
    assert.equal(out.kind, "conflict");
    assert.equal(registry.lastObservedVersionFor(id, AGENT_B), null);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------
// Upgrade into M∪E from an existing row (the clearReclaim UPDATE arm)
// ------------------------------------------------------------------

test("SHARED → EXCLUSIVE upgrade re-records the current version on the existing row", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10); // A observed v1
    registry.commitCas(id, AGENT_B, 1, HASH_2, 20); // peer WIN → v2, A INVALID
    registry.grantShared(id, AGENT_A, 30); // A re-reads the fresh bytes → v2

    // S→E: new ∈ M/E, old ∉ M/E — the clearReclaim UPDATE arm, on a row
    // that already exists (not the INSERT arm the fresh-pair tests cover).
    registry.acquireExclusive(id, AGENT_A, 40);
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.EXCLUSIVE);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 2);
  } finally {
    cleanup();
  }
});

test("INVALID → EXCLUSIVE upgrade advances a stale recorded value to the current version", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10); // A observed v1
    registry.acquireExclusive(id, AGENT_B, 20); // A → INVALID, still recorded at v1
    registry.commit(id, AGENT_B, HASH_2, 30); // v2
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 1);

    // A takes the write grant straight out of INVALID: same clearReclaim
    // arm, and the stale comparand must move to the version A now holds —
    // otherwise the post-compaction walk would flag A against its own read.
    registry.acquireExclusive(id, AGENT_A, 40);
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.EXCLUSIVE);
    assert.equal(registry.lastObservedVersionFor(id, AGENT_A), 2);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------
// Batched read scoping (SB-10 review): `allStateMaps` feeds a HOOK path,
// so it must read the caller's agents — never the whole ledger.
// ------------------------------------------------------------------

test("allStateMaps reads ONLY the requested agents' rows", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10);
    registry.grantShared(id, AGENT_B, 20);

    const inner = registry.allStateMaps([AGENT_A]).get(id);
    assert.ok(inner !== undefined, "the requested agent's artifact must carry an entry");
    assert.deepEqual(
      [...inner.keys()],
      [AGENT_A],
      "a peer session's row must never be read, mapped, or discarded",
    );
    assert.equal(inner.get(AGENT_A)?.lastObserved, 1);
  } finally {
    cleanup();
  }
});

test("allStateMaps omits an artifact only foreign agents ever touched", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const mine = registry.resolveOrRegisterArtifact("mine.md", HASH_1);
    const theirs = registry.resolveOrRegisterArtifact("theirs.md", HASH_2);
    registry.grantShared(mine, AGENT_A, 10);
    registry.grantShared(theirs, AGENT_B, 20);

    const scoped = registry.allStateMaps([AGENT_A]);
    assert.deepEqual([...scoped.keys()], [mine]);
  } finally {
    cleanup();
  }
});

test("allStateMaps with no agents returns an empty map without querying", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10);
    assert.equal(registry.allStateMaps([]).size, 0);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------
// Migration v5 (SB-10 perf follow-up): agent_states(agent_id) index
// ------------------------------------------------------------------

function agentStatesIndexes(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_states' AND name LIKE 'idx_%'`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

test("v5: a fresh db lands idx_agent_states_agent", () => {
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);
  try {
    runPendingMigrations(db);
    assert.deepEqual(agentStatesIndexes(db), ["idx_agent_states_agent"]);
  } finally {
    db.close();
    cleanup();
  }
});

test("v5: a v4-era db (column present, index absent) upgrades and gains the index", () => {
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);
  try {
    V1_INITIAL.apply(db);
    V2_VALIDATE_PENDING_NOTICES.apply(db);
    V3_WATCHDOG_DEADLINE.apply(db);
    V4_LAST_OBSERVED.apply(db);
    assert.equal(userVersion(db), 4);
    assert.deepEqual(agentStatesIndexes(db), []);

    const result = runPendingMigrations(db);
    assert.equal(result.applied.length, 1, "only v5 should be pending");
    assert.equal(userVersion(db), SCHEMA_USER_VERSION);
    assert.deepEqual(agentStatesIndexes(db), ["idx_agent_states_agent"]);
  } finally {
    db.close();
    cleanup();
  }
});

test("the scoped allStateMaps query is index-backed (SEARCH, never SCAN)", () => {
  // Without the index the scope only trims per-row materialization — the
  // page walk over a table nothing garbage-collects still runs on the hook
  // path. Dropping the index later would regress silently (queries stay
  // correct), so the plan itself is pinned.
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_A, 10);
    const db = new Database(
      (registry as unknown as { db: { name: string } }).db.name,
      { readonly: true },
    );
    try {
      const plan = (
        db
          .prepare(
            `EXPLAIN QUERY PLAN SELECT artifact_id, agent_id, state, last_observed_version ` +
              `FROM agent_states WHERE agent_id IN (?, ?)`,
          )
          .all(AGENT_A, AGENT_B) as Array<{ detail: string }>
      )
        .map((r) => r.detail)
        .join(" | ");
      assert.ok(plan.includes("idx_agent_states_agent"), plan);
      assert.ok(!plan.includes("SCAN agent_states"), plan);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

