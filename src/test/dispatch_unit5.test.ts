/**
 * Unit 5 — backend dispatcher + universal hook-client shim + Node-first CLI
 * shims (zero-Python exposure seam). Subprocess style per bin_shims.test.ts.
 *
 * The dispatcher itself is exercised with stubbed bootstrap scripts (we
 * assert WHICH bootstrap it selects, not the bootstrap's own behavior).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, chmodSync, symlinkSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findCoordinatorRoot } from "../hook_client_transport.js";
import { writeExecutable } from "./executable_fixture.js";
import { makeFifo, runCommandBounded } from "./fifo_fixture.js";
import { shimRefusal, type ShimRefusalKind } from "./shim_refusal_fixture.js";

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

// ------------------------------------- workspace the Node coordinator serves (#254)

/** ensure-coordinator-node's workspace line, which the stub below repeats. */
const NODE_BOOTSTRAP_WORKSPACE_LINE = 'WORKSPACE="${AGENT_COHERENCE_WORKSPACE:-$PWD}"';

/** A plugin-root copy whose Node bootstrap stub prints the workspace the real one would serve. */
const WORKSPACE_STUB_ROOT = ((): string => {
  const root = join(STUBS, "plugin-workspace");
  mkdirSync(join(root, "bin"), { recursive: true });
  cpSync(join(PLUGIN_ROOT, "bin", "ensure-coordinator-dispatch"), join(root, "bin", "ensure-coordinator-dispatch"));
  writeExecutable(join(root, "bin", "ensure-coordinator"), "#!/usr/bin/env bash\necho PYTHON-BOOTSTRAP\n");
  writeExecutable(
    join(root, "bin", "ensure-coordinator-node"),
    `#!/usr/bin/env bash\n${NODE_BOOTSTRAP_WORKSPACE_LINE}\necho "NODE-BOOTSTRAP $WORKSPACE"\n`,
  );
  return root;
})();

function dispatchFrom(cwd: string, env: Record<string, string> = {}) {
  return spawnSync("/bin/bash", [join(WORKSPACE_STUB_ROOT, "bin", "ensure-coordinator-dispatch")], {
    cwd,
    encoding: "utf8",
    env: { PATH: NODE_24_PATH, HOME: cwd, ...env } as NodeJS.ProcessEnv,
    timeout: 10000,
  });
}

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" });
}

test("dispatcher: a session started in a subdirectory or a linked worktree starts the Node coordinator at the root the hooks use", () => {
  assert.ok(
    readFileSync(join(PLUGIN_ROOT, "bin", "ensure-coordinator-node"), "utf8").includes(NODE_BOOTSTRAP_WORKSPACE_LINE),
    "the stub no longer repeats ensure-coordinator-node's workspace line",
  );
  const base = mkdtempSync(join(tmpdir(), "dispatch5-root-"));
  try {
    const repo = join(base, "repo");
    const subdirectory = join(repo, "sub", "deeper");
    mkdirSync(subdirectory, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(base, "worktree");
    assert.equal(git(repo, "worktree", "add", "-q", worktree).status, 0);

    for (const cwd of [subdirectory, worktree]) {
      // The workspace every hook and CLI resolves from this directory.
      const hooksRoot = findCoordinatorRoot(cwd);
      assert.ok(hooksRoot !== null && hooksRoot !== realpathSync(cwd), `the hooks resolve ${String(hooksRoot)} from ${cwd}`);
      const r = dispatchFrom(cwd);
      assert.deepEqual({ status: r.status, stdout: r.stdout }, { status: 0, stdout: `NODE-BOOTSTRAP ${hooksRoot}\n` }, r.stderr);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("dispatcher: an explicit AGENT_COHERENCE_WORKSPACE still names the Node coordinator's workspace", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "dispatch5-elsewhere-"));
  try {
    git(ws, "init", "-q");
    const r = dispatchFrom(ws, { AGENT_COHERENCE_WORKSPACE: elsewhere });
    assert.deepEqual({ status: r.status, stdout: r.stdout }, { status: 0, stdout: `NODE-BOOTSTRAP ${elsewhere}\n` }, r.stderr);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("dispatcher: outside a git repository no Node coordinator starts, since no hook would ever reach it", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-nogit-"));
  try {
    // Keep git from finding a repository above the temp directory.
    const env = { GIT_CEILING_DIRECTORIES: dirname(ws) };
    assert.equal(findCoordinatorRoot(ws), null);
    for (const backend of [{}, { COHERENCE_COORDINATOR_BACKEND: "node" }]) {
      const r = dispatchFrom(ws, { ...env, ...backend });
      assert.deepEqual({ status: r.status, stdout: r.stdout }, { status: 0, stdout: "" }, r.stderr);
      assert.match(r.stderr, /not in a git repository; no coordinator started/);
    }
    assert.equal(existsSync(join(ws, ".coherence")), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ------------------------------------------------- .coherence check (#251)

/**
 * Workspaces whose `.coherence` a repository can commit and a start must not
 * use (cohexa-ai/agent-coherence#498). `plant` builds one in `ws`, with any
 * link target in `outside`, and returns the FIFOs to release afterwards.
 */
const REFUSED_WORKSPACES: Array<{
  where: string;
  name: string;
  kind: ShimRefusalKind;
  plant: (ws: string, outside: string) => string[];
}> = [
  {
    // Read through the link, this one routed the workspace to Python.
    where: "a coordinator_backend linked to a file that selects python",
    name: ".coherence/coordinator_backend",
    kind: "link",
    plant: (ws, outside) => {
      writeFileSync(join(outside, "choice"), "python\n");
      symlinkSync(join(outside, "choice"), join(coherenceDirIn(ws), "coordinator_backend"));
      return [];
    },
  },
  {
    where: "a coordinator_backend linked to a FIFO",
    name: ".coherence/coordinator_backend",
    kind: "link",
    plant: (ws, outside) => {
      const fifo = join(outside, "pipe");
      makeFifo(fifo);
      symlinkSync(fifo, join(coherenceDirIn(ws), "coordinator_backend"));
      return [fifo];
    },
  },
  {
    // Read through the link, this one made a fresh workspace look established.
    where: "a linked state.db",
    name: ".coherence/state.db",
    kind: "link",
    plant: (ws, outside) => {
      writeFileSync(join(outside, "store"), "");
      symlinkSync(join(outside, "store"), join(coherenceDirIn(ws), "state.db"));
      return [];
    },
  },
  {
    where: "a .coherence linked to a directory elsewhere",
    name: ".coherence",
    kind: "link",
    plant: (ws, outside) => {
      writeFileSync(join(outside, "coordinator_backend"), "python\n");
      symlinkSync(outside, join(ws, ".coherence"));
      return [];
    },
  },
  {
    // [ -e ] and [ -f ] follow a link, so a dangling one looks absent to them.
    where: "a dangling .coherence link",
    name: ".coherence",
    kind: "link",
    plant: (ws, outside) => {
      symlinkSync(join(outside, "gone"), join(ws, ".coherence"));
      return [];
    },
  },
  {
    where: "a .coherence that is a file",
    name: ".coherence",
    kind: "not_a_directory",
    plant: (ws) => {
      writeFileSync(join(ws, ".coherence"), "");
      return [];
    },
  },
  {
    // A glob's * leaves out names that start with a dot.
    where: "a linked .gitignore",
    name: ".coherence/.gitignore",
    kind: "link",
    plant: (ws, outside) => {
      symlinkSync(join(outside, "gone"), join(coherenceDirIn(ws), ".gitignore"));
      return [];
    },
  },
  {
    where: "a link named ..x",
    name: ".coherence/..x",
    kind: "link",
    plant: (ws, outside) => {
      symlinkSync(join(outside, "gone"), join(coherenceDirIn(ws), "..x"));
      return [];
    },
  },
  {
    where: "a FIFO at state.db",
    name: ".coherence/state.db",
    kind: "special",
    plant: (ws) => {
      const fifo = join(coherenceDirIn(ws), "state.db");
      makeFifo(fifo);
      return [fifo];
    },
  },
  {
    where: "a socket at server.pid",
    name: ".coherence/server.pid",
    kind: "special",
    plant: (ws) => {
      // Bound by a relative name, which fits a socket address however long the
      // temporary directory's path; the file stays once the process exits.
      const bind = spawnSync(
        process.execPath,
        ["-e", 'require("node:net").createServer().listen("server.pid", () => process.exit(0))'],
        { cwd: coherenceDirIn(ws), encoding: "utf8", timeout: 10000 },
      );
      if (bind.status !== 0) throw new Error(`could not bind a socket at server.pid: ${bind.stderr}`);
      return [];
    },
  },
  {
    // The name reaches the JSON and a terminal: every byte outside a safe set shows as ?.
    where: "a link named with a quote, a backslash, a percent sign and a newline",
    name: ".coherence/a?b?c?s?d",
    kind: "link",
    plant: (ws, outside) => {
      symlinkSync(join(outside, "gone"), join(coherenceDirIn(ws), 'a"b\\c%s\nd'));
      return [];
    },
  },
];

function coherenceDirIn(ws: string): string {
  const dir = join(ws, ".coherence");
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("dispatcher: a .coherence a start must not use is refused before either bootstrap runs, whatever selects the backend", async () => {
  const base = mkdtempSync(join(tmpdir(), "dispatch5-refused-"));
  try {
    // The check runs before the backend is chosen, so an explicit one is refused too.
    const backends = [undefined, "python", "node"];
    // A workspace, and so a FIFO, per run: a run that releases its FIFO must
    // not let another one held on it go on.
    const cases = REFUSED_WORKSPACES.flatMap((c, i) =>
      backends.map((backend, j) => {
        const ws = join(base, `ws-${i}-${j}`);
        const outside = join(base, `outside-${i}-${j}`);
        mkdirSync(ws);
        mkdirSync(outside);
        spawnSync("git", ["init", "-q"], { cwd: ws });
        return { ...c, label: `${c.where} [backend=${backend ?? "default"}]`, backend, ws, fifos: c.plant(ws, outside) };
      }),
    );
    const runs = cases.map(async (c) => {
      const run = await runCommandBounded("/bin/bash", [join(STUB_ROOT, "bin", "ensure-coordinator-dispatch")], {
        cwd: c.ws,
        env: {
          PATH: NODE_24_PATH,
          HOME: c.ws,
          ...(c.backend === undefined ? {} : { COHERENCE_COORDINATOR_BACKEND: c.backend }),
        } as NodeJS.ProcessEnv,
        timeoutMs: 10000,
        fifos: c.fifos,
      });
      return [c.label, run] as const;
    });
    const seen = Object.fromEntries(await Promise.all(runs));
    const expected = Object.fromEntries(
      cases.map((c) => [c.label, { timedOut: false, ...shimRefusal(c.name, c.kind) }]),
    );
    assert.deepEqual(seen, expected);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test(
  "dispatcher: a .coherence it cannot list passes the check, and the start goes on",
  { skip: process.getuid?.() === 0 ? "root can list any directory" : false },
  () => {
    // Git records no directory mode, so no clone makes one; the user did. A
    // check that refused it would leave such a workspace with no coordinator,
    // where the Python coordinator repairs the mode and starts.
    const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
    const coherenceDir = join(ws, ".coherence");
    try {
      spawnSync("git", ["init", "-q"], { cwd: ws });
      mkdirSync(coherenceDir);
      chmodSync(coherenceDir, 0o000);
      const r = spawnSync("/bin/bash", [join(STUB_ROOT, "bin", "ensure-coordinator-dispatch")], {
        cwd: ws,
        encoding: "utf8",
        env: { PATH: NODE_24_PATH, HOME: ws } as NodeJS.ProcessEnv,
        timeout: 10000,
      });
      assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: "NODE-BOOTSTRAP\n", stderr: "" });
    } finally {
      chmodSync(coherenceDir, 0o755);
      rmSync(ws, { recursive: true, force: true });
    }
  },
);

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
