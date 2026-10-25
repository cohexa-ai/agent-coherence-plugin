/**
 * Unit 5 — backend dispatcher + universal hook-client shim + Node-first CLI
 * shims (zero-Python exposure seam). Subprocess style per bin_shims.test.ts.
 *
 * The dispatcher itself is exercised with stubbed bootstrap scripts (we
 * assert WHICH bootstrap it selects, not the bootstrap's own behavior).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeExecutable } from "./executable_fixture.js";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The stubs are written once for the whole file and each is run once as it
// is written (`writeExecutable`), so no timed spawn below runs a file macOS
// has not checked yet (#219). The tests only read them.
const STUBS = mkdtempSync(join(tmpdir(), "dispatch5-stubs-"));
after(() => rmSync(STUBS, { recursive: true, force: true }));

/**
 * A plugin-root copy whose ensure-coordinator{,-node} are stubs that print
 * which one ran.
 */
const STUB_ROOT = ((): string => {
  const root = join(STUBS, "plugin");
  mkdirSync(join(root, "bin"), { recursive: true });
  cpSync(join(PLUGIN_ROOT, "bin", "ensure-coordinator-dispatch"), join(root, "bin", "ensure-coordinator-dispatch"));
  for (const [name, marker] of [
    ["ensure-coordinator", "PYTHON-BOOTSTRAP"],
    ["ensure-coordinator-node", "NODE-BOOTSTRAP"],
  ] as const) {
    writeExecutable(join(root, "bin", name), `#!/usr/bin/env bash\necho ${marker}\n`);
  }
  chmodSync(join(root, "bin", "ensure-coordinator-dispatch"), 0o755);
  return root;
})();

function runDispatch(stubRoot: string, cwd: string, env: Record<string, string | undefined>) {
  return spawnSync("bash", [join(stubRoot, "bin", "ensure-coordinator-dispatch")], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, COHERENCE_COORDINATOR_BACKEND: undefined, ...env } as NodeJS.ProcessEnv,
    timeout: 10000,
  });
}

/**
 * Stub `node` (reporting the given major for the dispatcher's ABI probe) and
 * `npm` into a bin dir, so runtime-guard tests are deterministic regardless
 * of the Node actually running the suite. Returns a PATH that keeps
 * coreutils/git (/usr/bin:/bin) but resolves node/npm to the stubs.
 */
function makeRuntimeStubPath(nodeMajor: number): string {
  const stubBin = join(STUBS, `node-${nodeMajor}`);
  mkdirSync(stubBin, { recursive: true });
  writeExecutable(join(stubBin, "node"), `#!/bin/sh\necho ${nodeMajor}\n`);
  writeExecutable(join(stubBin, "npm"), `#!/bin/sh\nexit 0\n`);
  return `${stubBin}:/usr/bin:/bin`;
}

/** A Node with a better-sqlite3 prebuilt (24), and one without (23). */
const NODE_24_PATH = makeRuntimeStubPath(24);
const NODE_23_PATH = makeRuntimeStubPath(23);

test("dispatcher: default on a FRESH workspace selects the Node bootstrap (SB-2 option x)", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    // No .coherence/state.db → fresh install → the zero-Python default.
    // node stubbed to major 24 (a prebuilt ABI) so the runtime guard's
    // verdict does not depend on whichever Node runs this suite.
    const r = spawnSync("/bin/bash", [join(STUB_ROOT, "bin", "ensure-coordinator-dispatch")], {
      cwd: ws,
      encoding: "utf8",
      env: { PATH: NODE_24_PATH, HOME: ws } as NodeJS.ProcessEnv,
      timeout: 10000,
    });
    assert.equal(r.stdout.trim(), "NODE-BOOTSTRAP");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("dispatcher: GUARD (a) — an ESTABLISHED workspace (state.db present) stays on Python", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    mkdirSync(join(ws, ".coherence"), { recursive: true });
    // A pre-existing store is very likely Python-owned; the Node coordinator
    // fails closed on a foreign ledger (#55), so defaulting it to node would
    // leave the workspace with NO coordinator — the exact silent degrade this
    // change removes. Existing installs must be untouched.
    writeFileSync(join(ws, ".coherence", "state.db"), "", "utf8");
    const r = runDispatch(STUB_ROOT, ws, {});
    assert.equal(r.stdout.trim(), "PYTHON-BOOTSTRAP");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("dispatcher: GUARD (a) is default-only — an EXPLICIT node on an established workspace is honored", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    mkdirSync(join(ws, ".coherence"), { recursive: true });
    writeFileSync(join(ws, ".coherence", "state.db"), "", "utf8");
    writeFileSync(join(ws, ".coherence", "coordinator_backend"), "node\n", "utf8");
    // Operator's explicit choice wins over the conservative default.
    const r = runDispatch(STUB_ROOT, ws, {});
    assert.equal(r.stdout.trim(), "NODE-BOOTSTRAP");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("dispatcher: GUARD (b) — no node/npm on PATH falls back to Python instead of dead-ending", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  const emptyBin = mkdtempSync(join(tmpdir(), "dispatch5-nopath-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    // PATH keeps coreutils/git but hides node+npm by pointing at a dir that
    // has neither; /usr/bin & /bin on macOS+CI carry git but not node.
    const r = spawnSync("/bin/bash", [join(STUB_ROOT, "bin", "ensure-coordinator-dispatch")], {
      cwd: ws,
      encoding: "utf8",
      env: { PATH: `${emptyBin}:/usr/bin:/bin`, HOME: ws } as NodeJS.ProcessEnv,
      timeout: 10000,
    });
    assert.equal(r.stdout.trim(), "PYTHON-BOOTSTRAP");
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(emptyBin, { recursive: true, force: true });
  }
});

test("dispatcher: GUARD (b) — a Node major with no better-sqlite3 prebuilt (23) falls back to Python; explicit node is still honored", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    // Fresh workspace + Node 23 (ABI 131 — better-sqlite3 12.10.0 dropped its
    // prebuilt): the zero-Python default cannot succeed (npm would fall back
    // to node-gyp, i.e. Python), so the guarded default takes the working
    // Python path and says why on stderr.
    const fallback = spawnSync("/bin/bash", [join(STUB_ROOT, "bin", "ensure-coordinator-dispatch")], {
      cwd: ws,
      encoding: "utf8",
      env: { PATH: NODE_23_PATH, HOME: ws } as NodeJS.ProcessEnv,
      timeout: 10000,
    });
    assert.equal(fallback.stdout.trim(), "PYTHON-BOOTSTRAP");
    assert.match(fallback.stderr, /no better-sqlite3 prebuilt \(supported majors: 22\/24\/25\)/);

    // Guards apply to the DEFAULT only: an explicit `node` selection is
    // honored verbatim (the bootstrap's stage-0 preflight owns the loud error).
    mkdirSync(join(ws, ".coherence"), { recursive: true });
    writeFileSync(join(ws, ".coherence", "coordinator_backend"), "node\n", "utf8");
    const explicit = spawnSync("/bin/bash", [join(STUB_ROOT, "bin", "ensure-coordinator-dispatch")], {
      cwd: ws,
      encoding: "utf8",
      env: { PATH: NODE_23_PATH, HOME: ws } as NodeJS.ProcessEnv,
      timeout: 10000,
    });
    assert.equal(explicit.stdout.trim(), "NODE-BOOTSTRAP");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("dispatcher: .coherence/coordinator_backend=node selects the Node bootstrap", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    mkdirSync(join(ws, ".coherence"), { recursive: true });
    writeFileSync(join(ws, ".coherence", "coordinator_backend"), "node\n", "utf8");
    const r = runDispatch(STUB_ROOT, ws, {});
    assert.equal(r.stdout.trim(), "NODE-BOOTSTRAP");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("dispatcher: env override beats the file; unknown values fall back to python", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    mkdirSync(join(ws, ".coherence"), { recursive: true });
    writeFileSync(join(ws, ".coherence", "coordinator_backend"), "python\n", "utf8");
    const env = runDispatch(STUB_ROOT, ws, { COHERENCE_COORDINATOR_BACKEND: "node" });
    assert.equal(env.stdout.trim(), "NODE-BOOTSTRAP");
    const unknown = runDispatch(STUB_ROOT, ws, { COHERENCE_COORDINATOR_BACKEND: "cobol" });
    assert.equal(unknown.stdout.trim(), "PYTHON-BOOTSTRAP");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("hook-client shim: routes to the Node client (fail-open '{}' when coordinator absent)", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    const r = spawnSync("bash", [join(PLUGIN_ROOT, "bin", "hook-client"), "session-stop"], {
      cwd: ws,
      encoding: "utf8",
      input: JSON.stringify({ session_id: "44444444-4444-4444-8444-444444444444" }),
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      timeout: 10000,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "{}"); // no coordinator running → Node client fail-open
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("hook-client shim: no node + no python client → '{}' floor, exit 0", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    // Absolute /bin/bash: the scrubbed PATH must apply INSIDE the script
    // (hiding node + the Python client), not to resolving bash itself.
    const r = spawnSync("/bin/bash", [join(PLUGIN_ROOT, "bin", "hook-client"), "pre-read"], {
      cwd: ws,
      encoding: "utf8",
      input: "{}",
      env: { PATH: "/nonexistent", CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } as NodeJS.ProcessEnv,
      timeout: 10000,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "{}");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("CLI shim Probe 0: agent-coherence-status resolves to the Node CLI", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    // No coordinator running → the Node CLI (unlike the hook-client) signals
    // failure with exit 2 + an actionable stderr. Proves Probe 0 selected it
    // (the Python-script fallback would exit 127-style through probe errors).
    const r = spawnSync("bash", [join(PLUGIN_ROOT, "bin", "agent-coherence-status"), "--root", ws], {
      cwd: ws,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      timeout: 10000,
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /agent-coherence-status: no coordinator running/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
