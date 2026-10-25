/**
 * Unit 3 — Node hook-client: payload-builder parity, fail-open contract,
 * and a live end-to-end run against a real coordinator (subprocess, the
 * bin_shims.test.ts style).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import {
  buildPreRead,
  buildPreEdit,
  buildPostEdit,
  buildSessionStop,
  buildSessionStart,
  buildPreBash,
  buildPreGrep,
  SkipHook,
} from "../hook_client.js";
import { readPortFromPidFile } from "../hook_client_transport.js";

const SID = "44444444-4444-4444-8444-444444444444";
const HOOK_CLIENT_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "hook_client.js");

function makeWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hookclient-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ------------------------------------------------------------- builders

test("buildPreRead: workspace-relative path + raw-bytes disk hash; unreadable → omitted", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const abs = join(root, "plan.md");
    // Non-UTF8-safe bytes: the hash must be over RAW bytes.
    const bytes = Buffer.from([0xe2, 0x9a, 0xa0, 0x0d, 0x0a, 0xff, 0x00, 0x41]);
    writeFileSync(abs, bytes);
    const body = buildPreRead({ session_id: SID, tool_input: { file_path: abs } }, root);
    assert.deepEqual(body, {
      session_id: SID,
      path: "plan.md",
      content_hash: createHash("sha256").update(bytes).digest("hex"),
    });
    // Unreadable file → content_hash omitted (never a crash).
    const missing = buildPreRead(
      { session_id: SID, tool_input: { file_path: join(root, "gone.md") } },
      root,
    );
    assert.deepEqual(missing, { session_id: SID, path: "gone.md" });
  } finally {
    cleanup();
  }
});

test("builders: outside-root path / missing fields → SkipHook", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    assert.throws(
      () => buildPreEdit({ session_id: SID, tool_input: { file_path: "/etc/passwd" } }, root),
      SkipHook,
    );
    assert.throws(() => buildPreEdit({ tool_input: { file_path: join(root, "a.md") } }, root), SkipHook);
    assert.throws(() => buildPreBash({ session_id: SID, tool_input: { command: "   " } }), SkipHook);
    assert.throws(
      () => buildPreGrep({ session_id: SID, tool_input: { path: 42 } }, root),
      SkipHook,
    );
  } finally {
    cleanup();
  }
});

test("buildPostEdit: tool_response hash preferred; success defaults true; failure skips disk hash", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const abs = join(root, "plan.md");
    writeFileSync(abs, "content");
    const given = "a".repeat(64);
    const withHash = buildPostEdit(
      { session_id: SID, tool_input: { file_path: abs }, tool_response: { content_hash: given } },
      root,
    );
    assert.deepEqual(withHash, { session_id: SID, path: "plan.md", success: true, content_hash: given });

    const failed = buildPostEdit(
      { session_id: SID, tool_input: { file_path: abs }, tool_response: { success: false } },
      root,
    );
    assert.deepEqual(failed, { session_id: SID, path: "plan.md", success: false });
  } finally {
    cleanup();
  }
});

test("buildPreGrep: absolute → workspace-relative; './' stripped; empty passes through", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    assert.deepEqual(buildPreGrep({ session_id: SID, tool_input: { path: join(root, "docs") } }, root), {
      session_id: SID,
      search_root: "docs",
    });
    assert.deepEqual(buildPreGrep({ session_id: SID, tool_input: { path: "./docs" } }, root), {
      session_id: SID,
      search_root: "docs",
    });
    assert.deepEqual(buildPreGrep({ session_id: SID, tool_input: {} }, root), {
      session_id: SID,
      search_root: "",
    });
  } finally {
    cleanup();
  }
});

test("SB-25 thread: a CC agent_id is carried into the body; absent → absent", () => {
  assert.deepEqual(buildSessionStop({ session_id: SID, agent_id: "sub-1" }), {
    session_id: SID,
    agent_id: "sub-1",
  });
  assert.deepEqual(buildSessionStop({ session_id: SID }), { session_id: SID });
});

// ------------------------------------------------------- pid-file parsing

test("readPortFromPidFile: 2-line Python format AND 3-line Node format; never needs backend=", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const pidFile = join(root, "server.pid");
    writeFileSync(pidFile, "12345\n54321\n"); // Python 2-line
    assert.equal(readPortFromPidFile(pidFile), 54321);
    writeFileSync(pidFile, "12345\n54321\nbackend=node\n"); // Node 3-line
    assert.equal(readPortFromPidFile(pidFile), 54321);
    writeFileSync(pidFile, "12345\n"); // 1 line → unusable
    assert.equal(readPortFromPidFile(pidFile), null);
    writeFileSync(pidFile, "12345\n99999\n"); // out of range
    assert.equal(readPortFromPidFile(pidFile), null);
  } finally {
    cleanup();
  }
});

// ------------------------------------------- fail-open contract (subprocess)

function runClient(args: string[], stdin: string, cwd: string): { stdout: string; status: number | null } {
  const r = spawnSync(process.execPath, [HOOK_CLIENT_JS, ...args], {
    input: stdin,
    cwd,
    encoding: "utf8",
    timeout: 10000,
  });
  return { stdout: r.stdout, status: r.status };
}

test("fail-open: coordinator down / bad stdin / unknown sub → '{}' + exit 0, always", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    // A git repo with NO coordinator running.
    spawnSync("git", ["init", "-q"], { cwd: root });
    const down = runClient(["pre-edit", "--root", root], JSON.stringify({ session_id: SID, tool_input: { file_path: join(root, "a.md") } }), root);
    assert.equal(down.status, 0);
    assert.equal(down.stdout.trim(), "{}");

    const badJson = runClient(["pre-read", "--root", root], "not json {", root);
    assert.equal(badJson.status, 0);
    assert.equal(badJson.stdout.trim(), "{}");

    const badSub = runClient(["no-such-sub", "--root", root], "{}", root);
    assert.equal(badSub.status, 0);
    assert.equal(badSub.stdout.trim(), "{}");

    const emptyStdin = runClient(["session-stop", "--root", root], "", root);
    assert.equal(emptyStdin.status, 0);
    assert.equal(emptyStdin.stdout.trim(), "{}");
  } finally {
    cleanup();
  }
});

// ------------------------------------------------- live end-to-end

test("end-to-end: pre-bash through the real client against a live coordinator", async () => {
  const root = mkdtempSync(join(tmpdir(), "hookclient-e2e-"));
  const secret = "s".repeat(32);
  try {
    const registry = new ArtifactRegistry(join(root, ".coherence", "state.db"));
    const policy = PolicyRef.load(root);
    const sessions = new SessionRegistry();
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
    // Write the coordinator discovery files the client resolves.
    mkdirSync(join(root, ".coherence"), { recursive: true });
    writeFileSync(join(root, ".coherence", "server.pid"), `${process.pid}\n${port}\nbackend=node\n`);
    writeFileSync(join(root, ".coherence", "hook.secret"), `${secret}\n`);

    // Seed a stale artifact: peer commits CLAUDE.md v2, our session never read it.
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", "1".repeat(64));
    const peer = sessions.registerSession("55555555-5555-5555-8555-555555555555");
    registry.acquireExclusive(id, peer, 10);
    registry.commit(id, peer, "2".repeat(64), 11);

    const cc = JSON.stringify({ session_id: SID, tool_input: { command: "cat CLAUDE.md" } });
    // MUST be an async spawn: spawnSync would block this event loop, and the
    // in-process coordinator could never answer the child's request (deadlock
    // → child timeout → half-open socket wedges server.close()).
    const r = await new Promise<{ stdout: string; status: number | null }>((resolveRun) => {
      const child = spawn(process.execPath, [HOOK_CLIENT_JS, "pre-bash", "--root", root], {
        cwd: root,
        stdio: ["pipe", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.on("close", (status) => resolveRun({ stdout, status }));
      child.stdin.write(cc);
      child.stdin.end();
    });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(body.status, "stale");
    assert.deepEqual(body.stale_paths, ["CLAUDE.md"]);

    await new Promise<void>((r2) => server.close(() => r2()));
    registry.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildSubagentStop: agent_id REQUIRED + shape-validated (malformed must never release the parent)", async () => {
  const { buildSubagentStop } = await import("../hook_client.js");
  assert.deepEqual(buildSubagentStop({ session_id: SID, agent_id: "sub-1" }), {
    session_id: SID,
    agent_id: "sub-1",
  });
  assert.deepEqual(buildSubagentStop({ session_id: SID, agentId: "sub-2" }), {
    session_id: SID,
    agent_id: "sub-2",
  });
  // Absent → SkipHook (unchanged).
  assert.throws(() => buildSubagentStop({ session_id: SID }), SkipHook);
  // P1: present-but-MALFORMED → SkipHook, NOT a forwarded body that the server
  // would null and degrade to a parent-scoped release. Charset + length + the
  // control-char/newline vector.
  for (const bad of ["bad.id", "has space", "x".repeat(65), "trailing\n", "a/b", ":subagent-x"]) {
    assert.throws(() => buildSubagentStop({ session_id: SID, agent_id: bad }), SkipHook, `expected SkipHook for ${JSON.stringify(bad)}`);
  }
});

// --------------------------------------- SB-10 U7: session-start (compact)

test("buildSessionStart: gated on source == 'compact'; body is {session_id} (no fabricated agent_id)", () => {
  assert.deepEqual(buildSessionStart({ session_id: SID, source: "compact" }), {
    session_id: SID,
  });
  for (const source of ["startup", "resume", "clear", undefined]) {
    const cc: Record<string, unknown> = { session_id: SID };
    if (source !== undefined) cc.source = source;
    assert.throws(() => buildSessionStart(cc), SkipHook, `expected SkipHook for source=${String(source)}`);
  }
  // Missing session_id (even on compact) → SkipHook.
  assert.throws(() => buildSessionStart({ source: "compact" }), SkipHook);
});

/** Async spawn (the deadlock note on the pre-bash e2e test applies here too). */
function runClientAsync(
  args: string[],
  stdin: string,
  cwd: string,
): Promise<{ stdout: string; status: number | null }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [HOOK_CLIENT_JS, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.on("close", (status) => resolveRun({ stdout, status }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

test("session-start e2e: source=compact posts /hooks/session-start; response passes through byte-for-byte", async () => {
  const root = mkdtempSync(join(tmpdir(), "hookclient-ss-"));
  const secret = "s".repeat(32);
  const registry = new ArtifactRegistry(join(root, ".coherence", "state.db"));
  const policy = PolicyRef.load(root);
  const sessions = new SessionRegistry();
  const server = createServer({
    secret,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy,
    sessions,
  });
  let requests = 0;
  server.on("request", () => {
    requests += 1;
  });
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    mkdirSync(join(root, ".coherence"), { recursive: true });
    writeFileSync(join(root, ".coherence", "server.pid"), `${process.pid}\n${port}\nbackend=node\n`);
    writeFileSync(join(root, ".coherence", "hook.secret"), `${secret}\n`);

    // Seed a held grant so the re-grounding payload is NON-empty.
    const id = registry.resolveOrRegisterArtifact("plan.md", "1".repeat(64));
    const agent = sessions.registerSession(SID);
    registry.acquireExclusive(id, agent, 10);

    const cc = JSON.stringify({ session_id: SID, source: "compact" });
    const r = await runClientAsync(["session-start", "--root", root], cc, root);
    assert.equal(r.status, 0);
    assert.equal(requests, 1);
    const body = JSON.parse(r.stdout) as Record<string, unknown>;
    const hso = body.hookSpecificOutput as Record<string, unknown>;
    assert.equal(hso.hookEventName, "SessionStart");
    assert.match(
      hso.additionalContext as string,
      /^Post-compaction re-grounding \(agent-coherence\):\n/,
    );
    // Byte-for-byte passthrough: the client's stdout IS the wire body (the
    // session-start prose carries no timestamps, so a direct POST with the
    // same session must serialize identically).
    const direct = await fetch(`http://127.0.0.1:${port}/hooks/session-start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        Host: "127.0.0.1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: SID }),
    });
    assert.equal(r.stdout.trim(), (await direct.text()).trim());
  } finally {
    // Close in finally: a failing assert must not leave the server handle
    // holding the test process open (observed as a suite hang during TDD red).
    await new Promise<void>((r2) => server.close(() => r2()));
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("session-start gate: startup/resume/clear/absent source → '{}' exit 0 with NO network call", async () => {
  const root = mkdtempSync(join(tmpdir(), "hookclient-ss-gate-"));
  const secret = "s".repeat(32);
  const registry = new ArtifactRegistry(join(root, ".coherence", "state.db"));
  const policy = PolicyRef.load(root);
  const sessions = new SessionRegistry();
  const server = createServer({
    secret,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy,
    sessions,
  });
  let requests = 0;
  server.on("request", () => {
    requests += 1;
  });
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    mkdirSync(join(root, ".coherence"), { recursive: true });
    writeFileSync(join(root, ".coherence", "server.pid"), `${process.pid}\n${port}\nbackend=node\n`);
    writeFileSync(join(root, ".coherence", "hook.secret"), `${secret}\n`);

    for (const source of ["startup", "resume", "clear", undefined]) {
      const payload: Record<string, unknown> = { session_id: SID };
      if (source !== undefined) payload.source = source;
      const r = await runClientAsync(["session-start", "--root", root], JSON.stringify(payload), root);
      assert.equal(r.status, 0, `exit 0 for source=${String(source)}`);
      assert.equal(r.stdout.trim(), "{}", `'{}' for source=${String(source)}`);
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise<void>((r2) => server.close(() => r2()));
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("session-start fail-open: closed port / empty stdin / malformed JSON → '{}' exit 0", async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    // A pid file pointing at a port nothing listens on (bind, then close).
    const closedPort = await new Promise<number>((resolvePort) => {
      const s = createNetServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolvePort(p));
      });
    });
    mkdirSync(join(root, ".coherence"), { recursive: true });
    writeFileSync(join(root, ".coherence", "server.pid"), `${process.pid}\n${closedPort}\n`);
    writeFileSync(join(root, ".coherence", "hook.secret"), `${"x".repeat(32)}\n`);

    const down = runClient(
      ["session-start", "--root", root],
      JSON.stringify({ session_id: SID, source: "compact" }),
      root,
    );
    assert.equal(down.status, 0);
    assert.equal(down.stdout.trim(), "{}");

    const emptyStdin = runClient(["session-start", "--root", root], "", root);
    assert.equal(emptyStdin.status, 0);
    assert.equal(emptyStdin.stdout.trim(), "{}");

    const badJson = runClient(["session-start", "--root", root], "not json {", root);
    assert.equal(badJson.status, 0);
    assert.equal(badJson.stdout.trim(), "{}");
  } finally {
    cleanup();
  }
});

test("hooks.json: exactly two SessionStart entries — bootstrap shim first, hook-client session-start second", () => {
  const hooksJsonPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "hooks",
    "hooks.json",
  );
  const parsed = JSON.parse(readFileSync(hooksJsonPath, "utf8")) as {
    hooks: {
      SessionStart?: Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>;
    };
  };
  const entries = parsed.hooks.SessionStart ?? [];
  assert.equal(entries.length, 2);
  // Bootstrap shim stays first (it never reads stdin, so the pair is
  // parallel-safe); the compact re-grounding client is second.
  assert.ok(entries[0]!.hooks[0]!.command.endsWith('/bin/ensure-coordinator-dispatch"'));
  const second = entries[1]!;
  assert.equal(second.matcher, undefined);
  assert.equal(second.hooks.length, 1);
  assert.equal(second.hooks[0]!.type, "command");
  assert.ok(second.hooks[0]!.command.endsWith('hook-client" session-start'));
});

test("hooks.json: every ${CLAUDE_PLUGIN_ROOT} path is double-quoted, so an install path with a space stays one word", () => {
  const hooksJsonPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "hooks",
    "hooks.json",
  );
  const parsed = JSON.parse(readFileSync(hooksJsonPath, "utf8")) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  // Hook commands run through a shell. An unquoted placeholder splits at a
  // space in the install path, the command is not found, and the clients'
  // fail-open floor then leaves the plugin silently doing nothing.
  const placeholder = "${CLAUDE_PLUGIN_ROOT}";
  const commands = Object.entries(parsed.hooks).flatMap(([event, entries]) =>
    entries.flatMap((entry) => entry.hooks.map((hook) => ({ event, command: hook.command }))),
  );
  const withPlaceholder = commands.filter(({ command }) => command.includes(placeholder));
  assert.ok(withPlaceholder.length > 0, "no hooks.json command uses the placeholder; this check would pass vacuously");
  const unquoted = withPlaceholder
    .filter(({ command }) => command.split(placeholder).slice(0, -1).some((before) => !before.endsWith('"')))
    .map(({ event, command }) => `${event}: ${command}`);
  assert.deepEqual(unquoted, []);
});
