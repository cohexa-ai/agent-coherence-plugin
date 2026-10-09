/**
 * Issue #55: cross-runtime migration-ledger guard.
 *
 * The Node coordinator shares <workspace>/.coherence/state.db with the Python
 * coordinator (agent-coherence), which keeps an independent migration ledger.
 * Before this guard, Node opening a Python-v2 db (user_version=2 + the
 * artifact_versions retention table) saw 2 < 3 and ran its v3 ALTER, corrupting
 * the shared file so Python then failed closed. These tests pin the symmetric
 * fail-closed guard + the schema_runtime lineage stamp.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  runPendingMigrations,
  SCHEMA_USER_VERSION,
  SCHEMA_RUNTIME_KEY,
  CROSS_RUNTIME_SCHEMA_REASON,
  CrossRuntimeSchemaError,
  SchemaVersionError,
} from "../migrations.js";
import { ArtifactRegistry } from "../registry.js";

function tmpDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "xrt-ledger-"));
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

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function metaValue(db: Database.Database, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM registry_meta WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

/** Simulate what the Python coordinator's _apply_v2_schema writes. */
function buildPythonV2(db: Database.Database, opts: { stamp?: boolean } = {}): void {
  db.exec("BEGIN IMMEDIATE");
  db.exec(`CREATE TABLE artifacts (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL, owner_generation INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL, size_tokens INTEGER, last_writer_id TEXT, updated_at REAL NOT NULL)`);
  db.exec(`CREATE TABLE agent_states (artifact_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    state TEXT NOT NULL, read_generation INTEGER, PRIMARY KEY (artifact_id, agent_id))`);
  db.exec(`CREATE TABLE registry_meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.exec(`CREATE TABLE artifact_versions (artifact_id TEXT NOT NULL, version INTEGER NOT NULL,
    content TEXT, captured_at REAL NOT NULL, PRIMARY KEY (artifact_id, version))`);
  db.prepare("INSERT INTO registry_meta (key, value) VALUES (?, ?)").run("sequence_number", "0");
  if (opts.stamp ?? true) {
    db.prepare("INSERT INTO registry_meta (key, value) VALUES (?, ?)").run("schema_runtime", "python");
  }
  db.exec("PRAGMA user_version = 2");
  db.exec("COMMIT");
}

/**
 * Simulate what the Python coordinator's v6 schema writes (agent-coherence
 * commit 8d5dcfe). Python v6 ALSO carries agent_states.last_observed_version —
 * the column NAME is shared with this Node ledger's v4, so it is NOT a
 * cross-runtime marker in either direction. The disjoint fingerprints remain
 * deadline_tick (Node-only) vs artifact_versions/owner_generation (Python-only).
 */
function buildPythonV6(db: Database.Database, opts: { stamp?: boolean } = {}): void {
  db.exec("BEGIN IMMEDIATE");
  db.exec(`CREATE TABLE artifacts (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL, owner_generation INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL, size_tokens INTEGER, last_writer_id TEXT, updated_at REAL NOT NULL)`);
  db.exec(`CREATE TABLE agent_states (artifact_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    state TEXT NOT NULL, read_generation INTEGER, last_observed_version INTEGER,
    PRIMARY KEY (artifact_id, agent_id))`);
  db.exec(`CREATE TABLE registry_meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.exec(`CREATE TABLE artifact_versions (artifact_id TEXT NOT NULL, version INTEGER NOT NULL,
    content TEXT, captured_at REAL NOT NULL, PRIMARY KEY (artifact_id, version))`);
  db.prepare("INSERT INTO registry_meta (key, value) VALUES (?, ?)").run("sequence_number", "0");
  if (opts.stamp ?? true) {
    db.prepare("INSERT INTO registry_meta (key, value) VALUES (?, ?)").run("schema_runtime", "python");
  }
  db.exec("PRAGMA user_version = 6");
  db.exec("COMMIT");
}

/** A Node-v2 db created BEFORE the schema_runtime stamp shipped (no stamp). */
function buildNodeV2Unstamped(db: Database.Database, version = 2): void {
  db.exec("BEGIN IMMEDIATE");
  db.exec(`CREATE TABLE artifacts (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL, content_hash TEXT NOT NULL, size_tokens INTEGER,
    last_writer_id TEXT, updated_at REAL NOT NULL)`);
  db.exec(`CREATE TABLE agent_states (artifact_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    state TEXT NOT NULL, PRIMARY KEY (artifact_id, agent_id))`);
  db.exec(`CREATE TABLE heartbeats (agent_id TEXT PRIMARY KEY, last_tick INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE registry_meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.exec(`CREATE TABLE pending_notices (agent_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
    preempter_agent_id TEXT NOT NULL, preempted_at_unix_ts REAL NOT NULL,
    PRIMARY KEY (agent_id, artifact_id))`);
  db.prepare("INSERT INTO registry_meta (key, value) VALUES (?, ?)").run("sequence_number", "0");
  db.exec(`PRAGMA user_version = ${version}`);
  db.exec("COMMIT");
}

test("#55: a Python-v2 db is rejected and NOT migrated (the load-bearing case)", () => {
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);
  try {
    buildPythonV2(db);
    assert.equal(userVersion(db), 2);
    assert.equal(hasColumn(db, "agent_states", "deadline_tick"), false);

    assert.throws(
      () => runPendingMigrations(db),
      (err: unknown) => {
        assert.ok(err instanceof CrossRuntimeSchemaError, "must be CrossRuntimeSchemaError");
        assert.equal((err as CrossRuntimeSchemaError).reason, CROSS_RUNTIME_SCHEMA_REASON);
        // No tool converts a store between the two ledgers, so the message
        // must not point at a migration path that does not exist.
        const message = (err as Error).message;
        assert.match(message, /no supported path converts it to the Node backend/);
        assert.doesNotMatch(message, /migration path|prepare-for-migration/);
        return true;
      },
    );

    // The guard ran BEFORE any migration: no v3 ALTER, version untouched.
    assert.equal(hasColumn(db, "agent_states", "deadline_tick"), false, "v3 ALTER must not have run");
    assert.equal(userVersion(db), 2, "user_version must be untouched");
    assert.equal(metaValue(db, SCHEMA_RUNTIME_KEY), "python", "foreign stamp must be untouched");
  } finally {
    db.close();
    cleanup();
  }
});

test("SB-10: a Python-v6 db (shared last_observed_version column name) is still rejected", () => {
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);
  try {
    buildPythonV6(db);
    assert.equal(userVersion(db), 6);
    assert.equal(hasColumn(db, "agent_states", "last_observed_version"), true);

    assert.throws(
      () => runPendingMigrations(db),
      (err: unknown) => {
        assert.ok(err instanceof CrossRuntimeSchemaError, "must be CrossRuntimeSchemaError");
        assert.equal((err as CrossRuntimeSchemaError).reason, CROSS_RUNTIME_SCHEMA_REASON);
        return true;
      },
    );

    // Untouched: no Node ALTER ran, version + foreign stamp preserved.
    assert.equal(hasColumn(db, "agent_states", "deadline_tick"), false, "Node ALTERs must not run");
    assert.equal(userVersion(db), 6, "user_version must be untouched");
    assert.equal(metaValue(db, SCHEMA_RUNTIME_KEY), "python", "foreign stamp must be untouched");
  } finally {
    db.close();
    cleanup();
  }
});

test("SB-10: an un-stamped Python-v6 db is rejected on structural markers alone", () => {
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);
  try {
    // The shared agent_states.last_observed_version name must not confuse the
    // guard either way — artifact_versions/owner_generation still fire.
    buildPythonV6(db, { stamp: false });
    assert.equal(metaValue(db, SCHEMA_RUNTIME_KEY), undefined);
    assert.throws(() => runPendingMigrations(db), CrossRuntimeSchemaError);
    assert.equal(hasColumn(db, "agent_states", "deadline_tick"), false);
  } finally {
    db.close();
    cleanup();
  }
});

test("SB-10: an existing Node-v4 db (last_observed_version present) re-opens without false rejection", () => {
  const { path, cleanup } = tmpDbPath();
  const first = new ArtifactRegistry(path);
  first.close();
  const second = new ArtifactRegistry(path);
  try {
    assert.equal(second.getStats().schemaVersion, SCHEMA_USER_VERSION);
    assert.equal(second.getStats().migrationsApplied, 0, "reopen must be a write-free no-op");
  } finally {
    second.close();
    cleanup();
  }
});

test("#55: a foreign schema_runtime stamp alone is rejected (strongest marker)", () => {
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);
  try {
    // Minimal db: just registry_meta with a foreign stamp, no structural markers.
    db.exec(`CREATE TABLE registry_meta (key TEXT PRIMARY KEY, value TEXT)`);
    db.prepare("INSERT INTO registry_meta (key, value) VALUES (?, ?)").run("schema_runtime", "python");
    assert.throws(() => runPendingMigrations(db), CrossRuntimeSchemaError);
  } finally {
    db.close();
    cleanup();
  }
});

test("#55: an un-stamped Python db (artifact_versions present) is still rejected", () => {
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);
  try {
    buildPythonV2(db, { stamp: false });
    assert.equal(metaValue(db, SCHEMA_RUNTIME_KEY), undefined);
    assert.throws(() => runPendingMigrations(db), CrossRuntimeSchemaError);
    assert.equal(hasColumn(db, "agent_states", "deadline_tick"), false);
  } finally {
    db.close();
    cleanup();
  }
});

test("#55: a fresh Node create stamps schema_runtime=node and reaches the head version", () => {
  const { path, cleanup } = tmpDbPath();
  const registry = new ArtifactRegistry(path);
  try {
    assert.equal(registry.getStats().schemaVersion, SCHEMA_USER_VERSION);
    // Inspect via an independent read connection (WAL allows concurrent readers).
    const probe = new Database(path, { readonly: true });
    try {
      assert.equal(userVersion(probe), SCHEMA_USER_VERSION);
      assert.equal(metaValue(probe, SCHEMA_RUNTIME_KEY), "node");
      assert.equal(hasColumn(probe, "agent_states", "deadline_tick"), true);
      assert.equal(hasColumn(probe, "agent_states", "last_observed_version"), true);
    } finally {
      probe.close();
    }
  } finally {
    registry.close();
    cleanup();
  }
});

test("#55: an un-stamped Node-v2 db migrates normally and back-fills the node stamp", () => {
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);
  try {
    buildNodeV2Unstamped(db, 2);
    assert.equal(metaValue(db, SCHEMA_RUNTIME_KEY), undefined);

    const result = runPendingMigrations(db);
    assert.equal(result.current, SCHEMA_USER_VERSION);
    assert.equal(userVersion(db), SCHEMA_USER_VERSION);
    assert.equal(hasColumn(db, "agent_states", "deadline_tick"), true, "v3 must have run");
    assert.equal(hasColumn(db, "agent_states", "last_observed_version"), true, "v4 must have run");
    assert.equal(metaValue(db, SCHEMA_RUNTIME_KEY), "node", "node stamp must be back-filled");
  } finally {
    db.close();
    cleanup();
  }
});

test("#55: a v1 db is indistinguishable and still migrates (documented residual)", () => {
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);
  try {
    buildNodeV2Unstamped(db, 1); // v1-shape: no artifact_versions, no stamp, user_version=1
    assert.doesNotThrow(() => runPendingMigrations(db));
    assert.equal(userVersion(db), SCHEMA_USER_VERSION);
    assert.equal(metaValue(db, SCHEMA_RUNTIME_KEY), "node");
  } finally {
    db.close();
    cleanup();
  }
});

test("#55: a too-new (but Node-lineage) db throws SchemaVersionError without rm advice", () => {
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);
  try {
    buildNodeV2Unstamped(db, 2);
    db.prepare("INSERT INTO registry_meta (key, value) VALUES (?, ?)").run("schema_runtime", "node");
    db.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION + 5}`);

    assert.throws(
      () => runPendingMigrations(db),
      (err: unknown) => {
        assert.ok(err instanceof SchemaVersionError);
        assert.ok(!(err instanceof CrossRuntimeSchemaError), "Node-lineage → not cross-runtime");
        assert.doesNotMatch((err as Error).message, /rm /, "must not advise deleting state.db");
        return true;
      },
    );
  } finally {
    db.close();
    cleanup();
  }
});
