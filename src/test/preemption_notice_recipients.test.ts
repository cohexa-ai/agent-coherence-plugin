/**
 * Who is told a write grant was revoked, over the real hook routes (#163).
 *
 * The notice reads "Your EXCLUSIVE grant on this artifact was silently
 * revoked". The Python coordinator queues one only for a peer that held
 * EXCLUSIVE or MODIFIED when another session pre-edited; a commit or CAS
 * commit invalidates readers and queues nothing. registry_pending_notices
 * pins the rule at the registry; this file pins what the model reads.
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

const SECRET = "s".repeat(32);
const X = "44444444-4444-4444-8444-444444444444";
const Y = "55555555-5555-5555-8555-555555555555";
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const NOTICE = /silently revoked/;

/** Notice bullets' paths; the "  • Plus N more…" overflow line is a bullet too, and not a notice. */
const noticePaths = (ctx: string | undefined): string[] =>
  (ctx ?? "")
    .split("\n")
    .filter((l) => l.startsWith("  • ") && !l.startsWith("  • Plus "))
    .map((l) => l.match(/^ {2}• (\S+) /)?.[1] ?? l);

type Call = [route: string, body: Record<string, unknown>];

const read = (sid: string, path = "a/plan.md"): Call => ["/hooks/pre-read", { session_id: sid, path, content_hash: HASH_1 }];
const edit = (sid: string, path = "a/plan.md"): Call => ["/hooks/pre-edit", { session_id: sid, path }];
const commit = (sid: string): Call => [
  "/hooks/post-edit",
  { session_id: sid, path: "a/plan.md", success: true, content_hash: HASH_2 },
];
const casCommit = (sid: string): Call => [
  "/hooks/post-edit-cas",
  { session_id: sid, path: "a/plan.md", expected_version: 1, content_hash: HASH_2 },
];

/** Run `calls` on a fresh coordinator; return the context X's next hook carries. */
async function nextContextForX(calls: Call[]): Promise<string | undefined> {
  const tmp = mkdtempSync(join(tmpdir(), "notice-recipients-"));
  const registry = new ArtifactRegistry(join(tmp, ".coherence", "state.db"));
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy: PolicyRef.load(tmp),
    sessions: new SessionRegistry(),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (server.address() as AddressInfo).port;
    const post = async (route: string, body: unknown) =>
      (await (
        await fetch(`http://127.0.0.1:${port}${route}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${SECRET}`, Host: "127.0.0.1", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json()) as { hookSpecificOutput?: { additionalContext?: string } };
    for (const [route, body] of calls) await post(route, body);
    // A first read of an unrelated tracked file: it drains X's notices.
    const next = await post("/hooks/pre-read", { session_id: X, path: "b/plan.md", content_hash: HASH_1 });
    return next.hookSpecificOutput?.additionalContext;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    registry.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("a session that only read is not told it lost a write grant, whichever route invalidated it", async () => {
  for (const [label, calls] of [
    ["peer pre-edit", [read(X), edit(Y)]],
    ["peer commit", [edit(Y), read(X), commit(Y)]],
    ["peer CAS commit", [read(X), read(Y), casCommit(Y)]],
  ] as const) {
    const ctx = await nextContextForX([...calls]);
    assert.doesNotMatch(ctx ?? "", NOTICE, `${label}: a reader got a revoked-grant notice:\n${ctx}`);
  }
});

test("a session that held EXCLUSIVE or MODIFIED is still told, exactly once", async () => {
  for (const [label, calls] of [
    ["held EXCLUSIVE", [edit(X), edit(Y)]],
    ["held MODIFIED", [edit(X), commit(X), edit(Y)]],
  ] as const) {
    const ctx = await nextContextForX([...calls]);
    assert.match(ctx ?? "", NOTICE, `${label}: no notice`);
    assert.deepEqual(noticePaths(ctx), ["a/plan.md"], `${label}: expected one notice:\n${ctx}`);
  }
});

test("reads a peer later edits do not crowd out the one grant actually lost", async () => {
  // X reads four files and holds EXCLUSIVE on a fifth; Y takes the fifth,
  // then pre-edits the four. Only the fifth was a grant X held.
  const readPaths = ["r1", "r2", "r3", "r4"].map((d) => `${d}/plan.md`);
  const ctx = await nextContextForX([
    ...readPaths.map((p) => read(X, p)),
    edit(X, "real/plan.md"),
    edit(Y, "real/plan.md"),
    ...readPaths.map((p) => edit(Y, p)),
  ]);
  assert.deepEqual(noticePaths(ctx), ["real/plan.md"], `expected only the lost grant:\n${ctx}`);
});
