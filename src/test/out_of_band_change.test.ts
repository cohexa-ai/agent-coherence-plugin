/**
 * #205 — out-of-band change signals, mirroring the library's #278 (PR #360).
 * A session holding a valid grant (SHARED, EXCLUSIVE or MODIFIED) whose bytes
 * differ from the recorded content at an unchanged version saw a change no
 * session committed. Pre-read answers `hash_differs` and a context-only
 * notice in warn mode, and the out-of-band deny in strict mode; pre-edit
 * hashes the file on disk after an admitted acquire and answers
 * `disk_differs` with the same notice. The template bytes below are copied
 * from the library's `hook_payloads.py`, not from the Node constants, so a
 * drift on either side fails here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";

const SECRET = "s".repeat(32);
const SID_A = "44444444-4444-4444-8444-444444444444";
const SID_B = "55555555-5555-5555-8555-555555555555";
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const HASH_3 = "3".repeat(64);

const notice = (path: string, version: number) =>
  `⚠ ${path} on disk differs from v${version}, the last content committed through the coordinator, ` +
  `and no session committed the change: it was made outside the coordinator. Read ${path} before relying ` +
  `on it, and do not write it from an earlier read; that write would replace the change.`;

const outOfBandDeny = (path: string, version: number) =>
  `Stale read denied: ${path} on disk no longer matches v${version}, the version you last read, and no ` +
  `session committed the change, so it was made outside the coordinator. Do not restore or overwrite ` +
  `${path}: the change may be your user's work. Tell your user that ${path} changed outside the ` +
  `coordinator; the read stays denied until the change is committed through the coordinator. This ` +
  `denial is structural (v0.2 strict mode); retrying the same operation will produce the same denial.`;

async function makeServer(strictPatterns: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "out-of-band-test-"));
  mkdirSync(join(root, ".coherence"), { recursive: true });
  if (strictPatterns.length > 0) {
    writeFileSync(join(root, ".coherence", "strict_mode.yaml"), strictPatterns.map((p) => `- ${p}`).join("\n") + "\n");
  }
  const registry = new ArtifactRegistry(join(root, ".coherence", "state.db"));
  const sessions = new SessionRegistry();
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy: PolicyRef.load(root),
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
  const cleanup = () =>
    new Promise<void>((r) => {
      server.close(() => {
        registry.close();
        rmSync(root, { recursive: true, force: true });
        r();
      });
    });
  /** Age the artifact's last commit past the 5 s self-commit lag window. */
  const ageLastCommit = (seconds: number) => {
    const db = new Database(join(root, ".coherence", "state.db"));
    db.prepare("UPDATE artifacts SET updated_at = updated_at - ?").run(seconds);
    db.close();
  };
  return { registry, sessions, post, cleanup, root, ageLastCommit };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const readA = (post: (p: string, b: unknown) => Promise<Record<string, unknown>>, hash: string) =>
  post("/hooks/pre-read", { session_id: SID_A, path: "CLAUDE.md", content_hash: hash });

// ------------------------------------------------------------ pre-read, warn

test("pre-read, warn: a SHARED reader whose bytes changed out of band gets hash_differs and a context-only notice (#205)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    registry.grantShared(id, sessions.registerSession(SID_A), 10);
    const r = await readA(post, HASH_2);
    assert.deepEqual(r, {
      status: "fresh",
      hash_differs: true,
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notice("CLAUDE.md", 1) },
    });
  } finally {
    await cleanup();
  }
});

test("pre-read, warn: an EXCLUSIVE holder gets the notice too, not only a SHARED one (#205)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    registry.acquireExclusive(id, sessions.registerSession(SID_A), 10);
    const r = await readA(post, HASH_2);
    assert.equal(r.hash_differs, true);
    assert.deepEqual(r.hookSpecificOutput, { hookEventName: "PreToolUse", additionalContext: notice("CLAUDE.md", 1) });
  } finally {
    await cleanup();
  }
});

test("pre-read, warn: a MODIFIED holder's own recent commit sets hash_differs with no notice; once aged, it gets the notice (#205)", async () => {
  const { registry, sessions, post, cleanup, ageLastCommit } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.acquireExclusive(id, agentA, 10);
    registry.commit(id, agentA, HASH_2, 11);
    assert.deepEqual(await readA(post, HASH_3), { status: "fresh", hash_differs: true });
    ageLastCommit(6);
    const aged = await readA(post, HASH_3);
    assert.equal(aged.hash_differs, true);
    assert.deepEqual(aged.hookSpecificOutput, {
      hookEventName: "PreToolUse",
      additionalContext: notice("CLAUDE.md", 2),
    });
  } finally {
    await cleanup();
  }
});

test("pre-read, warn: a drained preemption notice and the out-of-band notice share one allow envelope (#205)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const other = registry.resolveOrRegisterArtifact("other.md", HASH_1);
    registry.grantShared(id, sessions.registerSession(SID_A), 9);
    // A held other.md and lost it to B, so a preemption notice is queued for A.
    registry.acquireExclusive(other, sessions.registerSession(SID_A), 10);
    registry.acquireExclusive(other, sessions.registerSession(SID_B), 11);
    const r = await readA(post, HASH_2);
    assert.equal(r.hash_differs, true);
    const hso = r.hookSpecificOutput as Record<string, unknown>;
    assert.equal(hso.permissionDecision, "allow");
    const context = String(hso.additionalContext);
    assert.ok(context.endsWith("\n\n" + notice("CLAUDE.md", 1)), context);
    assert.ok(context.includes("other.md"), context);
    assert.equal(registry.getArtifactById(id)!.version, 1);
  } finally {
    await cleanup();
  }
});

test("pre-read: a pending re-grounding rides the same context-only envelope, after the notice (#205)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    registry.grantShared(id, sessions.registerSession(SID_A), 10);
    const armed = await post("/hooks/session-start", { session_id: SID_A });
    assert.ok(armed.hookSpecificOutput !== undefined);
    const r = await readA(post, HASH_2);
    const hso = r.hookSpecificOutput as Record<string, unknown>;
    assert.equal("permissionDecision" in hso, false);
    const context = String(hso.additionalContext);
    assert.ok(context.startsWith(notice("CLAUDE.md", 1) + "\n\nPost-compaction re-grounding"), context);
    // Delivered once: the next read carries no re-grounding.
    const again = await readA(post, HASH_2);
    assert.equal((again.hookSpecificOutput as Record<string, unknown>).additionalContext, notice("CLAUDE.md", 1));
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------- pre-read, strict

test("pre-read, strict: an EXCLUSIVE holder's out-of-band change is denied with the out-of-band text (#205)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer(["CLAUDE.md"]);
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    registry.acquireExclusive(id, sessions.registerSession(SID_A), 10);
    const r = await readA(post, HASH_2);
    assert.equal(r.status, "stale");
    const hso = r.hookSpecificOutput as Record<string, unknown>;
    assert.equal(hso.permissionDecision, "deny");
    assert.equal(hso.permissionDecisionReason, outOfBandDeny("CLAUDE.md", 1));
  } finally {
    await cleanup();
  }
});

test("pre-read, strict: a MODIFIED holder's own recent commit is not denied (#205)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer(["CLAUDE.md"]);
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.acquireExclusive(id, agentA, 10);
    registry.commit(id, agentA, HASH_2, 11);
    assert.deepEqual(await readA(post, HASH_3), { status: "fresh", hash_differs: true });
  } finally {
    await cleanup();
  }
});

test("pre-read, strict: an INVALID reader whose grant a peer revoked keeps the write template (#205)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer(["CLAUDE.md"]);
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    registry.grantShared(id, sessions.registerSession(SID_A), 9);
    // B's pre-edit revoked A's grant: the change went through the coordinator.
    registry.acquireExclusive(id, sessions.registerSession(SID_B), 10);
    const r = await readA(post, HASH_2);
    const reason = String((r.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason);
    assert.notEqual(reason, outOfBandDeny("CLAUDE.md", 1));
    assert.ok(reason.startsWith("Stale read denied: CLAUDE.md "), reason);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------------ pre-edit

test("pre-edit: the file on disk no longer holds the recorded content → disk_differs and the notice, still admitted (#205)", async () => {
  const { registry, post, cleanup, root } = await makeServer();
  try {
    registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    writeFileSync(join(root, "CLAUDE.md"), "edited outside the coordinator\n");
    const r = await post("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.deepEqual(r, {
      ok: true,
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notice("CLAUDE.md", 1) },
      disk_differs: true,
    });
  } finally {
    await cleanup();
  }
});

test("pre-edit, strict: an admitted editor still gets disk_differs; the check never denies (#205)", async () => {
  const { registry, post, cleanup, root } = await makeServer(["CLAUDE.md"]);
  try {
    registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    writeFileSync(join(root, "CLAUDE.md"), "edited outside the coordinator\n");
    const r = await post("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.equal(r.ok, true);
    assert.equal(r.disk_differs, true);
  } finally {
    await cleanup();
  }
});

test("pre-edit: no disk_differs when the disk matches, the file is missing, or the record has no content claim (#205)", async () => {
  const { registry, post, cleanup, root } = await makeServer();
  try {
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    const text = "the recorded content\n";
    writeFileSync(join(root, "docs", "plans", "same.md"), text);
    registry.resolveOrRegisterArtifact("docs/plans/same.md", sha256(text));
    registry.resolveOrRegisterArtifact("docs/plans/missing.md", HASH_1);
    writeFileSync(join(root, "docs", "plans", "unclaimed.md"), "anything\n");
    registry.resolveOrRegisterArtifact("docs/plans/unclaimed.md", "f".repeat(64));
    writeFileSync(join(root, "docs", "plans", "empty-claim.md"), "anything\n");
    registry.resolveOrRegisterArtifact("docs/plans/empty-claim.md", "");
    for (const name of ["same", "missing", "unclaimed", "empty-claim"]) {
      const path = `docs/plans/${name}.md`;
      // An untracked path fast-admits before the check, which would prove nothing.
      assert.equal(PolicyRef.load(root).isTracked(path), true, path);
      assert.deepEqual(await post("/hooks/pre-edit", { session_id: SID_A, path }), { ok: true }, path);
    }
  } finally {
    await cleanup();
  }
});

test("pre-edit: the caller's own recent commit explains a differing disk (#205)", async () => {
  const { registry, sessions, post, cleanup, root } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.acquireExclusive(id, agentA, 10);
    registry.commit(id, agentA, HASH_2, 11);
    writeFileSync(join(root, "CLAUDE.md"), "bytes still landing\n");
    assert.deepEqual(await post("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" }), { ok: true });
  } finally {
    await cleanup();
  }
});

test("pre-edit: a peer's write still in flight skips the check; a committed peer's change is reported after the collision (#205)", async () => {
  const { registry, post, cleanup, root } = await makeServer();
  try {
    registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    writeFileSync(join(root, "CLAUDE.md"), "a peer is writing\n");
    // B holds EXCLUSIVE and has not committed: its write may still be landing.
    assert.equal((await post("/hooks/pre-edit", { session_id: SID_B, path: "CLAUDE.md" })).ok, true);
    const inFlight = await post("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.equal(inFlight.collision, true);
    assert.equal("disk_differs" in inFlight, false);

    // B takes the file back and commits HASH_2; the disk still holds other bytes.
    assert.equal((await post("/hooks/pre-edit", { session_id: SID_B, path: "CLAUDE.md" })).ok, true);
    await post("/hooks/post-edit", { session_id: SID_B, path: "CLAUDE.md", success: true, content_hash: HASH_2 });
    const committed = await post("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.equal(committed.collision, true);
    assert.equal(committed.disk_differs, true);
    const context = String((committed.hookSpecificOutput as Record<string, unknown>).additionalContext);
    assert.ok(context.endsWith("\n\n" + notice("CLAUDE.md", 2)), context);
  } finally {
    await cleanup();
  }
});

test("pre-read: a record with no content claim never reports an out-of-band change, in either mode (#205)", async () => {
  for (const strict of [[], ["docs/plans/*.md"]]) {
    const { registry, sessions, post, cleanup, root } = await makeServer(strict);
    try {
      for (const [name, recorded] of [["empty", ""], ["sentinel", "f".repeat(64)]] as const) {
        const path = `docs/plans/${name}.md`;
        assert.equal(PolicyRef.load(root).isTracked(path), true, path);
        const id = registry.resolveOrRegisterArtifact(path, recorded);
        registry.grantShared(id, sessions.registerSession(SID_A), 10);
        const r = await post("/hooks/pre-read", { session_id: SID_A, path, content_hash: HASH_2 });
        assert.deepEqual(r, { status: "fresh" }, `${path} strict=${strict.length > 0}`);
      }
    } finally {
      await cleanup();
    }
  }
});

test("pre-edit: the caller's own uncommitted claim is not a peer's write in flight (#205)", async () => {
  const { registry, post, cleanup, root } = await makeServer();
  try {
    registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    writeFileSync(join(root, "CLAUDE.md"), "edited outside the coordinator\n");
    // A's first pre-edit takes EXCLUSIVE and never commits; its second must still be told.
    for (let i = 0; i < 2; i++) {
      const r = await post("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
      assert.equal(r.disk_differs, true, `attempt ${i + 1}`);
    }
  } finally {
    await cleanup();
  }
});

test("pre-edit: a drained preemption notice and the out-of-band notice share one allow envelope (#205)", async () => {
  const { registry, sessions, post, cleanup, root } = await makeServer();
  try {
    registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const other = registry.resolveOrRegisterArtifact("other.md", HASH_1);
    registry.acquireExclusive(other, sessions.registerSession(SID_A), 10);
    registry.acquireExclusive(other, sessions.registerSession(SID_B), 11);
    writeFileSync(join(root, "CLAUDE.md"), "edited outside the coordinator\n");
    const r = await post("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.equal(r.ok, true);
    assert.equal(r.disk_differs, true);
    const hso = r.hookSpecificOutput as Record<string, unknown>;
    assert.equal(hso.permissionDecision, "allow");
    const context = String(hso.additionalContext);
    assert.ok(context.includes("other.md"), context);
    assert.ok(context.endsWith("\n\n" + notice("CLAUDE.md", 1)), context);
  } finally {
    await cleanup();
  }
});

test("pre-edit: a pending re-grounding rides the out-of-band notice's envelope, after it (#205)", async () => {
  const { registry, sessions, post, cleanup, root } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    registry.grantShared(id, sessions.registerSession(SID_A), 10);
    assert.ok((await post("/hooks/session-start", { session_id: SID_A })).hookSpecificOutput !== undefined);
    writeFileSync(join(root, "CLAUDE.md"), "edited outside the coordinator\n");
    const r = await post("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.equal(r.disk_differs, true);
    const hso = r.hookSpecificOutput as Record<string, unknown>;
    assert.equal("permissionDecision" in hso, false);
    const context = String(hso.additionalContext);
    assert.ok(context.startsWith(notice("CLAUDE.md", 1) + "\n\nPost-compaction re-grounding"), context);
  } finally {
    await cleanup();
  }
});

test("pre-edit: a nested tracked path is hashed where it lives (#205)", async () => {
  const { registry, post, cleanup, root } = await makeServer();
  try {
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    registry.resolveOrRegisterArtifact("docs/plans/x.md", HASH_1);
    writeFileSync(join(root, "docs", "plans", "x.md"), "edited outside the coordinator\n");
    const r = await post("/hooks/pre-edit", { session_id: SID_A, path: "docs/plans/x.md" });
    assert.deepEqual(r, {
      ok: true,
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notice("docs/plans/x.md", 1) },
      disk_differs: true,
    });
  } finally {
    await cleanup();
  }
});
