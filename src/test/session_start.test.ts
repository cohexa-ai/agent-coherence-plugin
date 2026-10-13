/**
 * SB-10 U6 — POST /hooks/session-start: post-compaction re-grounding.
 *
 * Node mirror of the Python endpoint landed in agent-coherence 2bd756c
 * (`_handle_session_start` + `_build_session_start_context`). Prose lines
 * are byte-pinned here on purpose: the Python coordinator renders these
 * exact strings and the protocol corpus byte-matches them. Any wording
 * change must land in BOTH backends plus the corpus fixtures.
 *
 * Seeding note (documented divergence): the Node registry queues preemption
 * notices for ALL non-INVALID victims of an exclusive acquire — including
 * SHARED readers — while Python only notifies preempted M∪E writers.
 * Scenarios that pin notice-free payloads therefore drain the victim's
 * queue after seeding (the victim's next admit hook would have done so).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import {
  SESSION_START_HEADER,
  SESSION_START_GRANT_LINE_TEMPLATE,
  SESSION_START_STALE_LINE_TEMPLATE,
  SESSION_START_TOUCHED_LINE_TEMPLATE,
  SESSION_START_OVERFLOW_LINE_TEMPLATE,
  PREEMPTION_NOTICE_OVERFLOW_LINE_TEMPLATE,
  SESSION_START_SUBAGENT_PREFIX_TEMPLATE,
  SESSION_START_CLOSING_LINE,
  emitSessionStart,
} from "../hook_payloads.js";

const SECRET = "s".repeat(32);
const SID_A = "44444444-4444-4444-8444-444444444444";
const SID_B = "55555555-5555-5555-8555-555555555555";
const SID_C = "66666666-6666-4666-8666-666666666666";
const SID_D = "77777777-7777-4777-8777-777777777777";
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);

const SS_HEADER = "Post-compaction re-grounding (agent-coherence):";
const SS_CLOSING =
  "Versions are as of this re-grounding; a more recent read supersedes this notice.";

async function makeServer() {
  const tmp = mkdtempSync(join(tmpdir(), "session-start-test-"));
  const dbPath = join(tmp, ".coherence", "state.db");
  const registry = new ArtifactRegistry(dbPath);
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
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const cleanup = () =>
    new Promise<void>((r) => {
      server.close(() => {
        registry.close();
        rmSync(tmp, { recursive: true, force: true });
        r();
      });
    });
  return { registry, sessions, dbPath, post, cleanup };
}

function sessionStartText(body: Record<string, unknown>): string {
  const hso = body.hookSpecificOutput as Record<string, unknown>;
  return hso.additionalContext as string;
}

// ------------------------------------------------------------ byte parity

test("session-start: the notice overflow line names no surface that lacks notice data", () => {
  // Python dropped the /status pointer from its own notice overflow line in
  // c05fbd9 for exactly this reason. Node's GET /status carries no notice
  // field at any tier, so naming it here would be a promise it cannot keep.
  assert.doesNotMatch(PREEMPTION_NOTICE_OVERFLOW_LINE_TEMPLATE, /agent-coherence-status/);
  assert.doesNotMatch(PREEMPTION_NOTICE_OVERFLOW_LINE_TEMPLATE, /GET \/status/);
  assert.match(PREEMPTION_NOTICE_OVERFLOW_LINE_TEMPLATE, /still queued/);
});

test("session-start: the seven prose constants byte-match the Python source (KTD8)", () => {
  assert.equal(SESSION_START_HEADER, "Post-compaction re-grounding (agent-coherence):");
  assert.equal(
    SESSION_START_GRANT_LINE_TEMPLATE,
    "At compaction you held {state} on {path} (v{version}) — re-acquire " + "before writing.",
  );
  assert.equal(
    SESSION_START_STALE_LINE_TEMPLATE,
    "{path} advanced to v{current} past your last-observed v{last} — " +
      "re-read before relying on it.",
  );
  assert.equal(SESSION_START_TOUCHED_LINE_TEMPLATE, "{path} is at v{current}.");
  assert.equal(
    SESSION_START_OVERFLOW_LINE_TEMPLATE,
    "Plus {count} more — run agent-coherence-status for the full picture.",
  );
  assert.equal(SESSION_START_SUBAGENT_PREFIX_TEMPLATE, "Subagent {name}:");
  assert.equal(
    SESSION_START_CLOSING_LINE,
    "Versions are as of this re-grounding; a more recent read supersedes " + "this notice.",
  );
  // Every dash is U+2014 EM DASH with surrounding spaces — never a hyphen
  // (guards against editor/tooling dash substitution).
  assert.ok(SESSION_START_GRANT_LINE_TEMPLATE.includes(" — "));
  assert.ok(SESSION_START_STALE_LINE_TEMPLATE.includes(" — "));
  assert.ok(SESSION_START_OVERFLOW_LINE_TEMPLATE.includes(" — "));
  assert.ok(!SESSION_START_GRANT_LINE_TEMPLATE.includes(" - "));
});

test("emitSessionStart: envelope carries hookEventName + additionalContext only", () => {
  const out = emitSessionStart({ additionalContext: "hello" });
  assert.deepEqual(out, { hookEventName: "SessionStart", additionalContext: "hello" });
});

// ------------------------------------------------------------ validation

test("session-start: malformed session_id → 400", async () => {
  const { post, cleanup } = await makeServer();
  try {
    const r = await post("/hooks/session-start", { session_id: "not-a-uuid" });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "missing session_id" });
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ empty session

test("session-start: empty session → {} and compact-pending NOT set (R5)", async () => {
  const { sessions, post, cleanup } = await makeServer();
  try {
    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {});
    assert.equal(sessions.consumeCompactPending(SID_A), false);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ grant lines

test("session-start: held EXCLUSIVE renders the event-anchored grant line; wrapper shape pinned (R3/KTD8)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.acquireExclusive(id, agentA, 10);

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    // Whole-body deepEqual pins the wrapper: hookSpecificOutput is the ONLY
    // top-level key; hookEventName + additionalContext the only inner keys.
    assert.deepEqual(r.body, {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          SS_HEADER +
          "\n" +
          "At compaction you held EXCLUSIVE on plan.md (v1) — re-acquire before writing." +
          "\n" +
          SS_CLOSING,
      },
    });
  } finally {
    await cleanup();
  }
});

test("session-start: non-empty payload arms compact-pending; consume is test-and-clear; expire drops (KTD5)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    registry.grantShared(id, sessions.registerSession(SID_A), 10);

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    assert.notDeepEqual(r.body, {});
    assert.equal(sessions.consumeCompactPending(SID_A), true);
    assert.equal(sessions.consumeCompactPending(SID_A), false);

    // Expire drops an unconsumed flag (parent-Stop wiring lands in the
    // deferred-delivery unit; the primitive is pinned here).
    sessions.markCompactPending(SID_A);
    sessions.expireCompactPending(SID_A);
    assert.equal(sessions.consumeCompactPending(SID_A), false);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ stale line

test("session-start: peer advanced past last-observed renders the stale line with both versions (R4/R7)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.grantShared(id, agentA, 10); // A observed v1
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 20); // A → INVALID (last_observed stays 1)
    registry.commit(id, agentB, HASH_2, 30); // v2, last_writer = B

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    const text = sessionStartText(r.body);
    assert.equal(
      text,
      SS_HEADER +
        "\n" +
        "plan.md advanced to v2 past your last-observed v1 — re-read before relying on it." +
        "\n" +
        SS_CLOSING,
    );
    // B's E/M grant belongs to B's session — never rendered for A; and the
    // whole payload is timestamp-free (KTD8).
    assert.ok(!text.includes("At compaction you held"));
    assert.ok(!text.includes("+00:00"));
  } finally {
    await cleanup();
  }
});

test("session-start: own last-writer renders the plain version line, never the stale flag (R7/KTD4)", async () => {
  const { registry, sessions, dbPath, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.grantShared(id, agentA, 10);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 20);
    registry.commit(id, agentB, HASH_2, 30); // v2 > A's last-observed v1

    // Seam: make A itself the recorded last writer. The natural flow advances
    // the writer's own last_observed in the same transaction (KTD4's FIRST
    // layer), so the second layer is only reachable by flipping last_writer
    // directly — mirrors the Python test's monkeypatched last_writer_for.
    const seam = new Database(dbPath);
    seam.prepare("UPDATE artifacts SET last_writer_id = ? WHERE id = ?").run(agentA, id);
    seam.close();

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    const text = sessionStartText(r.body);
    assert.equal(text, SS_HEADER + "\n" + "plan.md is at v2." + "\n" + SS_CLOSING);
    assert.ok(!text.includes("advanced to"));
  } finally {
    await cleanup();
  }
});

test("session-start: NULL last-observed row is admitted, never flagged (R7 — no 0-sentinel)", async () => {
  const { registry, sessions, dbPath, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 10);
    registry.commit(id, agentB, HASH_2, 20); // v2
    const agentA = sessions.registerSession(SID_A);
    // A gets an INVALID row that never observed bytes — the pre-U5 row shape
    // (last_observed_version stays NULL). Only reachable via direct SQL: every
    // Node non-INVALID upsert records atomically.
    const seam = new Database(dbPath);
    seam
      .prepare("INSERT INTO agent_states (artifact_id, agent_id, state) VALUES (?, ?, 'INVALID')")
      .run(id, agentA);
    seam.close();

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    const text = sessionStartText(r.body);
    assert.equal(text, SS_HEADER + "\n" + "plan.md is at v2." + "\n" + SS_CLOSING);
    assert.ok(!text.includes("advanced to"));
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ overflow cap

test("session-start: 5 artifacts → 3 verbatim + 'Plus 2 more' overflow, under 10KB (R5)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const agentA = sessions.registerSession(SID_A);
    for (const n of ["a", "b", "c", "d", "e"]) {
      const id = registry.resolveOrRegisterArtifact(`docs/plans/${n}.md`, HASH_1);
      registry.grantShared(id, agentA, 10);
    }

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    const text = sessionStartText(r.body);
    assert.equal(
      text,
      [
        SS_HEADER,
        "At compaction you held SHARED on docs/plans/a.md (v1) — re-acquire before writing.",
        "At compaction you held SHARED on docs/plans/b.md (v1) — re-acquire before writing.",
        "At compaction you held SHARED on docs/plans/c.md (v1) — re-acquire before writing.",
        "Plus 2 more — run agent-coherence-status for the full picture.",
        SS_CLOSING,
      ].join("\n"),
    );
    assert.ok(!text.includes("docs/plans/d.md"));
    assert.ok(!text.includes("docs/plans/e.md"));
    assert.ok(Buffer.byteLength(text, "utf8") < 10_000);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ notices

test("session-start: pending preemption notice rendered READ-ONLY — appears in payload AND stays drainable (R3/R6)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("AGENTS.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.acquireExclusive(id, agentA, 10);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 20); // queues A a notice; A → INVALID

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    const text = sessionStartText(r.body);
    assert.equal(text.split("\n")[0], SS_HEADER);
    // Notice block renders AFTER the header, BEFORE artifact lines.
    const noticeAt = text.indexOf("silently revoked");
    const touchedAt = text.indexOf("AGENTS.md is at v1.");
    assert.ok(noticeAt !== -1, "notice prose must render in the payload");
    assert.ok(touchedAt !== -1, "the invalidated row still renders its version line");
    assert.ok(noticeAt < touchedAt, "notices render before artifact lines");

    // Read-only proof #1: the queue still holds the notice.
    assert.equal(registry.peekPendingNoticesForAgent(agentA).length, 1);
    // Read-only proof #2: the next admit hook still surfaces AND consumes it.
    const rr = await post("/hooks/pre-read", { session_id: SID_A, path: "AGENTS.md" });
    assert.equal(rr.status, 200);
    const hso = rr.body.hookSpecificOutput as Record<string, unknown>;
    assert.ok((hso.additionalContext as string).includes("silently revoked"));
    assert.equal(registry.peekPendingNoticesForAgent(agentA).length, 0);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ subagents

test("session-start: parent lines first, then subagent group under its prefix; released grant → touched line (KTD8)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const cid = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    registry.grantShared(cid, sessions.registerSession(SID_A), 10);
    const pid = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentW = sessions.registerSession(SID_A, "worker-1");
    registry.acquireExclusive(pid, agentW, 20);

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    assert.equal(
      sessionStartText(r.body),
      [
        SS_HEADER,
        "At compaction you held SHARED on CLAUDE.md (v1) — re-acquire before writing.",
        "Subagent worker-1:",
        "At compaction you held EXCLUSIVE on plan.md (v1) — re-acquire before writing.",
        SS_CLOSING,
      ].join("\n"),
    );

    // Stop the subagent — its E grant releases (row goes INVALID); the row
    // is still touched, rendered without a flag.
    await post("/hooks/session-stop", { session_id: SID_A, agent_id: "worker-1" });
    const r2 = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(
      sessionStartText(r2.body),
      [
        SS_HEADER,
        "At compaction you held SHARED on CLAUDE.md (v1) — re-acquire before writing.",
        "Subagent worker-1:",
        "plan.md is at v1.",
        SS_CLOSING,
      ].join("\n"),
    );
  } finally {
    await cleanup();
  }
});

test("session-start: a group fully swallowed by the overflow cap renders NO subagent prefix (R5/KTD8)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const agentA = sessions.registerSession(SID_A);
    for (const n of ["a", "b", "c"]) {
      const id = registry.resolveOrRegisterArtifact(`docs/plans/${n}.md`, HASH_1);
      registry.grantShared(id, agentA, 10);
    }
    const pid = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentW = sessions.registerSession(SID_A, "worker-1");
    registry.acquireExclusive(pid, agentW, 20);

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    const text = sessionStartText(r.body);
    assert.equal(
      text,
      [
        SS_HEADER,
        "At compaction you held SHARED on docs/plans/a.md (v1) — re-acquire before writing.",
        "At compaction you held SHARED on docs/plans/b.md (v1) — re-acquire before writing.",
        "At compaction you held SHARED on docs/plans/c.md (v1) — re-acquire before writing.",
        "Plus 1 more — run agent-coherence-status for the full picture.",
        SS_CLOSING,
      ].join("\n"),
    );
    assert.ok(!text.includes("Subagent"), "swallowed group must not render its prefix");
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ determinism

test("session-start: two identical calls are byte-identical (KTD8 — no timestamps, stable sort)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const cid = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.grantShared(cid, agentA, 10);
    const pid = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(pid, agentB, 20);
    registry.commit(pid, agentB, HASH_2, 30); // A never touched plan.md — no line, no notice
    const xid = registry.resolveOrRegisterArtifact("docs/plans/x.md", HASH_1);
    registry.grantShared(xid, agentA, 40);

    const first = await post("/hooks/session-start", { session_id: SID_A });
    const second = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(sessionStartText(first.body), sessionStartText(second.body));
    assert.ok(!sessionStartText(first.body).includes("+00:00"));
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ breadcrumb

test("session-start: R8 breadcrumb fires only for a never-seen session in a nonempty workspace", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  const captured: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    // (a) never-seen session + EMPTY workspace → no breadcrumb.
    await post("/hooks/session-start", { session_id: SID_C });
    assert.ok(!captured.join("").includes("never-seen session"));

    // Seed workspace state with an unrelated session.
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    registry.grantShared(id, sessions.registerSession(SID_B), 10);

    // (b) never-seen session + NONEMPTY workspace → breadcrumb.
    captured.length = 0;
    await post("/hooks/session-start", { session_id: SID_D });
    assert.ok(captured.join("").includes("never-seen session"));

    // (c) already-seen session + nonempty workspace → no breadcrumb.
    captured.length = 0;
    await post("/hooks/session-start", { session_id: SID_D });
    assert.ok(!captured.join("").includes("never-seen session"));
  } finally {
    process.stderr.write = original;
    await cleanup();
  }
});

// ------------------------------------------------------- template escaping

test("session-start: a tracked path carrying a template token renders VERBATIM (single-pass fmt)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    // `isValidPath` admits braces and `$`, so a real workspace can register
    // any of these names. Substitution must be ONE pass over the template —
    // exactly like Python's `str.format` — or an already-inserted path gets
    // re-scanned and the model is handed a path that does not exist.
    const dollar = registry.resolveOrRegisterArtifact("docs/$&/dollar.md", HASH_1);
    const braced = registry.resolveOrRegisterArtifact("docs/{current}/plan.md", HASH_1);
    const held = registry.resolveOrRegisterArtifact("docs/{version}/held.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.grantShared(dollar, agentA, 10);
    registry.grantShared(braced, agentA, 10); // A observed v1
    registry.grantShared(held, agentA, 10);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(braced, agentB, 20); // A → INVALID at v1
    registry.commit(braced, agentB, HASH_2, 30); // v2, last_writer = B

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    assert.equal(
      sessionStartText(r.body),
      [
        SS_HEADER,
        "At compaction you held SHARED on docs/$&/dollar.md (v1) — re-acquire before writing.",
        "docs/{current}/plan.md advanced to v2 past your last-observed v1 — re-read before relying on it.",
        "At compaction you held SHARED on docs/{version}/held.md (v1) — re-acquire before writing.",
        SS_CLOSING,
      ].join("\n"),
    );
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------ notice-block cap

test("session-start: the flattened notice block honours the verbatim cap (R5 size bound)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    // 40 preempted grants — the notice list is flattened across the parent
    // and every registered subagent, so without a cap the payload grows
    // without bound and the 10KB additionalContext ceiling is a coin flip.
    const agentA = sessions.registerSession(SID_A);
    const agentB = sessions.registerSession(SID_B);
    for (let i = 0; i < 40; i++) {
      const id = registry.resolveOrRegisterArtifact(`docs/plans/p${i}.md`, HASH_1);
      registry.acquireExclusive(id, agentA, 10);
      // Preemption timestamps ASCEND with i, so the newest three are p37,
      // p38, p39 — which ASCII path order (p0, p1, p10, p11, …) does NOT
      // put first. Which three survive the cap is therefore observable.
      registry.acquireExclusive(id, agentB, 20 + i); // queues A a notice; A → INVALID
    }

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    const text = sessionStartText(r.body);
    // Exactly three notice bullets survive verbatim...
    assert.equal(text.split("\n").filter((l) => l.startsWith("  • ") && !l.includes("more preemptions since your last activity")).length, 3);
    // The ARTIFACT block coalesces its remaining 37 and points at the status
    // surface, which does carry tracked-artifact paths and versions.
    const artifactOverflow = "Plus 37 more — run agent-coherence-status for the full picture.";
    assert.equal(text.split("\n").filter((l) => l === artifactOverflow).length, 1);
    // The NOTICE block coalesces its own 37 and must NOT point there: no
    // /status tier carries notice data, so that pointer promises a surface
    // that cannot answer. Session-start PEEKS, so the rows really are queued.
    const noticeOverflow =
      "  • Plus 37 more preemptions since your last activity, still queued — " +
      "they surface on your next tracked-file operation.";
    assert.equal(text.split("\n").filter((l) => l === noticeOverflow).length, 1);
    assert.ok(Buffer.byteLength(text, "utf8") < 10_000);
    // The intro reports the TRUE pending count, never the post-cap bullet
    // count: "3 of your grants were revoked" when 40 were is a wrong number
    // in the operator's face, and the overflow line cannot unsay it.
    assert.ok(
      text.includes("⚠ 40 of your EXCLUSIVE grants were silently revoked by other sessions:"),
      `notice intro must carry the pre-cap count; got:\n${text}`,
    );
    // Newest-first, mirroring Python's `_build_preemption_text` sort: the
    // cap must drop the OLDEST preemptions, not whichever sort first by path.
    assert.deepEqual(
      text
        .split("\n")
        .filter((l) => l.startsWith("  • ") && !l.includes("more preemptions since your last activity"))
        .map((l) => l.slice("  • ".length).split(" ")[0]),
      ["docs/plans/p39.md", "docs/plans/p38.md", "docs/plans/p37.md"],
    );
    // Peek, never pop (R6): the cap bounds the PROSE, not the queue.
    assert.equal(registry.peekPendingNoticesForAgent(agentA).length, 40);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------- subagent identity

test("session-start: agent_id registers the subagent but the payload stays SESSION-scoped", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    registry.grantShared(id, sessions.registerSession(SID_A), 10);

    // Baseline: no agent_id on the wire.
    const baseline = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(baseline.status, 200);

    // Same call presenting a subagent identity: registered per SB-25, but
    // the payload is built for the session (parent + every subagent), so a
    // subagent holding nothing contributes nothing and the bytes match.
    const withAgent = await post("/hooks/session-start", {
      session_id: SID_A,
      agent_id: "worker-1",
    });
    assert.equal(withAgent.status, 200);
    assert.equal(sessionStartText(withAgent.body), sessionStartText(baseline.body));
    assert.ok(
      sessions.agentsForSession(SID_A).some((a) => a.subagentName === "worker-1"),
      "a valid agent_id must be registered under the session",
    );

    // A malformed id is ignored (never a 400, never registered) — the read
    // paths' readSubagentId contract.
    const malformed = await post("/hooks/session-start", {
      session_id: SID_A,
      agent_id: "bad!chars",
    });
    assert.equal(malformed.status, 200);
    assert.ok(!sessions.agentsForSession(SID_A).some((a) => a.subagentName === "bad!chars"));
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------- degraded build

test("session-start: a failed build answers {} , leaves the flag unarmed, and breadcrumbs (KTD7)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "session-start-degraded-"));
  const realRegistry = new ArtifactRegistry(join(tmp, ".coherence", "state.db"));
  // Only the builder's batched read explodes; every other registry call
  // behaves, so the failure is the handler's guard and nothing else.
  const exploding = new Proxy(realRegistry, {
    get(target, prop, receiver) {
      if (prop === "allStateMaps") {
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
    registry: exploding,
    policy: PolicyRef.load(tmp),
    sessions,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const captured: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    realRegistry.grantShared(
      realRegistry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1),
      sessions.registerSession(SID_B),
      10,
    );
    const res = await fetch(`http://127.0.0.1:${port}/hooks/session-start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        Host: "127.0.0.1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: SID_A }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {});
    // Never armed: nothing was built, so there is nothing to deliver later.
    assert.equal(sessions.consumeCompactPending(SID_A), false);
    const stderr = captured.join("");
    assert.ok(stderr.includes("session-start build failed"));
    // The degraded exit returns BEFORE the R8 breadcrumb — a build that
    // could not read the workspace must not claim what it holds.
    assert.ok(!stderr.includes("never-seen session"));
  } finally {
    process.stderr.write = original;
    await new Promise<void>((r) => {
      server.close(() => {
        realRegistry.close();
        rmSync(tmp, { recursive: true, force: true });
        r();
      });
    });
  }
});

// ------------------------------------------------- read scoping at the seam

test("session-start: the builder scopes the state read to THIS session's agents (SB-10 review)", async () => {
  // Behavioural tests cannot pin this: surplus rows are unobservable in the
  // render (the walk looks each pair up per agent), which is exactly why
  // dropping the scope would ship byte-identical and green. So assert the
  // ARGUMENT — otherwise the whole point of the fix, that a hook path stops
  // reading the workspace's entire never-GC'd ledger, is revertible in
  // silence.
  const tmp = mkdtempSync(join(tmpdir(), "session-start-scope-"));
  const realRegistry = new ArtifactRegistry(join(tmp, ".coherence", "state.db"));
  const scopes: ReadonlyArray<string>[] = [];
  const recording = new Proxy(realRegistry, {
    get(target, prop, receiver) {
      if (prop === "allStateMaps") {
        return (agentIds: readonly string[]) => {
          scopes.push([...agentIds]);
          return realRegistry.allStateMaps(agentIds);
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
    registry: recording,
    policy: PolicyRef.load(tmp),
    sessions,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const id = realRegistry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    const foreign = sessions.registerSession(SID_B); // a peer session's rows
    realRegistry.grantShared(id, agentA, 10);
    realRegistry.grantShared(id, foreign, 20);
    const subagent = sessions.registerSession(SID_A, "worker-1");

    const res = await fetch(`http://127.0.0.1:${port}/hooks/session-start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        Host: "127.0.0.1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: SID_A }),
    });
    assert.equal(res.status, 200);
    await res.json();

    assert.equal(scopes.length, 1, "the builder reads state exactly once");
    // The parent AND its registered subagent — never the peer session.
    assert.deepEqual([...scopes[0]].sort(), [agentA, subagent].sort());
    assert.ok(!scopes[0].includes(foreign), "a peer session's agent must never be in scope");
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
