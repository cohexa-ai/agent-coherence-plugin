/**
 * Strict-mode recovery after a stale deny (#514).
 *
 * A session whose copy of a strict file went stale is denied its first stale
 * Read or Edit of that file. Its next Read is admitted at the current version
 * when the bytes it read are the recorded ones (or the record holds no content
 * claim), and an Edit sent before that Read is still denied. A Read whose
 * bytes differ, or that carries no hash, stays denied. Only the Claude Code
 * hook request shape (no `want_owner_generation`, `verify_only` or
 * `name_kind`) can be admitted this way; every other caller keeps the sticky
 * deny it documents.
 *
 * Every test drives the HTTP routes in the order a session meets them; none
 * writes registry rows by hand to make a copy stale.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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
import { pythonIsoUtc } from "../hook_payloads.js";

const SECRET = "s".repeat(32);
const SID_A = "44444444-4444-4444-8444-444444444444";
const SID_B = "55555555-5555-5555-8555-555555555555";
const SID_C = "66666666-6666-6666-8666-666666666666";
const SID_D = "77777777-7777-4777-8777-777777777777";
const PLAN = "plan.md";
const WARN_PATH = "docs/plans/x.md";
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const H4 = "4".repeat(64);

type Body = Record<string, unknown>;
type Post = (route: string, body: Body) => Promise<Body>;

/*
 * The deny texts, written out here rather than read from the templates, so a
 * change to either side fails. They are the bytes the Python coordinator
 * emits too.
 */
const commitDeny = (path: string, writer: string, iso: string): string =>
  `Stale read denied: ${path} was updated by agent ${writer} at ${iso}. Read ${path} again with the Read ` +
  `tool: the next Read returns the current version, and edits of ${path} are denied until you have read it.`;

const grantChangeDeny = (path: string, version: number): string =>
  `Stale read denied: your grant on ${path} was revoked and no new version was committed — ${path} is ` +
  `still at v${version}. Read ${path} again with the Read tool: the next Read returns the current version, ` +
  `and edits of ${path} are denied until you have read it.`;

const outOfBandDeny = (path: string, version: number): string =>
  `Stale read denied: ${path} on disk does not match v${version}, the last version committed through the ` +
  `coordinator, and no session committed the change, so it was made outside the coordinator. Do not ` +
  `restore or overwrite ${path}: the change may be your user's work. Tell your user that ${path} changed ` +
  `outside the coordinator; the read stays denied until the change is committed through the coordinator. ` +
  `This denial is structural (v0.2 strict mode); retrying the same operation will produce the same denial.`;

const writeInFlightDeny = (path: string, version: number): string =>
  `Stale read denied: another agent is writing ${path} and has not committed it yet, so ${path} on disk ` +
  `does not match v${version}, the last version committed through the coordinator. Wait for that write ` +
  `to be committed, then Read ${path} again with the Read tool.`;

function makeWorkspace(strictPatterns: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "stale-read-recovery-"));
  mkdirSync(join(root, ".coherence"), { recursive: true });
  writeFileSync(
    join(root, ".coherence", "strict_mode.yaml"),
    strictPatterns.map((p) => `- ${p}`).join("\n") + "\n",
  );
  return root;
}

/** One coordinator process over the workspace's store; `stop` keeps the store. */
async function startCoordinator(root: string) {
  const registry = new ArtifactRegistry(join(root, ".coherence", "state.db"));
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy: PolicyRef.load(root),
    sessions: new SessionRegistry(),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const post: Post = async (route, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, Host: "127.0.0.1", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Body;
  };
  const stop = () => new Promise<void>((r) => server.close(() => (registry.close(), r())));
  return { registry, post, stop };
}

async function withCoordinator(
  strictPatterns: string[],
  run: (c: Awaited<ReturnType<typeof startCoordinator>>) => Promise<void>,
): Promise<void> {
  const root = makeWorkspace(strictPatterns);
  const coordinator = await startCoordinator(root);
  try {
    await run(coordinator);
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

/** The hook calls one Claude Code identity makes on one file. */
function sessionOf(post: Post, who: { sid: string; agentId?: string; path?: string }) {
  const base: Body = { session_id: who.sid, ...(who.agentId === undefined ? {} : { agent_id: who.agentId }) };
  const path = who.path ?? PLAN;
  return {
    read: (hash: string | null, extra: Body = {}) =>
      post("/hooks/pre-read", { ...base, path, ...(hash === null ? {} : { content_hash: hash }), ...extra }),
    edit: () => post("/hooks/pre-edit", { ...base, path }),
    commit: (hash: string) => post("/hooks/post-edit", { ...base, path, success: true, content_hash: hash }),
    cat: () => post("/hooks/pre-bash", { ...base, command: `cat ${path}` }),
    stop: () => post("/hooks/session-stop", base),
  };
}

type Session = ReturnType<typeof sessionOf>;

const isDenied = (b: Body): boolean =>
  (b.hookSpecificOutput as Body | undefined)?.permissionDecision === "deny";

/** A deny, and when `reason` is given, exactly that reason text. */
function assertDenied(b: Body, label: string, reason?: string): void {
  assert.equal(isDenied(b), true, `${label}: expected a deny, got ${JSON.stringify(b)}`);
  if (reason !== undefined) assert.equal((b.hookSpecificOutput as Body).permissionDecisionReason, reason, label);
}

function assertEditDenied(b: Body, label: string, reason?: string): void {
  assert.equal(b.ok, false, `${label}: ${JSON.stringify(b)}`);
  assertDenied(b, label, reason);
}

/** The commit text for the file's last commit, made by `writerAgentId`. */
function lastCommitDeny(registry: ArtifactRegistry, writerAgentId: string): string {
  const artifact = registry.getArtifactByName(PLAN)!;
  return commitDeny(PLAN, writerAgentId.slice(0, 8), pythonIsoUtc(artifact.updated_at));
}

const AGENT_A = sessionToAgentId(SID_A);
const SUBAGENT = "a0826622451ec196f";

function assertEditAdmitted(b: Body, label: string): void {
  assert.equal(b.ok, true, `${label}: ${JSON.stringify(b)}`);
  assert.equal(isDenied(b), false, label);
}

/** An admitted Read answers on the fresh arm at `version`, with no stale warning. */
function assertReadAdmitted(b: Body, version: number, label: string): void {
  assert.equal(b.status, "fresh", `${label}: ${JSON.stringify(b)}`);
  assert.equal(b.version, version, label);
  assert.equal(isDenied(b), false, label);
}

async function peerCommits(peer: Session, hash: string): Promise<void> {
  assertEditAdmitted(await peer.edit(), "peer edit");
  assert.deepEqual(await peer.commit(hash), { ok: true });
}

/** B reads v1 (H1), then A edits and commits v2 (H2): B's copy is stale. */
async function staleB(post: Post): Promise<{ a: Session; b: Session }> {
  const a = sessionOf(post, { sid: SID_A });
  const b = sessionOf(post, { sid: SID_B });
  assertReadAdmitted(await b.read(H1), 1, "B's first read");
  await peerCommits(a, H2);
  return { a, b };
}

test("a peer's commit: B's Read and Edit are denied, its next Read is admitted at v2, then its Edit", async () => {
  await withCoordinator([PLAN], async ({ registry, post }) => {
    const { b } = await staleB(post);
    const committed = lastCommitDeny(registry, AGENT_A);
    assertDenied(await b.read(H2), "first stale read", committed);
    assertEditDenied(await b.edit(), "edit before reading again", committed);
    const admitted = await b.read(H2);
    assert.deepEqual(admitted, { status: "fresh", version: 2 });
    const id = registry.getArtifactByName(PLAN)!.id;
    const agentB = sessionToAgentId(SID_B);
    assert.equal(registry.getAgentState(id, agentB), MESIState.SHARED);
    assert.equal(registry.lastObservedVersionFor(id, agentB), 2);
    assertEditAdmitted(await b.edit(), "edit after reading again");
  });
});

test("an Edit first: one deny, and the next Read is admitted", async () => {
  await withCoordinator([PLAN], async ({ registry, post }) => {
    const { b } = await staleB(post);
    assertEditDenied(await b.edit(), "first stale edit", lastCommitDeny(registry, AGENT_A));
    assertReadAdmitted(await b.read(H2), 2, "read after the edit deny");
  });
});

test("bytes put back to v1 with no commit: the Read after the deny is denied, and so is the Edit", async () => {
  await withCoordinator([PLAN], async ({ registry, post }) => {
    const { b } = await staleB(post);
    const committed = lastCommitDeny(registry, AGENT_A);
    assertDenied(await b.read(H2), "first stale read", committed);
    const outOfBand = await b.read(H1);
    assertDenied(outOfBand, "read of bytes no session committed", outOfBandDeny(PLAN, 2));
    // The same read again: the same bytes, since this deny stays in place.
    assertDenied(await b.read(H1), "the same read again", outOfBandDeny(PLAN, 2));
    assertEditDenied(await b.edit(), "edit after the denied read", committed);
  });
});

test("a deleted file: the Read after the deny carries no hash and is denied, and so is a Write", async () => {
  await withCoordinator([PLAN], async ({ registry, post }) => {
    const { b } = await staleB(post);
    const committed = lastCommitDeny(registry, AGENT_A);
    assertDenied(await b.read(H2), "first stale read", committed);
    assertDenied(await b.read(null), "read of a missing file", outOfBandDeny(PLAN, 2));
    assertEditDenied(await b.edit(), "write after the denied read", committed);
  });
});

test("another session's uncommitted write on disk: the Read after the deny is denied", async () => {
  await withCoordinator([PLAN], async ({ registry, post }) => {
    const { b } = await staleB(post);
    const c = sessionOf(post, { sid: SID_C });
    assertDenied(await b.read(H2), "first stale read", lastCommitDeny(registry, AGENT_A));
    assertEditAdmitted(await c.edit(), "C takes the file and writes H3 without committing");
    assertDenied(await b.read(H3), "read of C's uncommitted bytes", writeInFlightDeny(PLAN, 2));
  });
});

test("a first stale Read whose bytes already differ is denied and arms the recovery", async () => {
  await withCoordinator([PLAN], async ({ post }) => {
    const { b } = await staleB(post);
    assertDenied(await b.read(H3), "first stale read, bytes no session committed", outOfBandDeny(PLAN, 2));
    assertReadAdmitted(await b.read(H2), 2, "read of the recorded bytes");
  });
});

test("a first stale Read of another session's uncommitted bytes gets the write-in-flight text", async () => {
  await withCoordinator([PLAN], async ({ post }) => {
    const { b } = await staleB(post);
    assertEditAdmitted(await sessionOf(post, { sid: SID_C }).edit(), "C takes the file and writes H3");
    assertDenied(await b.read(H3), "first stale read of C's bytes", writeInFlightDeny(PLAN, 2));
  });
});

test("a commit between the deny and the Read: the Read is admitted at the newer version", async () => {
  await withCoordinator([PLAN], async ({ registry, post }) => {
    const { a, b } = await staleB(post);
    assertDenied(await b.read(H2), "first stale read", lastCommitDeny(registry, AGENT_A));
    await peerCommits(a, H3);
    assertReadAdmitted(await b.read(H3), 3, "read after the second commit");
    // The admitted Read used up the recovery: the next staleness starts from a deny.
    await peerCommits(a, H4);
    assertDenied(await b.read(H4), "first read after the third commit", lastCommitDeny(registry, AGENT_A));
  });
});

test("an identity whose rows were forgotten uses up its recovery on its next admitted Read", async () => {
  await withCoordinator([PLAN], async ({ registry, post }) => {
    const a = sessionOf(post, { sid: SID_A });
    const sub = sessionOf(post, { sid: SID_B, agentId: SUBAGENT });
    assertReadAdmitted(await sub.read(H1), 1, "subagent's first read");
    await peerCommits(a, H2);
    assertDenied(await sub.read(H2), "subagent's first stale read", lastCommitDeny(registry, AGENT_A));
    // An ended stop forgets the identity's rows but not its recovery.
    assert.deepEqual(await post("/hooks/session-stop", { session_id: SID_B, agent_id: SUBAGENT, ended: true }), {
      ok: true,
      released_artifacts: [],
    });
    assert.equal((await sub.read(H2)).status, "stale", "a read with no row is admitted on the stale arm");
    await peerCommits(a, H3);
    assertDenied(await sub.read(H3), "first read after the next commit", lastCommitDeny(registry, AGENT_A));
  });
});

test("a shell read recovers the row; the next Read uses up the recovery, so the next staleness is denied again", async () => {
  await withCoordinator([PLAN], async ({ registry, post }) => {
    const { a, b } = await staleB(post);
    const committed = lastCommitDeny(registry, AGENT_A);
    assertDenied(await b.read(H2), "first stale read", committed);
    assertDenied(await b.cat(), "the shell read is denied and re-grants the row", committed);
    assertReadAdmitted(await b.read(H2), 2, "read on the re-granted row");
    await peerCommits(a, H3);
    assertDenied(await b.read(H3), "first read after the next commit", lastCommitDeny(registry, AGENT_A));
    assertReadAdmitted(await b.read(H3), 3, "read after that deny");
  });
});

test("an admitted Edit uses up the recovery, so the next staleness is denied again", async () => {
  await withCoordinator([PLAN], async ({ registry, post }) => {
    const { b } = await staleB(post);
    assertDenied(await b.read(H2), "first stale read", lastCommitDeny(registry, AGENT_A));
    assertDenied(await b.cat(), "the shell read is denied and re-grants the row");
    assert.equal((await b.cat()).status, "fresh", "the retried shell read records v2");
    assertEditAdmitted(await b.edit(), "edit after the shell read");
    await b.stop();
    // B's edit took A's grant, so a third session makes the next commit.
    await peerCommits(sessionOf(post, { sid: SID_C }), H3);
    assertDenied(await b.read(H3), "first read after the next commit", lastCommitDeny(registry, sessionToAgentId(SID_C)));
  });
});

test("a subagent's commit: the parent's Read is denied once, and the next is admitted", async () => {
  await withCoordinator([PLAN], async ({ registry, post }) => {
    const parent = sessionOf(post, { sid: SID_B });
    const subagent = sessionOf(post, { sid: SID_B, agentId: SUBAGENT });
    assertReadAdmitted(await parent.read(H1), 1, "parent's first read");
    await peerCommits(subagent, H2);
    await subagent.stop();
    const committed = lastCommitDeny(registry, sessionToAgentId(SID_B, SUBAGENT));
    assertDenied(await parent.read(H2), "parent's first stale read", committed);
    assertReadAdmitted(await parent.read(H2), 2, "parent's next read");
  });
});

test("a holder takes the file and stops without committing: B's Read is denied once, and the next is admitted", async () => {
  await withCoordinator([PLAN], async ({ post }) => {
    const a = sessionOf(post, { sid: SID_A });
    const b = sessionOf(post, { sid: SID_B });
    assertReadAdmitted(await b.read(H1), 1, "B's first read");
    assertEditAdmitted(await a.edit(), "A takes the file");
    await a.stop();
    assertDenied(await b.read(H1), "B's first read after the handover", grantChangeDeny(PLAN, 1));
    assertReadAdmitted(await b.read(H1), 1, "B's next read");
  });
});

/** B and C read v1; then `staleness`, by A, makes both copies stale. C is kept for a pre-grep. */
async function staleReaders(post: Post, staleness: (a: Session) => Promise<void>): Promise<Session[]> {
  const readers = [sessionOf(post, { sid: SID_B }), sessionOf(post, { sid: SID_C })];
  // C's first read is of a file B registered, so it is allowed on the stale arm.
  for (const reader of readers) assert.equal(isDenied(await reader.read(H1)), false, "first read");
  await staleness(sessionOf(post, { sid: SID_A }));
  return readers;
}

test("the commit and grant-change texts are the same bytes on a pre-read, pre-edit, pre-bash and pre-grep deny", async () => {
  await withCoordinator([PLAN], async ({ registry, post }) => {
    const [b] = await staleReaders(post, (a) => peerCommits(a, H2));
    const committed = lastCommitDeny(registry, AGENT_A);
    assertDenied(await b.read(H2), "pre-read", committed);
    assertEditDenied(await b.edit(), "pre-edit", committed);
    assertDenied(await b.cat(), "pre-bash", committed);
    assertDenied(await post("/hooks/pre-grep", { session_id: SID_C, search_root: "" }), "pre-grep", committed);
  });
  await withCoordinator([PLAN], async ({ post }) => {
    const [b] = await staleReaders(post, async (a) => {
      assertEditAdmitted(await a.edit(), "A takes the file");
      await a.stop();
    });
    const revoked = grantChangeDeny(PLAN, 1);
    assertDenied(await b.read(H1), "pre-read", revoked);
    assertEditDenied(await b.edit(), "pre-edit", revoked);
    assertDenied(await b.cat(), "pre-bash", revoked);
    assertDenied(await post("/hooks/pre-grep", { session_id: SID_C, search_root: "" }), "pre-grep", revoked);
  });
});

for (const [label, field] of [
  ["want_owner_generation", { want_owner_generation: true }],
  ["verify_only", { verify_only: true }],
  ["name_kind", { name_kind: "file" }],
] as const) {
  test(`a read carrying ${label} keeps the sticky deny and neither arms nor uses up the recovery`, async () => {
    await withCoordinator([PLAN], async ({ registry, post }) => {
      const { b } = await staleB(post);
      const committed = lastCommitDeny(registry, AGENT_A);
      assertDenied(await b.read(H2, field), `first ${label} read`, committed);
      assertDenied(await b.read(H2, field), `second ${label} read`, committed);
      // Not armed by those two: the first hook Read is still the deny.
      assertDenied(await b.read(H2), "first hook read", committed);
      // Armed now, and not used up by another such read.
      assertDenied(await b.read(H2, field), `${label} read after the hook deny`, committed);
      assertReadAdmitted(await b.read(H2), 2, "next hook read");
    });
  });
}

test("the recovery survives a Stop: B's first Read in its next turn is admitted", async () => {
  await withCoordinator([PLAN], async ({ registry, post }) => {
    const { b } = await staleB(post);
    assertDenied(await b.read(H2), "first stale read", lastCommitDeny(registry, AGENT_A));
    assert.equal((await b.stop()).ok, true);
    assertReadAdmitted(await b.read(H2), 2, "first read of the next turn");
  });
});

test("a session that never read the file, with bytes that differ, is denied on every Read, naming no writer", async () => {
  await withCoordinator([PLAN], async ({ post }) => {
    await staleB(post);
    const c = sessionOf(post, { sid: SID_C });
    assertDenied(await c.read(H4), "C's first read", outOfBandDeny(PLAN, 2));
    assertDenied(await c.read(H4), "C's second read", outOfBandDeny(PLAN, 2));
  });
});

test("a session that never read a file whose record claims no bytes is not promised a Read it would be refused", async () => {
  await withCoordinator([PLAN], async ({ post }) => {
    // A first read that sends the all-f placeholder hash records a version
    // with no content claim; the never-read deny still fires on other bytes.
    assertReadAdmitted(await sessionOf(post, { sid: SID_A }).read("f".repeat(64)), 1, "A's first read");
    const c = sessionOf(post, { sid: SID_C });
    assertDenied(await c.read(H4), "C's first read", outOfBandDeny(PLAN, 1));
    assertDenied(await c.read(H4), "C's second read", outOfBandDeny(PLAN, 1));
  });
});

test("a session that never read the file, reading another session's uncommitted bytes, gets the write-in-flight text", async () => {
  await withCoordinator([PLAN], async ({ post }) => {
    await staleB(post);
    assertEditAdmitted(await sessionOf(post, { sid: SID_D }).edit(), "D takes the file and writes H4");
    const c = sessionOf(post, { sid: SID_C });
    assertDenied(await c.read(H4), "C's first read", writeInFlightDeny(PLAN, 2));
    assertDenied(await c.read(H4), "C's second read", writeInFlightDeny(PLAN, 2));
  });
});

test("warn mode is unchanged: a stale Read is allowed with a stale warning", async () => {
  await withCoordinator([PLAN], async ({ post }) => {
    const a = sessionOf(post, { sid: SID_A, path: WARN_PATH });
    const b = sessionOf(post, { sid: SID_B, path: WARN_PATH });
    assertReadAdmitted(await b.read(H1), 1, "B's first read");
    await peerCommits(a, H2);
    const stale = await b.read(H2);
    assert.equal(stale.status, "stale");
    assert.equal((stale.hookSpecificOutput as Body).permissionDecision, "allow");
    assert.match(String((stale.hookSpecificOutput as Body).additionalContext), /^⚠ Stale read/);
  });
});

test("a coordinator restart costs one more deny: the Read after it is denied, the next admitted", async () => {
  const root = makeWorkspace([PLAN]);
  try {
    const first = await startCoordinator(root);
    try {
      const { b } = await staleB(first.post);
      assertDenied(await b.read(H2), "first stale read", lastCommitDeny(first.registry, AGENT_A));
    } finally {
      await first.stop();
    }
    const second = await startCoordinator(root);
    try {
      const b = sessionOf(second.post, { sid: SID_B });
      assertDenied(await b.read(H2), "first read after the restart", lastCommitDeny(second.registry, AGENT_A));
      assertReadAdmitted(await b.read(H2), 2, "next read");
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
