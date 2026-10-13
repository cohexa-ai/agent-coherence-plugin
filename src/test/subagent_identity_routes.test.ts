/**
 * SB-25 Units 1+3 — composite subagent identity, end-to-end over HTTP.
 *
 * The two payoffs the finding demanded:
 *  1. SIBLING COLLISION DETECTION — two subagents of ONE parent session
 *     editing the same tracked artifact now collide (previously they were
 *     one identity: the self-skip in acquireExclusive hid the conflict).
 *  2. ATTRIBUTION — a subagent's write is attributed to the SUBAGENT id in
 *     warn prose, not the parent session.
 * Plus backward-compat: no agent_id ⇒ byte-identical parent behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import { sessionToAgentId } from "../agent_id.js";

const SECRET = "s".repeat(32);
const SID = "44444444-4444-4444-8444-444444444444";
const SUB_A = "a0826622451ec196f";
const SUB_B = "b1937733562fd2a7e";
const HASH_2 = "2".repeat(64);

async function makeServer() {
  const tmp = mkdtempSync(join(tmpdir(), "sb25-routes-"));
  const registry = new ArtifactRegistry(join(tmp, ".coherence", "state.db"));
  const policy = PolicyRef.load(tmp);
  const sessions = new SessionRegistry();
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy,
    sessions,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        Host: "127.0.0.1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
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
  return { registry, sessions, post, cleanup };
}

test("sibling subagents of ONE session collide on pre-edit (previously silent)", async () => {
  const { post, cleanup } = await makeServer();
  try {
    const a = await post("/hooks/pre-edit", {
      session_id: SID,
      agent_id: SUB_A,
      path: "CLAUDE.md",
    });
    assert.equal(a.ok, true);
    assert.equal("hookSpecificOutput" in a, false); // clean acquire

    // Sibling B — SAME parent session, different subagent — now a peer.
    const b = await post("/hooks/pre-edit", {
      session_id: SID,
      agent_id: SUB_B,
      path: "CLAUDE.md",
    });
    assert.equal(b.ok, true);
    const hso = b.hookSpecificOutput as Record<string, unknown>;
    assert.ok(hso, "sibling must receive a collision warning");
    // Attribution: the named holder is subagent A's COMPOSITE agent id --
    // distinct from the parent's and from sibling B's. R7 moved this from the
    // bare subagent id to the agent id; what it has to prove is unchanged.
    assert.match(
      hso.additionalContext as string,
      new RegExp(sessionToAgentId(SID, SUB_A).slice(0, 8)),
    );
    assert.doesNotMatch(
      hso.additionalContext as string,
      new RegExp(sessionToAgentId(SID).slice(0, 8)),
    );

    // And WITHOUT agent_id (the pre-SB-25 shape), the same session is one
    // identity: a re-edit by the parent after A+B were invalidated is just
    // an acquire (backward-compat sanity).
    const parent = await post("/hooks/pre-edit", { session_id: SID, path: "CLAUDE.md" });
    assert.equal(parent.ok, true);
  } finally {
    await cleanup();
  }
});

test("attribution: a subagent's commit is credited to the subagent in the parent's stale warning", async () => {
  const { post, cleanup } = await makeServer();
  try {
    // Parent reads first (SHARED under the parent identity).
    const seed = await post("/hooks/pre-read", { session_id: SID, path: "CLAUDE.md" });
    assert.equal(seed.status, "fresh");

    // Subagent A edits + commits v2.
    await post("/hooks/pre-edit", { session_id: SID, agent_id: SUB_A, path: "CLAUDE.md" });
    const commit = await post("/hooks/post-edit", {
      session_id: SID,
      agent_id: SUB_A,
      path: "CLAUDE.md",
      success: true,
      content_hash: HASH_2,
    });
    assert.equal(commit.ok, true);

    // Parent re-reads → stale, and the warn prose names the SUBAGENT.
    const stale = await post("/hooks/pre-read", { session_id: SID, path: "CLAUDE.md" });
    assert.equal(stale.status, "stale");
    const summary = stale.summary as Record<string, unknown>;
    // R7: the composite agent id, which both backends derive identically --
    // the corpus pins the same value at warn_mode/14.
    assert.equal(summary.last_writer_session_id, sessionToAgentId(SID, SUB_A));
    const hso = stale.hookSpecificOutput as Record<string, unknown>;
    assert.match(
      hso.additionalContext as string,
      new RegExp(`agent ${sessionToAgentId(SID, SUB_A).slice(0, 8)}`),
    );
    // The parent is not the writer, so it must not be the one named.
    assert.doesNotMatch(
      hso.additionalContext as string,
      new RegExp(`agent ${sessionToAgentId(SID).slice(0, 8)}`),
    );
  } finally {
    await cleanup();
  }
});

test("backward-compat: agent_id absent/invalid resolves to the parent identity", async () => {
  const { sessions, post, cleanup } = await makeServer();
  try {
    // Invalid shapes are treated as absent — same identity as no field.
    await post("/hooks/pre-edit", { session_id: SID, agent_id: "bad!chars", path: "CLAUDE.md" });
    const again = await post("/hooks/pre-edit", { session_id: SID, path: "CLAUDE.md" });
    // No collision warning: both requests were the SAME (parent) identity.
    assert.equal(again.ok, true);
    assert.equal("hookSpecificOutput" in again, false);
    // Registry knows exactly one identity for the session.
    assert.equal(sessions.knownAgentIds().length, 1);
  } finally {
    await cleanup();
  }
});

test("SubagentStop scoped release: stopping A frees A's grant, never the parent's or a sibling's", async () => {
  const { post, cleanup } = await makeServer();
  try {
    // Parent holds EXCLUSIVE on one artifact; subagent A on another.
    await post("/hooks/pre-edit", { session_id: SID, path: "AGENTS.md" });
    await post("/hooks/pre-edit", { session_id: SID, agent_id: SUB_A, path: "CLAUDE.md" });

    // SubagentStop for A → releases A's grant (session-stop verb, composite id).
    const stop = await post("/hooks/session-stop", { session_id: SID, agent_id: SUB_A });
    assert.equal(stop.ok, true);
    assert.deepEqual(stop.released_artifacts, ["CLAUDE.md"]);

    // A's artifact is free: sibling B acquires with NO collision warning.
    const b = await post("/hooks/pre-edit", { session_id: SID, agent_id: SUB_B, path: "CLAUDE.md" });
    assert.equal(b.ok, true);
    assert.equal("hookSpecificOutput" in b, false);

    // The PARENT's grant was untouched: a sibling editing AGENTS.md collides.
    const c = await post("/hooks/pre-edit", { session_id: SID, agent_id: SUB_B, path: "AGENTS.md" });
    assert.equal(c.ok, true);
    assert.ok(c.hookSpecificOutput, "parent's grant must still be held");
  } finally {
    await cleanup();
  }
});

test("P1: session-stop with a present-but-MALFORMED agent_id must NOT release the parent's grants", async () => {
  const { post, cleanup } = await makeServer();
  try {
    // Parent (no agent_id) acquires EXCLUSIVE.
    const acq = await post("/hooks/pre-edit", { session_id: SID, path: "CLAUDE.md" });
    assert.equal(acq.ok, true);

    // A session-stop arrives carrying a present-but-invalid agent_id (what
    // buildSubagentStop blocks client-side, but the server must ALSO fail
    // closed as defense-in-depth). Every present malformed JSON type — invalid
    // string AND non-string (number/array/object/bool) — must be a no-op, NOT a
    // parent release. Parity with Python has_subagent_id_field.
    for (const bad of ["bad.id", "x".repeat(65), 42, [1], { k: 1 }, true]) {
      const stop = await post("/hooks/session-stop", { session_id: SID, agent_id: bad });
      assert.equal(stop.ok, true);
      assert.deepEqual(stop.released_artifacts, [], `malformed ${JSON.stringify(bad)} must be a no-op`);
    }

    // Proof the parent's grant SURVIVED the malformed stop: a subsequent
    // legitimate parent stop (absent agent_id) can still release it. Had the
    // malformed stop degraded to a parent release, this would be empty.
    const parentStop = await post("/hooks/session-stop", { session_id: SID });
    assert.equal(parentStop.ok, true);
    assert.deepEqual(parentStop.released_artifacts, ["CLAUDE.md"]);
  } finally {
    await cleanup();
  }
});
