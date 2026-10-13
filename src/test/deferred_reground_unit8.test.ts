/**
 * SB-10 U8 — deferred re-grounding delivery on the next qualifying admit.
 *
 * Node mirror of the Python U4 suite (agent-coherence a69a68d,
 * `test_deferred_reground_*` in test_claude_code_coordinator_server.py).
 *
 * R2: at-most-once per delivery path; the flag is consumed by the FIRST
 * qualifying PARENT admit and expires at parent Stop. R8: the payload
 * attaches ONLY to allow envelopes; a request carrying agent_id neither
 * consumes nor attaches; strict-deny bodies stay byte-identical. KTD6: the
 * seam rides the four admit surfaces (pre-read, pre-edit, pre-bash,
 * pre-grep), with the advisory flag peek hoisted above the untracked
 * fast-path exits so no-flag traffic keeps today's exact bytes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";

const SECRET = "s".repeat(32);
const SID_A = "44444444-4444-4444-8444-444444444444";
const SID_B = "55555555-5555-5555-8555-555555555555";
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);

const SS_HEADER = "Post-compaction re-grounding (agent-coherence):";

async function makeServer(strictPatterns: string[] = []) {
  const tmp = mkdtempSync(join(tmpdir(), "reground8-test-"));
  mkdirSync(join(tmp, ".coherence"), { recursive: true });
  if (strictPatterns.length > 0) {
    writeFileSync(
      join(tmp, ".coherence", "strict_mode.yaml"),
      strictPatterns.map((p) => `- ${p}`).join("\n") + "\n",
      "utf8",
    );
  }
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
  // Returns the RAW body text alongside the parse: the byte-stability pins
  // in this suite compare wire bytes, not re-serialized objects.
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
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
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

type Post = Awaited<ReturnType<typeof makeServer>>["post"];

function decision(body: Record<string, unknown>): string | undefined {
  return (body.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision as
    | string
    | undefined;
}

/** The additionalContext of an admit response's hook envelope, or null. */
function regroundTextOf(body: Record<string, unknown>): string | null {
  const hso = body.hookSpecificOutput as Record<string, unknown> | undefined;
  if (hso === undefined) return null;
  return (hso.additionalContext as string | undefined) ?? null;
}

/**
 * Give the session coordination state (SHARED on CLAUDE.md), then arm the
 * deferred flag via the REAL /hooks/session-start endpoint (KTD5). Returns
 * the payload text the arming call rendered — KTD2's rebuild-at-delivery
 * means the deferred copy must byte-match it as long as no state moves in
 * between. Mirrors Python `_arm_reground`.
 */
async function armReground(post: Post, sid: string): Promise<string> {
  await post("/hooks/pre-read", { session_id: sid, path: "CLAUDE.md", content_hash: HASH_1 });
  const r = await post("/hooks/session-start", { session_id: sid });
  assert.equal(r.status, 200);
  assert.notDeepEqual(r.body, {});
  return (r.body.hookSpecificOutput as Record<string, unknown>).additionalContext as string;
}

// ------------------------------------------------- strict-deny byte stability
//
// R8/KTD-P pin, written FIRST and green throughout the unit: arming the
// compact-pending flag must not move a single strict-deny byte — the deny
// returns before any prepend, never carries additionalContext, and never
// consumes the flag. `warning_generated_at_unix_ts` is handler-time BY
// DESIGN (per-invocation variation is the Phase 0 structural defense), so
// the raw-byte comparison masks exactly that one field and nothing else.

const maskWarnTs = (text: string): string =>
  text.replace(/"warning_generated_at_unix_ts":[0-9.]+/, '"warning_generated_at_unix_ts":0');

test("strict deny with pending flag: deny bytes identical, no additionalContext, flag survives (R8/KTD-P)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer(["CLAUDE.md"]);
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.grantShared(id, agentA, 10); // A observed v1
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 20); // A → INVALID
    registry.commit(id, agentB, HASH_2, 30); // v2, last_writer = B

    // Baseline deny, BEFORE any flag exists (today's bytes).
    const baseline = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(baseline.status, 200);
    assert.equal(decision(baseline.body), "deny");

    // Arm the flag, then re-issue the IDENTICAL denied request.
    sessions.markCompactPending(SID_A);
    const flagged = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(flagged.status, 200);
    assert.equal(decision(flagged.body), "deny");
    // Raw wire bytes identical modulo the by-design handler timestamp.
    assert.equal(maskWarnTs(flagged.text), maskWarnTs(baseline.text));
    // The reason text itself is fully deterministic — byte-equal unmasked
    // (the existing strict fixtures' KTD-T sticky-retry expectation).
    assert.equal(
      (flagged.body.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason,
      (baseline.body.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason,
    );
    // Deny envelopes never grow an additionalContext key, flagged or not.
    assert.ok(!baseline.text.includes("additionalContext"));
    assert.ok(!flagged.text.includes("additionalContext"));
    assert.ok(!flagged.text.includes("Post-compaction"));
    // The deny consumed nothing: the flag is still pending afterwards.
    assert.equal(sessions.consumeCompactPending(SID_A), true);
  } finally {
    await cleanup();
  }
});

test("after a strict deny, the follow-up allowed re-read renders notices → stale warning → re-ground (KTD6 order)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer(["CLAUDE.md"]);
  try {
    // A holds EXCLUSIVE on strict CLAUDE.md and warn-mode plan.md; B preempts
    // and commits BOTH (A → INVALID, notices queued for A on both).
    const cid = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const pid = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.acquireExclusive(cid, agentA, 10);
    registry.acquireExclusive(pid, agentA, 10);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(cid, agentB, 20);
    registry.commit(cid, agentB, HASH_2, 30);
    registry.acquireExclusive(pid, agentB, 20);
    registry.commit(pid, agentB, HASH_2, 30);

    // Arm via the REAL endpoint (A's INVALID rows render a non-empty build).
    const armed = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(armed.status, 200);
    assert.notDeepEqual(armed.body, {});

    // Strict deny: no attach, no consume, notices untouched.
    const denied = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(decision(denied.body), "deny");
    assert.ok(!denied.text.includes("additionalContext"));
    assert.equal(sessions.hasCompactPending(SID_A), true);

    // Follow-up ALLOWED re-read (warn-mode plan.md): one envelope carrying
    // notices first, the stale warning next, the re-grounding block last.
    const followUp = await post("/hooks/pre-read", { session_id: SID_A, path: "plan.md" });
    assert.equal(decision(followUp.body), "allow");
    const text = regroundTextOf(followUp.body) ?? "";
    const noticeAt = text.indexOf("silently revoked");
    const staleAt = text.indexOf("⚠ Stale read");
    const regroundAt = text.indexOf(SS_HEADER);
    assert.ok(noticeAt !== -1, "preemption notice must render");
    assert.ok(staleAt !== -1, "stale warning must render");
    assert.ok(regroundAt !== -1, "re-grounding block must render");
    assert.ok(noticeAt < staleAt && staleAt < regroundAt, "order: notices → stale → re-ground");
    assert.equal(sessions.hasCompactPending(SID_A), false);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ pre-read seams

test("pending flag + tracked pre-read allow → re-ground block attached once; next admit clean", async () => {
  const { post, cleanup } = await makeServer();
  try {
    const armedText = await armReground(post, SID_A);
    const r = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "fresh");
    const out = r.body.hookSpecificOutput as Record<string, unknown>;
    // Context-only: the advisory payload adds context, never a decision.
    assert.deepEqual(out, {
      hookEventName: "PreToolUse",
      // KTD2 rebuild-at-delivery: byte-identical to the arming render as
      // long as no state moved in between.
      additionalContext: armedText,
    });
    // Consumed: the very next admit is today's bare fresh bytes.
    const r2 = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.text, '{"status":"fresh"}');
  } finally {
    await cleanup();
  }
});

test("pending flag + untracked pre-read → delivered via envelope; next untracked call byte-matches the pre-flag baseline", async () => {
  const { post, cleanup } = await makeServer();
  try {
    // Pre-flag baseline: today's exact fast-path bytes.
    const baseline = await post("/hooks/pre-read", { session_id: SID_A, path: "notes.txt" });
    assert.equal(baseline.status, 200);
    assert.equal(baseline.text, '{"status":"fresh"}');

    const armedText = await armReground(post, SID_A);
    const r = await post("/hooks/pre-read", { session_id: SID_A, path: "notes.txt" });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "fresh");
    const out = r.body.hookSpecificOutput as Record<string, unknown>;
    // Context-only envelope: an untracked read that would otherwise prompt
    // the user must not be auto-approved as a side effect of delivery.
    assert.deepEqual(out, { hookEventName: "PreToolUse", additionalContext: armedText });

    const r2 = await post("/hooks/pre-read", { session_id: SID_A, path: "notes.txt" });
    assert.equal(r2.status, 200);
    assert.equal(r2.text, baseline.text);
  } finally {
    await cleanup();
  }
});

test("no flag + untracked pre-read → byte-identical fast path with ZERO artifact-registry access (KTD6)", async () => {
  // The ArtifactRegistry is swapped for a proxy that explodes on ANY
  // property access — a touched registry would 500 the request. Only the
  // SessionRegistry's process-local peek is allowed on this path.
  const tmp = mkdtempSync(join(tmpdir(), "reground8-noreg-"));
  const realRegistry = new ArtifactRegistry(join(tmp, ".coherence", "state.db"));
  const exploding = new Proxy(realRegistry, {
    get(_target, prop) {
      throw new Error(`registry touched on untracked fast path: ${String(prop)}`);
    },
  });
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: "test",
    registry: exploding,
    policy: PolicyRef.load(tmp),
    sessions: new SessionRegistry(),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hooks/pre-read`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        Host: "127.0.0.1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: SID_A, path: "notes.txt" }),
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"status":"fresh"}');
  } finally {
    await new Promise<void>((r) => {
      server.close(() => {
        realRegistry.close();
        rmSync(tmp, { recursive: true, force: true });
        r();
      });
    });
  }
});

// ------------------------------------------------------- subagent identity

test("R8: a request carrying agent_id neither consumes nor attaches — the payload waits for the parent", async () => {
  const { post, sessions, cleanup } = await makeServer();
  try {
    await armReground(post, SID_A);
    // Untracked subagent admit: today's bare fast-path bytes, flag intact.
    const sub = await post("/hooks/pre-read", {
      session_id: SID_A,
      agent_id: "sub1",
      path: "notes.txt",
    });
    assert.equal(sub.status, 200);
    assert.equal(sub.text, '{"status":"fresh"}');
    assert.equal(sessions.hasCompactPending(SID_A), true);
    // Tracked subagent admit: the subagent's first read of the existing
    // artifact yields the ordinary warn-stale envelope — but never the
    // re-grounding block, and the flag survives.
    const sub2 = await post("/hooks/pre-read", {
      session_id: SID_A,
      agent_id: "sub1",
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(sub2.status, 200);
    assert.ok(!(regroundTextOf(sub2.body) ?? "").includes(SS_HEADER));
    assert.equal(sessions.hasCompactPending(SID_A), true);
    // The parent's next admit delivers (rebuilt from CURRENT registry truth
    // per KTD2 — the subagent's grant above renders as its own group).
    const parent = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(parent.status, 200);
    const delivered = regroundTextOf(parent.body) ?? "";
    assert.ok(delivered.startsWith(SS_HEADER));
    assert.ok(delivered.includes("Subagent sub1:"));
    assert.equal(sessions.hasCompactPending(SID_A), false);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ flag lifetime

test("SubagentStop keeps the flag; a parent session-stop expires it (R2)", async () => {
  const { post, sessions, cleanup } = await makeServer();
  try {
    await armReground(post, SID_A);
    const subStop = await post("/hooks/session-stop", { session_id: SID_A, agent_id: "sub1" });
    assert.equal(subStop.status, 200);
    assert.equal(sessions.hasCompactPending(SID_A), true);
    // Present-but-MALFORMED agent_id also presents the field: refused
    // upstream, flag untouched (parity with the Python guard ordering).
    const badStop = await post("/hooks/session-stop", { session_id: SID_A, agent_id: "bad!chars" });
    assert.equal(badStop.status, 200);
    assert.equal(sessions.hasCompactPending(SID_A), true);
    const parentStop = await post("/hooks/session-stop", { session_id: SID_A });
    assert.equal(parentStop.status, 200);
    assert.equal(sessions.hasCompactPending(SID_A), false);
    // Expired means expired: the next admit is today's bare shape.
    const r = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(r.status, 200);
    assert.equal(r.text, '{"status":"fresh"}');
  } finally {
    await cleanup();
  }
});

test("a second session-start re-marks idempotently: still exactly one delivery", async () => {
  const { post, cleanup } = await makeServer();
  try {
    await armReground(post, SID_A);
    const second = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(second.status, 200);
    const armedText = (second.body.hookSpecificOutput as Record<string, unknown>)
      .additionalContext as string;
    const first = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(regroundTextOf(first.body), armedText);
    const after = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(after.text, '{"status":"fresh"}');
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------- other admit seams

test("pre-edit attach point: {ok:true} rides a new context-only envelope; rebuild renders the CURRENT (EXCLUSIVE) grant", async () => {
  const { post, cleanup } = await makeServer();
  try {
    await armReground(post, SID_A);
    const r = await post("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const delivered = regroundTextOf(r.body) ?? "";
    assert.ok(delivered.startsWith(SS_HEADER));
    // KTD2: this pre-edit acquired EXCLUSIVE BEFORE the attach seam ran, so
    // the delivered prose renders EXCLUSIVE — not the SHARED arming snapshot.
    assert.ok(
      delivered.includes(
        "At compaction you held EXCLUSIVE on CLAUDE.md (v1) — re-acquire before writing.",
      ),
    );
    const r2 = await post("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.equal(r2.status, 200);
    assert.equal(r2.text, '{"ok":true}');
  } finally {
    await cleanup();
  }
});

test("pre-bash attach point: delivery from BOTH the zero-tracked fast path and the tracked work path", async () => {
  const { post, sessions, cleanup } = await makeServer();
  try {
    const armedText = await armReground(post, SID_A);
    // Fast path: no tracked paths detected in the command.
    const fast = await post("/hooks/pre-bash", { session_id: SID_A, command: "echo hello" });
    assert.equal(fast.status, 200);
    assert.equal(fast.body.status, "fresh");
    assert.equal(regroundTextOf(fast.body), armedText);
    const bare = await post("/hooks/pre-bash", { session_id: SID_A, command: "echo hello" });
    assert.equal(bare.text, '{"status":"fresh"}');
    // Tracked path: session is fresh on CLAUDE.md; the flag re-armed.
    sessions.markCompactPending(SID_A);
    const tracked = await post("/hooks/pre-bash", { session_id: SID_A, command: "cat CLAUDE.md" });
    assert.equal(tracked.status, 200);
    assert.equal(tracked.body.status, "fresh");
    assert.equal(regroundTextOf(tracked.body), armedText);
  } finally {
    await cleanup();
  }
});

test("pre-grep attach point: delivery from BOTH the tracked work path and the empty-root fast path", async () => {
  const { post, sessions, cleanup } = await makeServer();
  try {
    const armedText = await armReground(post, SID_A);
    const tracked = await post("/hooks/pre-grep", { session_id: SID_A, search_root: "" });
    assert.equal(tracked.status, 200);
    assert.equal(tracked.body.status, "fresh");
    assert.equal(regroundTextOf(tracked.body), armedText);
    // Fast path: a root with no registry-known artifacts.
    sessions.markCompactPending(SID_A);
    const fast = await post("/hooks/pre-grep", { session_id: SID_A, search_root: "src/empty" });
    assert.equal(fast.status, 200);
    assert.equal(fast.body.status, "fresh");
    assert.equal(regroundTextOf(fast.body), armedText);
    const bare = await post("/hooks/pre-grep", { session_id: SID_A, search_root: "src/empty" });
    assert.equal(bare.text, '{"status":"fresh"}');
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------- permission containment
//
// The load-bearing pin for the SB-10 review finding: the advisory payload
// may ADD context, never widen a permission decision. `permissionDecision:
// "allow"` short-circuits Claude Code's own permission prompting, so a
// delivery that promoted a bare untracked admit to an allow envelope would
// auto-approve — once per compaction — a bash/edit that should have
// prompted. Verified against Claude Code CLI 2.1.233: a PreToolUse envelope
// carrying additionalContext with NO permissionDecision still has its
// context rendered to the model, so the allow buys nothing.

test("delivery on a bare admit emits a CONTEXT-ONLY envelope: the wire bytes contain no permissionDecision at all", async () => {
  const { post, sessions, cleanup } = await makeServer();
  try {
    // Every untracked/zero-tracked surface: the bodies that carry no
    // decision of their own must not acquire one from the delivery.
    const surfaces: Array<[string, Record<string, unknown>]> = [
      ["/hooks/pre-read", { session_id: SID_A, path: "notes.txt" }],
      ["/hooks/pre-edit", { session_id: SID_A, path: "notes.txt" }],
      ["/hooks/pre-bash", { session_id: SID_A, command: "echo hello" }],
      ["/hooks/pre-grep", { session_id: SID_A, search_root: "src/empty" }],
    ];
    for (const [path, body] of surfaces) {
      const armedText = await armReground(post, SID_A);
      const r = await post(path, body);
      assert.equal(r.status, 200, path);
      const out = r.body.hookSpecificOutput as Record<string, unknown>;
      // Exact key set — pins the ABSENCE, not merely a non-"allow" value.
      assert.deepEqual(
        out,
        { hookEventName: "PreToolUse", additionalContext: armedText },
        `${path}: context-only envelope`,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(out, "permissionDecision"),
        false,
        `${path}: no permissionDecision key`,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(out, "permissionDecisionReason"),
        false,
        `${path}: no permissionDecisionReason key`,
      );
      // Raw wire bytes, not the re-parsed object: nothing decision-shaped
      // may appear anywhere in the response.
      assert.ok(!r.text.includes("permissionDecision"), `${path}: wire bytes carry no decision`);
      assert.equal(sessions.hasCompactPending(SID_A), false, `${path}: flag consumed`);
    }
  } finally {
    await cleanup();
  }
});

test("delivery onto an EXISTING envelope leaves its decision untouched (merge path unchanged)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    // Warn-mode stale read: the base result already owns an allow envelope
    // with prose of its own. The merge must append the block and keep that
    // decision — containment removes MINTED decisions, never existing ones.
    const pid = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.grantShared(pid, agentA, 10);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(pid, agentB, 20); // A → INVALID
    registry.commit(pid, agentB, HASH_2, 30); // v2, last_writer = B

    const armed = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(armed.status, 200);
    assert.notDeepEqual(armed.body, {});

    const r = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "plan.md",
      content_hash: HASH_2,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "stale");
    const out = r.body.hookSpecificOutput as Record<string, unknown>;
    assert.equal(out.permissionDecision, "allow");
    const text = out.additionalContext as string;
    assert.ok(text.startsWith("⚠ Stale read"), "the base envelope's prose renders first");
    assert.ok(text.includes(SS_HEADER), "the re-grounding block is appended after it");
    assert.equal(sessions.hasCompactPending(SID_A), false);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------- at-most-once

test("R2: parallel qualifying parent admits race one flag — exactly one response carries the block", async () => {
  const { post, sessions, cleanup } = await makeServer();
  try {
    await armReground(post, SID_A);
    // Distinct tracked paths so first-observation seeding never contends on
    // one artifact row; every response is a qualifying fresh admit.
    const results = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) =>
        post("/hooks/pre-read", {
          session_id: SID_A,
          path: `docs/plans/p${i}.md`,
          content_hash: HASH_1,
        }),
      ),
    );
    const delivered = results.filter((r) => (regroundTextOf(r.body) ?? "").includes(SS_HEADER));
    assert.equal(delivered.length, 1);
    assert.equal(sessions.hasCompactPending(SID_A), false);
  } finally {
    await cleanup();
  }
});

test("pre-edit attach point: the UNTRACKED fast path delivers; next call byte-matches the pre-flag baseline", async () => {
  const { post, cleanup } = await makeServer();
  try {
    // Pre-flag baseline: today's exact untracked pre-edit bytes.
    const baseline = await post("/hooks/pre-edit", { session_id: SID_A, path: "notes.txt" });
    assert.equal(baseline.status, 200);
    assert.equal(baseline.text, '{"ok":true}');

    const armedText = await armReground(post, SID_A);
    const r = await post("/hooks/pre-edit", { session_id: SID_A, path: "notes.txt" });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const out = r.body.hookSpecificOutput as Record<string, unknown>;
    // Context-only envelope: an untracked EDIT is exactly the call that must
    // keep prompting — delivery may add context, never authority.
    assert.deepEqual(out, { hookEventName: "PreToolUse", additionalContext: armedText });

    const r2 = await post("/hooks/pre-edit", { session_id: SID_A, path: "notes.txt" });
    assert.equal(r2.status, 200);
    assert.equal(r2.text, baseline.text);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------ rebuild forfeiture

test("a rebuild failure AFTER the claim forfeits the delivery — the admit keeps its bytes (KD3)", async () => {
  // The claim is won, then `buildSessionStartContext` throws. R2 permits
  // at-most-once → zero, so the delivery is dropped rather than turning an
  // otherwise-successful admit into a 500.
  const tmp = mkdtempSync(join(tmpdir(), "reground8-forfeit-"));
  mkdirSync(join(tmp, ".coherence"), { recursive: true });
  const realRegistry = new ArtifactRegistry(join(tmp, ".coherence", "state.db"));
  let explode = false;
  const proxied = new Proxy(realRegistry, {
    get(target, prop, receiver) {
      // `allStateMaps`'s only consumer is the session-start builder, so the
      // arming call and the admit's own registry work stay untouched.
      if (explode && prop === "allStateMaps") {
        return () => {
          throw new Error("allStateMaps exploded");
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const sessions = new SessionRegistry();
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: "test",
    registry: proxied,
    policy: PolicyRef.load(tmp),
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
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  const captured: string[] = [];
  const original = process.stderr.write;
  try {
    await armReground(post, SID_A);
    assert.equal(sessions.hasCompactPending(SID_A), true);

    explode = true;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const r = await post("/hooks/pre-read", { session_id: SID_A, path: "notes.txt" });
    process.stderr.write = original;

    assert.equal(r.status, 200);
    assert.equal(r.text, '{"status":"fresh"}');
    assert.ok(!r.text.includes("Post-compaction"));
    // Claimed and forfeited: the flag is gone, not re-armed for a retry.
    assert.equal(sessions.hasCompactPending(SID_A), false);
    assert.ok(captured.join("").includes("delivery forfeited"));
  } finally {
    process.stderr.write = original;
    explode = false;
    await new Promise<void>((r) => {
      server.close(() => {
        realRegistry.close();
        rmSync(tmp, { recursive: true, force: true });
        r();
      });
    });
  }
});
