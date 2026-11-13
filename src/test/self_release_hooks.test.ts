/**
 * A session that edited a file can read and edit it again on its next turn.
 * Stop, SubagentStop and a failed post-edit
 * leave the holder a reader (SHARED) instead of INVALID, while a copy a
 * peer's acquire or commit made stale is still denied. The answer bodies of
 * the releasing hooks are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import { sessionToAgentId } from "../agent_id.js";
import { MESIState } from "../states.js";

const SECRET = "s".repeat(32);
const SID_A = "44444444-4444-4444-8444-444444444444";
const SID_B = "55555555-5555-5555-8555-555555555555";
const SUB = "a0826622451ec196f";
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const HASH_3 = "3".repeat(64);
/** Strict mode covers plan.md only; task.md is tracked and warn-only. */
const STRICT = "plan.md";
const WARN = "task.md";

async function makeServer() {
  const tmp = mkdtempSync(join(tmpdir(), "self-release-test-"));
  mkdirSync(join(tmp, ".coherence"), { recursive: true });
  writeFileSync(join(tmp, ".coherence", "strict_mode.yaml"), `- ${STRICT}\n`, "utf8");
  const registry = new ArtifactRegistry(join(tmp, ".coherence", "state.db"));
  const sessions = new SessionRegistry();
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy: PolicyRef.load(tmp),
    sessions,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, Host: "127.0.0.1", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  };
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { Authorization: `Bearer ${SECRET}`, Host: "127.0.0.1" },
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
  return { registry, sessions, post, get, cleanup, root: tmp };
}

type Server = Awaited<ReturnType<typeof makeServer>>;

/** One committed edit: pre-edit, then a successful post-edit with `hash`. */
async function editAndCommit(s: Server, who: Record<string, unknown>, hash: string): Promise<void> {
  assert.equal((await s.post("/hooks/pre-edit", who)).ok, true);
  assert.deepEqual(await s.post("/hooks/post-edit", { ...who, success: true, content_hash: hash }), { ok: true });
}

function stateOf(s: Server, path: string, agentId: string): MESIState | null {
  return s.registry.getAgentState(s.registry.getArtifactByName(path)!.id, agentId);
}

function denyReason(body: Record<string, unknown>): string {
  const hso = body.hookSpecificOutput as Record<string, unknown>;
  assert.equal(hso.permissionDecision, "deny");
  return hso.permissionDecisionReason as string;
}

// ------------------------------------------------------------ the holder keeps a read

test("a strict file edited, committed and released at Stop reads fresh and edits again on the next turn", async () => {
  const s = await makeServer();
  try {
    await editAndCommit(s, { session_id: SID_A, path: STRICT }, HASH_2);
    const stop = await s.post("/hooks/session-stop", { session_id: SID_A });
    assert.deepEqual(stop, { ok: true, released_artifacts: [STRICT] });
    assert.equal(stateOf(s, STRICT, sessionToAgentId(SID_A)), MESIState.SHARED);

    const read = await s.post("/hooks/pre-read", { session_id: SID_A, path: STRICT, content_hash: HASH_2 });
    assert.deepEqual(read, { status: "fresh", version: 2 });
    assert.deepEqual(await s.post("/hooks/pre-edit", { session_id: SID_A, path: STRICT }), { ok: true });
  } finally {
    await s.cleanup();
  }
});

test("a warn file released at Stop reads with no stale warning on the next turn", async () => {
  const s = await makeServer();
  try {
    await editAndCommit(s, { session_id: SID_A, path: WARN }, HASH_2);
    await s.post("/hooks/session-stop", { session_id: SID_A });

    const read = await s.post("/hooks/pre-read", { session_id: SID_A, path: WARN, content_hash: HASH_2 });
    assert.deepEqual(read, { status: "fresh", version: 2 });
  } finally {
    await s.cleanup();
  }
});

test("a failed edit answers as before and leaves the holder reading fresh", async () => {
  const s = await makeServer();
  try {
    s.registry.resolveOrRegisterArtifact(STRICT, HASH_1);
    assert.equal((await s.post("/hooks/pre-edit", { session_id: SID_A, path: STRICT })).ok, true);
    const failed = await s.post("/hooks/post-edit", { session_id: SID_A, path: STRICT, success: false });
    assert.deepEqual(failed, { ok: true, released: true });
    assert.equal(stateOf(s, STRICT, sessionToAgentId(SID_A)), MESIState.SHARED);

    const read = await s.post("/hooks/pre-read", { session_id: SID_A, path: STRICT, content_hash: HASH_1 });
    assert.deepEqual(read, { status: "fresh", version: 1 });
  } finally {
    await s.cleanup();
  }
});

test("SubagentStop leaves the subagent a reader and the parent's rows untouched", async () => {
  const s = await makeServer();
  try {
    const parent = sessionToAgentId(SID_A);
    const sub = s.sessions.registerSession(SID_A, SUB);
    assert.equal((await s.post("/hooks/pre-edit", { session_id: SID_A, path: "AGENTS.md" })).ok, true);
    await editAndCommit(s, { session_id: SID_A, agent_id: SUB, path: STRICT }, HASH_2);

    const stop = await s.post("/hooks/session-stop", { session_id: SID_A, agent_id: SUB });
    assert.deepEqual(stop, { ok: true, released_artifacts: [STRICT] });
    assert.equal(stateOf(s, STRICT, sub), MESIState.SHARED);
    assert.equal(stateOf(s, STRICT, parent), null);
    assert.equal(stateOf(s, "AGENTS.md", parent), MESIState.EXCLUSIVE);

    const read = await s.post("/hooks/pre-read", {
      session_id: SID_A,
      agent_id: SUB,
      path: STRICT,
      content_hash: HASH_2,
    });
    assert.deepEqual(read, { status: "fresh", version: 2 });
  } finally {
    await s.cleanup();
  }
});

test("after a Stop, /status lists the session as a reader of the file it released", async () => {
  const s = await makeServer();
  try {
    await editAndCommit(s, { session_id: SID_A, path: STRICT }, HASH_2);
    await s.post("/hooks/session-stop", { session_id: SID_A });

    const status = await s.get("/status");
    const rows = status.sessions as Array<{ agent_id: string; states: Record<string, string> }>;
    const mine = rows.find((row) => row.agent_id === sessionToAgentId(SID_A));
    assert.deepEqual(mine?.states, { [STRICT]: MESIState.SHARED });
  } finally {
    await s.cleanup();
  }
});

test("after a Stop, a shell read and a grep of the session's own strict file are fresh", async () => {
  const s = await makeServer();
  try {
    await editAndCommit(s, { session_id: SID_A, path: STRICT }, HASH_2);
    await s.post("/hooks/session-stop", { session_id: SID_A });

    assert.deepEqual(await s.post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT}` }), {
      status: "fresh",
    });
    assert.deepEqual(await s.post("/hooks/pre-grep", { session_id: SID_A, search_root: "" }), { status: "fresh" });
    assert.equal(stateOf(s, STRICT, sessionToAgentId(SID_A)), MESIState.SHARED);
  } finally {
    await s.cleanup();
  }
});

test("an edit that reached the disk but never committed reads as a change outside the coordinator after a Stop", async () => {
  const s = await makeServer();
  try {
    s.registry.resolveOrRegisterArtifact(STRICT, HASH_1);
    assert.equal((await s.post("/hooks/pre-edit", { session_id: SID_A, path: STRICT })).ok, true);
    // The edit lands on disk; its post-edit never reaches the coordinator.
    const bytes = "edited by session A\n";
    writeFileSync(join(s.root, STRICT), bytes, "utf8");
    const diskHash = createHash("sha256").update(bytes).digest("hex");
    assert.deepEqual(await s.post("/hooks/session-stop", { session_id: SID_A }), {
      ok: true,
      released_artifacts: [STRICT],
    });

    const read = await s.post("/hooks/pre-read", { session_id: SID_A, path: STRICT, content_hash: diskHash });
    const reason = denyReason(read);
    assert.match(reason, /^Stale read denied: plan\.md on disk no longer matches v1, /);
    assert.ok(reason.includes("Do not restore or overwrite plan.md"), reason);
    const edit = await s.post("/hooks/pre-edit", { session_id: SID_A, path: STRICT });
    assert.equal(edit.ok, true);
    assert.equal(edit.disk_differs, true);
    assert.equal(stateOf(s, STRICT, sessionToAgentId(SID_A)), MESIState.EXCLUSIVE);
  } finally {
    await s.cleanup();
  }
});

test("a reader's failed edit leaves it a reader", async () => {
  const s = await makeServer();
  try {
    const first = await s.post("/hooks/pre-read", { session_id: SID_A, path: STRICT, content_hash: HASH_1 });
    assert.deepEqual(first, { status: "fresh", version: 1 });
    const failed = await s.post("/hooks/post-edit", { session_id: SID_A, path: STRICT, success: false });
    assert.deepEqual(failed, { ok: true, released: true });
    assert.equal(stateOf(s, STRICT, sessionToAgentId(SID_A)), MESIState.SHARED);

    const read = await s.post("/hooks/pre-read", { session_id: SID_A, path: STRICT, content_hash: HASH_1 });
    assert.deepEqual(read, { status: "fresh", version: 1 });
  } finally {
    await s.cleanup();
  }
});

// ------------------------------------------------------------ a peer still makes the copy stale

test("after the release, a peer's edit and commit leave the session denied as updated by the peer", async () => {
  const s = await makeServer();
  try {
    await editAndCommit(s, { session_id: SID_A, path: STRICT }, HASH_2);
    await s.post("/hooks/session-stop", { session_id: SID_A });
    await editAndCommit(s, { session_id: SID_B, path: STRICT }, HASH_3);
    assert.equal(stateOf(s, STRICT, sessionToAgentId(SID_A)), MESIState.INVALID);

    const read = await s.post("/hooks/pre-read", { session_id: SID_A, path: STRICT, content_hash: HASH_3 });
    assert.match(denyReason(read), /^Stale read denied: plan\.md was updated by agent /);
    const edit = await s.post("/hooks/pre-edit", { session_id: SID_A, path: STRICT });
    assert.equal(edit.ok, false);
    assert.match(denyReason(edit), /^Stale read denied: plan\.md was updated by agent /);
  } finally {
    await s.cleanup();
  }
});

test("after the release, a peer's edit with no commit leaves the session denied as revoked", async () => {
  const s = await makeServer();
  try {
    await editAndCommit(s, { session_id: SID_A, path: STRICT }, HASH_2);
    await s.post("/hooks/session-stop", { session_id: SID_A });
    assert.equal((await s.post("/hooks/pre-edit", { session_id: SID_B, path: STRICT })).ok, true);
    assert.equal(stateOf(s, STRICT, sessionToAgentId(SID_A)), MESIState.INVALID);

    const read = await s.post("/hooks/pre-read", { session_id: SID_A, path: STRICT, content_hash: HASH_2 });
    assert.match(denyReason(read), /^Stale read denied: your grant on plan\.md was revoked and no new version/);
    const edit = await s.post("/hooks/pre-edit", { session_id: SID_A, path: STRICT });
    assert.equal(edit.ok, false);
    assert.match(denyReason(edit), /^Stale read denied: your grant on plan\.md was revoked and no new version/);
  } finally {
    await s.cleanup();
  }
});

test("a successful edit reported after the same session's failed edit is refused, naming the caller SHARED", async () => {
  const s = await makeServer();
  try {
    const artifactId = s.registry.resolveOrRegisterArtifact(STRICT, HASH_1);
    const agentId = sessionToAgentId(SID_A);
    // Two edits of one file in one turn; the failed one reports first.
    assert.equal((await s.post("/hooks/pre-edit", { session_id: SID_A, path: STRICT })).ok, true);
    assert.equal((await s.post("/hooks/pre-edit", { session_id: SID_A, path: STRICT })).ok, true);
    const failed = await s.post("/hooks/post-edit", { session_id: SID_A, path: STRICT, success: false });
    assert.deepEqual(failed, { ok: true, released: true });

    const late = await s.post("/hooks/post-edit", {
      session_id: SID_A,
      path: STRICT,
      success: true,
      content_hash: HASH_2,
    });
    assert.deepEqual(late, {
      ok: false,
      reason:
        `commit_not_allowed: agent=${agentId} artifact=${artifactId} state=SHARED ` +
        `(must be EXCLUSIVE or MODIFIED to commit)`,
    });
    assert.equal(stateOf(s, STRICT, agentId), MESIState.SHARED);
  } finally {
    await s.cleanup();
  }
});

test("a failed edit reported after a peer took the file and committed leaves the session denied", async () => {
  const s = await makeServer();
  try {
    s.registry.resolveOrRegisterArtifact(STRICT, HASH_1);
    assert.equal((await s.post("/hooks/pre-edit", { session_id: SID_A, path: STRICT })).ok, true);
    await editAndCommit(s, { session_id: SID_B, path: STRICT }, HASH_2);
    const failed = await s.post("/hooks/post-edit", { session_id: SID_A, path: STRICT, success: false });
    assert.deepEqual(failed, { ok: true, released: true });
    assert.equal(stateOf(s, STRICT, sessionToAgentId(SID_A)), MESIState.INVALID);

    const read = await s.post("/hooks/pre-read", { session_id: SID_A, path: STRICT, content_hash: HASH_2 });
    assert.match(denyReason(read), /^Stale read denied: plan\.md was updated by agent /);
  } finally {
    await s.cleanup();
  }
});

// ------------------------------------------------------------ warn mode admits an edit of a stale copy

/**
 * Session A reads `path` at v1, then B edits and commits it, so A's copy is
 * stale (INVALID). Returns A's pre-edit answer.
 */
async function editAfterPeerCommit(s: Server, path: string): Promise<Record<string, unknown>> {
  const read = await s.post("/hooks/pre-read", { session_id: SID_A, path, content_hash: HASH_1 });
  assert.deepEqual(read, { status: "fresh", version: 1 });
  await editAndCommit(s, { session_id: SID_B, path }, HASH_2);
  assert.equal(stateOf(s, path, sessionToAgentId(SID_A)), MESIState.INVALID);
  return s.post("/hooks/pre-edit", { session_id: SID_A, path });
}

const UPDATED_BY_PEER = `Stale read denied: ${STRICT} was updated by agent `;

// A known limit of warn mode: the admitted edit takes the write grant at the
// current version, so releasing that grant leaves a read of the current
// version and the stale-read warning A would have got is never shown.
for (const [name, release] of [
  [
    "a failed edit",
    async (s: Server) =>
      assert.deepEqual(await s.post("/hooks/post-edit", { session_id: SID_A, path: WARN, success: false }), {
        ok: true,
        released: true,
      }),
  ],
  [
    "a Stop",
    async (s: Server) =>
      assert.deepEqual(await s.post("/hooks/session-stop", { session_id: SID_A }), {
        ok: true,
        released_artifacts: [WARN],
      }),
  ],
] as const) {
  test(`in warn mode, an edit of a copy a peer made stale is admitted, and after ${name} the next read is fresh`, async () => {
    const s = await makeServer();
    try {
      const edit = await editAfterPeerCommit(s, WARN);
      assert.equal(edit.ok, true);
      assert.equal(stateOf(s, WARN, sessionToAgentId(SID_A)), MESIState.EXCLUSIVE);

      await release(s);
      assert.equal(stateOf(s, WARN, sessionToAgentId(SID_A)), MESIState.SHARED);
      const read = await s.post("/hooks/pre-read", { session_id: SID_A, path: WARN, content_hash: HASH_2 });
      assert.deepEqual(read, { status: "fresh", version: 2 });
    } finally {
      await s.cleanup();
    }
  });
}

test("in strict mode, an edit of a copy a peer made stale is denied and the session stays stale", async () => {
  const s = await makeServer();
  try {
    const edit = await editAfterPeerCommit(s, STRICT);
    assert.equal(edit.ok, false);
    assert.ok(denyReason(edit).startsWith(UPDATED_BY_PEER));
    assert.equal(stateOf(s, STRICT, sessionToAgentId(SID_A)), MESIState.INVALID);

    assert.deepEqual(await s.post("/hooks/session-stop", { session_id: SID_A }), {
      ok: true,
      released_artifacts: [],
    });
    assert.equal(stateOf(s, STRICT, sessionToAgentId(SID_A)), MESIState.INVALID);
    const read = await s.post("/hooks/pre-read", { session_id: SID_A, path: STRICT, content_hash: HASH_2 });
    assert.ok(denyReason(read).startsWith(UPDATED_BY_PEER));
  } finally {
    await s.cleanup();
  }
});
