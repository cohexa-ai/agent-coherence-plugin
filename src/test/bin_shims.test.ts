/**
 * bin/ shim integration tests — operator-facing PATH-resolver shims for
 * the four agent-coherence-* Python console scripts.
 *
 * Surfaced 2026-05-26 Phase E broad-beta monitoring: skill template
 * invocations (`/agent-coherence:status`, `:track`, `:untrack`) fail with
 * exit 127 "command not found" in environments where the operator's PATH
 * does not include the project venv (Claude UI / remote-control session
 * inheriting an unmodified system shell env). The shims sit in `bin/`
 * (auto-added to Bash tool's PATH per Claude Code plugin contract per
 * https://code.claude.com/docs/en/plugins-reference) and probe alternate
 * locations before failing with an actionable error.
 *
 * What these tests assert (per Phase 3 fix plan):
 *   1. When the real binary is on PATH (operator activated venv), shim
 *      execs through to it AND skips itself to avoid infinite recursion.
 *   2. When the real binary is NOT on PATH but exists at .venv/bin/<NAME>
 *      under CWD or git root, shim probes + execs the venv binary.
 *   3. When the real binary is nowhere, shim exits 127 with stderr
 *      mentioning "not found on PATH" + install guidance (pip install
 *      and venv-activate hints).
 *   4. All 4 shims differ only in their NAME variable (defense against
 *      drift introducing subtle per-shim behavior divergence).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runOnce, writeExecutable } from "./executable_fixture.js";

// ES-module equivalent of __dirname (package.json has "type": "module")
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __dirname at runtime is dist/test/; plugin root is two levels up
const PLUGIN_ROOT = resolve(__dirname, "..", "..");
const BIN_DIR = join(PLUGIN_ROOT, "bin");

const SHIMMED_COMMANDS = [
  "agent-coherence-status",
  "agent-coherence-track",
  "agent-coherence-untrack",
  "agent-coherence-migrate-deny",
];

// Every test below times a shim, and a fresh checkout or worktree writes the
// shims anew, so each runs once first (#219). With no binary on PATH and no
// .venv under /tmp it reaches probe 3 and exits 127, touching nothing.
for (const name of SHIMMED_COMMANDS) {
  runOnce(join(BIN_DIR, name), { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" }, cwd: "/tmp" });
}

/** Create a fake "real binary" that prints a sentinel + its argv to stdout. */
function makeFakeBinary(dir: string, name: string, sentinel: string): string {
  mkdirSync(dir, { recursive: true });
  return writeExecutable(
    join(dir, name),
    `#!/usr/bin/env bash\necho "${sentinel}"\nfor arg in "$@"; do echo "ARG:$arg"; done\nexit 0\n`,
  );
}

/** Run a shim in a controlled env (custom PATH + CWD). */
function runShim(
  shimName: string,
  customPath: string,
  cwd: string,
  args: string[] = [],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(join(BIN_DIR, shimName), args, {
    env: { PATH: customPath, HOME: process.env.HOME ?? "/tmp" },
    cwd,
    encoding: "utf-8",
    timeout: 5000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("bin shim: probe 1 — real binary on PATH → exec succeeds + skips self", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bin-shim-probe1-"));
  try {
    // Fake binary in a separate dir from the plugin's bin/
    const fakeDir = join(tmp, "fake-bin");
    makeFakeBinary(fakeDir, "agent-coherence-status", "FAKE-STATUS-OK");

    // PATH includes BOTH the plugin bin/ (where the shim lives) AND the
    // fake dir (where the real binary lives). Order: plugin bin first
    // (worst case for recursion).
    const customPath = `${BIN_DIR}:${fakeDir}:/usr/bin:/bin`;
    const result = runShim("agent-coherence-status", customPath, tmp, ["--probe1-arg"]);

    assert.strictEqual(result.status, 0, `expected exit 0; stderr: ${result.stderr}`);
    assert.match(result.stdout, /FAKE-STATUS-OK/, "shim should have exec'd the fake binary");
    assert.match(result.stdout, /ARG:--probe1-arg/, "shim should have forwarded argv");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bin shim: probe 2 — .venv/bin/<NAME> under CWD → exec succeeds", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bin-shim-probe2-"));
  try {
    const venvBin = join(tmp, ".venv", "bin");
    makeFakeBinary(venvBin, "agent-coherence-track", "FAKE-TRACK-OK");

    // PATH includes ONLY the plugin bin/ (shim is on PATH; real binary is not)
    // CWD is the dir whose .venv/bin/ has the real binary.
    const customPath = `${BIN_DIR}:/usr/bin:/bin`;
    const result = runShim("agent-coherence-track", customPath, tmp, ["docs/plan.md"]);

    assert.strictEqual(result.status, 0, `expected exit 0; stderr: ${result.stderr}`);
    assert.match(result.stdout, /FAKE-TRACK-OK/, "shim should have probed .venv/bin and exec'd");
    assert.match(result.stdout, /ARG:docs\/plan\.md/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bin shim: probe 3 — no binary anywhere → exit 127 + actionable stderr", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bin-shim-probe3-"));
  try {
    // PATH includes ONLY the plugin bin/ (shim itself; no real binary)
    // CWD has no .venv/bin/. Git root probe also won't find one
    // (tmpdir is not a git repo).
    const customPath = `${BIN_DIR}:/usr/bin:/bin`;
    const result = runShim("agent-coherence-untrack", customPath, tmp);

    assert.strictEqual(result.status, 127, `expected exit 127; stdout: ${result.stdout}`);
    assert.match(
      result.stderr,
      /agent-coherence-untrack not found on PATH/,
      "stderr should name the missing binary",
    );
    // Actionable guidance: must point at the venv-activation + pip-install paths
    assert.match(result.stderr, /pip install/, "stderr should suggest pip install");
    assert.match(result.stderr, /\.venv\/bin\/activate/, "stderr should suggest venv activate");
    // Must NOT recurse — if it had, the exit would be SIGTERM-after-timeout (-1)
    // or test would hang. The exit-127 assertion above already covers this.
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bin shim: CLI shims differ only in NAME + Node-CLI entry; migrate-deny lacks only Probe 0", () => {
  // Drift defense (updated zero-Python Unit 5): the three CLI shims carry a
  // Probe 0 that prefers the bundled Node CLI (dist/cli_<name>.js); they must
  // stay identical modulo the command name + that dist entry name.
  // agent-coherence-migrate-deny has NO Node port (G6 deferred) — it must be
  // the canonical shim minus the Probe 0 block, nothing else.
  const canonical = readFileSync(join(BIN_DIR, "agent-coherence-status"), "utf-8");
  const cliEntry: Record<string, string> = {
    "agent-coherence-track": "cli_track.js",
    "agent-coherence-untrack": "cli_untrack.js",
  };
  for (const [sibling, entry] of Object.entries(cliEntry)) {
    const content = readFileSync(join(BIN_DIR, sibling), "utf-8");
    const normalized = content.replaceAll(sibling, "agent-coherence-status").replaceAll(entry, "cli_status.js");
    assert.strictEqual(
      normalized,
      canonical,
      `${sibling} differs from agent-coherence-status by more than NAME/entry — drift introduced`,
    );
  }
  // migrate-deny = canonical minus the Probe 0 block.
  const probe0 = /\n# Probe 0 \(zero-Python Unit 5\)[\s\S]*?\nfi\n/;
  assert.match(canonical, probe0, "canonical shim must carry the Probe 0 block");
  const canonicalSansProbe0 = canonical.replace(probe0, "");
  const migrateDeny = readFileSync(join(BIN_DIR, "agent-coherence-migrate-deny"), "utf-8");
  const normalizedMd = migrateDeny.replaceAll("agent-coherence-migrate-deny", "agent-coherence-status");
  assert.strictEqual(
    normalizedMd,
    canonicalSansProbe0,
    "agent-coherence-migrate-deny should equal the canonical shim minus Probe 0 — drift introduced",
  );
});

test("bin shim: all 4 shims are present and executable", () => {
  for (const name of SHIMMED_COMMANDS) {
    const path = join(BIN_DIR, name);
    assert.ok(existsSync(path), `${name} shim missing`);
    // Spawn with --help-style invocation will reach probe 3 in this test env
    // (no real binary present), confirming the shim is at least invokable.
    const result = spawnSync(path, [], {
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
      cwd: "/tmp",
      encoding: "utf-8",
      timeout: 3000,
    });
    assert.strictEqual(
      result.status,
      127,
      `${name} should be invokable + return 127 when no binary found; got status=${result.status}, stderr=${result.stderr}`,
    );
  }
});
