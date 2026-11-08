/**
 * registry.releaseToReader — a holder's own release (Stop, SubagentStop, a
 * failed post-edit) leaves it a reader. Only an EXCLUSIVE or MODIFIED row
 * moves, to SHARED at the version it held; every other row is left exactly
 * as it was, so a copy a peer made stale is never restored.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { ArtifactRegistry } from "../registry.js";
import { MESIState } from "../states.js";

const AGENT_A = "a".repeat(32);
const AGENT_B = "b".repeat(32);
const AGENT_C = "c".repeat(32);
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);

interface Fixture {
  registry: ArtifactRegistry;
  id: string;
  raw: Database;
  dbPath: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "release-to-reader-test-"));
  const dbPath = join(tmp, "state.db");
  const registry = new ArtifactRegistry(dbPath);
  const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
  const raw = new BetterSqlite3(dbPath);
  return {
    registry,
    id,
    raw,
    dbPath,
    cleanup: () => {
      raw.close();
      registry.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function grantedAtTick(raw: Database, artifactId: string, agentId: string): number | null {
  const row = raw
    .prepare(`SELECT granted_at_tick FROM agent_states WHERE artifact_id = ? AND agent_id = ?`)
    .get(artifactId, agentId) as { granted_at_tick: number | null };
  return row.granted_at_tick;
}

function agentRows(raw: Database, artifactId: string): unknown[] {
  return raw.prepare(`SELECT * FROM agent_states WHERE artifact_id = ? ORDER BY agent_id`).all(artifactId);
}

test("an EXCLUSIVE holder's release leaves it SHARED, drops its grant tick and keeps its observed version", () => {
  const f = makeFixture();
  try {
    f.registry.acquireExclusive(f.id, AGENT_A, 10);
    assert.equal(grantedAtTick(f.raw, f.id, AGENT_A), 10);

    f.registry.releaseToReader(f.id, AGENT_A, 20);

    assert.equal(f.registry.getAgentState(f.id, AGENT_A), MESIState.SHARED);
    assert.equal(grantedAtTick(f.raw, f.id, AGENT_A), null);
    assert.equal(f.registry.lastObservedVersionFor(f.id, AGENT_A), 1);
    assert.equal(f.registry.getArtifactById(f.id)!.version, 1);
  } finally {
    f.cleanup();
  }
});

test("a MODIFIED holder's release leaves it SHARED at the version it committed", () => {
  const f = makeFixture();
  try {
    f.registry.acquireExclusive(f.id, AGENT_A, 10);
    f.registry.commit(f.id, AGENT_A, HASH_2, 11);
    assert.equal(f.registry.getAgentState(f.id, AGENT_A), MESIState.MODIFIED);

    f.registry.releaseToReader(f.id, AGENT_A, 20);

    assert.equal(f.registry.getAgentState(f.id, AGENT_A), MESIState.SHARED);
    assert.equal(grantedAtTick(f.raw, f.id, AGENT_A), null);
    assert.equal(f.registry.lastObservedVersionFor(f.id, AGENT_A), 2);
    assert.equal(f.registry.getArtifactById(f.id)!.version, 2);
  } finally {
    f.cleanup();
  }
});

test("a peer's write cannot land between the release reading the holder's row and writing it", () => {
  const f = makeFixture();
  const peer = new BetterSqlite3(f.dbPath, { timeout: 0 });
  try {
    f.registry.acquireExclusive(f.id, AGENT_A, 10);
    // Right after the release reads A's row, another connection tries to make
    // A's copy stale. Read inside the release's transaction, it must be refused.
    const peerWrites: Array<"landed" | "refused"> = [];
    const read = f.registry.getAgentState.bind(f.registry);
    Object.defineProperty(f.registry, "getAgentState", {
      configurable: true,
      value: (artifactId: string, agentId: string) => {
        const state = read(artifactId, agentId);
        try {
          peer
            .prepare(`UPDATE agent_states SET state = 'INVALID' WHERE artifact_id = ? AND agent_id = ?`)
            .run(artifactId, agentId);
          peerWrites.push("landed");
        } catch {
          peerWrites.push("refused");
        }
        return state;
      },
    });

    f.registry.releaseToReader(f.id, AGENT_A, 20);

    assert.deepEqual(peerWrites, ["refused"]);
    assert.equal(read(f.id, AGENT_A), MESIState.SHARED);
  } finally {
    peer.close();
    f.cleanup();
  }
});

test("a reader, a stale copy and an agent with no row are left as they were, and no row is created", () => {
  const f = makeFixture();
  try {
    f.registry.grantShared(f.id, AGENT_A, 10);
    f.registry.grantShared(f.id, AGENT_B, 10);
    f.registry.invalidate(f.id, AGENT_B, 11);
    const before = agentRows(f.raw, f.id);

    f.registry.releaseToReader(f.id, AGENT_A, 20);
    f.registry.releaseToReader(f.id, AGENT_B, 20);
    f.registry.releaseToReader(f.id, AGENT_C, 20);

    assert.deepEqual(agentRows(f.raw, f.id), before);
    assert.equal(f.registry.getAgentState(f.id, AGENT_A), MESIState.SHARED);
    assert.equal(f.registry.getAgentState(f.id, AGENT_B), MESIState.INVALID);
    assert.equal(f.registry.getAgentState(f.id, AGENT_C), null);
  } finally {
    f.cleanup();
  }
});
