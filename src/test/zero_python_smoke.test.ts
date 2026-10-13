/**
 * Unit 7 — THE ZERO-PYTHON SMOKE TEST (the plan's acceptance gate).
 *
 * Drives the plugin's own four-step sequence — pre-read → pre-edit →
 * post-edit → stale-pre-read — entirely through the compiled Node
 * hook-client subprocesses against the Node coordinator, with the child
 * environment's PATH set to a directory containing NOTHING: no python, no
 * git, no shell utilities. The client is invoked via the absolute node
 * binary and an explicit --root, so it needs no PATH resolution at all.
 * A warn-mode leg and a strict-mode leg both run; python3 is proven
 * unresolvable in the child env first.
 *
 * (Decision B's install-time assertion — `ensure-coordinator-node`'s
 * npm install with Python scrubbed — is the separate env-gated test below:
 * it needs network + a real npm install, so CI opts in explicitly.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import { sessionToAgentId } from "../agent_id.js";

const HOOK_CLIENT_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "hook_client.js");
const SID_A = "44444444-4444-4444-8444-444444444444";
const SID_B = "55555555-5555-5555-8555-555555555555";
const HASH_2 = "2".repeat(64);
const HASH_3 = "3".repeat(64);

/** The zero-everything child environment: PATH points at an empty dir. */
function zeroPythonEnv(emptyDir: string): NodeJS.ProcessEnv {
  return { PATH: emptyDir, HOME: emptyDir } as NodeJS.ProcessEnv;
}

function clientCall(
  sub: string,
  root: string,
  ccPayload: unknown,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [HOOK_CLIENT_JS, sub, "--root", root], {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.on("close", (status) => {
      if (status !== 0) {
        rejectRun(new Error(`hook-client ${sub} exited ${status} (contract: always 0)`));
        return;
      }
      try {
        resolveRun(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        rejectRun(new Error(`hook-client ${sub} emitted non-JSON: ${stdout}`));
      }
    });
    child.stdin.write(JSON.stringify(ccPayload));
    child.stdin.end();
  });
}

async function makeCoordinator(root: string, secret: string) {
  const registry = new ArtifactRegistry(join(root, ".coherence", "state.db"));
  const policy = PolicyRef.load(root);
  const sessions = new SessionRegistry();
  const server = createServer({
    secret,
    startedAtMs: Date.now(),
    version: "smoke",
    registry,
    policy,
    sessions,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(join(root, ".coherence", "server.pid"), `${process.pid}\n${port}\nbackend=node\n`);
  writeFileSync(join(root, ".coherence", "hook.secret"), `${secret}\n`);
  const close = () =>
    new Promise<void>((r) => {
      server.close(() => {
        registry.close();
        r();
      });
    });
  return { registry, close };
}

test("ZERO-PYTHON SMOKE: four-step warn sequence + strict deny, no Python (or anything) on PATH", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-py-smoke-"));
  const emptyDir = join(root, "empty-path");
  mkdirSync(emptyDir, { recursive: true });
  mkdirSync(join(root, ".coherence"), { recursive: true });
  const env = zeroPythonEnv(emptyDir);
  const secret = "s".repeat(32);
  try {
    // Precondition: python (and everything else) is unresolvable in the child env.
    for (const exe of ["python3", "python", "git"]) {
      const probe = spawnSync(exe, ["--version"], { env, encoding: "utf8" });
      assert.notEqual(probe.error, undefined, `${exe} must be unresolvable in the smoke env`);
    }

    const { close } = await makeCoordinator(root, secret);
    const abs = join(root, "CLAUDE.md");
    writeFileSync(abs, "v1 content\n");

    // Step 1 — pre-read (first observation → fresh).
    const r1 = await clientCall(
      "pre-read",
      root,
      { session_id: SID_A, tool_input: { file_path: abs } },
      env,
    );
    assert.equal(r1.status, "fresh");

    // Step 2 — pre-edit (acquire EXCLUSIVE).
    const r2 = await clientCall(
      "pre-edit",
      root,
      { session_id: SID_A, tool_input: { file_path: abs } },
      env,
    );
    assert.equal(r2.ok, true);

    // Step 3 — post-edit (commit v2).
    const r3 = await clientCall(
      "post-edit",
      root,
      {
        session_id: SID_A,
        tool_input: { file_path: abs },
        tool_response: { success: true, content_hash: HASH_2 },
      },
      env,
    );
    assert.equal(r3.ok, true);

    // Peer B preempts + commits v3.
    const b1 = await clientCall(
      "pre-edit",
      root,
      { session_id: SID_B, tool_input: { file_path: abs } },
      env,
    );
    assert.equal(b1.ok, true);
    const b2 = await clientCall(
      "post-edit",
      root,
      {
        session_id: SID_B,
        tool_input: { file_path: abs },
        tool_response: { success: true, content_hash: HASH_3 },
      },
      env,
    );
    assert.equal(b2.ok, true);

    // Step 4 — A's stale pre-read → warn-mode allow with stale status.
    const r4 = await clientCall(
      "pre-read",
      root,
      { session_id: SID_A, tool_input: { file_path: abs } },
      env,
    );
    assert.equal(r4.status, "stale");
    const hso4 = r4.hookSpecificOutput as Record<string, unknown>;
    assert.equal(hso4.permissionDecision, "allow");
    assert.match(hso4.additionalContext as string, /⚠ Stale read/);

    // Strict leg: opt CLAUDE.md into strict mode, reload live via /policy —
    // wait: strict_mode.yaml is loaded by PolicyRef; write it + reload via a
    // policy/track round-trip is tracked-only, so restart the ref through a
    // no-op track call after writing the YAML.
    writeFileSync(join(root, ".coherence", "strict_mode.yaml"), "- CLAUDE.md\n");
    // A no-op /policy/track of an already-tracked path still reloads the ref.
    // MUST be async spawn — spawnSync would deadlock the in-process server
    // (the documented Unit 3 lesson).
    await clientCall("session-stop", root, { session_id: SID_B }, env); // release B's grant first
    const trkStatus = await new Promise<number | null>((r) => {
      const child = spawn(
        process.execPath,
        [join(dirname(HOOK_CLIENT_JS), "cli_track.js"), "CLAUDE.md", "--root", root],
        { cwd: root, env, stdio: "ignore" },
      );
      child.on("close", (status) => r(status));
    });
    assert.equal(trkStatus, 0);

    // B invalidated A again above; A pre-reads → strict DENY, byte-stable prefix.
    const r5 = await clientCall(
      "pre-read",
      root,
      { session_id: SID_A, tool_input: { file_path: abs } },
      env,
    );
    assert.equal(r5.status, "stale");
    const hso5 = r5.hookSpecificOutput as Record<string, unknown>;
    assert.equal(hso5.permissionDecision, "deny");
    assert.match(
      hso5.permissionDecisionReason as string,
      // R7: the deny names the writer's AGENT id, not the session id it was
      // derived from. Derived here rather than pasted so the pin stays an
      // attribution check -- a bare `[0-9a-f]{8}` would pass for any writer.
      new RegExp(
        `^Stale read denied: CLAUDE\\.md was updated by agent ${sessionToAgentId(SID_B).slice(0, 8)} at .+\\. Re-read CLAUDE\\.md via the Read tool before proceeding\\. This denial is structural \\(v0\\.2 strict mode\\); retrying the same operation will produce the same denial\\.$`,
      ),
    );
    assert.equal("additionalContext" in hso5, false);

    // KTD-T sticky: identical retry re-denies byte-identically.
    const r6 = await clientCall(
      "pre-read",
      root,
      { session_id: SID_A, tool_input: { file_path: abs } },
      env,
    );
    assert.equal(
      (r6.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason,
      hso5.permissionDecisionReason,
    );

    await close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "install-time zero-Python assertion (decision B) — opt-in via ZERO_PYTHON_INSTALL_CHECK=1",
  { skip: process.env.ZERO_PYTHON_INSTALL_CHECK !== "1" },
  () => {
    // Runs ensure-coordinator-node's npm install with Python scrubbed from
    // PATH: if better-sqlite3 has no prebuilt for this platform/ABI, npm
    // falls back to node-gyp (which needs Python) and this fails — exactly
    // the signal we want from CI on every supported ABI.
    const root = mkdtempSync(join(tmpdir(), "zero-py-install-"));
    const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const emptyDir = join(root, "empty-path");
    mkdirSync(emptyDir, { recursive: true });
    try {
      const nodeDir = dirname(process.execPath);
      const r = spawnSync("bash", [join(pluginRoot, "bin", "ensure-coordinator-node")], {
        cwd: root,
        encoding: "utf8",
        timeout: 300000,
        env: {
          // NOTE: /usr/bin stays on PATH for coreutils, so this does NOT
          // mask /usr/bin/python3 from PATH — and masking alone was never
          // enough anyway: node-gyp's find-python treats npm_config_python /
          // PYTHON as SOFT candidates and falls through to system python3
          // when they fail. NODE_GYP_FORCE_PYTHON is the one HARD override
          // (it becomes the sole candidate), so any node-gyp fallback dies
          // instead of silently compiling with system Python. Belt: this
          // env. Braces: the config.gypi assertion below.
          PATH: `${emptyDir}:${nodeDir}:/usr/bin:/bin`,
          HOME: root,
          NODE_GYP_FORCE_PYTHON: "/nonexistent",
          // npm 11 gates install scripts behind package.json's allowScripts,
          // and better-sqlite3's install script IS prebuild-install — the
          // prebuilt download the zero-Python guarantee rests on. Default is
          // warn-only, so strict is what turns the allowlist into something
          // this assertion can actually hold: an uncovered install script
          // fails here instead of quietly degrading to a node-gyp build on
          // some user's machine. npm 10 does not know the config, ignores it.
          npm_config_strict_allow_scripts: "true",
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          CLAUDE_PLUGIN_DATA: join(root, "plugin-data"),
        } as NodeJS.ProcessEnv,
      });
      assert.equal(r.status, 0, `install-time bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      // ensure-coordinator-node Stage 4 spawns a DETACHED `nohup` coordinator
      // daemon that keeps writing into the workspace/plugin-data dirs. It must
      // be stopped before cleanup — otherwise rmSync races the live daemon
      // (ENOTEMPTY, seen on CI) AND the process leaks on the runner. The pid is
      // in the bootstrap's stderr, available immediately (the pid FILE is
      // written asynchronously by the daemon and may not exist yet).
      const spawned = /spawned Node coordinator \(pid=(\d+)/.exec(r.stderr ?? "");
      if (spawned) {
        try {
          process.kill(Number(spawned[1]), "SIGKILL");
        } catch {
          // already exited
        }
      }
      // Decision B discriminator (the vacuous-gate lesson): prebuild-install
      // extracts EXACTLY build/Release/better_sqlite3.node, while a node-gyp
      // source build — the Python-needing fallback — first writes
      // build/config.gypi at configure time. The .node present proves the
      // module installed; config.gypi absent proves it arrived as a prebuilt
      // and NOT via a silent local compile with system Python.
      const bs3 = join(root, "plugin-data", "node_modules", "better-sqlite3");
      assert.equal(
        existsSync(join(bs3, "build", "Release", "better_sqlite3.node")),
        true,
        "prebuilt better_sqlite3.node missing after bootstrap install",
      );
      assert.equal(
        existsSync(join(bs3, "build", "config.gypi")),
        false,
        "build/config.gypi present — better-sqlite3 was compiled from source via node-gyp, violating decision B",
      );
    } finally {
      // maxRetries absorbs the brief window between SIGKILL and the OS
      // releasing the daemon's open SQLite/WAL/log handles.
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
