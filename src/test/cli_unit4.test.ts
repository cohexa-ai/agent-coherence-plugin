/**
 * Unit 4 — Node CLIs (track/untrack/status): path normalization contract +
 * a live end-to-end (async spawn — see hook_client.test.ts for why never
 * spawnSync against an in-process server).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import { normalizeWorkspacePath } from "../cli.js";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..");

test("normalizeWorkspacePath: relative passes; absolute-inside strips; outside/traversal reject", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-norm-"));
  try {
    assert.deepEqual(normalizeWorkspacePath("docs/plan.md", root), ["docs/plan.md", null]);
    assert.deepEqual(normalizeWorkspacePath(join(root, "docs", "plan.md"), root), [
      "docs/plan.md",
      null,
    ]);
    assert.deepEqual(normalizeWorkspacePath("/etc/passwd", root), [
      "/etc/passwd",
      "path outside workspace root",
    ]);
    assert.deepEqual(normalizeWorkspacePath("../up.md", root), ["../up.md", "contains '..'"]);
    assert.deepEqual(normalizeWorkspacePath("", root), ["", "empty"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runCli(
  entry: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(DIST, entry), ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("close", (status) => resolveRun({ stdout, stderr, status }));
  });
}

test("end-to-end: track writes YAML + prints; untrack uses `removed`; status renders JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "cli-e2e-"));
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
    mkdirSync(join(root, ".coherence"), { recursive: true });
    writeFileSync(join(root, ".coherence", "server.pid"), `${process.pid}\n${port}\n`); // 2-line Python format
    writeFileSync(join(root, ".coherence", "hook.secret"), `${secret}\n`);

    // track: one valid relative + one absolute-inside (normalized) + one outside (client-rejected).
    const track = await runCli(
      "cli_track.js",
      ["notes.md", join(root, "docs", "a.md"), "/etc/passwd", "--root", root],
      root,
    );
    assert.equal(track.status, 0);
    assert.match(track.stdout, /agent-coherence-track: tracked notes\.md/);
    assert.match(track.stdout, /agent-coherence-track: tracked docs\/a\.md/);
    assert.match(track.stderr, /rejected '\/etc\/passwd': path outside workspace root/);
    const yaml = readFileSync(join(root, ".coherence", "tracked.yaml"), "utf8");
    assert.equal(yaml, '- "notes.md"\n- "docs/a.md"\n');

    const untrack = await runCli("cli_untrack.js", ["notes.md", "--root", root], root);
    assert.equal(untrack.status, 0);
    assert.match(untrack.stdout, /agent-coherence-untrack: untracked notes\.md/);

    const status = await runCli("cli_status.js", ["--root", root], root);
    assert.equal(status.status, 0);
    const parsed = JSON.parse(status.stdout) as Record<string, unknown>;
    assert.equal(parsed.backend, "node");

    // Failure signaling (unlike the fail-open hook-client): no coordinator → exit 2.
    const deadRoot = mkdtempSync(join(tmpdir(), "cli-dead-"));
    try {
      const dead = await runCli("cli_status.js", ["--root", deadRoot], deadRoot);
      assert.equal(dead.status, 2);
    } finally {
      rmSync(deadRoot, { recursive: true, force: true });
    }

    await new Promise<void>((r) => server.close(() => r()));
    registry.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 0.3.1: unsupported flags must FAIL, not silently no-op -----------------

test("0.3.1: --self-test is rejected with exit 2, not a false-positive exit 0", async () => {
  const { runStatus } = await import("../cli.js");
  const code = await runStatus(["--self-test"]);
  // The bug: the Node CLI discarded unknown flags, printed ordinary status and
  // exited 0 — so the README's flagship post-install validation reported
  // success without ever running. Non-zero is the whole point of this test.
  assert.equal(code, 2);
});

test("0.3.1: unknown/typo flags are rejected rather than ignored", async () => {
  const { runStatus, runTrack, runUntrack } = await import("../cli.js");
  assert.equal(await runStatus(["--detial", "metrics"]), 2);
  assert.equal(await runTrack(["--self-test"]), 2);
  assert.equal(await runUntrack(["--bogus"]), 2);
});

test("0.3.1: --detail validates its value", async () => {
  const { runStatus } = await import("../cli.js");
  assert.equal(await runStatus(["--detail", "bogus"]), 2);
});
