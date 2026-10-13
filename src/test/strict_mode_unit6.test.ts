/**
 * Unit 6 — Node strict mode (zero-Python plan capstone).
 *
 * The acceptance contracts, per the plan review:
 * 1. BYTE-STABLE deny text — hard-coded expected strings (incl. the Python
 *    isoformat() semantics: +00:00 offset, variable-precision microseconds,
 *    zero-fraction case) and the <unknown> sentinel (never [:8]-sliced).
 * 2. The pre-read 2×2 gate truth table — (None, matches) must NOT deny.
 * 3. KTD-U terminal denial — emitAllow throws on the strict class.
 * 4. KTD-T stickiness — a denied pre-read re-denies (no SHARED re-grant).
 * 5. Empty strict_mode.yaml → warn-only (v0.1.1 default preserved).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import { drainNoticeText } from "../hooks/_common.js";
import { sessionToAgentId } from "../agent_id.js";
import { MESIState } from "../states.js";
import {
  emitAllow,
  emitStrictDeny,
  pythonIsoUtc,
  STRICT_MODE_DENY_REASON_TEMPLATE,
  type StaleSummary,
  staleReadWarning,
  editCollisionWarning,
  preemptionNoticeText,
  shortSessionId,
  summaryReportsAWrite,
} from "../hook_payloads.js";

const SID_A = "44444444-4444-4444-8444-444444444444";
const SID_B = "55555555-5555-5555-8555-555555555555";
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);

/**
 * The `<unknown>` sentinel with its closing bracket dropped — what a bare
 * `slice(0, 8)` makes of it, and the exact malformed text every sentinel test
 * here exists to keep out of model-visible prose.
 *
 * Excluding `-` as well as `>` is load-bearing: `<unknown-artifact>` is the
 * artifact-path fallback in all four notice builders (pre_bash, pre_read,
 * pre_edit, session_start) and legitimately reaches the same prose, so a
 * lookahead of `(?!>)` alone would fail a notice that truncated nothing.
 */
const TRUNCATED_SENTINEL = /<unknown(?![->])/;

// ------------------------------------------------------------ byte parity

test("pythonIsoUtc: +00:00 offset, 6-digit microseconds, zero-fraction omits them", () => {
  // Fractional: Python datetime.fromtimestamp(1748088000.123456, tz=utc).isoformat()
  assert.equal(pythonIsoUtc(1748088000.123456), "2025-05-24T12:00:00.123456+00:00");
  // Zero fraction: no fractional part at all.
  assert.equal(pythonIsoUtc(1748088000), "2025-05-24T12:00:00+00:00");
  // Trailing-zero microseconds keep 6-digit padding (Python: .120000).
  assert.equal(pythonIsoUtc(1748088000.12), "2025-05-24T12:00:00.120000+00:00");
});

test("emitStrictDeny: byte-identical reason (real writer, fractional ts) + no additionalContext key", () => {
  const summary: StaleSummary = {
    path: "docs/plan.md",
    current_version: 3,
    prior_version_seen_by_session: 2,
    last_writer_session_id: SID_B,
    last_writer_at_unix_ts: 1748088000.123456,
    warning_generated_at_unix_ts: 999,
    hash_differs: false,
  };
  const out = emitStrictDeny({ source: "pre_read_strict_deny", summary });
  assert.deepEqual(out, {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "Stale read denied: docs/plan.md was updated by agent 55555555 " +
      "at 2025-05-24T12:00:00.123456+00:00. Re-read docs/plan.md via the Read tool before " +
      "proceeding. This denial is structural (v0.2 strict mode); retrying " +
      "the same operation will produce the same denial.",
  });
  assert.equal("additionalContext" in out, false);
});

test("emitStrictDeny: the path is inserted verbatim — no $-pattern or placeholder inside it expands (#164)", () => {
  // Python renders both templates with `str.format`: each value is inserted
  // once and never re-read. A `replaceAll`/`replace` chain gets both halves
  // wrong — a replacement STRING expands `$&` `$$` `` $` `` `$'`, and the
  // next link re-scans the path it just inserted, so a placeholder inside the
  // path takes the value while the real one ships unexpanded. `isValidPath`
  // admits all of these names. The expected text below interpolates the path
  // with a template literal (verbatim by construction) and was checked
  // byte-for-byte against Python's `emit_strict_deny` for every path here.
  const writeReason = (p: string): string =>
    `Stale read denied: ${p} was updated by agent 01234567 ` +
    `at 2026-09-21T14:13:20.500000+00:00. Re-read ${p} via the Read tool before ` +
    "proceeding. This denial is structural (v0.2 strict mode); retrying " +
    "the same operation will produce the same denial.";
  const grantReason = (p: string): string =>
    `Stale read denied: your grant on ${p} was revoked and no new version ` +
    `was committed — ${p} is still at v3. Re-read ` +
    `${p} via the Read tool before proceeding. This denial is structural ` +
    "(v0.2 strict mode); retrying the same operation will produce the same " +
    "denial.";
  // `prior` picks the template via summaryReportsAWrite: null (never observed)
  // renders the write text; 3 (equal to current_version) the grant-change text.
  const render = (path: string, prior: number | null): string | undefined =>
    emitStrictDeny({
      source: "pre_read_strict_deny",
      summary: {
        path,
        current_version: 3,
        prior_version_seen_by_session: prior,
        last_writer_session_id: "0123456789abcdef0123456789abcdef",
        last_writer_at_unix_ts: 1790000000.5,
        warning_generated_at_unix_ts: 1790000001,
        hash_differs: false,
      },
    }).permissionDecisionReason;

  const dollarPatterns = ["docs/a$&b.md", "docs/a$$b.md", "docs/a$`b.md", "docs/a$'b.md"];
  // Controls a replacement-string renderer also gets right (a string pattern has
  // no capture groups, `$i` is no pattern), so they check the expected text itself.
  const controls = ["docs/plain.md", "docs/a$1b.md", "routes/$id.tsx", "docs/a{path}b.md"];
  const writePlaceholders = ["docs/a{last_writer_short}b.md", "docs/a{last_writer_ts_iso}b.md"];

  for (const p of [...dollarPatterns, ...writePlaceholders, ...controls]) {
    assert.equal(render(p, null), writeReason(p), `write text, path ${JSON.stringify(p)}`);
  }
  for (const p of [...dollarPatterns, "docs/a{current_version}b.md", ...controls]) {
    assert.equal(render(p, 3), grantReason(p), `grant-change text, path ${JSON.stringify(p)}`);
  }
});

test("warn renderers speak Python's timestamp dialect, not toISOString's", () => {
  // `pythonIsoUtc` exists in this module and reproduces `datetime.isoformat()`
  // exactly, but only `emitStrictDeny` used it; the three warn renderers called
  // a module-private `isoUtc` (`toISOString()`), so every stale warning, every
  // collision warning and every preemption bullet spelled the same instant
  // `...T12:00:00.000Z` where Python writes `...T12:00:00+00:00`. The corpus
  // cannot catch this: its harness scrubs both spellings to the same `<TS>`.
  const Z_TIMESTAMP = /\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;

  const stale = staleReadWarning({
    path: "plan.md",
    current_version: 2,
    prior_version_seen_by_session: 1,
    last_writer_session_id: "f2f7eab3-1111-4111-8111-111111111111",
    last_writer_at_unix_ts: 1748088000,
    warning_generated_at_unix_ts: 1748088000.5,
    hash_differs: false,
  });
  assert.match(stale, /2025-05-24T12:00:00\+00:00/);
  assert.match(stale, /2025-05-24T12:00:00\.500000\+00:00/);
  assert.doesNotMatch(stale, Z_TIMESTAMP);

  const collision = editCollisionWarning("f2f7eab3-1111-4111-8111-111111111111", 1748088000, "plan.md");
  assert.match(collision, /2025-05-24T12:00:00\+00:00/);
  assert.doesNotMatch(collision, Z_TIMESTAMP);

  const notice = preemptionNoticeText([
    {
      artifactPath: "plan.md",
      preempterAgentShort: "f2f7eab3",
      preemptedAtUnixTs: 1748088000,
    },
  ]);
  assert.match(notice, /2025-05-24T12:00:00\+00:00/);
  assert.doesNotMatch(notice, Z_TIMESTAMP);
});

test("emitStrictDeny: <unknown> sentinel preserved verbatim (never sliced to '<unknow')", () => {
  const summary: StaleSummary = {
    path: "plan.md",
    current_version: 1,
    prior_version_seen_by_session: null,
    last_writer_session_id: "",
    last_writer_at_unix_ts: 1748088000,
    warning_generated_at_unix_ts: 999,
    hash_differs: true,
  };
  const out = emitStrictDeny({ source: "pre_read_strict_deny", summary });
  assert.match(out.permissionDecisionReason!, /by agent <unknown> at 2025-05-24T12:00:00\+00:00\./);
  assert.doesNotMatch(out.permissionDecisionReason!, TRUNCATED_SENTINEL);
});

test("staleReadWarning: <unknown> sentinel preserved verbatim (never sliced)", () => {
  const summary: StaleSummary = {
    path: "plan.md",
    current_version: 2,
    prior_version_seen_by_session: 1,
    last_writer_session_id: "<unknown>",
    last_writer_at_unix_ts: 1748088000,
    warning_generated_at_unix_ts: 1748088001,
    hash_differs: false,
  };
  const text = staleReadWarning(summary);
  assert.match(text, /agent <unknown> at/);
  assert.doesNotMatch(text, TRUNCATED_SENTINEL);
});

test("editCollisionWarning: <unknown> sentinel preserved verbatim (never sliced)", () => {
  const text = editCollisionWarning("<unknown>", 1748088000, "plan.md");
  assert.match(text, /\(<unknown>\)/);
  assert.doesNotMatch(text, TRUNCATED_SENTINEL);
});

test("warn renderers still shorten a REAL session id to 8 chars", () => {
  const sid = "f2f7eab3-1111-4111-8111-111111111111";
  const stale = staleReadWarning({
    path: "plan.md",
    current_version: 2,
    prior_version_seen_by_session: 1,
    last_writer_session_id: sid,
    last_writer_at_unix_ts: 1748088000,
    warning_generated_at_unix_ts: 1748088001,
    hash_differs: false,
  });
  assert.match(stale, /agent f2f7eab3 at/);
  assert.equal(stale.includes(sid), false);

  const collision = editCollisionWarning(sid, 1748088000, "plan.md");
  assert.match(collision, /\(f2f7eab3\)/);
  assert.equal(collision.includes(sid), false);
});

/*
 * `drainNoticeText: an unresolved preempter keeps its <unknown> sentinel`
 * lived here. It drove the real call site with a session map that could not
 * resolve the preempter -- the ordinary post-restart state -- and asserted
 * the sentinel rendered whole. R7 removed the lookup, so there is nothing
 * left to fail to resolve on that path and the case is unreachable. Its
 * replacement, `drainNoticeText: the preempter is named from the notice row`,
 * is in the R7/R8 block below and asserts the stronger property: the
 * attribution survives with no session map at all. The sentinel arm that IS
 * still reachable is the last-writer one, covered by the two tests above.
 */

test("shortSessionId is the single shortener: sentinel whole, real id to 8", () => {
  assert.equal(shortSessionId("<unknown>"), "<unknown>");
  assert.equal(shortSessionId("<unknown-artifact>"), "<unknown-artifact>");
  assert.equal(shortSessionId("f2f7eab3-1111-4111-8111-111111111111"), "f2f7eab3");
  // Each case above satisfies BOTH halves of `startsWith("<") && endsWith(">")`
  // or neither, so either half could be deleted and they would all still pass.
  // These two are the only inputs that tell the halves apart, and they must be
  // longer than 8 chars or the slice is a no-op and proves nothing.
  assert.equal(shortSessionId("<unclosed-sentinel"), "<unclose");
  assert.equal(shortSessionId("no-open-bracket>"), "no-open-");
});

test("template placeholder set is locked (KTD-P)", () => {
  const placeholders = [...STRICT_MODE_DENY_REASON_TEMPLATE.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  assert.deepEqual(placeholders, ["path", "last_writer_short", "last_writer_ts_iso", "path"]);
});

test("KTD-U: emitAllow refuses to convert a terminal denial class", () => {
  assert.throws(
    () => emitAllow({ source: "test", denialClass: "permissions_deny_strict_mode" }),
    /KTD-U security invariant/,
  );
  // Non-terminal allow works and omits additionalContext when absent.
  const quiet = emitAllow({ source: "test" });
  assert.deepEqual(quiet, { hookEventName: "PreToolUse", permissionDecision: "allow" });
});

// -------------------------------------------------------- gate truth table

async function makeStrictServer(strictPatterns: string[]) {
  const tmp = mkdtempSync(join(tmpdir(), "strict6-test-"));
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
  const secret = "s".repeat(32);
  const server = createServer({
    secret,
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
        Authorization: `Bearer ${secret}`,
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

function decision(body: Record<string, unknown>): string | undefined {
  return (body.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision as
    | string
    | undefined;
}

test("pre-read strict gate truth table: INVALID→deny; (None,differs)→deny; (None,matches)→allow; sticky re-deny", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer(["CLAUDE.md"]);
  try {
    // Seed: peer B commits v2 with HASH_2.
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 10);
    registry.commit(id, agentB, HASH_2, 11);

    // (None, hash matches current) → warn-mode allow (NOT deny) — the
    // truth-table cell a wholesale-broadened gate would break.
    const nullMatch = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_2,
    });
    assert.equal(decision(nullMatch), "allow");

    // The (None→allow) path re-granted SHARED to A; a peer commit now makes A INVALID.
    registry.acquireExclusive(id, agentB, 20);
    registry.commit(id, agentB, HASH_1, 21);

    // INVALID → deny, regardless of hash.
    const invalidDeny = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(decision(invalidDeny), "deny");
    assert.equal(invalidDeny.status, "stale");

    // KTD-T sticky: the deny did NOT re-grant SHARED — an identical retry re-denies
    // with byte-identical reason text.
    const retry = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(decision(retry), "deny");
    assert.equal(
      (retry.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason,
      (invalidDeny.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason,
    );

    // (None, hash differs) → deny: a fresh session C reading stale bytes.
    const SID_C = "66666666-6666-6666-8666-666666666666";
    const nullDiffers = await post("/hooks/pre-read", {
      session_id: SID_C,
      path: "CLAUDE.md",
      content_hash: HASH_2, // current is HASH_1 after B's second commit
    });
    assert.equal(decision(nullDiffers), "deny");
  } finally {
    await cleanup();
  }
});

test("empty strict_mode.yaml → warn-only default preserved (INVALID reader gets allow+warn)", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([]);
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 10);
    registry.commit(id, agentB, HASH_2, 11);
    const r = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(decision(r), "allow");
    assert.equal(r.status, "stale");
  } finally {
    await cleanup();
  }
});

test("pre-edit strict gate is INVALID-only: first-time editor acquires; preempted editor denied {ok:false}", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer(["CLAUDE.md"]);
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    // First-time editor (state None) on a strict artifact → normal acquire.
    const first = await post("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.equal(first.ok, true);
    // Peer B preempts + commits → A INVALID.
    const preempt = await post("/hooks/pre-edit", { session_id: SID_B, path: "CLAUDE.md" });
    assert.equal(preempt.ok, true);
    const agentB = sessions.registerSession(SID_B);
    registry.commit(id, agentB, HASH_2, 30);
    // A (INVALID) edits again → strict deny with ok:false.
    const denied = await post("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.equal(denied.ok, false);
    assert.equal(decision(denied), "deny");
    assert.equal(denied.status, "stale");
  } finally {
    await cleanup();
  }
});

test("pre-bash strict short-circuit: strict stale path → deny with stale_paths", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer(["CLAUDE.md"]);
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 10);
    registry.commit(id, agentB, HASH_2, 11);
    const r = await post("/hooks/pre-bash", { session_id: SID_A, command: "cat CLAUDE.md" });
    assert.equal(decision(r), "deny");
    assert.equal(r.status, "stale");
    assert.deepEqual(r.stale_paths, ["CLAUDE.md"]);
    assert.equal("summary" in r, false); // pre-bash deny body carries no summary key
  } finally {
    await cleanup();
  }
});

test("SHARED-hash arm: foreign out-of-band edit denies; recent self-commit lag suppresses", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer(["CLAUDE.md"]);
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    // A becomes a SHARED holder via a clean read (hash matches).
    const fresh = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(decision(fresh), "allow");
    // Foreign out-of-band edit: A still SHARED, but disk hash now differs
    // and A is NOT the last writer → deny (pre_read_shared_hash_deny).
    const foreign = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_2,
    });
    assert.equal(decision(foreign), "deny");

    // Self-commit lag: B holds SHARED after its own commit_cas WIN (<5s ago);
    // B's disk still has old bytes → suppressed (allow), not denied.
    const agentB = sessions.registerSession(SID_B);
    registry.grantShared(id, agentB, 40);
    const win = registry.commitCas(id, agentB, 1, HASH_2, 41);
    assert.equal(win.kind, "win");
    const lag = await post("/hooks/pre-read", {
      session_id: SID_B,
      path: "CLAUDE.md",
      content_hash: HASH_1, // stale disk bytes ≠ canonical HASH_2
    });
    // Suppression falls through to the plain fresh response (no deny, no
    // hookSpecificOutput) — same as Python's warn-mode fall-through.
    assert.equal(lag.status, "fresh");
    assert.equal(decision(lag), undefined);
  } finally {
    await cleanup();
  }
});

test("SHARED-hash arm: a SUBAGENT's own recent commit is suppressed, not denied (self-commit-lag identity fix)", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer(["CLAUDE.md"]);
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const SUB = "a0826622451ec196f";
    // A SUBAGENT (composite identity) holds SHARED after its own commit_cas WIN.
    const agentSub = sessions.registerSession(SID_B, SUB);
    registry.grantShared(id, agentSub, 40);
    const win = registry.commitCas(id, agentSub, 1, HASH_2, 41);
    assert.equal(win.kind, "win");
    // The subagent re-reads with stale disk bytes, carrying its agent_id.
    // BEFORE the fix: agentIdToSessionId(composite) → the bare subagent id,
    // which never equals the parent session_id → NOT suppressed → the
    // subagent's own recent commit was wrongly DENIED as a foreign edit,
    // naming the subagent itself. AFTER: last_writer_id === the caller's
    // composite agentId → recognized as self-commit lag → suppressed.
    const lag = await post("/hooks/pre-read", {
      session_id: SID_B,
      agent_id: SUB,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(lag.status, "fresh");
    assert.equal(decision(lag), undefined);
  } finally {
    await cleanup();
  }
});

test("strict re-arm without drain: a re-granted reader is queued no second notice (#163)", async () => {
  // The strict pre-bash deny re-grants SHARED and returns before draining
  // notices. That re-grant is a read, not a write grant, so another
  // session's pre-edit must queue it nothing: the victim keeps exactly one
  // notice, naming the session that took its EXCLUSIVE grant. Only
  // `contended.md` is strict, so the victim's final pre-read of a different
  // tracked path is free to drain.
  const CONTENDED = "docs/plans/contended.md";
  const { post, cleanup } = await makeStrictServer([CONTENDED]);
  try {
    const victim = "11111111-1111-4111-8111-111111111111";
    const first = "aaaaaaaa-1111-4111-8111-111111111111";
    const second = "bbbbbbbb-2222-4222-8222-222222222222";

    await post("/hooks/pre-edit", { session_id: victim, path: CONTENDED });
    await post("/hooks/pre-edit", { session_id: first, path: CONTENDED });

    // The re-arm. Asserted rather than assumed: if this ever stops denying,
    // it starts draining, and the scenario below silently stops testing
    // anything.
    const bash = await post("/hooks/pre-bash", { session_id: victim, command: `cat ${CONTENDED}` });
    assert.equal(bash.status, "stale", "strict pre-bash must deny (and so re-arm without draining)");

    await post("/hooks/pre-edit", { session_id: second, path: CONTENDED });

    const read = await post("/hooks/pre-read", { session_id: victim, path: "docs/plans/drain.md" });
    const text = (read.hookSpecificOutput as { additionalContext?: string } | undefined)
      ?.additionalContext;
    assert.ok(text, "the victim's next admit hook must carry the drained notice");
    const bullets = text.split("\n").filter((l) => l.includes("preempted by agent"));
    assert.equal(bullets.length, 1, `expected exactly one notice:\n${text}`);
    assert.match(
      bullets[0]!,
      new RegExp(`preempted by agent ${sessionToAgentId(first).slice(0, 8)} `),
      "the notice must name the session that took the victim's write grant",
    );
    assert.doesNotMatch(bullets[0]!, new RegExp(sessionToAgentId(second).slice(0, 8)));
  } finally {
    await cleanup();
  }
});

// ------------------------------------------- R7/R8: what a response may say

/**
 * R7 — a hook response names a peer by the agent id the registry already
 * holds it under, not by the session id that id was derived from. The four
 * hooks used to run `sessionToAgentId` backwards through the session map to
 * recover a session id for prose; they now render `last_writer_id` /
 * `preempterAgentId` as-is. `sessions.agentIdToSessionId` is deleted so the
 * next renderer cannot reach for it.
 *
 * R8 — Cohexa-ai/agent-coherence#196. A peer's pre-edit invalidates a live
 * holder WITHOUT committing. The deny said "was updated by session <unknown>
 * at <t>": a write that never happened, named against a writer that does not
 * exist, at a timestamp when nothing was written. `summaryReportsAWrite`
 * decides which of the two templates a summary can support, and Python
 * derives it identically.
 */

const AGENT_HEX_B = "d7f57e8766895239ab8e6446ae5be1f0";

function grantChangeSummary(): StaleSummary {
  return {
    path: "docs/plan.md",
    current_version: 1,
    prior_version_seen_by_session: 1,
    last_writer_session_id: "<unknown>",
    last_writer_at_unix_ts: 1748088000,
    warning_generated_at_unix_ts: 1748088001,
    hash_differs: false,
  };
}

test("summaryReportsAWrite: both directions, because one direction proves nothing", () => {
  const s = grantChangeSummary();
  assert.equal(summaryReportsAWrite({ ...s, current_version: 2 }), true);
  assert.equal(summaryReportsAWrite(s), false);
  // Never observed: nothing to call unchanged.
  assert.equal(summaryReportsAWrite({ ...s, prior_version_seen_by_session: null }), true);
  // Diverged bytes: something WAS written.
  assert.equal(summaryReportsAWrite({ ...s, hash_differs: true }), true);
});

test("emitStrictDeny: a grant handover reports no write and names the unchanged version", () => {
  const out = emitStrictDeny({ source: "pre_read_strict_deny", summary: grantChangeSummary() });
  assert.deepEqual(out, {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "Stale read denied: your grant on docs/plan.md was revoked and no new " +
      "version was committed — docs/plan.md is still at v1. Re-read " +
      "docs/plan.md via the Read tool before proceeding. This denial is " +
      "structural (v0.2 strict mode); retrying the same operation will " +
      "produce the same denial.",
  });
  assert.equal(out.permissionDecisionReason!.includes("was updated by"), false);
});

test("staleReadWarning: a grant handover reports no write and names the unchanged version", () => {
  const text = staleReadWarning(grantChangeSummary());
  assert.equal(
    text,
    "⚠ Stale read [warning emitted 2025-05-24T12:00:01+00:00]: your " +
      "grant on docs/plan.md was revoked and no new version was committed. " +
      "docs/plan.md is still at v1, the version you last saw. " +
      "Re-acquire before writing to docs/plan.md.",
  );
  assert.equal(text.includes("was updated by"), false);
});

test("emitStrictDeny: a real commit still names the writing agent and its tick", () => {
  const out = emitStrictDeny({
    source: "pre_read_strict_deny",
    summary: { ...grantChangeSummary(), current_version: 2, last_writer_session_id: AGENT_HEX_B },
  });
  assert.equal(
    out.permissionDecisionReason,
    "Stale read denied: docs/plan.md was updated by agent d7f57e87 at " +
      "2025-05-24T12:00:00+00:00. Re-read docs/plan.md via the Read tool " +
      "before proceeding. This denial is structural (v0.2 strict mode); " +
      "retrying the same operation will produce the same denial.",
  );
});

test("R7: the reverse session lookup is gone from SessionRegistry", () => {
  const sessions = new SessionRegistry();
  assert.equal(
    "agentIdToSessionId" in (sessions as unknown as Record<string, unknown>),
    false,
  );
  assert.equal(
    typeof (SessionRegistry.prototype as unknown as Record<string, unknown>)
      .agentIdToSessionId,
    "undefined",
  );
});

test("drainNoticeText: the preempter is named from the notice row, with no lookup", () => {
  // The stub has no `sessions` surface at all. Rendering still attributes,
  // which is what proves the lookup is gone rather than merely unused -- and
  // it is why a coordinator restart, which empties the session map, no longer
  // blanks the attribution an operator most needs.
  const deps = {
    registry: {
      popPendingNoticesForAgent: () => [
        { artifactId: "a1", preempterAgentId: AGENT_HEX_B, preemptedAtUnixTs: 1748088000 },
      ],
      getArtifactById: () => ({ name: "plan.md" }),
    },
  } as unknown as Parameters<typeof drainNoticeText>[0];

  const text = drainNoticeText(deps, "victim");
  assert.ok(text);
  assert.match(text, /preempted by agent d7f57e87 at 2025-05-24T12:00:00\+00:00/);
  assert.doesNotMatch(text, TRUNCATED_SENTINEL);
});

// ------------------------------------------- a denied read is not an observation

/**
 * pre-bash and pre-grep re-grant SHARED to every stale path they name, on the
 * strict path too: the deny fires once and the retry goes through. A SHARED
 * grant used to be an observation, full stop, so a DENIED `cat plan.md` —
 * which never ran — credited the session with the version it was refused.
 * When a peer then took the grant without committing, the summary compared
 * that invented baseline against an unchanged version and said nothing had
 * been written since "the version you last saw".
 *
 * The allowed twin is NOT a bug and must stay: the command runs and reads the
 * current bytes. The key is the COMMAND's outcome — not the trigger, not the
 * path's own strictness. Every pair below pins both directions; the Python
 * twins live in tests/integration/test_strict_mode.py.
 */
const STRICT_PATH = "plan.md";
const WARN_PATH = "docs/plans/x.md";
const SEED_PATH = "CLAUDE.md"; // tracked by default, never registered below

/** A observed v1, then B committed v2: A is INVALID at observed 1. */
function staleForA(
  registry: ArtifactRegistry,
  sessions: SessionRegistry,
  path: string,
): { id: string; agentA: string; agentB: string } {
  const id = registry.resolveOrRegisterArtifact(path, HASH_1);
  const agentA = sessions.registerSession(SID_A);
  const agentB = sessions.registerSession(SID_B);
  registry.grantShared(id, agentA, 1);
  registry.acquireExclusive(id, agentB, 2);
  registry.commit(id, agentB, HASH_2, 3);
  assert.equal(registry.getAgentState(id, agentA), MESIState.INVALID);
  assert.equal(registry.lastObservedVersionFor(id, agentA), 1);
  return { id, agentA, agentB };
}

/** B takes the grant again and writes nothing — asserted, so the read after
 * it cannot silently take the fresh arm. */
function handOverWithoutCommit(
  registry: ArtifactRegistry,
  ids: { id: string; agentA: string; agentB: string },
): void {
  const before = registry.getArtifactById(ids.id)?.version;
  registry.acquireExclusive(ids.id, ids.agentB, 10);
  assert.equal(registry.getAgentState(ids.id, ids.agentA), MESIState.INVALID);
  assert.equal(registry.getArtifactById(ids.id)?.version, before);
}

test("denied pre-bash: the grant is re-armed but the baseline does NOT advance", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const ids = staleForA(registry, sessions, STRICT_PATH);
    const r = await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });
    assert.equal(decision(r), "deny");
    assert.equal(registry.lastObservedVersionFor(ids.id, ids.agentA), 1);
    assert.equal(registry.getAgentState(ids.id, ids.agentA), MESIState.SHARED);
  } finally {
    await cleanup();
  }
});

test("denied pre-bash then a grant handover: the deny still reports the write A never read", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const ids = staleForA(registry, sessions, STRICT_PATH);
    await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });
    handOverWithoutCommit(registry, ids);

    const r = await post("/hooks/pre-read", { session_id: SID_A, path: STRICT_PATH });
    assert.equal(decision(r), "deny");
    const reason = (r.hookSpecificOutput as Record<string, string>).permissionDecisionReason;
    assert.match(reason, /plan\.md was updated by agent /);
    assert.doesNotMatch(reason, /no new version was committed/);
    const summary = r.summary as Record<string, unknown>;
    assert.equal(summary.current_version, 2);
    assert.equal(summary.prior_version_seen_by_session, 1);
  } finally {
    await cleanup();
  }
});

test("allowed pre-bash: the command runs, so the baseline DOES advance and the handover wording stays", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const ids = staleForA(registry, sessions, WARN_PATH);
    const r = await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${WARN_PATH}` });
    assert.equal(decision(r), "allow");
    assert.equal(registry.lastObservedVersionFor(ids.id, ids.agentA), 2);

    handOverWithoutCommit(registry, ids);
    const read = await post("/hooks/pre-read", { session_id: SID_A, path: WARN_PATH });
    assert.equal(decision(read), "allow");
    const text = (read.hookSpecificOutput as Record<string, string>).additionalContext;
    assert.match(text, /your grant on docs\/plans\/x\.md was revoked and no new version was committed/);
    assert.match(text, /the version you last saw/);
    assert.doesNotMatch(text, /was updated by/);
    assert.equal((read.summary as Record<string, unknown>).prior_version_seen_by_session, 2);
  } finally {
    await cleanup();
  }
});

test("a warn path inside a DENIED bash command is not observed either", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const strictIds = staleForA(registry, sessions, STRICT_PATH);
    const warnIds = staleForA(registry, sessions, WARN_PATH);
    const r = await post("/hooks/pre-bash", {
      session_id: SID_A,
      command: `cat ${STRICT_PATH} ${WARN_PATH}`,
    });
    assert.equal(decision(r), "deny");
    assert.equal(registry.lastObservedVersionFor(strictIds.id, strictIds.agentA), 1);
    assert.equal(registry.lastObservedVersionFor(warnIds.id, warnIds.agentA), 1);
    assert.equal(registry.getAgentState(warnIds.id, warnIds.agentA), MESIState.SHARED);
  } finally {
    await cleanup();
  }
});

test("first observation inside a DENIED bash command records no observation; inside an allowed one it does", async () => {
  const denied = await makeStrictServer([STRICT_PATH]);
  try {
    staleForA(denied.registry, denied.sessions, STRICT_PATH);
    const r = await denied.post("/hooks/pre-bash", {
      session_id: SID_A,
      command: `cat ${STRICT_PATH} ${SEED_PATH}`,
    });
    assert.equal(decision(r), "deny");
    const seeded = denied.registry.getArtifactByName(SEED_PATH);
    assert.ok(seeded, "the seed path is registered either way");
    const agentA = sessionToAgentId(SID_A);
    assert.equal(denied.registry.getAgentState(seeded.id, agentA), MESIState.SHARED);
    assert.equal(denied.registry.lastObservedVersionFor(seeded.id, agentA), null);
  } finally {
    await denied.cleanup();
  }

  const allowed = await makeStrictServer([STRICT_PATH]);
  try {
    staleForA(allowed.registry, allowed.sessions, WARN_PATH);
    const r = await allowed.post("/hooks/pre-bash", {
      session_id: SID_A,
      command: `cat ${WARN_PATH} ${SEED_PATH}`,
    });
    assert.equal(decision(r), "allow");
    const seeded = allowed.registry.getArtifactByName(SEED_PATH);
    assert.ok(seeded);
    assert.equal(allowed.registry.lastObservedVersionFor(seeded.id, sessionToAgentId(SID_A)), 1);
  } finally {
    await allowed.cleanup();
  }
});

test("denied pre-grep does NOT advance the baseline; allowed pre-grep does", async () => {
  const denied = await makeStrictServer([STRICT_PATH]);
  try {
    const ids = staleForA(denied.registry, denied.sessions, STRICT_PATH);
    const r = await denied.post("/hooks/pre-grep", { session_id: SID_A, search_root: "" });
    assert.equal(decision(r), "deny");
    assert.equal(denied.registry.lastObservedVersionFor(ids.id, ids.agentA), 1);
    assert.equal(denied.registry.getAgentState(ids.id, ids.agentA), MESIState.SHARED);
  } finally {
    await denied.cleanup();
  }

  const allowed = await makeStrictServer([STRICT_PATH]);
  try {
    const ids = staleForA(allowed.registry, allowed.sessions, WARN_PATH);
    const r = await allowed.post("/hooks/pre-grep", {
      session_id: SID_A,
      search_root: "docs/plans",
    });
    assert.equal(decision(r), "allow");
    assert.equal(allowed.registry.lastObservedVersionFor(ids.id, ids.agentA), 2);
  } finally {
    await allowed.cleanup();
  }
});

test("control: an allowed stale pre-read still advances the baseline", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const ids = staleForA(registry, sessions, WARN_PATH);
    const r = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: WARN_PATH,
      content_hash: HASH_2,
    });
    assert.equal(decision(r), "allow");
    assert.equal(registry.lastObservedVersionFor(ids.id, ids.agentA), 2);
  } finally {
    await cleanup();
  }
});

async function regroundText(
  post: (path: string, body: unknown) => Promise<Record<string, unknown>>,
): Promise<string> {
  const r = await post("/hooks/session-start", { session_id: SID_A });
  return (r.hookSpecificOutput as Record<string, string>).additionalContext;
}

test("denied pre-bash keeps the post-compaction stale flag (the baseline's other reader)", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const ids = staleForA(registry, sessions, STRICT_PATH);
    await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });
    handOverWithoutCommit(registry, ids);
    assert.match(await regroundText(post), /plan\.md advanced to v2 past your last-observed v1/);
  } finally {
    await cleanup();
  }
});

test("allowed pre-bash raises no false post-compaction stale flag", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const ids = staleForA(registry, sessions, WARN_PATH);
    await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${WARN_PATH}` });
    handOverWithoutCommit(registry, ids);
    const text = await regroundText(post);
    assert.match(text, /docs\/plans\/x\.md is at v2\./);
    assert.doesNotMatch(text, /advanced to/);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------- the retry a deny invites is a read

/**
 * The flip side of the section above. A strict Bash / Grep deny re-grants
 * SHARED without recording an observation, to let the retry go through --
 * strict mode never re-grants on a denied Read, so running the command again
 * is how a strict session recovers. That retry, and any Read the session takes
 * instead, finds the grant held and answers fresh; the command then runs and
 * reads the current bytes, so the read is recorded there. Only a SHARED holder
 * is credited, and only when the command runs. A Grep credits no held file: its
 * path set is every tracked file under its root, not what it showed. The
 * Python twins live in tests/integration/test_strict_mode.py.
 */

test("the bash retry a deny invites advances the baseline", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const ids = staleForA(registry, sessions, STRICT_PATH);
    const denied = await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });
    assert.equal(decision(denied), "deny");
    assert.equal(registry.lastObservedVersionFor(ids.id, ids.agentA), 1);

    const retry = await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });
    assert.equal(retry.status, "fresh");
    assert.notEqual(decision(retry), "deny");
    assert.equal(registry.lastObservedVersionFor(ids.id, ids.agentA), 2);
    assert.equal(registry.getAgentState(ids.id, ids.agentA), MESIState.SHARED);
  } finally {
    await cleanup();
  }
});

test("a bash retry then a grant handover reports no write", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const ids = staleForA(registry, sessions, STRICT_PATH);
    await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });
    await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });
    handOverWithoutCommit(registry, ids);

    const r = await post("/hooks/pre-read", { session_id: SID_A, path: STRICT_PATH });
    assert.equal(decision(r), "deny");
    const reason = (r.hookSpecificOutput as Record<string, string>).permissionDecisionReason;
    assert.doesNotMatch(reason, /was updated by/);
    assert.match(reason, /your grant on plan\.md was revoked and no new version was committed/);
    assert.match(reason, /plan\.md is still at v2/);
    const summary = r.summary as Record<string, unknown>;
    assert.equal(summary.current_version, 2);
    assert.equal(summary.prior_version_seen_by_session, 2);
  } finally {
    await cleanup();
  }
});

test("a first-touch bash retry keeps the post-compaction stale flag", async () => {
  // A's first contact with plan.md is a denied cat, which records nothing, so
  // the retry is A's only read of v1. Unrecorded, the re-grounding after B's
  // commit says only "is at v2".
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const id = registry.resolveOrRegisterArtifact(STRICT_PATH, HASH_1);
    const agentA = sessions.registerSession(SID_A);
    const agentB = sessions.registerSession(SID_B);
    registry.grantShared(id, agentB, 1);

    const denied = await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });
    assert.equal(decision(denied), "deny");
    assert.equal(registry.lastObservedVersionFor(id, agentA), null);

    const retry = await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });
    assert.deepEqual(retry, { status: "fresh" });
    assert.equal(registry.lastObservedVersionFor(id, agentA), 1);

    registry.acquireExclusive(id, agentB, 2);
    registry.commit(id, agentB, HASH_2, 3);
    assert.match(await regroundText(post), /plan\.md advanced to v2 past your last-observed v1/);
  } finally {
    await cleanup();
  }
});

test("a Grep after a denied bash does not count as reading the file", async () => {
  // The Grep lists every tracked file under the root; it never showed plan.md,
  // so it must not stand in for the re-read the deny asked for.
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const ids = staleForA(registry, sessions, STRICT_PATH);
    await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });

    const grep = await post("/hooks/pre-grep", { session_id: SID_A, search_root: "" });
    assert.equal(grep.status, "fresh");
    assert.notEqual(decision(grep), "deny");
    assert.equal(registry.lastObservedVersionFor(ids.id, ids.agentA), 1);

    handOverWithoutCommit(registry, ids);
    const r = await post("/hooks/pre-read", { session_id: SID_A, path: STRICT_PATH });
    assert.equal(decision(r), "deny");
    const reason = (r.hookSpecificOutput as Record<string, string>).permissionDecisionReason;
    assert.match(reason, /plan\.md was updated by agent /);
    assert.equal((r.summary as Record<string, unknown>).prior_version_seen_by_session, 1);
  } finally {
    await cleanup();
  }
});

test("a Grep retry leaves the baseline for the Read to record", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const ids = staleForA(registry, sessions, STRICT_PATH);
    const denied = await post("/hooks/pre-grep", { session_id: SID_A, search_root: "" });
    assert.equal(decision(denied), "deny");

    const retry = await post("/hooks/pre-grep", { session_id: SID_A, search_root: "" });
    assert.equal(retry.status, "fresh");
    assert.notEqual(decision(retry), "deny");
    assert.equal(registry.lastObservedVersionFor(ids.id, ids.agentA), 1);

    const read = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: STRICT_PATH,
      content_hash: HASH_2,
    });
    assert.equal(read.status, "fresh");
    assert.equal(registry.lastObservedVersionFor(ids.id, ids.agentA), 2);
  } finally {
    await cleanup();
  }
});

test("a Read after a denied bash advances the baseline", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const ids = staleForA(registry, sessions, STRICT_PATH);
    await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });

    const r = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: STRICT_PATH,
      content_hash: HASH_2,
    });
    assert.equal(r.status, "fresh");
    assert.notEqual(decision(r), "deny");
    assert.equal(registry.lastObservedVersionFor(ids.id, ids.agentA), 2);
  } finally {
    await cleanup();
  }
});

test("a bash retry denied again on another path records no observation", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH, SEED_PATH]);
  try {
    const planIds = staleForA(registry, sessions, STRICT_PATH);
    await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });
    staleForA(registry, sessions, SEED_PATH);

    const r = await post("/hooks/pre-bash", {
      session_id: SID_A,
      command: `cat ${STRICT_PATH} ${SEED_PATH}`,
    });
    assert.equal(decision(r), "deny");
    assert.match(
      (r.hookSpecificOutput as Record<string, string>).permissionDecisionReason,
      /CLAUDE\.md/,
    );
    assert.equal(registry.lastObservedVersionFor(planIds.id, planIds.agentA), 1);
  } finally {
    await cleanup();
  }
});

test("a bash read leaves a held EXCLUSIVE grant alone", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const id = registry.resolveOrRegisterArtifact(STRICT_PATH, HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.acquireExclusive(id, agentA, 1);

    const r = await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });
    assert.deepEqual(r, { status: "fresh" });
    assert.equal(registry.getAgentState(id, agentA), MESIState.EXCLUSIVE);
  } finally {
    await cleanup();
  }
});

/*
 * A denied shell read re-arms the grant, not the right to write
 * (Cohexa-ai/agent-coherence#275). The strict Bash / Grep deny re-grants
 * SHARED without an observation; the strict pre-edit gate used to look only
 * for INVALID, so that grant admitted the session's next Edit or Write and a
 * whole-file write from its pre-commit copy overwrote the peer's commit. The
 * Python twins live in tests/integration/test_strict_mode.py.
 */
for (const [label, route, extra] of [
  ["cat", "/hooks/pre-bash", { command: `cat ${STRICT_PATH}` }],
  ["Grep tool", "/hooks/pre-grep", { search_root: "" }],
] as const) {
  test(`a write after a denied shell read (${label}) is the strict deny until the session reads`, async () => {
    const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
    try {
      const ids = staleForA(registry, sessions, STRICT_PATH);
      const r = await post(route, { session_id: SID_A, ...extra });
      assert.equal(decision(r), "deny");
      // Asserted, not assumed: the deny re-armed SHARED and recorded no read.
      assert.equal(registry.getAgentState(ids.id, ids.agentA), MESIState.SHARED);
      assert.equal(registry.lastObservedVersionFor(ids.id, ids.agentA), 1);

      const edit = await post("/hooks/pre-edit", { session_id: SID_A, path: STRICT_PATH });
      assert.equal(edit.ok, false);
      assert.equal(decision(edit), "deny");
      const summary = edit.summary as Record<string, unknown>;
      assert.equal(summary.prior_version_seen_by_session, 1);
      assert.equal(summary.current_version, 2);
      // The deny takes nothing: A keeps the re-armed grant its Read relies on.
      assert.equal(registry.getAgentState(ids.id, ids.agentA), MESIState.SHARED);

      const read = await post("/hooks/pre-read", { session_id: SID_A, path: STRICT_PATH, content_hash: HASH_2 });
      assert.equal(read.status, "fresh");
      const again = await post("/hooks/pre-edit", { session_id: SID_A, path: STRICT_PATH });
      assert.notEqual(decision(again), "deny");
      assert.notEqual(again.ok, false);
    } finally {
      await cleanup();
    }
  });
}

test("a write after the retry a denied bash invites is admitted", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([STRICT_PATH]);
  try {
    const ids = staleForA(registry, sessions, STRICT_PATH);
    await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });
    const retry = await post("/hooks/pre-bash", { session_id: SID_A, command: `cat ${STRICT_PATH}` });
    assert.equal(retry.status, "fresh");
    assert.notEqual(decision(retry), "deny");
    assert.equal(registry.lastObservedVersionFor(ids.id, ids.agentA), 2);

    const edit = await post("/hooks/pre-edit", { session_id: SID_A, path: STRICT_PATH });
    assert.notEqual(decision(edit), "deny");
    assert.notEqual(edit.ok, false);
  } finally {
    await cleanup();
  }
});
