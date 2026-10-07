/**
 * Unit 2 — the 5 zero-Python routes, full-HTTP integration
 * (pattern: status_shape.test.ts). Byte-parity contracts per the plan:
 * exact error strings, response keys (`removed` on untrack), the
 * PolicyRef live-reload end-to-end, and the CAS wire bodies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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

async function makeServer() {
  const tmp = mkdtempSync(join(tmpdir(), "unit2-test-"));
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
  return { registry, sessions, post, cleanup, root: tmp };
}

// ---------------------------------------------------------------- pre-bash

test("pre-bash: untracked-only command → fresh (fast path)", async () => {
  const { post, cleanup } = await makeServer();
  try {
    const r = await post("/hooks/pre-bash", { session_id: SID_A, command: "cat untracked.txt" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "fresh" });
  } finally {
    await cleanup();
  }
});

test("pre-bash: stale tracked path → stale + exact warn prose + re-grant", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    // Seed: B commits CLAUDE.md v2 while A holds nothing → A stale on read.
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 10);
    registry.commit(id, agentB, HASH_2, 11);

    const r = await post("/hooks/pre-bash", { session_id: SID_A, command: "cat CLAUDE.md" });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "stale");
    assert.deepEqual(r.body.stale_paths, ["CLAUDE.md"]);
    const hso = r.body.hookSpecificOutput as Record<string, unknown>;
    assert.equal(hso.permissionDecision, "allow");
    assert.match(
      hso.additionalContext as string,
      /⚠ Bash command reads tracked artifacts that have been updated since your session's last fresh read: CLAUDE\.md \(current v2\)\./,
    );
    // Warn-mode re-grant suppresses a repeat fire.
    const r2 = await post("/hooks/pre-bash", { session_id: SID_A, command: "cat CLAUDE.md" });
    assert.equal(r2.body.status, "fresh");
  } finally {
    await cleanup();
  }
});

test("pre-bash: command too long → 413; blank → 400 (exact strings)", async () => {
  const { post, cleanup } = await makeServer();
  try {
    const long = await post("/hooks/pre-bash", { session_id: SID_A, command: "x".repeat(16385) });
    assert.equal(long.status, 413);
    assert.deepEqual(long.body, { error: "command too long" });
    const blank = await post("/hooks/pre-bash", { session_id: SID_A, command: "   " });
    assert.equal(blank.status, 400);
    assert.deepEqual(blank.body, { error: "missing or empty command" });
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------- pre-grep

test("pre-grep: stale artifact under prefix → stale + exact prose; no seeding for unknowns", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("docs/plans/a-plan.md", HASH_1);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 10);
    registry.commit(id, agentB, HASH_2, 11);

    const r = await post("/hooks/pre-grep", { session_id: SID_A, search_root: "docs/" });
    assert.equal(r.body.status, "stale");
    assert.deepEqual(r.body.stale_paths, ["docs/plans/a-plan.md"]);
    const hso = r.body.hookSpecificOutput as Record<string, unknown>;
    assert.match(
      hso.additionalContext as string,
      /⚠ Grep search over tracked artifacts your session has not freshened since peer commits: docs\/plans\/a-plan\.md \(current v2\)\. The results may reflect outdated content\. Consider re-reading via Read before acting on Grep output\./,
    );
    // Empty registry prefix → fresh.
    const none = await post("/hooks/pre-grep", { session_id: SID_A, search_root: "nomatch/" });
    assert.deepEqual(none.body, { status: "fresh" });
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ post-edit-cas

test("post-edit-cas: WIN → {ok:true, version}; loser → version_mismatch body", async () => {
  const { registry, post, cleanup } = await makeServer();
  try {
    registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const win = await post("/hooks/post-edit-cas", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_2,
      expected_version: 1,
    });
    assert.deepEqual(win.body, { ok: true, version: 2 });
    const lose = await post("/hooks/post-edit-cas", {
      session_id: SID_B,
      path: "CLAUDE.md",
      content_hash: HASH_1,
      expected_version: 1,
    });
    assert.deepEqual(lose.body, { ok: false, reason: "version_mismatch", current_version: 2 });
  } finally {
    await cleanup();
  }
});

test("post-edit-cas: validation strings + untracked fast paths", async () => {
  const { post, cleanup } = await makeServer();
  try {
    const badVer = await post("/hooks/post-edit-cas", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
      expected_version: -1,
    });
    assert.equal(badVer.status, 400);
    assert.deepEqual(badVer.body, { error: "expected_version must be a non-negative integer" });

    const untracked = await post("/hooks/post-edit-cas", {
      session_id: SID_A,
      path: "not-tracked.txt",
      content_hash: HASH_1,
      expected_version: 1,
    });
    assert.deepEqual(untracked.body, { ok: true });

    // Tracked by policy but never observed by the registry.
    const unknown = await post("/hooks/post-edit-cas", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
      expected_version: 1,
    });
    assert.deepEqual(unknown.body, { ok: true, note: "untracked-at-commit" });
  } finally {
    await cleanup();
  }
});

test("post-edit-cas: corruption (expected > current) → verbose reason, no current_version key", async () => {
  const { registry, post, cleanup } = await makeServer();
  try {
    registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const r = await post("/hooks/post-edit-cas", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_2,
      expected_version: 9,
    });
    assert.equal(r.body.ok, false);
    assert.match(
      r.body.reason as string,
      /^commit_cas_corruption agent=.+ artifact=.+ expected_version=9 current_version=1 \(expected > current — corruption or multi-coordinator violation\)$/,
    );
    assert.equal("current_version" in r.body, false);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------- policy routes

test("policy/track: adds + rejects, exact validation strings, live-reload end-to-end", async () => {
  const { post, cleanup } = await makeServer();
  try {
    const notList = await post("/policy/track", { paths: "notes.md" });
    assert.equal(notList.status, 400);
    assert.deepEqual(notList.body, { error: "paths must be a list of strings" });

    const tooMany = await post("/policy/track", { paths: Array(21).fill("a.md") });
    assert.equal(tooMany.status, 400);
    assert.deepEqual(tooMany.body, { error: "max 20 paths per request" });

    // Rejection reasons are byte-identical to Python validate_path (the
    // corpus pins them cross-runtime). Includes the control-char guard that
    // closes the YAML newline-injection vector.
    const r = await post("/policy/track", {
      paths: ["notes.md", "/abs.md", "../up.md", "a\n- /etc/passwd", "\\win.md"],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.added, ["notes.md"]);
    assert.deepEqual(r.body.rejected, [
      { path: "/abs.md", reason: "path must be relative (no leading /)" },
      { path: "../up.md", reason: "path contains '..' traversal" },
      { path: "a\n- /etc/passwd", reason: "path contains control characters" },
      { path: "\\win.md", reason: "path must be relative (no leading \\)" },
    ]);

    // Integration: the newly-tracked path is live for hooks with NO restart —
    // post-edit-cas now treats notes.md as tracked (unknown-at-commit note).
    const cas = await post("/hooks/post-edit-cas", {
      session_id: SID_A,
      path: "notes.md",
      content_hash: HASH_1,
      expected_version: 1,
    });
    assert.deepEqual(cas.body, { ok: true, note: "untracked-at-commit" });
  } finally {
    await cleanup();
  }
});

test("policy/untrack: response key is `removed`; ignore wins over tracked", async () => {
  const { post, cleanup } = await makeServer();
  try {
    await post("/policy/track", { paths: ["notes.md"] });
    const r = await post("/policy/untrack", { paths: ["notes.md"] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.removed, ["notes.md"]);
    assert.equal("added" in r.body, false);

    // notes.md is now ignored → post-edit-cas fast-paths as untracked.
    const cas = await post("/hooks/post-edit-cas", {
      session_id: SID_A,
      path: "notes.md",
      content_hash: HASH_1,
      expected_version: 1,
    });
    assert.deepEqual(cas.body, { ok: true });
  } finally {
    await cleanup();
  }
});

test("policy/untrack: a policy file that loads as no entries is refused with 400 and left as it was", async () => {
  // What an earlier unquoted write left behind. An append cannot make it load,
  // so answering success would report an entry that never takes effect.
  const { post, cleanup, root } = await makeServer();
  try {
    const broken = "- notes.md\n- *.log\n";
    const yamlPath = join(root, ".coherence", "ignored.yaml");
    writeFileSync(yamlPath, broken, "utf8");
    const r = await post("/policy/untrack", { paths: ["secrets.md"] });
    assert.equal(r.status, 400);
    assert.match(String(r.body.error), /^\.coherence\/ignored\.yaml is not valid YAML/);
    assert.equal(readFileSync(yamlPath, "utf8"), broken);
  } finally {
    await cleanup();
  }
});

test("policy/untrack and /track: a '*'-led glob keeps every earlier entry in force (#178)", async () => {
  // A plain `- *.log` is a YAML alias, which stops the file parsing and
  // leaves the loader with no entries while the route still answers success.
  const { post, cleanup } = await makeServer();
  const casOnNotes = () =>
    post("/hooks/post-edit-cas", {
      session_id: SID_A,
      path: "notes.md",
      content_hash: HASH_1,
      expected_version: 1,
    });
  try {
    await post("/policy/track", { paths: ["notes.md"] });
    await post("/policy/track", { paths: ["*.txt"] });
    // Still tracked: unknown-at-commit, not the untracked fast path.
    assert.deepEqual((await casOnNotes()).body, { ok: true, note: "untracked-at-commit" });

    await post("/policy/untrack", { paths: ["notes.md"] });
    const r = await post("/policy/untrack", { paths: ["*.log"] });
    assert.deepEqual(r.body, { ok: true, removed: ["*.log"], rejected: [] });
    // Still ignored: the earlier untrack of notes.md survives the '*' entry.
    assert.deepEqual((await casOnNotes()).body, { ok: true });
  } finally {
    await cleanup();
  }
});
