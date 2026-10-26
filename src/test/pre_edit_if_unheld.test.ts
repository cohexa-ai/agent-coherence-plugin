/**
 * POST /hooks/pre-edit with `"if_unheld": true` — the opted-in pre-edit.
 *
 * It is refused while another agent holds the path for writing, naming that
 * holder; it reclaims a grant held 30 minutes or more; otherwise it is
 * admitted with no collision warning. Every request that does not send JSON
 * `true` answers exactly as before. A busy store keeps the failure envelope
 * before the grant and admits without notices when only the notice drain
 * finds it busy.
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
import { MESIState } from "../states.js";
import { sessionToAgentId } from "../agent_id.js";

const SECRET = "s".repeat(32);
const SID_A = "44444444-4444-4444-8444-444444444444";
const SID_B = "55555555-5555-4555-8555-555555555555";
const SID_C = "66666666-6666-4666-8666-666666666666";
const SID_S = "77777777-7777-4777-8777-777777777777";
const SUB_X = "a0826622451ec196f";
const SUB_Y = "b1937733562fd2a7e";
const HASH_1 = "1".repeat(64);
const BUSY = { ok: false, reason: "internal: SqliteError" };

/**
 * The refusal's wire shape, frozen from the Python contract
 * (cohexa-ai/agent-coherence tests/fixtures/wire/pre_edit_other_holder.json
 * at df38e9b2), with the holder substituted per test. Key order is part of
 * the contract.
 */
const REFUSAL_KEYS = ["ok", "reason", "holder_agent_id"];
const FORBIDDEN_KEYS = ["hookSpecificOutput", "permissionDecision", "collision", "degraded"];

interface Server {
  registry: ArtifactRegistry;
  sessions: SessionRegistry;
  policy: PolicyRef;
  root: string;
  request: (path: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown>; raw: string }>;
  cleanup: () => Promise<void>;
}

function writePolicy(root: string, file: string, patterns: string[]): void {
  writeFileSync(join(root, ".coherence", file), patterns.map((p) => `- ${JSON.stringify(p)}`).join("\n") + "\n");
}

async function makeServer(opts: { strict?: string[]; ignored?: string[] } = {}): Promise<Server> {
  const root = mkdtempSync(join(tmpdir(), "if-unheld-route-test-"));
  mkdirSync(join(root, ".coherence"), { recursive: true });
  writePolicy(root, "tracked.yaml", ["*.md"]);
  if (opts.strict) writePolicy(root, "strict_mode.yaml", opts.strict);
  if (opts.ignored) writePolicy(root, "ignored.yaml", opts.ignored);
  const registry = new ArtifactRegistry(join(root, ".coherence", "state.db"));
  const sessions = new SessionRegistry();
  const policy = PolicyRef.load(root);
  const server = createServer({ secret: SECRET, startedAtMs: Date.now(), version: "test", registry, policy, sessions });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const request = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, Host: "127.0.0.1", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: JSON.parse(raw) as Record<string, unknown>, raw };
  };
  const cleanup = () =>
    new Promise<void>((r) => {
      server.close(() => {
        registry.close();
        rmSync(root, { recursive: true, force: true });
        r();
      });
    });
  return { registry, sessions, policy, root, request, cleanup };
}

const preEdit = (s: Server, sessionId: string, path: string, extra: Record<string, unknown> = {}) =>
  s.request("/hooks/pre-edit", { session_id: sessionId, path, ...extra });
const optedIn = (s: Server, sessionId: string, path: string, extra: Record<string, unknown> = {}) =>
  preEdit(s, sessionId, path, { ...extra, if_unheld: true });

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Write `content` to `path` on disk and commit it as `sessionId`'s edit. */
async function commitEdit(s: Server, sessionId: string, path: string, content: string) {
  writeFileSync(join(s.root, path), content);
  const r = await s.request("/hooks/post-edit", {
    session_id: sessionId,
    path,
    success: true,
    content_hash: sha256(content),
  });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
}

function idOf(s: Server, path: string): string {
  return s.registry.getArtifactByName(path)!.id;
}

function keysAtAnyDepth(value: unknown, into = new Set<string>()): Set<string> {
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysAtAnyDepth(v, into);
    }
  }
  return into;
}

function assertRefusal(r: { status: number; raw: string }, holderAgentId: string): void {
  assert.equal(r.status, 200);
  const answer = JSON.parse(r.raw) as Record<string, unknown>;
  assert.deepEqual(answer, { ok: false, reason: "other_holder", holder_agent_id: holderAgentId });
  assert.deepEqual(Object.keys(answer), REFUSAL_KEYS);
  assert.match(holderAgentId, /^[0-9a-f]{32}$/);
  const keys = keysAtAnyDepth(answer);
  for (const k of FORBIDDEN_KEYS) assert.equal(keys.has(k), false, `no ${k} at any depth`);
}

async function withNow<T>(epochMs: number, fn: () => Promise<T>): Promise<T> {
  const original = Date.now;
  Date.now = () => epochMs;
  try {
    return await fn();
  } finally {
    Date.now = original;
  }
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const original = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(...String(chunk).split("\n").filter((l) => l.length > 0));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), lines };
  } finally {
    process.stderr.write = original;
  }
}

/** Count `BEGIN` statements every registry connection runs inside `fn`. */
async function countBegins<T>(fn: () => Promise<T>): Promise<number> {
  const proto = Database.prototype as unknown as { exec: (sql: string) => unknown };
  const original = proto.exec;
  let begins = 0;
  proto.exec = function (this: unknown, sql: string) {
    if (/^\s*BEGIN/i.test(sql)) begins += 1;
    return original.call(this, sql);
  };
  try {
    await fn();
    return begins;
  } finally {
    proto.exec = original;
  }
}

/** Queue `sessionId` one preemption notice on `path` by displacing it. */
async function queueNoticeFor(s: Server, sessionId: string, path: string): Promise<void> {
  await preEdit(s, sessionId, path);
  await preEdit(s, SID_C, path);
  assert.equal(s.registry.peekPendingNoticesForAgent(sessionToAgentId(sessionId)).length, 1);
}

function failOn<T extends object>(target: T, method: keyof T, err: Error): void {
  Object.defineProperty(target, method, {
    configurable: true,
    value: () => {
      throw err;
    },
  });
}

const busyError = () => new Database.SqliteError("database is locked", "SQLITE_BUSY");

function reclaimRecord(s: Server, path: string, agentId: string): { trigger: string | null; tick: number | null } {
  const raw = new Database(join(s.root, ".coherence", "state.db"), { readonly: true });
  try {
    return raw
      .prepare(
        `SELECT last_reclaim_trigger AS trigger, last_reclaim_tick AS tick
         FROM agent_states WHERE artifact_id = ? AND agent_id = ?`,
      )
      .get(idOf(s, path), agentId) as { trigger: string | null; tick: number | null };
  } finally {
    raw.close();
  }
}

// ---------------------------------------------------------------- the refusal

test("an EXCLUSIVE holder refuses an opted-in pre-edit and nothing changes hands", async () => {
  const s = await makeServer();
  try {
    await preEdit(s, SID_A, "plan.md");
    const r = await optedIn(s, SID_B, "plan.md");
    assertRefusal(r, sessionToAgentId(SID_A));
    assert.equal(s.registry.getAgentState(idOf(s, "plan.md"), sessionToAgentId(SID_A)), MESIState.EXCLUSIVE);
    assert.equal(s.registry.getAgentState(idOf(s, "plan.md"), sessionToAgentId(SID_B)), null);
    assert.deepEqual(s.registry.peekPendingNoticesForAgent(sessionToAgentId(SID_A)), []);
  } finally {
    await s.cleanup();
  }
});

test("a MODIFIED holder refuses an opted-in pre-edit and stays MODIFIED", async () => {
  const s = await makeServer();
  try {
    await preEdit(s, SID_A, "plan.md");
    await commitEdit(s, SID_A, "plan.md", "first\n");
    assert.equal(s.registry.getAgentState(idOf(s, "plan.md"), sessionToAgentId(SID_A)), MESIState.MODIFIED);
    assertRefusal(await optedIn(s, SID_B, "plan.md"), sessionToAgentId(SID_A));
    assert.equal(s.registry.getAgentState(idOf(s, "plan.md"), sessionToAgentId(SID_A)), MESIState.MODIFIED);
  } finally {
    await s.cleanup();
  }
});

test("a refusal leaves the caller's queued notices and re-grounding flag in place", async () => {
  const s = await makeServer();
  try {
    await queueNoticeFor(s, SID_B, "other.md");
    await preEdit(s, SID_A, "plan.md");
    s.sessions.markCompactPending(SID_B);
    assertRefusal(await optedIn(s, SID_B, "plan.md"), sessionToAgentId(SID_A));
    assert.equal(s.registry.peekPendingNoticesForAgent(sessionToAgentId(SID_B)).length, 1);
    assert.equal(s.sessions.hasCompactPending(SID_B), true);
  } finally {
    await s.cleanup();
  }
});

test("a refused caller holding the path SHARED keeps its grant and observed version", async () => {
  const s = await makeServer();
  try {
    await preEdit(s, SID_A, "plan.md");
    const id = idOf(s, "plan.md");
    const agentB = sessionToAgentId(SID_B);
    s.registry.grantShared(id, agentB, 1);
    const observed = s.registry.lastObservedVersionFor(id, agentB);
    assertRefusal(await optedIn(s, SID_B, "plan.md"), sessionToAgentId(SID_A));
    assert.equal(s.registry.getAgentState(id, agentB), MESIState.SHARED);
    assert.equal(s.registry.lastObservedVersionFor(id, agentB), observed);
  } finally {
    await s.cleanup();
  }
});

// ------------------------------------------------- who counts as another agent

test("subagents and their parent refuse each other; the holder's own repeat is admitted", async () => {
  const s = await makeServer();
  try {
    const x = sessionToAgentId(SID_S, SUB_X);
    const parent = sessionToAgentId(SID_S);
    await preEdit(s, SID_S, "plan.md", { agent_id: SUB_X });
    assertRefusal(await optedIn(s, SID_S, "plan.md", { agent_id: SUB_Y }), x);
    assertRefusal(await optedIn(s, SID_S, "plan.md"), x);

    await preEdit(s, SID_S, "notes.md");
    assertRefusal(await optedIn(s, SID_S, "notes.md", { agent_id: SUB_X }), parent);
    assert.deepEqual((await optedIn(s, SID_S, "notes.md")).body, { ok: true });
    // A malformed subagent id is read as the parent session, so it is the repeat.
    assert.deepEqual((await optedIn(s, SID_S, "notes.md", { agent_id: "not a subagent id!" })).body, { ok: true });
    assert.equal(s.registry.getAgentState(idOf(s, "notes.md"), parent), MESIState.EXCLUSIVE);
  } finally {
    await s.cleanup();
  }
});

test("over SHARED readers only, an opted-in pre-edit is admitted and the readers lose their read", async () => {
  const s = await makeServer();
  try {
    const id = s.registry.resolveOrRegisterArtifact("readers.md", HASH_1);
    s.registry.grantShared(id, sessionToAgentId(SID_A), 1);
    s.registry.grantShared(id, sessionToAgentId(SID_C), 1);
    assert.deepEqual((await optedIn(s, SID_B, "readers.md")).body, { ok: true });
    for (const reader of [SID_A, SID_C]) {
      assert.equal(s.registry.getAgentState(id, sessionToAgentId(reader)), MESIState.INVALID);
      assert.deepEqual(s.registry.peekPendingNoticesForAgent(sessionToAgentId(reader)), []);
    }
  } finally {
    await s.cleanup();
  }
});

// ------------------------------------------------------ the 30-minute reclaim

test("a grant held 30 minutes is reclaimed: plain admit, reclaim record, one log line, reclaim wording", async () => {
  const s = await makeServer();
  try {
    const agentA = sessionToAgentId(SID_A);
    const agentB = sessionToAgentId(SID_B);
    await preEdit(s, SID_A, "plan.md");
    const later = Date.now() + 1800 * 1000 + 1000;
    const { result: r, lines } = await captureStderr(() => withNow(later, () => optedIn(s, SID_B, "plan.md")));

    assert.deepEqual(r.body, { ok: true });
    const id = idOf(s, "plan.md");
    assert.equal(s.registry.getAgentState(id, agentA), MESIState.INVALID);
    assert.equal(s.registry.getAgentState(id, agentB), MESIState.EXCLUSIVE);
    assert.deepEqual(reclaimRecord(s, "plan.md", agentA), {
      trigger: "reclaim_max_hold",
      tick: Math.floor(later / 1000),
    });
    const logged = lines.filter((l) => l.startsWith("agent-coherence: reclaimed"));
    assert.equal(logged.length, 1, lines.join("\n"));
    const m = new RegExp(`^agent-coherence: reclaimed artifact=${id} holder=${agentA} held=(\\d+)s for=${agentB}$`).exec(
      logged[0]!,
    );
    assert.ok(m, logged[0]);
    assert.ok(Number(m[1]) >= 1800);

    // Session start shows the reclaim without consuming it.
    const ss = await s.request("/hooks/session-start", { session_id: SID_A });
    const ssText = JSON.stringify(ss.body);
    assert.ok(ssText.includes("minutes or more"), ssText);
    assert.doesNotMatch(ssText, /silently revoked/);
    assert.equal(s.registry.peekPendingNoticesForAgent(agentA).length, 1);

    // A's next admit drains it with the reclaim wording.
    const rr = await s.request("/hooks/pre-read", { session_id: SID_A, path: "other.md" });
    const rrText = JSON.stringify(rr.body);
    assert.ok(rrText.includes("minutes or more"), rrText);
    assert.doesNotMatch(rrText, /silently revoked/);

    // A's commit from the reclaimed grant is refused.
    writeFileSync(join(s.root, "plan.md"), "late\n");
    const pe = await s.request("/hooks/post-edit", {
      session_id: SID_A,
      path: "plan.md",
      success: true,
      content_hash: sha256("late\n"),
    });
    assert.equal(pe.body.ok, false);
    assert.match(String(pe.body.reason), /^commit_not_allowed/);
  } finally {
    await s.cleanup();
  }
});

test("session start sets the neutral intro when the queue's only reclaim sits past the verbatim cap", async () => {
  const s = await makeServer();
  try {
    const agentA = sessionToAgentId(SID_A);
    const T = 1_000_000;
    const reclaimedId = s.registry.resolveOrRegisterArtifact("reclaimed.md", HASH_1);
    s.registry.acquireExclusive(reclaimedId, agentA, T);
    s.registry.acquireExclusiveIfUnheld(reclaimedId, sessionToAgentId(SID_B), T + 1800);
    // Three newer ordinary preemptions fill the three verbatim slots.
    for (const [i, path] of ["a.md", "b.md", "c.md"].entries()) {
      const id = s.registry.resolveOrRegisterArtifact(path, HASH_1);
      s.registry.acquireExclusive(id, agentA, T + 1801);
      s.registry.acquireExclusive(id, sessionToAgentId(SID_C), T + 1802 + i);
    }
    const r = await s.request("/hooks/session-start", { session_id: SID_A });
    const text = String((r.body.hookSpecificOutput as Record<string, unknown>).additionalContext);
    assert.ok(text.includes("⚠ 4 of your EXCLUSIVE grants were revoked:"), text);
    assert.doesNotMatch(text, /silently/);
    assert.equal(text.split("preempted by agent").length - 1, 3);
  } finally {
    await s.cleanup();
  }
});

test("after reclaiming an EXCLUSIVE holder the admit skips the disk check; after a MODIFIED one it reports disk_differs", async () => {
  for (const holderCommitted of [false, true]) {
    const s = await makeServer();
    try {
      // The artifact has a recorded hash, and the bytes on disk differ from it.
      await preEdit(s, SID_C, "plan.md");
      await commitEdit(s, SID_C, "plan.md", "recorded\n");
      await preEdit(s, SID_A, "plan.md");
      if (holderCommitted) await commitEdit(s, SID_A, "plan.md", "recorded by A\n");
      writeFileSync(join(s.root, "plan.md"), "changed on disk\n");
      const r = await withNow(Date.now() + 1801 * 1000, () => optedIn(s, SID_B, "plan.md"));
      assert.equal(r.body.ok, true);
      if (holderCommitted) {
        assert.equal(r.body.disk_differs, true, JSON.stringify(r.body));
      } else {
        assert.equal("disk_differs" in r.body, false, JSON.stringify(r.body));
      }
    } finally {
      await s.cleanup();
    }
  }
});

// --------------------------------------------------- the default path is unchanged

test("a pre-edit whose if_unheld is anything but JSON true answers exactly as one without it", async () => {
  const s = await makeServer();
  try {
    const fixedMs = Date.now();
    const variants: Array<Record<string, unknown>> = [
      {},
      { if_unheld: "true" },
      { if_unheld: 1 },
      { if_unheld: null },
      { if_unheld: false },
      { if_unheld: {} },
    ];
    const answers = await withNow(fixedMs, async () => {
      const out: string[] = [];
      for (const [i, extra] of variants.entries()) {
        await preEdit(s, SID_A, "plan.md");
        const caller = `88888888-8888-4888-8888-${String(i).padStart(12, "0")}`;
        out.push((await preEdit(s, caller, "plan.md", extra)).raw);
      }
      return out;
    });
    assert.equal((JSON.parse(answers[0]!) as Record<string, unknown>).collision, true);
    for (const answer of answers) assert.equal(answer, answers[0]);
  } finally {
    await s.cleanup();
  }
});

test("an ordinary pre-edit still displaces an opted-in holder", async () => {
  const s = await makeServer();
  try {
    assert.deepEqual((await optedIn(s, SID_B, "plan.md")).body, { ok: true });
    const r = await preEdit(s, SID_C, "plan.md");
    assert.equal(r.body.collision, true);
    const id = idOf(s, "plan.md");
    assert.equal(s.registry.getAgentState(id, sessionToAgentId(SID_B)), MESIState.INVALID);
    assert.equal(s.registry.peekPendingNoticesForAgent(sessionToAgentId(SID_B)).length, 1);
  } finally {
    await s.cleanup();
  }
});

// ----------------------------------------------------- the order of the answers

test("an untracked path admits an opted-in pre-edit unchecked and records nothing", async () => {
  const s = await makeServer({ ignored: ["skip.md"] });
  try {
    assert.deepEqual((await optedIn(s, SID_B, "skip.md")).body, { ok: true });
    assert.equal(s.registry.getArtifactByName("skip.md"), null);
  } finally {
    await s.cleanup();
  }
});

test("a held path untracked afterwards admits an opted-in pre-edit unchecked", async () => {
  const s = await makeServer();
  try {
    await preEdit(s, SID_A, "held.md");
    writePolicy(s.root, "ignored.yaml", ["held.md"]);
    s.policy.reload();
    assert.deepEqual((await optedIn(s, SID_B, "held.md")).body, { ok: true });
    assert.equal(s.registry.getAgentState(idOf(s, "held.md"), sessionToAgentId(SID_A)), MESIState.EXCLUSIVE);
  } finally {
    await s.cleanup();
  }
});

test("a held strict path listed in ignored.yaml stays tracked and refuses", async () => {
  const s = await makeServer({ strict: ["strict.md"], ignored: ["strict.md"] });
  try {
    await preEdit(s, SID_A, "strict.md");
    assertRefusal(await optedIn(s, SID_B, "strict.md"), sessionToAgentId(SID_A));
  } finally {
    await s.cleanup();
  }
});

test("a stale strict-mode editor that opts in gets the strict deny first", async () => {
  const s = await makeServer({ strict: ["strict.md"] });
  try {
    await preEdit(s, SID_B, "strict.md");
    await preEdit(s, SID_A, "strict.md"); // B preempted
    await commitEdit(s, SID_A, "strict.md", "v2\n");
    const r = await optedIn(s, SID_B, "strict.md");
    assert.equal(r.body.ok, false);
    assert.equal(r.body.status, "stale");
    assert.ok("hookSpecificOutput" in r.body);
    assert.notEqual(r.body.reason, "other_holder");
  } finally {
    await s.cleanup();
  }
});

// ------------------------------------------------------------ after the answer

test("after a refusal the holder commits and its next read is fresh", async () => {
  const s = await makeServer();
  try {
    await preEdit(s, SID_A, "plan.md");
    assertRefusal(await optedIn(s, SID_B, "plan.md"), sessionToAgentId(SID_A));
    await commitEdit(s, SID_A, "plan.md", "v2\n");
    const r = await s.request("/hooks/pre-read", { session_id: SID_A, path: "plan.md", content_hash: sha256("v2\n") });
    assert.deepEqual(r.body, { status: "fresh" });
  } finally {
    await s.cleanup();
  }
});

test("after the holder's session stops, an opted-in pre-edit is admitted with no collision", async () => {
  const s = await makeServer();
  try {
    await preEdit(s, SID_A, "plan.md");
    await s.request("/hooks/session-stop", { session_id: SID_A });
    assert.deepEqual((await optedIn(s, SID_B, "plan.md")).body, { ok: true });
  } finally {
    await s.cleanup();
  }
});

test("an opted-in admit names no holder the decision did not displace", async () => {
  const s = await makeServer();
  try {
    await preEdit(s, SID_A, "plan.md");
    const id = idOf(s, "plan.md");
    // The holder lets go between the handler's start and the decision.
    const original = s.registry.acquireExclusiveIfUnheld.bind(s.registry);
    Object.defineProperty(s.registry, "acquireExclusiveIfUnheld", {
      configurable: true,
      value: (artifactId: string, agentId: string, nowTick: number) => {
        s.registry.invalidate(id, sessionToAgentId(SID_A), nowTick, "session_stop");
        return original(artifactId, agentId, nowTick);
      },
    });
    assert.deepEqual((await optedIn(s, SID_B, "plan.md")).body, { ok: true });
    assert.deepEqual(s.registry.peekPendingNoticesForAgent(sessionToAgentId(SID_A)), []);
  } finally {
    await s.cleanup();
  }
});

test("the opted-in decision is one transaction: admit 2, refusal 1, unseen admit 3, reclaim admit 2", async () => {
  const s = await makeServer();
  try {
    s.registry.resolveOrRegisterArtifact("seen.md", HASH_1);
    assert.equal(await countBegins(() => optedIn(s, SID_B, "seen.md")), 2);

    await preEdit(s, SID_A, "plan.md");
    assert.equal(await countBegins(() => optedIn(s, SID_C, "plan.md")), 1);

    assert.equal(await countBegins(() => optedIn(s, SID_C, "fresh.md")), 3);

    await preEdit(s, SID_A, "old.md");
    const later = Date.now() + 1801 * 1000;
    assert.equal(await countBegins(() => withNow(later, () => optedIn(s, SID_C, "old.md"))), 2);
  } finally {
    await s.cleanup();
  }
});

// ------------------------------------------------------------ a busy store

/** Another connection holds the store's write lock past the busy timeout. */
async function whileStoreLocked<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const other = new Database(join(root, ".coherence", "state.db"));
  other.exec("BEGIN IMMEDIATE");
  try {
    return await fn();
  } finally {
    other.exec("ROLLBACK");
    other.close();
  }
}

/** Make the notice pop meet a real held lock: take it, then call the original. */
function lockBeforePop(s: Server): void {
  const original = s.registry.popPendingNoticesForAgent.bind(s.registry);
  Object.defineProperty(s.registry, "popPendingNoticesForAgent", {
    configurable: true,
    value: (agentId: string, consumeLimit?: number) => {
      const other = new Database(join(s.root, ".coherence", "state.db"));
      other.exec("BEGIN IMMEDIATE");
      try {
        return original(agentId, consumeLimit);
      } finally {
        other.exec("ROLLBACK");
        other.close();
      }
    },
  });
}

test("a store busy before the grant answers the failure envelope, opted in or not", async () => {
  const s = await makeServer();
  try {
    s.registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    await whileStoreLocked(s.root, async () => {
      assert.deepEqual((await optedIn(s, SID_B, "plan.md")).body, BUSY);
      assert.deepEqual((await optedIn(s, SID_B, "new.md")).body, BUSY);
      assert.deepEqual((await preEdit(s, SID_C, "plan.md")).body, BUSY);
    });
    assert.equal(s.registry.getAgentState(idOf(s, "plan.md"), sessionToAgentId(SID_B)), null);
    assert.equal(s.registry.getArtifactByName("new.md"), null);
  } finally {
    await s.cleanup();
  }
});

test("a busy notice drain after an opted-in grant admits without notices and keeps them queued", async () => {
  const s = await makeServer();
  try {
    await queueNoticeFor(s, SID_B, "other.md");
    lockBeforePop(s);
    assert.deepEqual((await optedIn(s, SID_B, "plan.md")).body, { ok: true });
    assert.equal(s.registry.getAgentState(idOf(s, "plan.md"), sessionToAgentId(SID_B)), MESIState.EXCLUSIVE);
    assert.equal(s.registry.peekPendingNoticesForAgent(sessionToAgentId(SID_B)).length, 1);

    // An ordinary request in the same position keeps today's answer.
    await queueNoticeFor(s, SID_A, "a.md");
    assert.deepEqual((await preEdit(s, SID_A, "b.md")).body, BUSY);
  } finally {
    await s.cleanup();
  }
});

test("a busy drain still delivers re-grounding, without the notices it kept", async () => {
  const s = await makeServer();
  try {
    await queueNoticeFor(s, SID_B, "other.md");
    s.sessions.markCompactPending(SID_B);
    lockBeforePop(s);
    const r = await optedIn(s, SID_B, "plan.md");
    assert.equal(r.body.ok, true);
    const text = JSON.stringify(r.body);
    assert.ok("hookSpecificOutput" in r.body, text);
    assert.doesNotMatch(text, /revoked|preempted by agent/);
    assert.equal(s.sessions.hasCompactPending(SID_B), false);
    assert.equal(s.registry.peekPendingNoticesForAgent(sessionToAgentId(SID_B)).length, 1);
  } finally {
    await s.cleanup();
  }
});

test("only the pop's busy error is caught: a busy artifact read in the drain, or another error, still fails", async () => {
  const s = await makeServer();
  try {
    await queueNoticeFor(s, SID_B, "other.md");
    failOn(s.registry, "getArtifactById", busyError());
    assert.deepEqual((await optedIn(s, SID_B, "plan.md")).body, BUSY);
  } finally {
    await s.cleanup();
  }
  const t = await makeServer();
  try {
    failOn(t.registry, "popPendingNoticesForAgent", new Database.SqliteError("disk I/O error", "SQLITE_IOERR"));
    assert.deepEqual((await optedIn(t, SID_B, "plan.md")).body, BUSY);
  } finally {
    await t.cleanup();
  }
});
