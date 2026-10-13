/**
 * SQLite artifact registry — Node port of the Python coordinator's
 * SqliteArtifactRegistry (src/ccs/coordinator/sqlite_registry.py).
 *
 * v0.1.1 Unit 1 (this commit) lands ONLY the constructor + close():
 * - Open Database at <workspace>/.coherence/state.db
 * - Set PRAGMA journal_mode = WAL (concurrent reader safety)
 * - Set PRAGMA busy_timeout = 1500ms per KTD-K REVISED ordering rule
 *   (busy_timeout is per-lock-acquisition, NOT per-transaction; multi-statement
 *   transactions accumulate budget; 2× lock-acquisitions × 1500ms = 3s ceiling
 *   stays under the 4s handler watchdog with 1s safety margin)
 * - Run pending migrations (empty list in Unit 1; Unit 2 fills)
 * - Provide close() for graceful shutdown
 *
 * NOT in this commit (Unit 2 lands):
 * - register_artifact / fetch / write / commit / invalidate methods
 * - pending_notices table operations
 * - state_log callback wiring
 * - mutation-then-log invariant enforcement (per KTD-A.5 + sqlite_registry.py
 *   "mutation-then-log" docstring)
 *
 * Per KTD-C: state.db lives in the workspace (not ${CLAUDE_PLUGIN_DATA}) because
 * it's per-workspace shared state across coordinator backends, not per-plugin
 * cache. Same path as Python coordinator — KTD-A.5 point 1 mutex + KTD-D
 * forward-compatible schema enable backend coexistence.
 */
import BetterSqlite3, { type Database } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { runPendingMigrations, SCHEMA_USER_VERSION } from "./migrations.js";
import { MESIState, isValidTransition, isWriter } from "./states.js";
import { checkSingleWriter, checkMonotonicVersion } from "./invariants.js";

/** Per KTD-K REVISED: per-lock-acquisition retry budget, NOT per-transaction. */
export const BUSY_TIMEOUT_MS = 1500;

export interface RegistryStats {
  readonly schemaVersion: number;
  readonly migrationsApplied: number;
}

/**
 * Artifact record returned by registry queries. Mirrors Python core/types.py
 * Artifact dataclass for KTD-B wire-equality contract. `id` is UUID hex
 * (no hyphens, lowercase); `name` is parent-repo-relative path.
 */
export interface Artifact {
  /** UUID hex without hyphens — matches Python `Artifact.id.hex`. */
  readonly id: string;
  /** Parent-repo-relative path. UNIQUE in the artifacts table. */
  readonly name: string;
  /** Monotonic version. Bumps on commit (Unit 2 commit 3). */
  readonly version: number;
  /** SHA-256 hex of content at this version. */
  readonly content_hash: string;
  /** Optional token count for diagnostics; null if unknown. */
  readonly size_tokens: number | null;
  /** UUID hex of last agent to commit; null if never written. */
  readonly last_writer_id: string | null;
  /** Coordinator epoch seconds (Date.now() / 1000) of last write. */
  readonly updated_at: number;
}

/**
 * Typed CAS result — Node mirror of Python's `ConflictDetail` / `CasCorruption`
 * / WIN-tuple discrimination (core/types.py). Returned (never thrown) so the
 * route layer maps each outcome to its exact Python wire body:
 * - win        → `{ok: true, version}`
 * - conflict   → `{ok: false, reason, current_version}` (reason matched
 *                EXACTLY by consumers — typed-signal discipline, never substring)
 * - corruption → the service-level `commit_cas_corruption …` error body
 *                (`expected_version > current`; no current_version on the wire)
 */
export type CasOutcome =
  | { kind: "win"; artifact: Artifact; invalidatedPeers: string[] }
  | {
      kind: "conflict";
      reason: "version_mismatch" | "other_holder";
      currentVersion: number;
    }
  | { kind: "corruption"; currentVersion: number };

/**
 * One (artifact, agent) row as the session-start walk needs it: the MESI
 * state plus the recorded last-observed version (null when the pair never
 * observed bytes — absence is NULL, never a 0-sentinel). Batched by
 * `allStateMaps` so the walk never re-queries per pair.
 */
export interface AgentStateSnapshot {
  readonly state: MESIState;
  readonly lastObserved: number | null;
}

// ArtifactRow / rowToArtifact removed (ce-review maintainability finding):
// the SQLite row shape and the Artifact interface were byte-identical;
// the mapper was an identity function. We cast directly to `Artifact` at
// the `.get()`/`.all()` call sites — the `readonly` modifiers on Artifact
// are a TypeScript compile-time constraint that the cast satisfies.

/**
 * Narrow a raw SQLite `state` string to `MESIState`. Throws on unknown values
 * (e.g., a Python transient state string like "ISG" surfacing through a
 * shared state.db). ce-review kieran-typescript finding: replaces the bare
 * `as MESIState` cast with an explicit guard.
 */
function toMESIState(s: string): MESIState {
  switch (s) {
    case MESIState.MODIFIED:
    case MESIState.EXCLUSIVE:
    case MESIState.SHARED:
    case MESIState.INVALID:
      return s;
    default:
      throw new Error(`registry: unknown MESI state from DB: ${s}`);
  }
}

/**
 * UUID hex format used in `artifacts.id`: 32 hex chars, no hyphens, lowercase.
 * Matches Python's `UUID.hex` representation. randomUUID() returns the
 * hyphenated form; we strip + lowercase for storage consistency.
 */
function newArtifactId(): string {
  return randomUUID().replace(/-/g, "").toLowerCase();
}

export class ArtifactRegistry {
  private readonly db: Database;
  private readonly stats: RegistryStats;
  private closed = false;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });

    this.db = new BetterSqlite3(databasePath, { fileMustExist: false });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // foreign_keys = ON matches Python coordinator's _apply_v1_schema setup.
    this.db.pragma("foreign_keys = ON");
    // synchronous = NORMAL matches Python coordinator's sqlite_registry.py:181 —
    // WAL default is NORMAL but Python sets it explicitly; mirror for parity.
    // ce-review safe_auto fix per data-migrations finding 4.
    this.db.pragma("synchronous = NORMAL");

    const result = runPendingMigrations(this.db);
    this.stats = {
      schemaVersion: result.current,
      migrationsApplied: result.applied.length,
    };
  }

  /** Stats from constructor migration run; surfaces in /status diagnostics. */
  getStats(): RegistryStats {
    return this.stats;
  }

  // ------------------------------------------------------------------
  // Artifact registration + lookup (Unit 2 commit 2)
  // ------------------------------------------------------------------

  /**
   * KTD-9 first-observation seeding. Mirrors Python `resolve_or_register`
   * (sqlite_registry.py:818).
   *
   * Atomically: SELECT artifact by name → if found, return its id; otherwise
   * INSERT new artifact at version=1 with the given content_hash. Concurrent
   * first-Reads from two sessions on the same fresh path converge to ONE row:
   * BEGIN IMMEDIATE + UNIQUE constraint on `artifacts.name` absorbs the race;
   * the loser's INSERT raises SqliteError code SQLITE_CONSTRAINT_UNIQUE, which
   * we catch + re-fetch.
   *
   * Returns the artifact's UUID hex id (32 chars, no hyphens, lowercase).
   */
  resolveOrRegisterArtifact(name: string, contentHash: string): string {
    const select = this.db.prepare(`SELECT id FROM artifacts WHERE name = ?`);
    const insert = this.db.prepare(`
      INSERT INTO artifacts (id, name, version, content_hash, size_tokens, last_writer_id, updated_at)
      VALUES (?, ?, 1, ?, NULL, NULL, ?)
    `);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = select.get(name) as { id: string } | undefined;
      if (existing !== undefined) {
        this.db.exec("COMMIT");
        return existing.id;
      }
      const newId = newArtifactId();
      insert.run(newId, name, contentHash, Date.now() / 1000);
      this.db.exec("COMMIT");
      return newId;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      // UNIQUE-on-name race: another caller inserted between our SELECT and
      // INSERT. Re-fetch the winning row. better-sqlite3 surfaces the
      // constraint violation as SqliteError with `code === "SQLITE_CONSTRAINT_UNIQUE"`.
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        const existing = select.get(name) as { id: string } | undefined;
        if (existing !== undefined) {
          return existing.id;
        }
        // Genuine UNIQUE violation that's NOT our name race; re-throw.
      }
      throw err;
    }
  }

  /** Return artifact metadata by id, or null if unknown. */
  getArtifactById(id: string): Artifact | null {
    const row = this.db
      .prepare(`SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts WHERE id = ?`)
      .get(id) as Artifact | undefined;
    return row ?? null;
  }

  /** Return artifact metadata by name (parent-repo-relative path), or null. */
  getArtifactByName(name: string): Artifact | null {
    const row = this.db
      .prepare(`SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts WHERE name = ?`)
      .get(name) as Artifact | undefined;
    return row ?? null;
  }

  /** Cheap existence check; cheaper than getArtifactById when only presence matters. */
  hasArtifact(id: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM artifacts WHERE id = ?`).get(id);
    return row !== undefined;
  }

  /** Return all known artifact ids (UUID hex). Order is unspecified. */
  listArtifactIds(): string[] {
    const rows = this.db.prepare(`SELECT id FROM artifacts`).all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Return all known artifacts. Order is unspecified. */
  listArtifacts(): Artifact[] {
    return this.db
      .prepare(`SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts`)
      .all() as Artifact[];
  }

  // ------------------------------------------------------------------
  // MESI write-path (Unit 2 commit 3)
  // ------------------------------------------------------------------

  /**
   * Return per-agent MESI state map for an artifact. Returns empty map if
   * no agent has ever touched it. Mirrors Python `get_state_map`.
   */
  getStateMap(artifactId: string): Map<string, MESIState> {
    const rows = this.db
      .prepare(`SELECT agent_id, state FROM agent_states WHERE artifact_id = ?`)
      .all(artifactId) as { agent_id: string; state: string }[];
    const map = new Map<string, MESIState>();
    for (const r of rows) {
      map.set(r.agent_id, toMESIState(r.state));
    }
    return map;
  }

  /**
   * Per-agent state snapshots for `agentIds` across every artifact they
   * have touched, in one SELECT — the batched form of `getStateMap` for
   * the session-start builder's all-artifacts walk (N per-artifact SELECTs
   * collapse to one). Carries `last_observed_version` in the SAME row so
   * the walk's staleness test never re-prepares `lastObservedVersionFor`
   * per INVALID pair. An artifact none of these agents touched has no outer
   * entry; consumers tolerate the missing entry.
   *
   * Scoped to the caller's agents on purpose (SB-10 review): this runs on
   * the session-start hook path — twice per compaction, synchronously, on
   * a table nothing ever garbage-collects — while the only rows the walk
   * can render belong to the requesting session's parent and subagents. An
   * unfiltered read would load the workspace's entire coordination history
   * to discard all but a handful of rows, and better-sqlite3 being
   * synchronous, it would block every other session's hooks while doing so.
   *
   * The predicate is NOT index-backed: `agent_states` is keyed
   * `(artifact_id, agent_id)` and nothing indexes `agent_id` alone, so
   * SQLite still walks the table either way (`EXPLAIN QUERY PLAN` reports
   * `SCAN` for both forms). What the scope removes is the per-row cost —
   * one JS object plus a Map insert for every row the caller would then
   * throw away. Measured on a 500k-row table with a four-agent session:
   * 990ms unscoped, 94ms scoped. An index on `agent_id` would turn the
   * remaining constant into a bound, but it needs a migration in BOTH
   * backends (a Node-only `user_version` bump trips the cross-runtime
   * schema guard), so it is deliberately not done here.
   */
  allStateMaps(agentIds: readonly string[]): Map<string, Map<string, AgentStateSnapshot>> {
    const byArtifact = new Map<string, Map<string, AgentStateSnapshot>>();
    if (agentIds.length === 0) return byArtifact;
    const placeholders = agentIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT artifact_id, agent_id, state, last_observed_version FROM agent_states ` +
          `WHERE agent_id IN (${placeholders})`,
      )
      .all(...agentIds) as {
      artifact_id: string;
      agent_id: string;
      state: string;
      last_observed_version: number | null;
    }[];
    for (const r of rows) {
      let inner = byArtifact.get(r.artifact_id);
      if (inner === undefined) {
        inner = new Map<string, AgentStateSnapshot>();
        byArtifact.set(r.artifact_id, inner);
      }
      inner.set(r.agent_id, {
        state: toMESIState(r.state),
        lastObserved: r.last_observed_version,
      });
    }
    return byArtifact;
  }

  /** Return one agent's MESI state for an artifact, or null if no row exists. */
  getAgentState(artifactId: string, agentId: string): MESIState | null {
    const row = this.db
      .prepare(`SELECT state FROM agent_states WHERE artifact_id = ? AND agent_id = ?`)
      .get(artifactId, agentId) as { state: string } | undefined;
    return row === undefined ? null : toMESIState(row.state);
  }

  /**
   * Return the artifact version whose bytes this agent last observed (SB-10
   * R6/R7: recorded atomically with every non-INVALID grant/commit upsert),
   * or null when the pair was never observed — absence is NULL, never a
   * 0-sentinel, and a transition to INVALID preserved the prior recorded
   * value. The post-compaction staleness comparand. Mirrors Python
   * `last_observed_version_for` (sqlite_registry.py).
   */
  lastObservedVersionFor(artifactId: string, agentId: string): number | null {
    const row = this.db
      .prepare(`SELECT last_observed_version FROM agent_states WHERE artifact_id = ? AND agent_id = ?`)
      .get(artifactId, agentId) as { last_observed_version: number | null } | undefined;
    return row === undefined ? null : row.last_observed_version;
  }

  /**
   * Acquire EXCLUSIVE for `agentId` on `artifactId`, invalidating any peers
   * currently in M / E / S. Mirrors Python `CoordinatorService.write`
   * (service.py:164) collapsed into a single registry-level transaction
   * (per KTD-10 MESI subset: no transient states, no event bus).
   *
   * Side effects (all in one BEGIN IMMEDIATE):
   * - For each peer in {M, E, S}: UPSERT agent_states to INVALID. A peer that
   *   was M or E lost a write grant, so it also gets a pending_notice with
   *   `agentId` as preempter and `nowUnixTs`; an S peer gets none (as Python's
   *   pre-edit queues notices only for `_peers_in_me_excluding`).
   * - UPSERT agent_states[agentId] to EXCLUSIVE; stamp granted_at_tick.
   * - checkSingleWriter on the post-mutation state map → rollback if
   *   violated.
   *
   * Returns the list of peer agent_ids that were invalidated (empty if no
   * peers held the artifact). Caller uses this for `additionalContext`
   * warning emission downstream.
   */
  acquireExclusive(artifactId: string, agentId: string, nowTick: number): string[] {
    if (!this.hasArtifact(artifactId)) {
      throw new Error(`acquireExclusive: artifact ${artifactId} not registered`);
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stateMap = this.getStateMap(artifactId);
      const invalidatedPeers: string[] = [];

      for (const [peerId, peerState] of stateMap) {
        if (peerId === agentId) continue;
        if (peerState === MESIState.INVALID) continue;
        if (!isValidTransition(peerState, MESIState.INVALID)) {
          throw new Error(
            `acquireExclusive: peer ${peerId} in ${peerState} cannot transition to INVALID`,
          );
        }
        this.setAgentStateInternal(artifactId, peerId, peerState, MESIState.INVALID, nowTick, "write");
        // A reader lost no write grant; its next read is warned stale instead.
        if (isWriter(peerState)) {
          this.upsertPendingNotice(peerId, artifactId, agentId, nowTick);
        }
        invalidatedPeers.push(peerId);
      }

      const priorAgentState = stateMap.get(agentId) ?? MESIState.INVALID;
      if (priorAgentState !== MESIState.EXCLUSIVE && priorAgentState !== MESIState.MODIFIED) {
        if (!isValidTransition(priorAgentState, MESIState.EXCLUSIVE)) {
          throw new Error(
            `acquireExclusive: ${agentId} transition ${priorAgentState}→EXCLUSIVE not allowed`,
          );
        }
        this.setAgentStateInternal(
          artifactId,
          agentId,
          priorAgentState,
          MESIState.EXCLUSIVE,
          nowTick,
          "write",
        );
      }

      // Verify single-writer in same txn so violation rolls back.
      const postMap = this.getStateMap(artifactId);
      checkSingleWriter(postMap);

      this.db.exec("COMMIT");
      return invalidatedPeers;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      throw err;
    }
  }

  /**
   * Commit a new content_hash + bump version. Caller MUST hold EXCLUSIVE or
   * MODIFIED on the artifact (verified inside the BEGIN IMMEDIATE).
   *
   * Mirrors Python `CoordinatorService.commit` (service.py:216), collapsed
   * into one transaction per KTD-10.
   *
   * Side effects (all in one BEGIN IMMEDIATE):
   * - Verify agent_states[agentId] ∈ {EXCLUSIVE, MODIFIED}; raise otherwise
   * - Bump artifacts.version (monotonicity invariant check)
   * - Update artifacts.content_hash, last_writer_id, updated_at
   * - For each peer ≠ agentId in {S}: UPSERT agent_states to INVALID, with no
   *   pending_notice: a reader held no write grant to lose (any M/E peers
   *   would already be INVALID via acquireExclusive — they don't recur)
   * - UPSERT agent_states[agentId] to MODIFIED
   * - checkSingleWriter
   *
   * Returns the updated Artifact record.
   */
  commit(
    artifactId: string,
    agentId: string,
    newContentHash: string,
    nowTick: number,
    sizeTokens: number | null = null,
  ): { artifact: Artifact; invalidatedPeers: string[] } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const artifactRow = this.db
        .prepare(
          `SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts WHERE id = ?`,
        )
        .get(artifactId) as Artifact | undefined;
      if (artifactRow === undefined) {
        throw new Error(`commit: artifact ${artifactId} not registered`);
      }

      const agentState = this.getAgentState(artifactId, agentId);
      if (agentState !== MESIState.EXCLUSIVE && agentState !== MESIState.MODIFIED) {
        throw new Error(
          `commit_not_allowed: agent=${agentId} artifact=${artifactId} state=${agentState ?? "INVALID"} ` +
            `(must be EXCLUSIVE or MODIFIED to commit)`,
        );
      }

      const nextVersion = artifactRow.version + 1;
      checkMonotonicVersion(artifactRow.version, nextVersion);

      const updatedAt = Date.now() / 1000;
      this.db
        .prepare(
          `UPDATE artifacts
             SET version = ?, content_hash = ?, size_tokens = COALESCE(?, size_tokens),
                 last_writer_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(nextVersion, newContentHash, sizeTokens, agentId, updatedAt, artifactId);

      // Invalidate every peer. Each is a reader: the caller holds the write
      // grant (checked above), and every transition that grants one runs
      // checkSingleWriter, so no other M/E peer can exist here. That is why
      // none is queued a preemption notice. (A stray writer would NOT be
      // caught by the post-commit check below: this loop invalidates it first.)
      const stateMap = this.getStateMap(artifactId);
      const invalidatedPeers: string[] = [];
      for (const [peerId, peerState] of stateMap) {
        if (peerId === agentId) continue;
        if (peerState === MESIState.INVALID) continue;
        if (!isValidTransition(peerState, MESIState.INVALID)) {
          throw new Error(
            `commit: peer ${peerId} in ${peerState} cannot transition to INVALID`,
          );
        }
        this.setAgentStateInternal(artifactId, peerId, peerState, MESIState.INVALID, nowTick, "commit");
        invalidatedPeers.push(peerId);
      }

      // Transition agent E → M (or M → M no-op). SB-10 R6/R7: the committer
      // produced (and therefore observed) the new version's bytes — the
      // upsert records nextVersion as its last_observed_version in this same
      // txn; invalidated peers above keep their prior value.
      if (agentState === MESIState.EXCLUSIVE) {
        this.setAgentStateInternal(
          artifactId,
          agentId,
          agentState,
          MESIState.MODIFIED,
          nowTick,
          "commit",
          nextVersion,
        );
      } else {
        // Already MODIFIED — a repeat commit on a held grant skips the
        // upsert, so advance last_observed_version directly.
        this.touchLastObservedVersion(artifactId, agentId, nextVersion);
      }

      // Single-writer invariant on post-state. Must hold post-mutation.
      const postMap = this.getStateMap(artifactId);
      checkSingleWriter(postMap);

      // Re-fetch the updated artifact row for the return value.
      const updatedRow = this.db
        .prepare(
          `SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts WHERE id = ?`,
        )
        .get(artifactId) as Artifact;

      this.db.exec("COMMIT");
      return { artifact: updatedRow, invalidatedPeers };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      throw err;
    }
  }

  /**
   * Optimistic-concurrency compare-and-swap commit. Node port of Python
   * `sqlite_registry.commit_cas` + the service-layer D4 preconditions
   * (`service._commit_cas_impl`), collapsed into one registry method per the
   * KTD-10 pattern (no separate service layer on Node).
   *
   * Discrimination order mirrors Python's wire outcome exactly:
   * 1. artifact missing → throw (route maps to an error body)
   * 2. caller in M/E → throw `commit_cas_not_allowed … occ_is_shared_or_invalid_only`
   *    (the D4 precondition: an acquired pessimistic writer must use commit()).
   *    SHARED **and INVALID** callers are admitted — same as Python.
   * 3. expected_version > current → `corruption` (no mutation) — the service
   *    wraps this as a verbose CoherenceError; the route mirrors that body.
   * 4. expected_version < current → `version_mismatch` (no mutation)
   * 5. version matches, another agent holds M/E → `other_holder` (no mutation)
   * 6. WIN: version+1, content_hash/last_writer_id/updated_at updated
   *    (size_tokens preserved on null), committer S/I → SHARED (an OCC writer
   *    never acquired a grant, so SHARED is the honest end-state and keeps a
   *    repeat commit_cas eligible), every non-INVALID peer → INVALID with no
   *    pending notice (each is a reader), single-writer re-checked.
   *
   * Parity notes (plan §Review corrections, decision A):
   * - `caller_in_transient_state` is STRUCTURALLY UNREACHABLE on Node: the
   *   MESI subset has no transient states (invalidation is instantaneous), so
   *   the mid-transient window the Python precondition guards cannot exist.
   * - `stale_read_generation` is STRUCTURALLY UNREACHABLE on Node: the Node
   *   schema has no read_generation/owner_generation columns — those are
   *   foreign-Python-ledger markers that the cross-runtime migration guard
   *   fails closed on (migrations.ts), so a fence claim can never be present
   *   in a Node-owned state.db.
   */
  commitCas(
    artifactId: string,
    agentId: string,
    expectedVersion: number,
    newContentHash: string,
    nowTick: number,
    sizeTokens: number | null = null,
  ): CasOutcome {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const artifactRow = this.db
        .prepare(`SELECT version FROM artifacts WHERE id = ?`)
        .get(artifactId) as { version: number } | undefined;
      if (artifactRow === undefined) {
        throw new Error(`commitCas: artifact ${artifactId} not registered`);
      }
      const current = artifactRow.version;

      // D4 precondition (Python service layer): an EXCLUSIVE/MODIFIED holder
      // is a pessimistic writer and must use commit(). Checked before the
      // version discrimination to match Python's wire outcome for an M/E
      // caller with a mismatched version.
      const callerState = this.getAgentState(artifactId, agentId);
      if (callerState === MESIState.EXCLUSIVE || callerState === MESIState.MODIFIED) {
        throw new Error(
          `commit_cas_not_allowed agent=${agentId} artifact=${artifactId} ` +
            `state=${callerState} reason=occ_is_shared_or_invalid_only ` +
            `(use commit() for an EXCLUSIVE/MODIFIED holder)`,
        );
      }

      if (expectedVersion > current) {
        this.db.exec("COMMIT");
        return { kind: "corruption", currentVersion: current };
      }
      if (expectedVersion < current) {
        this.db.exec("COMMIT");
        return { kind: "conflict", reason: "version_mismatch", currentVersion: current };
      }
      // Version matches. A *pessimistic* M/E peer blocks the OCC win.
      const otherHolder = this.db
        .prepare(
          `SELECT 1 FROM agent_states
           WHERE artifact_id = ? AND agent_id != ? AND state IN (?, ?)
           LIMIT 1`,
        )
        .get(artifactId, agentId, MESIState.MODIFIED, MESIState.EXCLUSIVE);
      if (otherHolder !== undefined) {
        this.db.exec("COMMIT");
        return { kind: "conflict", reason: "other_holder", currentVersion: current };
      }

      // ---- WIN: mutate atomically ----
      const nextVersion = current + 1;
      checkMonotonicVersion(current, nextVersion);
      this.db
        .prepare(
          `UPDATE artifacts
             SET version = ?, content_hash = ?, size_tokens = COALESCE(?, size_tokens),
                 last_writer_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(nextVersion, newContentHash, sizeTokens, agentId, Date.now() / 1000, artifactId);

      // Invalidate every non-INVALID peer (SHARED readers; M/E was excluded
      // above). No preemption notice — same shape as commit().
      const stateMap = this.getStateMap(artifactId);
      const invalidatedPeers: string[] = [];
      for (const [peerId, peerState] of stateMap) {
        if (peerId === agentId) continue;
        if (peerState === MESIState.INVALID) continue;
        if (!isValidTransition(peerState, MESIState.INVALID)) {
          throw new Error(`commitCas: peer ${peerId} in ${peerState} cannot transition to INVALID`);
        }
        this.setAgentStateInternal(artifactId, peerId, peerState, MESIState.INVALID, nowTick, "commit_cas");
        invalidatedPeers.push(peerId);
      }

      // Committer ends SHARED (S no-op; I/absent → SHARED). SB-10 R6/R7
      // (KTD4 first layer): the WIN advances the WRITER's
      // last_observed_version to nextVersion atomically in this txn — it
      // produced (and therefore observed) the new version's bytes; peers
      // going INVALID above keep their prior value.
      const committerState = callerState ?? MESIState.INVALID;
      if (committerState !== MESIState.SHARED) {
        if (!isValidTransition(committerState, MESIState.SHARED)) {
          throw new Error(
            `commitCas: ${agentId} transition ${committerState}→SHARED not allowed`,
          );
        }
        this.setAgentStateInternal(
          artifactId,
          agentId,
          committerState,
          MESIState.SHARED,
          nowTick,
          "commit_cas",
          nextVersion,
        );
      } else {
        // Already-SHARED committer skips the upsert, so advance
        // last_observed_version directly.
        this.touchLastObservedVersion(artifactId, agentId, nextVersion);
      }

      const postMap = this.getStateMap(artifactId);
      checkSingleWriter(postMap);

      const updatedRow = this.db
        .prepare(
          `SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts WHERE id = ?`,
        )
        .get(artifactId) as Artifact;

      this.db.exec("COMMIT");
      return { kind: "win", artifact: updatedRow, invalidatedPeers };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      throw err;
    }
  }

  /**
   * Return the names of all registry-known artifacts whose name starts with
   * `prefix` (empty prefix = all). Used by /hooks/pre-grep to enumerate the
   * tracked artifacts under a search root. Mirrors Python
   * `sqlite_registry.artifact_names_under_prefix`.
   *
   * The LIKE pattern escapes `%`, `_`, and the escape char itself so a
   * literal prefix like `docs_v2/` cannot wildcard-match `docsXv2/`.
   */
  artifactNamesUnderPrefix(prefix: string): string[] {
    // Empty / "." / "./" ⇒ all artifacts (Grep over the workspace root).
    // Mirrors Python artifact_names_under_prefix. P1: the bare-LIKE version
    // both OVER-matched siblings ("docs/specs" catching "docs/specs-internal/")
    // and returned [] for a "." search_root — silently skipping the entire
    // pre-grep stale check for the very common workspace-root Grep.
    if (prefix === "" || prefix === "." || prefix === "./") {
      const all = this.db
        .prepare(`SELECT name FROM artifacts ORDER BY name`)
        .all() as { name: string }[];
      return all.map((r) => r.name);
    }
    // Strip trailing slash(es) then append exactly one, so the LIKE prefix
    // matches only true directory children — not sibling dirs sharing the
    // stem. UNION an exact-match so a search_root that IS a tracked file
    // still matches it.
    const stripped = prefix.replace(/\/+$/, "");
    const escaped = `${stripped}/`.replace(/([\\%_])/g, "\\$1");
    const rows = this.db
      .prepare(
        `SELECT name FROM artifacts WHERE name LIKE ? ESCAPE '\\'
         UNION SELECT name FROM artifacts WHERE name = ?
         ORDER BY name`,
      )
      .all(`${escaped}%`, stripped) as { name: string }[];
    return rows.map((r) => r.name);
  }

  /**
   * Transition an agent to SHARED on a tracked artifact. Used by pre-read
   * hooks (first-observation seeding + post-stale re-grant). Mirrors Python
   * `CoordinatorService` indirectly: Python flows through `set_agent_state`
   * with `MESIState.SHARED`; here we expose a thin wrapper for the hook
   * handler's clarity.
   *
   * Idempotent on already-SHARED state. Transitions from MODIFIED or
   * EXCLUSIVE to SHARED are valid per MESI semantics (writer downgrades
   * to reader). Throws on a non-valid transition.
   *
   * `observed` (default true) says whether this grant certifies that the
   * agent now holds the artifact's current bytes. `false` is the pre-bash /
   * pre-grep re-grant issued alongside a DENIED command, which never ran: the
   * recorded `last_observed_version` is left as it was — the prior value
   * kept, a never-observed row still NULL — exactly as on a transition to
   * INVALID. Mirrors Python `set_agent_state(..., observed=False)`.
   */
  grantShared(
    artifactId: string,
    agentId: string,
    nowTick: number,
    _trigger = "grant_shared",
    observed = true,
  ): void {
    if (!this.hasArtifact(artifactId)) {
      throw new Error(`grantShared: artifact ${artifactId} not registered`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const priorState = this.getAgentState(artifactId, agentId) ?? MESIState.INVALID;
      if (priorState === MESIState.SHARED) {
        this.db.exec("COMMIT");
        return;
      }
      if (!isValidTransition(priorState, MESIState.SHARED)) {
        throw new Error(
          `grantShared: ${agentId} transition ${priorState}→SHARED not allowed`,
        );
      }
      this.setAgentStateInternal(
        artifactId,
        agentId,
        priorState,
        MESIState.SHARED,
        nowTick,
        _trigger,
        observed ? undefined : null,
      );
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      throw err;
    }
  }

  /**
   * Record that an agent already holding SHARED has read the artifact's
   * current bytes: advance its `last_observed_version` to the current version
   * when the recorded value is NULL or below it. Nothing else moves -- not the
   * state and not the grant tick -- and a row that is not SHARED is left
   * alone, so an E/M grant is never touched and a revoked (INVALID) one is
   * never restored.
   *
   * A denied pre-bash / pre-grep re-grants SHARED without an observation
   * (`grantShared(..., observed=false)`), and `grantShared` is a no-op on a
   * SHARED row. So a retried Bash command, or the Read the session takes
   * instead, answers fresh and is its first read at this version -- recorded
   * here, or never. One guarded UPDATE, so the check and the write are a
   * single statement. Mirrors Python `_record_held_read`
   * (coordinator_server.py). Returns whether the baseline advanced.
   */
  recordObservation(artifactId: string, agentId: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE agent_states
            SET last_observed_version = (SELECT version FROM artifacts WHERE id = ?)
          WHERE artifact_id = ? AND agent_id = ? AND state = ?
            AND (last_observed_version IS NULL
                 OR last_observed_version < (SELECT version FROM artifacts WHERE id = ?))`,
      )
      .run(artifactId, artifactId, agentId, MESIState.SHARED, artifactId);
    return info.changes === 1;
  }

  /**
   * Return (agent_id, granted_at_tick) of the current exclusive holder for an
   * artifact, excluding `excludeAgentId`. Returns null if no M∪E holder. Used
   * by pre-edit collision detection.
   */
  exclusiveHolder(
    artifactId: string,
    excludeAgentId: string,
  ): { agentId: string; grantedAtTick: number | null } | null {
    const rows = this.db
      .prepare(
        `SELECT agent_id, granted_at_tick FROM agent_states
         WHERE artifact_id = ? AND state IN (?, ?) AND agent_id != ?`,
      )
      .all(artifactId, MESIState.MODIFIED, MESIState.EXCLUSIVE, excludeAgentId) as Array<{
      agent_id: string;
      granted_at_tick: number | null;
    }>;
    if (rows.length === 0) return null;
    // checkSingleWriter elsewhere keeps this to at most one row.
    const r = rows[0]!;
    return { agentId: r.agent_id, grantedAtTick: r.granted_at_tick };
  }

  /**
   * Release an agent's grant by transitioning to INVALID. Does NOT bump
   * artifact.version — this is for Stop-hook cleanup of uncommitted grants
   * per KTD-11. Mirrors Python `CoordinatorService.invalidate`.
   *
   * Safe to call on an agent that's already INVALID (no-op).
   */
  invalidate(artifactId: string, agentId: string, nowTick: number, trigger = "invalidate"): void {
    if (!this.hasArtifact(artifactId)) {
      return; // Delete-tombstone-style no-op for absent artifacts.
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const priorState = this.getAgentState(artifactId, agentId) ?? MESIState.INVALID;
      if (priorState === MESIState.INVALID) {
        this.db.exec("COMMIT");
        return;
      }
      if (!isValidTransition(priorState, MESIState.INVALID)) {
        throw new Error(
          `invalidate: ${agentId} transition ${priorState}→INVALID not allowed`,
        );
      }
      this.setAgentStateInternal(artifactId, agentId, priorState, MESIState.INVALID, nowTick, trigger);
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // Internal helpers (called within BEGIN IMMEDIATE from public methods)
  // ------------------------------------------------------------------

  /**
   * UPSERT agent_states with granted_at_tick + last_reclaim slot bookkeeping
   * mirroring Python `set_agent_state`. Caller MUST hold an open transaction.
   *
   * granted_at_tick semantics (per Python sqlite_registry.py:531-546):
   * - new ∈ M/E AND old ∉ M/E → stamp granted_at_tick = nowTick; clear last_reclaim slots
   * - new ∈ M/E AND old ∈ M/E → preserve granted_at_tick (continuous M∪E hold)
   * - old ∈ M/E AND new ∉ M/E → drop granted_at_tick (release)
   * - else → preserve
   *
   * SB-10 R6/R7 rides the same statements: a non-INVALID target records the
   * version whose bytes this agent now holds — `observedVersion` when the
   * caller has it in hand (commit paths), else the artifact row's current
   * version SELECTed in this txn — the post-compaction staleness comparand.
   * A transition TO INVALID preserves the prior recorded value (CASE guard
   * on the UPDATEs; NULL on the INSERT) and a never-observed row keeps NULL
   * (never a 0-sentinel). Mirrors Python sqlite_registry.set_agent_state.
   *
   * `observedVersion === null` is a grant that certifies no read (Python's
   * `observed=False`): it takes the same preserving branch as INVALID.
   */
  private setAgentStateInternal(
    artifactId: string,
    agentId: string,
    priorState: MESIState,
    newState: MESIState,
    nowTick: number,
    _trigger: string,
    observedVersion?: number | null,
  ): void {
    const newInMe = isWriter(newState);
    const prevInMe = isWriter(priorState);

    const observe = newState !== MESIState.INVALID && observedVersion !== null;
    let observedValue: number | null = null;
    if (observe) {
      if (observedVersion !== undefined) {
        observedValue = observedVersion;
      } else {
        const versionRow = this.db
          .prepare(`SELECT version FROM artifacts WHERE id = ?`)
          .get(artifactId) as { version: number } | undefined;
        if (versionRow === undefined) {
          // Callers verify artifact existence before granting; mirror Python's
          // KeyError so a silent NULL overwrite can never mask the bug.
          throw new Error(`setAgentStateInternal: artifact ${artifactId} not registered`);
        }
        observedValue = versionRow.version;
      }
    }

    // Look up prior granted_at_tick for the preserve case.
    const priorRow = this.db
      .prepare(`SELECT granted_at_tick FROM agent_states WHERE artifact_id = ? AND agent_id = ?`)
      .get(artifactId, agentId) as { granted_at_tick: number | null } | undefined;
    const priorGrantedAt = priorRow?.granted_at_tick ?? null;

    let grantedAtTick: number | null;
    let clearReclaim: boolean;
    if (newInMe && !prevInMe) {
      grantedAtTick = nowTick;
      clearReclaim = true;
    } else if (newInMe && prevInMe) {
      grantedAtTick = priorGrantedAt;
      clearReclaim = false;
    } else if (prevInMe) {
      grantedAtTick = null;
      clearReclaim = false;
    } else {
      grantedAtTick = priorGrantedAt;
      clearReclaim = false;
    }

    if (priorRow === undefined) {
      this.db
        .prepare(
          `INSERT INTO agent_states (artifact_id, agent_id, state, granted_at_tick,
                                     last_reclaim_trigger, last_reclaim_tick,
                                     last_observed_version)
           VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .run(artifactId, agentId, newState, grantedAtTick, observedValue);
    } else if (clearReclaim) {
      this.db
        .prepare(
          `UPDATE agent_states
             SET state = ?, granted_at_tick = ?,
                 last_reclaim_trigger = NULL, last_reclaim_tick = NULL,
                 last_observed_version = CASE WHEN ? THEN ? ELSE last_observed_version END
           WHERE artifact_id = ? AND agent_id = ?`,
        )
        .run(newState, grantedAtTick, observe ? 1 : 0, observedValue, artifactId, agentId);
    } else {
      this.db
        .prepare(
          `UPDATE agent_states
             SET state = ?, granted_at_tick = ?,
                 last_observed_version = CASE WHEN ? THEN ? ELSE last_observed_version END
           WHERE artifact_id = ? AND agent_id = ?`,
        )
        .run(newState, grantedAtTick, observe ? 1 : 0, observedValue, artifactId, agentId);
    }
  }

  /**
   * SB-10 R6/R7: advance the recorded last-observed version for one
   * (artifact, agent) pair. Used by the repeat-commit branches where the
   * committer already holds its end state (M→M commit, already-SHARED
   * commit_cas) and `setAgentStateInternal`'s upsert is skipped. Caller
   * MUST hold an open transaction.
   */
  private touchLastObservedVersion(artifactId: string, agentId: string, version: number): void {
    this.db
      .prepare(
        `UPDATE agent_states SET last_observed_version = ?
         WHERE artifact_id = ? AND agent_id = ?`,
      )
      .run(version, artifactId, agentId);
  }

  /**
   * UPSERT a preemption notice. PRIMARY KEY (agent_id, artifact_id) means a
   * second preemption on the same (victim, artifact) replaces the prior
   * notice — latest preempter wins (matches Python's `pop_pending_notices`
   * sibling in `sqlite_registry.record_preemption_notice`).
   *
   * The guard is `>=`, not `>`. Timestamps here are WHOLE SECONDS, so two
   * preemptions of the same pair inside one second are indistinguishable by
   * time, and a strict `>` declines the second — leaving the row naming a
   * session that no longer holds the grant, which is the opposite of the
   * "latest preempter wins" contract above. `>=` makes it last-write-wins
   * within a second while still refusing a strictly OLDER timestamp, which
   * is the only thing the comparison was ever load-bearing for.
   *
   * Only a write-grant holder is queued a notice, so this takes a victim that
   * re-acquires a write grant between two preemptions without draining. A
   * reader re-grant (the strict-mode `pre_bash`/`pre_grep` re-arm) is queued
   * nothing and cannot reach it.
   */
  private upsertPendingNotice(
    victimAgentId: string,
    artifactId: string,
    preempterAgentId: string,
    nowUnixTs: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO pending_notices (agent_id, artifact_id, preempter_agent_id, preempted_at_unix_ts)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, artifact_id) DO UPDATE
           SET preempter_agent_id = excluded.preempter_agent_id,
               preempted_at_unix_ts = excluded.preempted_at_unix_ts
           WHERE excluded.preempted_at_unix_ts >= pending_notices.preempted_at_unix_ts`,
      )
      .run(victimAgentId, artifactId, preempterAgentId, nowUnixTs);
  }

  /** Shared SELECT + row mapping for the peek/pop pending-notice variants. */
  private selectPendingNoticesForAgent(agentId: string): Array<{
    artifactId: string;
    preempterAgentId: string;
    preemptedAtUnixTs: number;
  }> {
    const rows = this.db
      .prepare(
        // Newest-first. Every capped renderer sorts by this key before
        // slicing, and Python's `pop_pending_notices` pins the identical
        // order; without it the SELECT returns `artifact_id` ASCII order,
        // which is random-UUID order and uncorrelated with preemption time.
        // Harmless only while callers drain the whole queue -- a bounded
        // consume would delete a different set than it rendered.
        `SELECT artifact_id, preempter_agent_id, preempted_at_unix_ts
           FROM pending_notices WHERE agent_id = ?
           ORDER BY preempted_at_unix_ts DESC, artifact_id DESC`,
      )
      .all(agentId) as {
      artifact_id: string;
      preempter_agent_id: string;
      preempted_at_unix_ts: number;
    }[];
    return rows.map((r) => ({
      artifactId: r.artifact_id,
      preempterAgentId: r.preempter_agent_id,
      preemptedAtUnixTs: r.preempted_at_unix_ts,
    }));
  }

  /**
   * SB-10 U6: read-only variant of `popPendingNoticesForAgent` — SELECT
   * without the DELETE. The session-start re-grounding payload renders
   * pending notices but must NOT consume them (R6): consumption ownership
   * stays with the admit-endpoint drains, so the victim's next pre-read /
   * pre-edit still surfaces the same notice. Mirrors Python
   * `peek_preemption_notice` (per-pair there; per-agent here to match the
   * pop variant's shape).
   */
  peekPendingNoticesForAgent(agentId: string): Array<{
    artifactId: string;
    preempterAgentId: string;
    preemptedAtUnixTs: number;
  }> {
    return this.selectPendingNoticesForAgent(agentId);
  }

  /**
   * Return pending notices for one agent, newest-first, and DELETE the ones
   * the caller commits to rendering.
   *
   * `consumeLimit` is how many the caller can actually deliver, and it bounds
   * the DELETE only — the SELECT and the return value stay whole. That
   * asymmetry is the whole design, and it is Python's
   * (`sqlite_registry.pop_pending_notices`):
   *
   *   - The caller gets the TRUE pending count from data it still holds, so
   *     its overflow line is arithmetic rather than a guess. A method that
   *     returned only the consumed slice would make "Plus K more" unknowable
   *     without a second query.
   *   - The rows it declines to render stay in the table and surface on that
   *     agent's next admit hook. Deleting rows a response never showed
   *     destroys the operator's only record of who preempted them, which is
   *     exactly how a render-only cap (PR #150) turned DEFERRED into
   *     DESTROYED.
   *
   * Because the returned list is ordered newest-first and the caller's own
   * cap slices the same list from the front, the set rendered is by
   * construction the set deleted. Node is the safer side of this than Python
   * here: Python's renderer re-sorts internally and depends on sort stability
   * to reproduce the tiebreak, while the Node admit callers never re-sort.
   *
   * Omitting `consumeLimit` drains everything, which is the unchanged default
   * and keeps the bulk DELETE — an IN-list over a large pending set would
   * bind one variable per row and can exceed SQLITE_LIMIT_VARIABLE_NUMBER.
   */
  popPendingNoticesForAgent(
    agentId: string,
    consumeLimit?: number,
  ): Array<{
    artifactId: string;
    preempterAgentId: string;
    preemptedAtUnixTs: number;
  }> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const notices = this.selectPendingNoticesForAgent(agentId);
      if (notices.length === 0) {
        this.db.exec("COMMIT");
        return [];
      }
      const consumed = consumeLimit === undefined ? notices : notices.slice(0, consumeLimit);
      if (consumeLimit === undefined) {
        this.db.prepare(`DELETE FROM pending_notices WHERE agent_id = ?`).run(agentId);
      } else if (consumed.length > 0) {
        const placeholders = consumed.map(() => "?").join(", ");
        this.db
          .prepare(
            `DELETE FROM pending_notices WHERE agent_id = ? AND artifact_id IN (${placeholders})`,
          )
          .run(agentId, ...consumed.map((n) => n.artifactId));
      }
      this.db.exec("COMMIT");
      return notices;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      throw err;
    }
  }

  /**
   * Return artifact_ids where the given agent currently holds one of the
   * listed MESI states. Used by /hooks/session-stop per KTD-11 to enumerate
   * uncommitted grants that need release. Mirrors Python
   * `sqlite_registry.artifacts_held_by_agent`.
   */
  artifactsHeldByAgent(agentId: string, states: ReadonlyArray<MESIState>): string[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT artifact_id FROM agent_states
         WHERE agent_id = ? AND state IN (${placeholders})`,
      )
      .all(agentId, ...states) as { artifact_id: string }[];
    return rows.map((r) => r.artifact_id);
  }

  /** Active sessions = agents with at least one non-INVALID grant. For /status default tier. */
  listActiveAgents(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT agent_id FROM agent_states WHERE state != ?`,
      )
      .all(MESIState.INVALID) as { agent_id: string }[];
    return rows.map((r) => r.agent_id);
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    // Better-sqlite3 doesn't expose a checkpoint primitive directly; WAL
    // checkpoint happens automatically on close per the binding's docs.
    this.db.close();
    this.closed = true;
  }
}

export { SCHEMA_USER_VERSION };
