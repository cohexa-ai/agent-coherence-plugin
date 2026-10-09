/**
 * Schema migration ledger for the Node coordinator.
 *
 * Mirror of the Python coordinator's KTD-D revised pattern: schema lives as a
 * module-level array of {version, description, apply} tuples, each wrapped in
 * one atomic `BEGIN IMMEDIATE; …; PRAGMA user_version = N; COMMIT;`
 * transaction so partial-power-loss leaves the database at either the prior
 * version or the target — never mid-state.
 *
 * SCHEMA_USER_VERSION is derived from the list, NOT a hand-maintained constant.
 *
 * v0.1.1 Unit 1 (this commit) lands only the runner + empty array. Unit 2
 * appends migration 1 (initial schema mirroring _apply_v1_schema), migration 2
 * (formalize pending_notices), migration 3 (KTD-F watchdog deadline column).
 *
 * Per KTD-D revised: NEVER use multi-statement-without-batch-transaction.
 * Each apply() function MUST issue exactly one BEGIN IMMEDIATE that wraps all
 * DDL + PRAGMA user_version bump + COMMIT. This preserves the v0.1 SIGKILL
 * atomicity guarantee documented in Python's _apply_v1_schema docstring.
 */
import type { Database } from "better-sqlite3";
import { V1_INITIAL } from "./migrations/v1_initial.js";
import { V2_VALIDATE_PENDING_NOTICES } from "./migrations/v2_validate_pending_notices.js";
import { V3_WATCHDOG_DEADLINE } from "./migrations/v3_watchdog_deadline.js";
import { V4_LAST_OBSERVED } from "./migrations/v4_last_observed.js";
import { V5_AGENT_STATES_AGENT_INDEX } from "./migrations/v5_agent_states_agent_index.js";

/**
 * Cross-runtime lineage stamp (registry_meta). The sibling Python coordinator
 * (agent-coherence) shares the SAME <workspace>/.coherence/state.db path but
 * keeps its OWN migration ledger — its v2 adds the `artifact_versions` table
 * (durable version retention) + fence columns, while this Node ledger's v2 adds
 * no schema objects and its v3 ALTERs `agent_states ADD COLUMN deadline_tick`.
 * So `PRAGMA user_version` alone cannot say WHOSE ledger a file belongs to: the
 * same number means different schemas depending on the writer.
 *
 * This side stamps `schema_runtime=node`; the Python side stamps `python`. A
 * present-and-foreign stamp is the STRONGEST cross-runtime marker. Absence is
 * NOT foreign — every db created before this marker shipped lacks the key.
 * Mirrors agent-coherence sqlite_registry.py (_META_SCHEMA_RUNTIME); issue #55.
 */
export const SCHEMA_RUNTIME_KEY = "schema_runtime";
export const SCHEMA_RUNTIME_NODE = "node";

/**
 * Machine-readable classification for a cross-runtime open failure. Wire-stable
 * mirror of agent-coherence's CROSS_RUNTIME_SCHEMA_REASON — consumers match
 * `err.reason === CONSTANT`, never a substring of the message.
 */
export const CROSS_RUNTIME_SCHEMA_REASON = "cross_runtime_schema";

/**
 * Raised when an existing state.db carries an unexpected user_version.
 *
 * The message deliberately never recommends deleting the database: as of the
 * durable-retention schema the store holds retained version content + live
 * coordination state, so a delete is destructive. The forward path is upgrading
 * the coordinator binary to one that understands the schema, never `rm state.db`.
 */
export class SchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaVersionError";
  }
}

/**
 * The state.db was written under the sibling Python coordinator's ledger.
 *
 * The Node coordinator fails CLOSED at open — it will neither read nor migrate
 * a foreign-ledger db (migrating would corrupt the Python side's live state and
 * retained content; reading would misinterpret its schema). Symmetric with the
 * Python guard in agent-coherence sqlite_registry.py
 * (SqliteArtifactRegistry._reject_foreign_ledger_db). `reason` is always
 * CROSS_RUNTIME_SCHEMA_REASON. Same anti-delete wording rule as the parent.
 */
export class CrossRuntimeSchemaError extends SchemaVersionError {
  readonly reason = CROSS_RUNTIME_SCHEMA_REASON;
  constructor(message: string) {
    super(message);
    this.name = "CrossRuntimeSchemaError";
  }
}

export interface Migration {
  /** Monotonically increasing positive integer. */
  version: number;
  /** Short human-readable label; surfaces in error messages on migration failure. */
  description: string;
  /**
   * Apply the migration. MUST wrap all DDL + `PRAGMA user_version = <version>`
   * in a single `BEGIN IMMEDIATE; … COMMIT;` transaction. The runner does NOT
   * wrap the call — it's the apply function's responsibility per the v0.1
   * pattern.
   */
  apply: (db: Database) => void;
}

/**
 * Ordered migration list. Each entry appends; never reorder, never delete.
 *
 * v0.1.1 Unit 2 (this commit):
 *  - v1: initial schema (artifacts, agent_states, heartbeats, registry_meta,
 *    pending_notices); mirrors Python `_apply_v1_schema` byte-for-byte for
 *    KTD-B parity
 *  - v2: validate pending_notices shape; formalize v1→v2 boundary per KTD-D
 *  - v3: add agent_states.deadline_tick column per KTD-F watchdog A6 fix
 *
 * v0.4.x SB-10 (this commit):
 *  - v4: add agent_states.last_observed_version column (nullable; the
 *    post-compaction staleness comparand — mirrors Python's v6 step). The
 *    column NAME is shared with the Python ledger, so it is NOT a lineage
 *    marker; rejectForeignLedgerDb needs no new probe (KTD9).
 *  - v5: index agent_states(agent_id) so the scoped session-start read is
 *    SEARCH-backed, not a full scan (mirrors Python's v7 step; an index
 *    carries no lineage signal, so again no new foreign-ledger probe).
 *
 * Future migrations (v6+) append here; the version-derived SCHEMA_USER_VERSION
 * constant updates automatically.
 */
export const MIGRATIONS: ReadonlyArray<Migration> = [
  V1_INITIAL,
  V2_VALIDATE_PENDING_NOTICES,
  V3_WATCHDOG_DEADLINE,
  V4_LAST_OBSERVED,
  V5_AGENT_STATES_AGENT_INDEX,
];

/**
 * Target schema version = max version in the list, or 0 if list is empty.
 * Derived; do NOT hand-maintain a separate constant.
 */
export const SCHEMA_USER_VERSION: number = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);

/** Read-only probe: does a table exist? (sqlite_master, no writes). */
function hasTable(db: Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

/**
 * Read-only probe: does `table` carry `column`? `table` is an internal literal
 * (never user input); PRAGMA table_info takes no bindings. A missing table
 * yields zero rows → reads as "column absent".
 */
function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/** registry_meta.schema_runtime, or null when the table or key is absent. */
function readSchemaRuntimeStamp(db: Database): string | null {
  if (!hasTable(db, "registry_meta")) {
    return null;
  }
  const row = db
    .prepare("SELECT value FROM registry_meta WHERE key = ?")
    .get(SCHEMA_RUNTIME_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

function raiseCrossRuntime(detail: string): never {
  throw new CrossRuntimeSchemaError(
    `The state.db ${detail}. The likely writer is the sibling Python coordinator ` +
      `(agent-coherence), which shares this path but keeps its own migration ledger — ` +
      `the two ledgers assign different meanings to the same user_version numbers. ` +
      `This Node coordinator will not read or migrate a foreign-ledger db, and no ` +
      `supported path converts it to the Node backend. To keep using the runtime that ` +
      `owns this store, set coherence.coordinator_backend = "python". Do NOT delete ` +
      `state.db — it holds the sibling runtime's live coordination state and retained ` +
      `version content, which a delete destroys.`,
  );
}

/**
 * Fail closed when the db carries sibling-Python-coordinator markers. Every
 * probe is a plain read (SELECT / PRAGMA table_info), so the guard itself can
 * never dirty a foreign db. Detection order (strongest marker first), mirroring
 * agent-coherence sqlite_registry.py:
 *
 *   1. registry_meta.schema_runtime present and != "node" — the explicit
 *      lineage stamp, checked regardless of version.
 *   2. the `artifact_versions` table present — the Python ledger's durable
 *      retention table; NO Node migration ever creates it, at any version.
 *   3. the `artifacts.owner_generation` fence column present — added by the
 *      Python v2 schema; no Node ledger has it. Belt-and-suspenders for a
 *      hypothetical Python db missing the retention table.
 *
 * user_version == 1 is deliberately NOT blocked: the Node ledger's v1 mirrors
 * the Python v1 schema byte-for-byte, so the two are indistinguishable by
 * design (documented residual in issue #55).
 */
function rejectForeignLedgerDb(db: Database): void {
  const runtime = readSchemaRuntimeStamp(db);
  if (runtime !== null && runtime !== SCHEMA_RUNTIME_NODE) {
    raiseCrossRuntime(
      `is stamped registry_meta.schema_runtime='${runtime}' (this build stamps '${SCHEMA_RUNTIME_NODE}')`,
    );
  }
  if (hasTable(db, "artifact_versions")) {
    raiseCrossRuntime(
      "carries the artifact_versions table (the Python ledger's durable-retention " +
        "table; no Node migration creates it)",
    );
  }
  if (hasColumn(db, "artifacts", "owner_generation")) {
    raiseCrossRuntime(
      "carries the artifacts.owner_generation fence column (added by the Python v2 " +
        "schema; no Node schema has it)",
    );
  }
}

/** Stamp this db's lineage as Node (idempotent; never overwrites a stamp). */
function stampSchemaRuntime(db: Database): void {
  if (!hasTable(db, "registry_meta")) {
    return;
  }
  db.prepare("INSERT OR IGNORE INTO registry_meta (key, value) VALUES (?, ?)").run(
    SCHEMA_RUNTIME_KEY,
    SCHEMA_RUNTIME_NODE,
  );
}

/**
 * Apply all pending migrations from current `PRAGMA user_version` to
 * `SCHEMA_USER_VERSION`. Idempotent: re-running against an already-current
 * database is a no-op (no migrations to apply).
 *
 * Throws if a migration's apply() raises, OR if `PRAGMA user_version` after
 * apply does NOT match the migration's version (catches the foot-gun of an
 * apply() that forgets to bump PRAGMA user_version).
 */
export function runPendingMigrations(db: Database): { applied: ReadonlyArray<Migration>; current: number } {
  const currentRow = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const startVersion = currentRow?.user_version ?? 0;

  // Cross-runtime fail-closed guard (issue #55): read-only probes, BEFORE any
  // migration can run — migrating a Python-ledger db would corrupt the sibling
  // coordinator's live state. Runs first so a foreign db surfaces the typed
  // CrossRuntimeSchemaError rather than the generic schema-mismatch throw below.
  rejectForeignLedgerDb(db);

  if (startVersion > SCHEMA_USER_VERSION) {
    throw new SchemaVersionError(
      `Schema mismatch: the database is at user_version=${startVersion} but this ` +
        `coordinator binary targets ${SCHEMA_USER_VERSION}. The store was written by a ` +
        `newer coordinator build — upgrade this coordinator to one that understands ` +
        `schema v${startVersion}. Do NOT delete state.db: as of the durable-retention ` +
        `schema it holds retained version content and live coordination state that a ` +
        `delete destroys.`,
    );
  }

  const pending = MIGRATIONS.filter((m) => m.version > startVersion);
  pending.sort((a, b) => a.version - b.version);

  for (const m of pending) {
    m.apply(db);
    const after = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (after.user_version !== m.version) {
      throw new Error(
        `Migration ${m.version} (${m.description}) ran but PRAGMA user_version is ${after.user_version}, ` +
          `not ${m.version}. The apply() function MUST set PRAGMA user_version inside its BEGIN IMMEDIATE block.`,
      );
    }
  }

  // Stamp this db's lineage so the sibling Python coordinator's mirror guard can
  // fail closed on an explicit marker. Idempotent; the v1 create already seeds
  // it, so this only back-fills pre-existing un-stamped Node dbs.
  stampSchemaRuntime(db);

  return { applied: pending, current: SCHEMA_USER_VERSION };
}
