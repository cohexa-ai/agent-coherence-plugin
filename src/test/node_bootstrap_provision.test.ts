/**
 * Marketplace provisioning regression — a plugin package WITHOUT dist/ (the
 * shape every marketplace install receives: git clone + gitignored dist/)
 * must still yield a LIVE Node coordinator, and provisioning failures must
 * be loud — exit 1 with no "spawned" line — never the pre-fix behavior of
 * spawning a nonexistent entry point and reporting success while the
 * coordinator crash-looped MODULE_NOT_FOUND into coordinator.log.
 *
 * Subprocess style per dispatch_unit5.test.ts. The stub package has zero
 * dependencies so Stage 1's `npm install` is fast and offline; tsc is
 * provided by symlinking the repo's own node_modules as the stub package's
 * (standing in for the marketplace installer's npm install in the plugin
 * cache — no network in tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  chmodSync,
  symlinkSync,
  existsSync,
  readFileSync,
  renameSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeExecutable } from './executable_fixture.js';
import { makeFifo, runCommandBounded } from './fifo_fixture.js';
import { LOCK_MODULE_URL, holdPidFileLock, killAndWait } from './pid_lock_fixture.js';
import { shimRefusal } from './shim_refusal_fixture.js';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const STUB_PACKAGE_JSON = JSON.stringify({
  name: 'provision-stub',
  version: '0.0.1',
  private: true,
  type: 'module',
});

// Minimal project shape mirroring the real tsconfig's src → dist layout.
const STUB_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    outDir: 'dist',
    rootDir: 'src',
  },
  include: ['src/**/*'],
});

// What the bootstrap waits for before calling a coordinator spawned: it writes
// server.pid naming itself, as the real one does once its port is bound.
const SERVE_LIKE_A_COORDINATOR =
  'const dir = (process.env.AGENT_COHERENCE_WORKSPACE ?? process.cwd()) + "/.coherence";\n' +
  'mkdirSync(dir, { recursive: true });\n' +
  'writeFileSync(dir + "/server.pid", `${process.pid}\\n0\\nbackend=node\\n`);\n' +
  'setInterval(() => {}, 60_000);\n';
// The inline `declare`s and the unchecked import keep the stub compilable with
// no @types/node in the stub's (empty) node_modules; Node provides them at run
// time regardless.
const HEALTHY_COORDINATOR_TS =
  '// @ts-ignore -- the stub package has no @types/node; Node provides the module.\n' +
  'import { mkdirSync, writeFileSync } from "node:fs";\n' +
  'declare const process: { pid: number; env: Record<string, string | undefined>; cwd(): string };\n' +
  'declare function setInterval(cb: () => void, ms: number): unknown;\n' +
  SERVE_LIKE_A_COORDINATOR;
const CRASHING_COORDINATOR_TS = 'throw new Error("stub coordinator crash on boot");\n';
const HEALTHY_PREBUILT_JS = 'import { mkdirSync, writeFileSync } from "node:fs";\n' + SERVE_LIKE_A_COORDINATOR;

// The exact crash a Node-major change produces once node_modules holds a
// binary built for the previous ABI — the failure this file's SELF-HEAL
// tests exist to make self-healing.
const ABI_CRASH_COORDINATOR_TS =
  "throw new Error(\"The module '/x/better_sqlite3.node' was compiled against a " +
  'different Node.js version using NODE_MODULE_VERSION 131. This version of Node.js ' +
  'requires NODE_MODULE_VERSION 137.");\n';

/** The ABI the running node binds native addons to — what a build is sealed for. */
const RUNNING_ABI = process.versions.modules;

/**
 * Where a provision publishes its build (#295): builds/<name>/, named by the
 * one-line file `current` and sealed by `.ok` ("<abi> <install digest>").
 */
function publishedBuild(data: string): string {
  return readFileSync(join(data, 'current'), 'utf8').trim();
}
function publishedDir(data: string): string {
  return join(data, 'builds', publishedBuild(data));
}
function sealedAbi(buildDir: string): string {
  return readFileSync(join(buildDir, '.ok'), 'utf8').split(' ')[0]!.trim();
}

interface StubRootOpts {
  /** When set, the package ships src/coordinator.ts + tsconfig.json (marketplace shape). */
  srcCoordinatorTs?: string;
  /** Symlink the repo's node_modules into the package (provides .bin/tsc). */
  withTsc?: boolean;
  /** When set, the package ships a prebuilt dist/coordinator.js (dev-checkout shape). */
  prebuiltDistJs?: string;
}

function makeStubRoot(opts: StubRootOpts): string {
  const root = mkdtempSync(join(tmpdir(), 'provision-root-'));
  mkdirSync(join(root, 'bin'), { recursive: true });
  cpSync(
    join(PLUGIN_ROOT, 'bin', 'ensure-coordinator-node'),
    join(root, 'bin', 'ensure-coordinator-node')
  );
  chmodSync(join(root, 'bin', 'ensure-coordinator-node'), 0o755);
  writeFileSync(join(root, 'package.json'), STUB_PACKAGE_JSON);
  if (opts.srcCoordinatorTs !== undefined) {
    writeFileSync(join(root, 'tsconfig.json'), STUB_TSCONFIG);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'coordinator.ts'), opts.srcCoordinatorTs);
  }
  if (opts.withTsc) {
    symlinkSync(join(PLUGIN_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  }
  if (opts.prebuiltDistJs !== undefined) {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'coordinator.js'), opts.prebuiltDistJs);
  }
  return root;
}

function runBootstrap(root: string, data: string, ws: string) {
  return spawnSync('bash', [join(root, 'bin', 'ensure-coordinator-node')], {
    cwd: ws,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_PLUGIN_DATA: data,
    } as NodeJS.ProcessEnv,
  });
}

/** Kill the detached coordinator a successful bootstrap left running. */
function killSpawned(stderr: string): void {
  const m = /spawned Node coordinator \(pid=(\d+)/.exec(stderr);
  if (m) {
    try {
      process.kill(Number(m[1]), 'SIGKILL');
    } catch {
      // already exited
    }
  }
}

function makeDirs(): { data: string; ws: string; cleanup: () => void } {
  const data = mkdtempSync(join(tmpdir(), 'provision-data-'));
  const ws = mkdtempSync(join(tmpdir(), 'provision-ws-'));
  return {
    data,
    ws,
    cleanup: () => {
      // maxRetries absorbs the window between SIGKILL and the OS releasing
      // the daemon's open log handle (same pattern as zero_python_smoke).
      rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

test('REGRESSION: dist-less package (marketplace clone) self-builds src/ and spawns a LIVE coordinator', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrap(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /building src\//);
      assert.ok(
        existsSync(join(publishedDir(data), 'dist', 'coordinator.js')),
        'built entry must exist in the build PLUGIN_DATA publishes'
      );
      const m = /spawned Node coordinator \(pid=(\d+)/.exec(r.stderr);
      assert.ok(m, `no spawn line in stderr:\n${r.stderr}`);
      // Let through because it serves, not because the deadline passed.
      assert.doesNotMatch(r.stderr, /has not started serving/);
      // The bootstrap's own liveness gate passed; the pid must still be up.
      assert.doesNotThrow(() => process.kill(Number(m[1]), 0));
      // First successful provision of a VIRGIN workspace stamps the backend,
      // so the dispatcher's state.db guard can't reroute session 2 to python.
      assert.equal(
        readFileSync(join(ws, '.coherence', 'coordinator_backend'), 'utf8').trim(),
        'node'
      );
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('provisioning is keyed: an unchanged package skips the rebuild and just spawns', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const first = runBootstrap(root, data, ws);
    killSpawned(first.stderr ?? '');
    assert.equal(first.status, 0, `first bootstrap failed:\n${first.stdout}\n${first.stderr}`);
    assert.match(first.stderr, /building src\//);
    const built = publishedBuild(data);

    const second = runBootstrap(root, data, ws);
    try {
      assert.equal(
        second.status,
        0,
        `second bootstrap failed:\n${second.stdout}\n${second.stderr}`
      );
      // Same package.json, same ABI, entry already built → no install, no
      // rebuild. The ABI key must not turn every session into a reinstall.
      assert.equal(publishedBuild(data), built, 'the published build is reused, not rebuilt');
      assert.doesNotMatch(second.stderr, /installing Node deps/);
      assert.doesNotMatch(second.stderr, /building src\//);
      assert.doesNotMatch(second.stderr, /Node ABI changed/);
      assert.match(second.stderr, /spawned Node coordinator/);
      assert.doesNotMatch(second.stderr, /has not started serving/);
      assert.equal(sealedAbi(publishedDir(data)), RUNNING_ABI);
    } finally {
      killSpawned(second.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test("LOUD FAIL: dist-less package with no tsc anywhere → exit 1, actionable stderr, NO false 'spawned'", () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: false });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrap(root, data, ws);
    assert.equal(r.status, 1, `expected loud failure:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /no dist\/ and no tsc/);
    assert.match(r.stderr, /coordinator will not start this session/);
    assert.doesNotMatch(r.stderr, /spawned Node coordinator/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test("LIVENESS GATE: a coordinator that dies on boot → exit 1 with a log excerpt, NO false 'spawned'", () => {
  const root = makeStubRoot({ srcCoordinatorTs: CRASHING_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrap(root, data, ws);
    assert.equal(r.status, 1, `expected loud failure:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /exited before it started serving/);
    // The crash log tail is surfaced so the failure is diagnosable from the
    // hook output alone.
    assert.match(r.stderr, /stub coordinator crash on boot/);
    assert.doesNotMatch(r.stderr, /spawned Node coordinator/);
    // A FAILED boot must not stamp the workspace as node-backed.
    assert.equal(existsSync(join(ws, '.coherence', 'coordinator_backend')), false);
    // ...but a crash with no NODE_MODULE_VERSION in it is NOT an ABI problem,
    // so the build's seal must survive. Removing it on any crash would turn
    // an ordinary coordinator bug into a full npm reinstall every session.
    assert.equal(sealedAbi(publishedDir(data)), RUNNING_ABI);
    assert.doesNotMatch(r.stderr, /next session reprovisions/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test("LIVENESS GATE: a coordinator that dies after half a second, before it serves → exit 1, NO false 'spawned', no stamp", () => {
  // A real coordinator fails start-up only after loading its native module
  // and opening state.db: measured at 1.3-1.7 s under heavy load. A fixed
  // half-second check let such a coordinator through as spawned and pinned a
  // fresh workspace to the Node backend.
  const lateCrash = 'setTimeout(() => { throw new Error("stub coordinator crash after 1.5 s"); }, 1500);\n';
  const root = makeStubRoot({ prebuiltDistJs: lateCrash });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrap(root, data, ws);
    try {
      assert.equal(r.status, 1, `expected loud failure:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /exited before it started serving/);
      assert.match(r.stderr, /stub coordinator crash after 1\.5 s/);
      assert.doesNotMatch(r.stderr, /spawned Node coordinator/);
      assert.equal(existsSync(join(ws, '.coherence', 'coordinator_backend')), false);
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('LIVENESS GATE: a coordinator still alive but not serving after the deadline is warned about, then let through', () => {
  // Only a coordinator that exits counts as failed: one that is merely slow
  // keeps today's handling (spawned, and a fresh workspace stamped node).
  const root = makeStubRoot({ prebuiltDistJs: 'setInterval(() => {}, 60_000);\n' });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrap(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /has not started serving after 10s; it may still be starting/);
      assert.match(r.stderr, /spawned Node coordinator/);
      assert.equal(readFileSync(join(ws, '.coherence', 'coordinator_backend'), 'utf8').trim(), 'node');
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test("LIVENESS GATE: under a `node` launcher that does not exec, the coordinator's own pid is reported", () => {
  // A version manager's shim can run node as a child instead of exec'ing it.
  // The coordinator then runs under a pid other than the one the shell
  // started, and that one exits once the coordinator is detached; the
  // bootstrap reports the coordinator's.
  const root = makeStubRoot({ prebuiltDistJs: HEALTHY_PREBUILT_JS });
  const { data, ws, cleanup } = makeDirs();
  const launcherBin = mkdtempSync(join(tmpdir(), 'provision-launcher-'));
  writeExecutable(join(launcherBin, 'node'), `#!/usr/bin/env bash\n"${process.execPath}" "$@"\nexit $?\n`);
  const pidFile = join(ws, '.coherence', 'server.pid');
  try {
    const r = runBootstrapIn(root, data, ws, launcherBin);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      const spawned = /spawned Node coordinator \(pid=(\d+)/.exec(r.stderr)?.[1];
      assert.equal(spawned, readFileSync(pidFile, 'utf8').split('\n')[0]);
      assert.doesNotMatch(r.stderr, /has not started serving/);
    } finally {
      killSpawned(r.stderr ?? '');
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, 'utf8').split('\n')[0]), 'SIGKILL');
        } catch {
          // already exited
        }
      }
    }
  } finally {
    rmSync(launcherBin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

/**
 * A stub coordinator that takes server.pid's lock as the real one does
 * (#217): it retries a held lock for up to 2 s, exits when another holds it
 * on, and otherwise publishes its pid and a port through the locked file.
 * The triggers are files it creates, so a test's lock holder can act at the
 * moment this coordinator starts (`started`) or gives up (`lost`).
 */
function lockingCoordinatorJs(triggers: { started?: string; lost?: string } = {}): string {
  const touch = (path: string | undefined, indent = ''): string =>
    path === undefined ? '' : `${indent}writeFileSync(${JSON.stringify(path)}, "");\n`;
  return (
    'import { mkdirSync, writeFileSync } from "node:fs";\n' +
    `const { lockPidFile, rewritePidFile } = await import(${JSON.stringify(LOCK_MODULE_URL)});\n` +
    'const dir = (process.env.AGENT_COHERENCE_WORKSPACE ?? process.cwd()) + "/.coherence";\n' +
    'mkdirSync(dir, { recursive: true });\n' +
    touch(triggers.started) +
    'const lock = await lockPidFile(dir + "/server.pid");\n' +
    'if (lock.state === "contended") {\n' +
    '  process.stderr.write("another coordinator holds " + dir + "/server.pid; exiting (pid=" + process.pid + ")\\n");\n' +
    touch(triggers.lost, '  ') +
    '  process.exit(0);\n' +
    '}\n' +
    'rewritePidFile(lock.fd, `${process.pid}\\n0\\nbackend=node\\n`);\n' +
    'setInterval(() => {}, 60_000);\n'
  );
}

/** Kill the coordinator a joined session started, which exits on its own soon after. */
function killJoinedStart(stderr: string): void {
  const m = /the one started here \(pid=(\d+)\) exits/.exec(stderr);
  if (m) {
    try {
      process.kill(Number(m[1]), 'SIGKILL');
    } catch {
      // already exited
    }
  }
}

test('LIVENESS GATE: a session whose coordinator loses the start is told another serves it, not that it spawned', async () => {
  // Two sessions starting at once each spawn a coordinator. The winner
  // publishes while the loser still waits for the lock, and the loser exits
  // about 2 s later; its session is served by the winner all the same. The
  // stamp follows the winner's backend line: a Node store is pinned to node,
  // a Python coordinator's file (no backend line) pins nothing.
  for (const [published, stamped] of [
    ['PID\n4242\nbackend=node\n', true],
    ['PID\n4242\n', false],
  ] as const) {
    const { data, ws, cleanup } = makeDirs();
    const trigger = join(ws, 'coordinator-started');
    const root = makeStubRoot({ prebuiltDistJs: lockingCoordinatorJs({ started: trigger }) });
    mkdirSync(join(ws, '.coherence'), { recursive: true });
    const winner = await holdPidFileLock(join(ws, '.coherence', 'server.pid'), { publish: published, publishWhen: trigger });
    try {
      const r = runBootstrapIn(root, data, ws);
      const label = `published=${JSON.stringify(published)}\n${r.stdout}\n${r.stderr}`;
      try {
        assert.equal(r.status, 0, label);
        assert.match(r.stderr, /serves no port \(starting or stopping\); starting one that waits for it/, label);
        assert.match(r.stderr, new RegExp(`another coordinator already serves this workspace \\(pid=${winner.pid}\\)`), label);
        assert.doesNotMatch(r.stderr, /spawned Node coordinator|exited before it started serving/, label);
        assert.equal(existsSync(join(ws, '.coherence', 'coordinator_backend')), stamped, label);
      } finally {
        killJoinedStart(r.stderr ?? '');
      }
    } finally {
      await killAndWait(winner);
      rmSync(root, { recursive: true, force: true });
      cleanup();
    }
  }
});

test('STAGE 3: a coordinator holding the lock with its port published counts as running', async () => {
  const root = makeStubRoot({ prebuiltDistJs: lockingCoordinatorJs() });
  const { data, ws, cleanup } = makeDirs();
  mkdirSync(join(ws, '.coherence'), { recursive: true });
  const holder = await holdPidFileLock(join(ws, '.coherence', 'server.pid'), { publish: 'PID\n4242\nbackend=node\n' });
  try {
    const r = runBootstrapIn(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, new RegExp(`coordinator already running \\(pid=${holder.pid}\\)`));
      assert.doesNotMatch(r.stderr, /stale pid file|spawned Node coordinator/);
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    await killAndWait(holder);
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('STAGE 3: a coordinator holding the lock without a port is replaced once it lets go', async () => {
  // A coordinator that is stopping has dropped its port but holds the lock
  // until it exits; one that dies during start-up holds it with no port at
  // all. Treating either as running left the session with no coordinator.
  // The one started here waits for the lock and serves.
  const { data, ws, cleanup } = makeDirs();
  const trigger = join(ws, 'coordinator-started');
  const root = makeStubRoot({ prebuiltDistJs: lockingCoordinatorJs({ started: trigger }) });
  mkdirSync(join(ws, '.coherence'), { recursive: true });
  const pidFile = join(ws, '.coherence', 'server.pid');
  const stopping = await holdPidFileLock(pidFile, { publish: 'PID\n', exitWhen: trigger });
  try {
    const r = runBootstrapIn(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /serves no port \(starting or stopping\); starting one that waits for it/);
      const spawned = /spawned Node coordinator \(pid=(\d+)/.exec(r.stderr)?.[1];
      assert.equal(spawned, readFileSync(pidFile, 'utf8').split('\n')[0]);
      assert.doesNotMatch(r.stderr, /already running|another coordinator already serves/);
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    await killAndWait(stopping);
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('LIVENESS GATE: a session whose coordinator gave up waiting joins the holder once it serves', async () => {
  // A holder still starting when ours gives up its 2 s wait for the lock:
  // ours has exited, but the holder will serve, so the session waits for it.
  const { data, ws, cleanup } = makeDirs();
  const lost = join(ws, 'coordinator-lost');
  const root = makeStubRoot({ prebuiltDistJs: lockingCoordinatorJs({ lost }) });
  mkdirSync(join(ws, '.coherence'), { recursive: true });
  const holder = await holdPidFileLock(join(ws, '.coherence', 'server.pid'), {
    publish: 'PID\n4242\nbackend=node\n',
    publishWhen: lost,
  });
  try {
    const r = runBootstrapIn(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, new RegExp(`another coordinator already serves this workspace \\(pid=${holder.pid}\\)`));
      assert.doesNotMatch(r.stderr, /exited before it started serving|spawned Node coordinator/);
      assert.equal(readFileSync(join(ws, '.coherence', 'coordinator_backend'), 'utf8').trim(), 'node');
    } finally {
      killJoinedStart(r.stderr ?? '');
    }
  } finally {
    await killAndWait(holder);
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('LIVENESS GATE: when the holder lets go only after ours gave up, one more coordinator is started and serves', async () => {
  // A coordinator stopping slower than ours waits for the lock: ours gives up
  // and exits, then the lock frees with nothing served. Reporting that as a
  // failed start left the session with no coordinator.
  const { data, ws, cleanup } = makeDirs();
  const lost = join(ws, 'coordinator-lost');
  const root = makeStubRoot({ prebuiltDistJs: lockingCoordinatorJs({ lost }) });
  mkdirSync(join(ws, '.coherence'), { recursive: true });
  const pidFile = join(ws, '.coherence', 'server.pid');
  const stopping = await holdPidFileLock(pidFile, { publish: 'PID\n', exitWhen: lost });
  try {
    const r = runBootstrapIn(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /let go without serving; starting another/);
      const spawned = /spawned Node coordinator \(pid=(\d+)/.exec(r.stderr)?.[1];
      assert.equal(spawned, readFileSync(pidFile, 'utf8').split('\n')[0]);
      assert.doesNotMatch(r.stderr, /exited before it started serving/);
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    await killAndWait(stopping);
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('LIVENESS GATE: a holder that never serves while ours gave up is warned about at the deadline, not failed', async () => {
  // Ours exited on finding the lock held and the holder publishes nothing
  // within the deadline. The holder may only be slow, as at the PR #232
  // deadline, so the session is let through with a warning, and nothing is
  // stamped: the holder's file names no backend.
  const { data, ws, cleanup } = makeDirs();
  const root = makeStubRoot({ prebuiltDistJs: lockingCoordinatorJs() });
  mkdirSync(join(ws, '.coherence'), { recursive: true });
  const holder = await holdPidFileLock(join(ws, '.coherence', 'server.pid'));
  try {
    const r = runBootstrapIn(root, data, ws);
    assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /another coordinator holds .*server\.pid but has not started serving after 10s/);
    assert.doesNotMatch(r.stderr, /exited before it started serving|spawned Node coordinator/);
    assert.equal(existsSync(join(ws, '.coherence', 'coordinator_backend')), false);
  } finally {
    await killAndWait(holder);
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('STAGE 3: a server.pid naming a live process that is not a coordinator does not pass for one', () => {
  // The pid of a coordinator that died is reused by whatever starts next;
  // `kill -0` alone took that process for the coordinator and started none.
  const root = makeStubRoot({ prebuiltDistJs: HEALTHY_PREBUILT_JS });
  const { data, ws, cleanup } = makeDirs();
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  mkdirSync(join(ws, '.coherence'), { recursive: true });
  writeFileSync(join(ws, '.coherence', 'server.pid'), `${sleeper.pid}\n4242\nbackend=node\n`);
  try {
    const r = runBootstrapIn(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /stale pid file/);
      assert.match(r.stderr, /spawned Node coordinator/);
      assert.doesNotMatch(r.stderr, /already running/);
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    sleeper.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('STAGE 3: a running coordinator that holds no lock, as before #217, still counts as running', () => {
  // After a plugin update the coordinator the previous version started keeps
  // serving, and it never locks server.pid. Starting another beside it would
  // put two coordinators on one store; the stub here locks nothing either.
  const root = makeStubRoot({ prebuiltDistJs: HEALTHY_PREBUILT_JS });
  const { data, ws, cleanup } = makeDirs();
  try {
    const first = runBootstrapIn(root, data, ws);
    try {
      assert.equal(first.status, 0, `first bootstrap failed:\n${first.stdout}\n${first.stderr}`);
      const spawned = /spawned Node coordinator \(pid=(\d+)/.exec(first.stderr)![1];
      const second = runBootstrapIn(root, data, ws);
      try {
        assert.equal(second.status, 0, `second bootstrap failed:\n${second.stdout}\n${second.stderr}`);
        assert.match(second.stderr, new RegExp(`coordinator already running \\(pid=${spawned}\\)`));
        assert.doesNotMatch(second.stderr, /spawned Node coordinator/);
      } finally {
        killSpawned(second.stderr ?? '');
      }
    } finally {
      killSpawned(first.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test("STAGE 4: the coordinator leads a process group of its own, out of reach of the hook's", () => {
  // Claude Code may kill the SessionStart hook's process group, for example
  // when the hook times out. `nohup cmd &` left the coordinator in that group.
  const root = makeStubRoot({ prebuiltDistJs: HEALTHY_PREBUILT_JS });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrapIn(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      const pid = /spawned Node coordinator \(pid=(\d+)/.exec(r.stderr)![1];
      const pgid = spawnSync('ps', ['-o', 'pgid=', '-p', pid!], { encoding: 'utf8' }).stdout.trim();
      assert.equal(pgid, pid);
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('dev-checkout shape: a package WITH dist/ is mirrored (no build) and spawns', () => {
  const root = makeStubRoot({ prebuiltDistJs: HEALTHY_PREBUILT_JS });
  const { data, ws, cleanup } = makeDirs();
  try {
    // An ESTABLISHED store (state.db predates this boot) must not be claimed
    // for node — it may be Python-owned; the default-flip guard decides.
    mkdirSync(join(ws, '.coherence'), { recursive: true });
    writeFileSync(join(ws, '.coherence', 'state.db'), '');
    const r = runBootstrap(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      assert.ok(
        existsSync(join(publishedDir(data), 'dist', 'coordinator.js')),
        'mirrored entry must exist in the build PLUGIN_DATA publishes'
      );
      assert.doesNotMatch(r.stderr, /building src\//);
      assert.match(r.stderr, /spawned Node coordinator/);
      assert.doesNotMatch(r.stderr, /has not started serving/);
      assert.equal(existsSync(join(ws, '.coherence', 'coordinator_backend')), false);
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test("an operator's existing coordinator_backend file is never overwritten by the stamp", () => {
  const root = makeStubRoot({ prebuiltDistJs: HEALTHY_PREBUILT_JS });
  const { data, ws, cleanup } = makeDirs();
  try {
    // Virgin store, but the operator already selected python (this bootstrap
    // still runs when e.g. COHERENCE_COORDINATOR_BACKEND=node overrides it).
    mkdirSync(join(ws, '.coherence'), { recursive: true });
    writeFileSync(join(ws, '.coherence', 'coordinator_backend'), 'python\n');
    const r = runBootstrap(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /spawned Node coordinator/);
      assert.equal(readFileSync(join(ws, '.coherence', 'coordinator_backend'), 'utf8'), 'python\n');
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

// --- .coherence check (#251) -------------------------------------------------

/**
 * A start the check refuses lstats and lists only, so it answers in well under
 * a second; this only has to tell it from a start held on a FIFO.
 */
const AT_ONCE_MS = 5_000;

/** A coordinator that never serves and goes away on its own: for starts that must never spawn one. */
const SHORT_LIVED_JS = 'setTimeout(() => {}, 20_000);\n';

/** What is at `path`, without following a link there. */
function entryAt(path: string): string {
  let info;
  try {
    info = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
  if (info.isSymbolicLink()) return `link to ${readlinkSync(path)}`;
  if (info.isFIFO()) return 'FIFO';
  return `file ${JSON.stringify(readFileSync(path, 'utf8'))}`;
}

test('the bootstrap refuses a linked server.pid, coordinator_backend, state.db or .coherence before it reads, joins or writes anything', async () => {
  // A repository can commit these links (cohexa-ai/agent-coherence#498).
  // Before, the bootstrap joined the coordinator another workspace's pid file
  // names, waited for good on a FIFO behind server.pid, and stamped the backend
  // through a dangling link, creating the file it names.
  const base = mkdtempSync(join(tmpdir(), 'provision-refused-'));
  const theirs = join(base, 'other', '.coherence', 'server.pid');
  mkdirSync(dirname(theirs), { recursive: true });
  const fifo = join(base, 'pipe');
  makeFifo(fifo);
  const store = join(base, 'store');
  writeFileSync(store, 'theirs');
  // Only its own row releases the FIFO: a row that finished first must not let a held one go on.
  const rows = [
    { where: "server.pid linked to a serving coordinator's", entry: '.coherence/server.pid', target: theirs, pinned: true, fifos: [] },
    { where: 'server.pid linked to a FIFO', entry: '.coherence/server.pid', target: fifo, pinned: true, fifos: [fifo] },
    // Run as Claude Code runs it, in $PWD.
    { where: 'a dangling coordinator_backend link', entry: '.coherence/coordinator_backend', target: join(base, 'gone'), pinned: false, fifos: [] },
    // Its way out moves the store's -wal and -shm with it.
    { where: 'a linked state.db', entry: '.coherence/state.db', target: store, pinned: true, fifos: [] },
    // Its way out is a real directory, not a copy of a file.
    { where: 'a dangling .coherence link', entry: '.coherence', target: join(base, 'gone-dir'), pinned: true, fifos: [] },
  ].map((row) => {
    const root = makeStubRoot({ prebuiltDistJs: SHORT_LIVED_JS });
    const dirs = makeDirs();
    const link = join(dirs.ws, row.entry);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(row.target, link);
    return { ...row, ...dirs, root, link };
  });
  // Another workspace's coordinator, serving.
  const holder = await holdPidFileLock(theirs, { publish: 'PID\n4242\nbackend=node\n' });
  try {
    const before = rows.map((row) => entryAt(row.target));
    const runs = rows.map(async (row) => {
      const run = await runCommandBounded('bash', [join(row.root, 'bin', 'ensure-coordinator-node')], {
        cwd: row.ws,
        env: {
          ...process.env,
          AGENT_COHERENCE_WORKSPACE: row.pinned ? row.ws : undefined,
          CLAUDE_PLUGIN_ROOT: row.root,
          CLAUDE_PLUGIN_DATA: row.data,
        } as NodeJS.ProcessEnv,
        timeoutMs: AT_ONCE_MS,
        fifos: row.fifos,
      });
      return [row.where, { ...run, link: entryAt(row.link), target: entryAt(row.target) }] as const;
    });
    const seen = Object.fromEntries(await Promise.all(runs));
    assert.deepEqual(
      seen,
      Object.fromEntries(
        rows.map((row, i) => [
          row.where,
          {
            timedOut: false,
            ...shimRefusal(row.entry, 'link'),
            link: `link to ${row.target}`,
            target: before[i],
          },
        ])
      )
    );
  } finally {
    await killAndWait(holder);
    for (const row of rows) {
      rmSync(row.root, { recursive: true, force: true });
      row.cleanup();
    }
    rmSync(base, { recursive: true, force: true });
  }
});

/**
 * A coordinator that serves at once and goes away on its own. With `linkTarget`
 * it first plants a link to it at coordinator_backend: after the start check,
 * before the backend stamp.
 */
function servingCoordinatorJs(linkTarget?: string): string {
  return (
    'import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";\n' +
    'const dir = (process.env.AGENT_COHERENCE_WORKSPACE ?? process.cwd()) + "/.coherence";\n' +
    'mkdirSync(dir, { recursive: true });\n' +
    (linkTarget === undefined
      ? ''
      : `symlinkSync(${JSON.stringify(linkTarget)}, dir + "/coordinator_backend");\n`) +
    'writeFileSync(dir + "/server.pid", `${process.pid}\\n0\\nbackend=node\\n`);\n' +
    'setTimeout(() => {}, 20_000);\n'
  );
}

/**
 * A bin directory whose `mkdir`, once it has made `ws`/.coherence, plants a
 * link to `linkTarget` at coordinator_backend: between the stamp's own test
 * and its write.
 */
function mkdirThatPlants(ws: string, linkTarget: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'provision-mkdir-'));
  const coherenceDir = join(ws, '.coherence');
  writeExecutable(
    join(bin, 'mkdir'),
    '#!/usr/bin/env bash\n' +
      '/bin/mkdir "$@" || exit\n' +
      'for last in "$@"; do :; done\n' +
      `if [ "\${last:-}" = ${JSON.stringify(coherenceDir)} ]; then\n` +
      `  ln -s ${JSON.stringify(linkTarget)} ${JSON.stringify(join(coherenceDir, 'coordinator_backend'))}\n` +
      'fi\n'
  );
  return bin;
}

test('the first-provision stamp follows no link planted after the start check, and waits on no FIFO', async () => {
  // The stamp runs once a coordinator serves, seconds after the start check.
  // Before, a dangling link at coordinator_backend by then had "node" written
  // through it, creating the file it names, and a link to a FIFO held the
  // session start until something read the FIFO.
  const base = mkdtempSync(join(tmpdir(), 'provision-stamp-'));
  const fifo = join(base, 'pipe');
  makeFifo(fifo);
  const rows = [
    { where: 'a dangling link the coordinator plants as it starts', target: join(base, 'gone-1'), by: 'coordinator', fifos: [] },
    { where: "a dangling link planted between the stamp's test and its write", target: join(base, 'gone-2'), by: 'mkdir', fifos: [] },
    { where: 'a link to a FIFO the coordinator plants as it starts', target: fifo, by: 'coordinator', fifos: [fifo] },
  ].map((row) => {
    const root = makeStubRoot({
      prebuiltDistJs: servingCoordinatorJs(row.by === 'coordinator' ? row.target : undefined),
    });
    const dirs = makeDirs();
    const bin = row.by === 'mkdir' ? mkdirThatPlants(dirs.ws, row.target) : undefined;
    return { ...row, ...dirs, root, bin, link: join(dirs.ws, '.coherence', 'coordinator_backend') };
  });
  const runs: Array<{ stderr: string }> = [];
  try {
    const before = rows.map((row) => entryAt(row.target));
    const outcomes = rows.map(async (row) => {
      const run = await runCommandBounded('bash', [join(row.root, 'bin', 'ensure-coordinator-node')], {
        cwd: row.ws,
        env: {
          ...process.env,
          PATH: row.bin === undefined ? process.env.PATH : `${row.bin}:${process.env.PATH ?? ''}`,
          AGENT_COHERENCE_WORKSPACE: row.ws,
          CLAUDE_PLUGIN_ROOT: row.root,
          CLAUDE_PLUGIN_DATA: row.data,
        } as NodeJS.ProcessEnv,
        // The whole provision runs first; this only has to tell a finished
        // start from one held on the FIFO.
        timeoutMs: 60_000,
        fifos: row.fifos,
      });
      runs.push(run);
      return [
        row.where,
        {
          timedOut: run.timedOut,
          status: run.status,
          spawned: /spawned Node coordinator \(pid=/.test(run.stderr),
          link: entryAt(row.link),
          target: entryAt(row.target),
        },
      ] as const;
    });
    const seen = Object.fromEntries(await Promise.all(outcomes));
    assert.deepEqual(
      seen,
      Object.fromEntries(
        rows.map((row, i) => [
          row.where,
          { timedOut: false, status: 0, spawned: true, link: `link to ${row.target}`, target: before[i] },
        ])
      ),
      runs.map((run) => run.stderr).join('\n')
    );
  } finally {
    for (const run of runs) killSpawned(run.stderr);
    for (const row of rows) {
      if (row.bin !== undefined) rmSync(row.bin, { recursive: true, force: true });
      rmSync(row.root, { recursive: true, force: true });
      row.cleanup();
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test('ABI KEY: a successful provision names and seals its build for the running Node ABI', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrap(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      // process.versions.modules — NOT the Node version. A binary is bound to
      // the ABI, and two Node majors can share one (as 24 and 25 nearly did).
      assert.ok(
        publishedBuild(data).startsWith(`${RUNNING_ABI}-${process.platform}-${process.arch}-`),
        `build name does not carry the ABI: ${publishedBuild(data)}`
      );
      assert.equal(sealedAbi(publishedDir(data)), RUNNING_ABI);
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('REGRESSION: a Node-major change forces a CLEAN install, beside the build published for the old ABI', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const first = runBootstrap(root, data, ws);
    killSpawned(first.stderr ?? '');
    assert.equal(first.status, 0, `first bootstrap failed:\n${first.stdout}\n${first.stderr}`);

    // Stand in for the build a previous Node major published: node_modules
    // holding a binary compiled for ABI 131 (Node 23). The sentinel is the
    // load-bearing part — a plain `npm install` over this tree leaves it
    // untouched, because npm sees a satisfying version already installed,
    // which is exactly how the 0.3.1 -> 0.4.0 bump shipped a stale binary to
    // a Node 24 user. Only a clean install leaves it behind.
    const oldName = publishedBuild(data).replace(/^\d+-/, '131-');
    renameSync(publishedDir(data), join(data, 'builds', oldName));
    writeFileSync(join(data, 'current'), `${oldName}\n`);
    writeFileSync(join(data, 'builds', oldName, '.ok'), '131 stale\n');
    const sentinel = join(data, 'builds', oldName, 'node_modules', 'STALE-ABI-131-ARTIFACT');
    writeFileSync(sentinel, 'compiled for NODE_MODULE_VERSION 131\n');

    const second = runBootstrap(root, data, ws);
    try {
      assert.equal(
        second.status,
        0,
        `second bootstrap failed:\n${second.stdout}\n${second.stderr}`
      );
      assert.match(second.stderr, new RegExp(`Node ABI changed \\(131 -> ${RUNNING_ABI}\\)`));
      assert.match(second.stderr, /installing Node deps/);
      assert.notEqual(publishedBuild(data), oldName);
      assert.equal(
        existsSync(join(publishedDir(data), 'node_modules', 'STALE-ABI-131-ARTIFACT')),
        false,
        'the new ABI gets a clean install, not one over the stale tree'
      );
      assert.equal(existsSync(sentinel), true, 'the old ABI\'s build is left whole, not torn down under its readers');
      // The sources did not change: tsc output is plain JavaScript, bound to
      // no ABI, so the old build's dist/ is reused rather than rebuilt.
      assert.doesNotMatch(second.stderr, /building src\//);
      assert.equal(sealedAbi(publishedDir(data)), RUNNING_ABI);
      assert.match(second.stderr, /spawned Node coordinator/);
    } finally {
      killSpawned(second.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('a seal left behind by a hand-deleted node_modules does not vouch for the missing tree', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const first = runBootstrap(root, data, ws);
    killSpawned(first.stderr ?? '');
    assert.equal(first.status, 0, `first bootstrap failed:\n${first.stdout}\n${first.stderr}`);

    // A sealed build whose tree isn't there. Reading the seal without
    // checking the tree would take the fast path and spawn straight into a
    // MODULE_NOT_FOUND crash loop.
    const gutted = publishedBuild(data);
    rmSync(join(publishedDir(data), 'node_modules'), { recursive: true, force: true });

    const second = runBootstrap(root, data, ws);
    try {
      assert.equal(
        second.status,
        0,
        `second bootstrap failed:\n${second.stdout}\n${second.stderr}`
      );
      assert.match(second.stderr, /spawned Node coordinator/);
      assert.notEqual(publishedBuild(data), gutted, 'a new build replaces the gutted one');
      assert.ok(existsSync(join(publishedDir(data), 'node_modules')));
      assert.equal(sealedAbi(publishedDir(data)), RUNNING_ABI);
    } finally {
      killSpawned(second.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('STAGE 2: a src/ change with no package.json change still rebuilds dist/', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const first = runBootstrap(root, data, ws);
    killSpawned(first.stderr ?? '');
    assert.equal(first.status, 0, `first bootstrap failed:\n${first.stdout}\n${first.stderr}`);
    assert.match(first.stderr, /building src\//);

    // A plugin update that touches src/ without bumping the version — the
    // same shape as the ABI bug: package.json is a proxy, and keying only on
    // it serves the OLD dist/ forever.
    writeFileSync(
      join(root, 'src', 'coordinator.ts'),
      `${HEALTHY_COORDINATOR_TS}const marker = "SECOND-REVISION";\nvoid marker;\n`
    );

    const second = runBootstrap(root, data, ws);
    try {
      assert.equal(
        second.status,
        0,
        `second bootstrap failed:\n${second.stdout}\n${second.stderr}`
      );
      assert.match(second.stderr, /building src\//);
      assert.doesNotMatch(second.stderr, /installing Node deps/);
      assert.match(readFileSync(join(publishedDir(data), 'dist', 'coordinator.js'), 'utf8'), /SECOND-REVISION/);
    } finally {
      killSpawned(second.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('hook-client resolves the PLUGIN_DATA-provisioned Node client on a dist-less package', () => {
  const root = mkdtempSync(join(tmpdir(), 'provision-root-'));
  const { data, ws, cleanup } = makeDirs();
  try {
    mkdirSync(join(root, 'bin'), { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'bin', 'hook-client'), join(root, 'bin', 'hook-client'));
    chmodSync(join(root, 'bin', 'hook-client'), 0o755);
    // What ensure-coordinator-node's provision leaves behind.
    mkdirSync(join(data, 'dist'), { recursive: true });
    writeFileSync(
      join(data, 'dist', 'hook_client.js'),
      'process.stdout.write(JSON.stringify({ marker: "data-client" }));\n'
    );

    const run = () =>
      spawnSync('bash', [join(root, 'bin', 'hook-client'), 'pre-read'], {
        cwd: ws,
        encoding: 'utf8',
        input: '{}',
        timeout: 30000,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: root,
          CLAUDE_PLUGIN_DATA: data,
        } as NodeJS.ProcessEnv,
      });

    // Marketplace shape: no ROOT dist → the DATA client is the only one.
    const viaData = run();
    assert.equal(viaData.status, 0);
    assert.match(viaData.stdout, /"marker":"data-client"/);

    // Dev-checkout shape: the package's own dist/ wins over the DATA copy.
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'hook_client.js'),
      'process.stdout.write(JSON.stringify({ marker: "root-client" }));\n'
    );
    const viaRoot = run();
    assert.equal(viaRoot.status, 0);
    assert.match(viaRoot.stdout, /"marker":"root-client"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('CLI shim resolves the PLUGIN_DATA-provisioned Node CLI on a dist-less package', () => {
  const root = mkdtempSync(join(tmpdir(), 'provision-root-'));
  const { data, ws, cleanup } = makeDirs();
  try {
    mkdirSync(join(root, 'bin'), { recursive: true });
    cpSync(
      join(PLUGIN_ROOT, 'bin', 'agent-coherence-status'),
      join(root, 'bin', 'agent-coherence-status')
    );
    chmodSync(join(root, 'bin', 'agent-coherence-status'), 0o755);
    mkdirSync(join(data, 'dist'), { recursive: true });
    writeFileSync(
      join(data, 'dist', 'cli_status.js'),
      'process.stdout.write("data-cli-status");\n'
    );

    const r = spawnSync('bash', [join(root, 'bin', 'agent-coherence-status')], {
      cwd: ws,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: data,
      } as NodeJS.ProcessEnv,
    });
    assert.equal(r.status, 0, `shim failed:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /data-cli-status/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

// ------------------------------------------------- npm-failure classification

/**
 * Drive the bootstrap with a stub `npm` earlier on PATH that fails with a
 * canned log. The script invokes npm exactly once, so this reaches the
 * install-failure branch and nothing else.
 */
/**
 * A stub `npm` that models prebuild-install's ACTUAL gating: its
 * `log.http(status, url)` line is emitted only when the caller raised the log
 * level (`log.js:14` reads `npm_config_loglevel`, which npm sets from
 * `--loglevel`). A stub that printed it unconditionally would let the real
 * script drop `--loglevel=http` and leave every status test green -- which is
 * exactly the hole this shape closes, since asking for the status is the only
 * thing the flag buys.
 */
function stubNpmScript(npmOutput: string, exitCode = 1): string {
  return (
    `#!/usr/bin/env bash\n` +
    `emit() { cat <<'AC_STUB_LOG'\n${npmOutput}\nAC_STUB_LOG\n}\n` +
    `case " $* " in\n` +
    `  *" --loglevel=http "*) emit ;;\n` +
    `  *) emit | grep -v 'prebuild-install http ' ;;\n` +
    `esac\n` +
    `exit ${exitCode}\n`
  );
}

function runBootstrapWithFailingNpm(root: string, data: string, ws: string, npmOutput: string) {
  const stubBin = mkdtempSync(join(tmpdir(), 'provision-npmstub-'));
  writeExecutable(join(stubBin, 'npm'), stubNpmScript(npmOutput));
  try {
    return spawnSync('bash', [join(root, 'bin', 'ensure-coordinator-node')], {
      cwd: ws,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: data,
      } as NodeJS.ProcessEnv,
    });
  } finally {
    rmSync(stubBin, { recursive: true, force: true });
  }
}

const GYP_TAIL = [
  'npm error gyp ERR! find Python checking Python explicitly set from NODE_GYP_FORCE_PYTHON',
  'npm error gyp ERR! find Python - process.env.NODE_GYP_FORCE_PYTHON is "/nonexistent"',
  'npm error gyp ERR! not ok',
].join('\n');

test('a successful install is not reported as failed when the filter eats every line', () => {
  // The pipeline's exit-status contract, isolated. npm exits 0 while `grep -v`
  // matches nothing and exits 1 -- so under `set -o pipefail` the PIPELINE's
  // status is 1, and reading `$?` instead of `PIPESTATUS[0]` would turn a
  // clean install into "npm install failed". Every other stub in this file
  // exits non-zero, so this inversion is otherwise only covered by accident.
  //
  // The script still exits non-zero afterwards, because the stub installs no
  // real addon and the install-time verification catches that. What this
  // pins is the reason: the npm step must not be blamed.
  const root = makeStubRoot({});
  const { data, ws, cleanup } = makeDirs();
  const stubBin = mkdtempSync(join(tmpdir(), 'provision-npmstub-'));
  const onlyFilteredLines = [
    'npm http cache a@https://registry.npmjs.org/a 3ms (cache hit)',
    'npm http fetch GET 200 https://registry.npmjs.org/b 7ms',
  ].join('\n');
  writeExecutable(join(stubBin, 'npm'), stubNpmScript(onlyFilteredLines, 0));
  try {
    const r = spawnSync('bash', [join(root, 'bin', 'ensure-coordinator-node')], {
      cwd: ws,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: data,
      } as NodeJS.ProcessEnv,
    });
    const err = r.stderr ?? '';
    assert.doesNotMatch(
      err,
      /npm install failed/,
      'npm exited 0; the filter exiting 1 must not be read as the install failing'
    );
    // And no cause line, since there was no npm failure to classify.
    assert.doesNotMatch(err, /agent-coherence: cause:/);
  } finally {
    rmSync(stubBin, { recursive: true, force: true });
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry chatter is filtered from the display but kept for classification', () => {
  // --loglevel=http is what surfaces the asset fetch's status, and it also
  // makes npm log one line per package: 148 lines / 16KB warm and 298 / 31KB
  // cold on this repo's own tree. This script's stdout is a SessionStart
  // hook's stdout, so unfiltered that lands in the model's context at several
  // times the 10,000-byte ceiling and would evict the diagnostic it came for.
  // The filter is on the DISPLAY only; the captured log keeps everything,
  // which is why the classifier below still sees the 503.
  const root = makeStubRoot({});
  const { data, ws, cleanup } = makeDirs();
  const stubBin = mkdtempSync(join(tmpdir(), 'provision-npmstub-'));
  const chatter = Array.from(
    { length: 40 },
    (_, i) => `npm http cache pkg${i}@https://registry.npmjs.org/pkg${i} 3ms (cache hit)`
  ).join('\n');
  writeExecutable(
    join(stubBin, 'npm'),
    stubNpmScript(
      `${chatter}\n` +
        `npm http fetch GET 200 https://registry.npmjs.org/other 12ms\n` +
        `npm error prebuild-install http 503 https://github.com/x/a.tar.gz\n` +
        `npm error prebuild-install warn install No prebuilt binaries found (target=${process.versions.node} runtime=node arch=x64 libc= platform=linux)`
    )
  );
  try {
    const r = spawnSync('bash', [join(root, 'bin', 'ensure-coordinator-node')], {
      cwd: ws,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: data,
      } as NodeJS.ProcessEnv,
    });
    const shown = (r.stdout ?? '') + (r.stderr ?? '');
    assert.doesNotMatch(shown, /npm http cache pkg0@/, 'registry chatter must not reach the display');
    assert.doesNotMatch(shown, /npm http fetch GET 200/, 'successful registry fetches must not either');
    // Kept: npm prefixes prebuild-install's lines `npm error `, not `npm http `.
    assert.match(shown, /prebuild-install http 503/, "prebuild-install's own lines must survive the filter");
    // And the classifier read the status out of the captured log.
    assert.match(shown, /server said 503/);
  } finally {
    rmSync(stubBin, { recursive: true, force: true });
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('npm-failure hint says so when it could not capture the output at all', () => {
  // With TMPDIR pointing at a nonexistent directory, mktemp fails, the log is
  // never written and every classifier branch is skipped. The message must
  // say that rather than reporting "no recognised cause in the npm output
  // above" -- which claims an examination that never happened, the same class
  // of misdirection the classifier exists to remove.
  const root = makeStubRoot({});
  const { data, ws, cleanup } = makeDirs();
  const stubBin = mkdtempSync(join(tmpdir(), 'provision-npmstub-'));
  writeExecutable(join(stubBin, 'npm'), `#!/usr/bin/env bash\necho "npm error boom"\nexit 1\n`);
  try {
    const r = spawnSync('bash', [join(root, 'bin', 'ensure-coordinator-node')], {
      cwd: ws,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        TMPDIR: join(ws, 'no', 'such', 'dir'),
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: data,
      } as NodeJS.ProcessEnv,
    });
    assert.equal(r.status, 1, 'a failed install must still exit 1 without a capture');
    assert.match(r.stderr ?? '', /could not be captured/);
    assert.doesNotMatch(r.stderr ?? '', /no recognised cause in the npm output above/);
  } finally {
    rmSync(stubBin, { recursive: true, force: true });
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('npm-failure hint DISCRIMINATES a fetch flake from a missing prebuilt', () => {
  // Both failures end in the SAME node-gyp trace, because better-sqlite3
  // compiles from source whenever it cannot place a prebuilt binary for any
  // reason. The old hint asserted the first explanation unconditionally, so
  // a dropped connection read as "your Node version is unsupported" and sent
  // the reader to change Node. Observed for real on 2026-09-20 (CI job
  // "Zero-Python install (Node 24)"), where the only discriminating line was
  // `prebuild-install warn install read ECONNRESET` and a rerun went green.
  const cases: Array<{ name: string; npm: string; expect: RegExp; reject: RegExp }> = [
    {
      // DEFENSIVE branch: `target=` disagrees with the running major. Stage 0
      // rejects an unsupported major before the install runs, so this should
      // be unreachable; the branch exists so a future Stage-0 change cannot
      // silently turn it into the case below.
      name: 'target disagrees with the running major (defensive)',
      npm: `npm error prebuild-install warn install No prebuilt binaries found (target=23.0.0 runtime=node arch=x64 libc= platform=linux)\n${GYP_TAIL}`,
      expect: /switch Node majors/,
      reject: /transient: RETRY/,
    },
    {
      // A non-200 that IS worth retrying. prebuild-install collapses every
      // non-200 into "No prebuilt binaries found" (download.js:56 calls
      // onerror() with no argument), so without the status this reads as a
      // possibly-permanent platform gap -- the exact over-claim the status
      // line exists to remove.
      name: 'transient 503 on the asset fetch',
      npm:
        `npm error prebuild-install http 503 https://github.com/x/releases/download/v1/a.tar.gz\n` +
        `npm error prebuild-install warn install No prebuilt binaries found ` +
        `(target=${process.versions.node} runtime=node arch=x64 libc= platform=linux)\n${GYP_TAIL}`,
      expect: /server said 503\.[\s\S]*transient: RETRY/,
      reject: /no prebuilt is published/,
    },
    {
      // Not every non-200 is retryable. A corporate proxy or firewall refusing
      // the release host returns 403, and telling that operator "transient:
      // RETRY" sends them round a loop that can never succeed. Only 5xx and
      // 429 are worth retrying.
      name: '403 — refused, not transient',
      npm:
        `npm error prebuild-install http 403 https://github.com/x/releases/download/v1/a.tar.gz\n` +
        `npm error prebuild-install warn install No prebuilt binaries found ` +
        `(target=${process.versions.node} runtime=node arch=x64 libc= platform=linux)\n${GYP_TAIL}`,
      expect: /refused — the server said 403/,
      reject: /transient: RETRY/,
    },
    {
      // 404 means the asset is not there. NOT stated as permanent: a release
      // rollout can 404 mid-publish, an unsynced binary-host mirror 404s, and
      // blocking proxies 404 disallowed hosts.
      name: '404 — asset not published for this platform',
      npm:
        `npm error prebuild-install http 404 https://github.com/x/releases/download/v1/a.tar.gz\n` +
        `npm error prebuild-install warn install No prebuilt binaries found ` +
        `(target=${process.versions.node} runtime=node arch=x64 libc= platform=linux)\n${GYP_TAIL}`,
      expect: /no prebuilt is published for this platform/,
      reject: /transient: RETRY/,
    },
    {
      // THE REACHABLE ONE, and the reason this whole block was wrong.
      // `prebuild-install` emits "No prebuilt binaries found" for ANY non-200
      // response, not just a missing ABI: download.js does
      // `if (res.statusCode !== 200) return onerror()` with no argument, and
      // `onerror` falls through to `error.noPrebuilts(opts)`. So a 404 or a
      // 503 from the release CDN lands here with `target=` equal to the
      // running major -- which Stage 0 has already guaranteed is supported.
      // Telling that operator to switch Node majors is impossible advice.
      name: 'supported major, prebuilt could not be placed',
      npm:
        `npm error prebuild-install warn install No prebuilt binaries found ` +
        `(target=${process.versions.node} runtime=node arch=x64 libc= platform=linux)\n${GYP_TAIL}`,
      expect: /could not be placed for this platform/,
      reject: /switch Node majors/,
    },
    {
      // ESTRICTALLOWSCRIPTS is a terminal npm error code, not a warning, so a
      // log carrying it is that failure whatever prebuild-install logged on
      // the way. Reachable with more than one native dependency.
      name: 'allowScripts block wins over a transport warn',
      npm:
        `npm error prebuild-install warn install read ECONNRESET\n` +
        `npm error code ESTRICTALLOWSCRIPTS\nnpm error Cannot run script`,
      expect: /allowScripts entry/,
      reject: /transient: RETRY/,
    },
    {
      name: 'transient fetch failure',
      npm: `npm error prebuild-install warn install read ECONNRESET\n${GYP_TAIL}`,
      expect: /transient: RETRY/,
      reject: /retrying will not help/,
    },
    {
      name: 'npm 11 blocked the install script',
      npm: 'npm error code ESTRICTALLOWSCRIPTS\nnpm error Cannot run script',
      expect: /allowScripts entry/,
      reject: /prebuilt binary could not be DOWNLOADED/,
    },
    {
      name: 'unrecognised',
      npm: 'npm error ENOSPC no space left on device',
      expect: /no recognised cause/,
      reject: /cause: /,
    },
  ];

  for (const c of cases) {
    const root = makeStubRoot({});
    const { data, ws, cleanup } = makeDirs();
    try {
      const r = runBootstrapWithFailingNpm(root, data, ws, c.npm);
      assert.equal(r.status, 1, `${c.name}: a failed install must exit 1`);
      const err = r.stderr ?? '';
      assert.match(err, c.expect, `${c.name}: wrong or missing cause line`);
      assert.doesNotMatch(err, c.reject, `${c.name}: emitted a cause that contradicts the log`);
      // The remedy is the point of the hint: a reader who acts on the wrong
      // one either changes Node for nothing or retries forever.
      assert.match(err, /npm install failed/, `${c.name}: kept the headline`);
    } finally {
      cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// --- Python-backend hint: offered only while the workspace has no store -----
//
// Both refusals used to print `echo python > .coherence/coordinator_backend`
// unconditionally. On a store the Node coordinator created, the dispatcher
// honors that file verbatim and the Python coordinator fails closed on the
// Node ledger, so following the hint left the workspace with no coordinator.

const STORE_PRESENT_HINT =
  /state\.db exists, so select the Python backend only if the Python coordinator created it: it refuses a store the Node coordinator created, and no tool converts one\./;

/** Runs the bootstrap with the workspace pinned, so printed paths are exact. */
function runBootstrapIn(root: string, data: string, ws: string, pathPrefix?: string) {
  return spawnSync('bash', [join(root, 'bin', 'ensure-coordinator-node')], {
    cwd: ws,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH ?? ''}` : process.env.PATH,
      AGENT_COHERENCE_WORKSPACE: ws,
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_PLUGIN_DATA: data,
    } as NodeJS.ProcessEnv,
  });
}

function assertPythonBackendHint(stderr: string, ws: string, hadStore: boolean): void {
  const label = `hadStore=${hadStore}`;
  if (hadStore) {
    assert.match(stderr, STORE_PRESENT_HINT, label);
    assert.doesNotMatch(stderr, /echo python >/, label);
  } else {
    assert.ok(
      stderr.includes(
        `select the Python backend: mkdir -p '${ws}/.coherence' && echo python > '${ws}/.coherence/coordinator_backend'`,
      ),
      `${label}: missing the no-store hint:\n${stderr}`,
    );
    assert.doesNotMatch(stderr, STORE_PRESENT_HINT, label);
  }
}

test('STAGE 0: an unsupported Node major offers the Python backend only when the workspace has no store', () => {
  for (const hadStore of [false, true]) {
    const root = makeStubRoot({});
    const { data, ws, cleanup } = makeDirs();
    const stubBin = mkdtempSync(join(tmpdir(), 'provision-nodestub-'));
    writeExecutable(join(stubBin, 'node'), '#!/usr/bin/env bash\necho v23.11.0\n');
    try {
      if (hadStore) {
        mkdirSync(join(ws, '.coherence'), { recursive: true });
        writeFileSync(join(ws, '.coherence', 'state.db'), '');
      }
      const r = runBootstrapIn(root, data, ws, stubBin);
      assert.equal(r.status, 1, `expected the stage-0 refusal:\n${r.stderr}`);
      assert.match(r.stderr, /Node v23\.11\.0 is not supported by the Node coordinator/);
      assertPythonBackendHint(r.stderr, ws, hadStore);
    } finally {
      rmSync(stubBin, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      cleanup();
    }
  }
});

test('a build that emits no coordinator.js offers the Python backend only when the workspace has no store', () => {
  for (const hadStore of [false, true]) {
    const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
    // tsc succeeds but emits dist/not_the_entry.js, so the entry point is missing.
    renameSync(join(root, 'src', 'coordinator.ts'), join(root, 'src', 'not_the_entry.ts'));
    const { data, ws, cleanup } = makeDirs();
    try {
      if (hadStore) {
        mkdirSync(join(ws, '.coherence'), { recursive: true });
        writeFileSync(join(ws, '.coherence', 'state.db'), '');
      }
      const r = runBootstrapIn(root, data, ws);
      assert.equal(r.status, 1, `expected the missing-entry refusal:\n${r.stderr}`);
      assert.match(r.stderr, /dist\/coordinator\.js missing after provisioning/);
      assert.doesNotMatch(r.stderr, /spawned Node coordinator/);
      assertPythonBackendHint(r.stderr, ws, hadStore);
    } finally {
      rmSync(root, { recursive: true, force: true });
      cleanup();
    }
  }
});

/** The client a Python-backend start refreshes; any compilable body will do. */
const HOOK_CLIENT_TS = 'export const BUILT_BY_THIS_PACKAGE = true;\n';
const STALE_CLIENT_JS = '// a hook client an earlier plugin version built\n';

/** A package with a hook-client source, and PLUGIN_DATA holding a stale, older build of it. */
function stalePluginData(coordinatorTs: string): { root: string; data: string; ws: string; cleanup: () => void } {
  const root = makeStubRoot({ srcCoordinatorTs: coordinatorTs, withTsc: true });
  writeFileSync(join(root, 'src', 'hook_client.ts'), HOOK_CLIENT_TS);
  const dirs = makeDirs();
  mkdirSync(join(dirs.data, 'dist'), { recursive: true });
  for (const name of ['coordinator.js', 'hook_client.js']) {
    writeFileSync(join(dirs.data, 'dist', name), STALE_CLIENT_JS);
    // Older than the package's sources, as a plugin upgrade leaves it.
    utimesSync(join(dirs.data, 'dist', name), new Date('2026-01-01'), new Date('2026-01-01'));
  }
  return { root, ...dirs, cleanup: () => { rmSync(root, { recursive: true, force: true }); dirs.cleanup(); } };
}

function provisionOnly(root: string, data: string, ws: string) {
  return spawnSync('bash', [join(root, 'bin', 'ensure-coordinator-node')], {
    cwd: ws,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_PLUGIN_DATA: data,
      AGENT_COHERENCE_PROVISION_ONLY: '1',
    } as NodeJS.ProcessEnv,
  });
}

test('PROVISION ONLY: refreshes the client in PLUGIN_DATA and starts no coordinator (#289)', () => {
  // What a Python-backend session start runs, so that its hooks stop running
  // the Node client an earlier plugin installed.
  const { root, data, ws, cleanup } = stalePluginData(HEALTHY_COORDINATOR_TS);
  try {
    const r = provisionOnly(root, data, ws);
    try {
      assert.equal(r.status, 0, `provision-only failed:\n${r.stdout}\n${r.stderr}`);
      assert.match(readFileSync(join(publishedDir(data), 'dist', 'hook_client.js'), 'utf8'), /BUILT_BY_THIS_PACKAGE/);
      // The copy the earlier plugin version built is its own: sessions of
      // that version keep running it, and nothing here writes it (#295).
      assert.equal(readFileSync(join(data, 'dist', 'hook_client.js'), 'utf8'), STALE_CLIENT_JS);
      assert.doesNotMatch(r.stderr, /spawned Node coordinator/);
      assert.equal(existsSync(join(ws, '.coherence', 'server.pid')), false, 'no coordinator started');
      assert.equal(existsSync(join(ws, '.coherence', 'coordinator_backend')), false, 'no backend stamp');
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    cleanup();
  }
});

test('STAGE 2: a build that fails leaves the last working build in PLUGIN_DATA (#289)', () => {
  // Every workspace's hooks run this one copy, so a failed rebuild must not
  // leave them with none.
  const { root, data, ws, cleanup } = stalePluginData(HEALTHY_COORDINATOR_TS);
  try {
    const good = provisionOnly(root, data, ws);
    assert.equal(good.status, 0, `the first build failed:\n${good.stderr}`);
    const published = publishedBuild(data);
    writeFileSync(join(root, 'src', 'coordinator.ts'), 'const broken: number = "not a number";\n');

    const r = provisionOnly(root, data, ws);
    assert.equal(r.status, 1, `expected the build to fail:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /tsc build failed; the previous build stays in place/);
    assert.equal(publishedBuild(data), published);
    assert.match(readFileSync(join(publishedDir(data), 'dist', 'hook_client.js'), 'utf8'), /BUILT_BY_THIS_PACKAGE/);
    assert.equal(readFileSync(join(data, 'dist', 'hook_client.js'), 'utf8'), STALE_CLIENT_JS);
    assert.deepEqual(readdirSync(join(data, 'builds')), [published], 'no unfinished build left behind');
    assert.equal(existsSync(join(data, 'dist.next')), false);
    assert.equal(existsSync(join(data, 'dist.old')), false);
  } finally {
    cleanup();
  }
});

// ----------------------------------- #295: readers while a session start provisions
//
// Every workspace's hooks, CLI shims and Node coordinators load from the one
// CLAUDE_PLUGIN_DATA, and Claude Code runs a session's SessionStart hooks at
// once, so provisioning always races readers starting up, and other session
// starts. These tests go through bin/hook-client, whatever layout the data
// directory has, with a stub npm that does what npm's reify does to a changed
// package: the installed copy goes, then the new one is unpacked.

/** A package whose hook client imports a package its install provides. */
function dependentPackageJson(version: string): string {
  return JSON.stringify({
    name: 'provision-stub',
    version,
    private: true,
    type: 'module',
    dependencies: { 'fake-dep': '1.0.0' },
  });
}

function dependentClientTs(version: string): string {
  return (
    '// @ts-ignore -- fake-dep ships no types; Node resolves it at run time.\n' +
    'import { ok } from "fake-dep";\n' +
    'declare const process: { stdout: { write(s: string): void } };\n' +
    `process.stdout.write(JSON.stringify({ ok, v: "${version}" }));\n`
  );
}

function setDependentVersion(root: string, version: string): void {
  writeFileSync(join(root, 'package.json'), dependentPackageJson(version));
  writeFileSync(join(root, 'src', 'hook_client.ts'), dependentClientTs(version));
}

/** A marketplace-shaped package (src/, no dist/) with the hook-client shim. */
function makeDependentRoot(version: string): string {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  cpSync(join(PLUGIN_ROOT, 'bin', 'hook-client'), join(root, 'bin', 'hook-client'));
  chmodSync(join(root, 'bin', 'hook-client'), 0o755);
  setDependentVersion(root, version);
  return root;
}

/**
 * A stub `npm install`. It records each run and any two runs at once, removes
 * fake-dep from the directory it runs in, waits until $NPM_SIGNAL/release
 * exists (and $NPM_HOLD_S more), then unpacks fake-dep there, unless
 * $NPM_SKIP_UNPACK is set. With $NPM_SLEEPER set it first leaves behind a
 * process in a group of its own, as an npm child that outlives a killed start
 * would be. Anything other than an install with $NPM_SIGNAL set, such as
 * writeExecutable's warm-up run, does nothing.
 */
const REIFY_NPM =
  '#!/usr/bin/env bash\n' +
  '[ "${1:-}" = install ] && [ -n "${NPM_SIGNAL:-}" ] || exit 0\n' +
  'mkdir "$NPM_SIGNAL/inside" 2>/dev/null || echo overlap >>"$NPM_SIGNAL/overlaps"\n' +
  'echo "$PWD" >>"$NPM_SIGNAL/entries"\n' +
  'if [ -n "${NPM_SLEEPER:-}" ]; then\n' +
  '  perl -e \'setpgrp(0, 0); sleep 60\' </dev/null >/dev/null 2>&1 &\n' +
  '  echo "$!" >"$NPM_SIGNAL/sleeper.pid"\n' +
  'fi\n' +
  'rm -rf node_modules/fake-dep\n' +
  ': >"$NPM_SIGNAL/entered"\n' +
  'for _ in $(seq 1 1200); do [ -e "$NPM_SIGNAL/release" ] && break; sleep 0.05; done\n' +
  '[ -n "${NPM_HOLD_S:-}" ] && sleep "$NPM_HOLD_S"\n' +
  'if [ -z "${NPM_SKIP_UNPACK:-}" ]; then\n' +
  '  mkdir -p node_modules/fake-dep\n' +
  '  printf \'%s\\n\' \'{"name":"fake-dep","version":"1.0.0","type":"module","main":"index.js"}\' >node_modules/fake-dep/package.json\n' +
  '  printf \'%s\\n\' \'export const ok = true;\' >node_modules/fake-dep/index.js\n' +
  'fi\n' +
  'rmdir "$NPM_SIGNAL/inside" 2>/dev/null\n' +
  'exit 0\n';

interface ProvisionRig {
  root: string;
  data: string;
  ws: string;
  signal: string;
  env: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
  cleanup: () => void;
}

function provisionRig(version: string): ProvisionRig {
  const root = makeDependentRoot(version);
  const { data, ws, cleanup } = makeDirs();
  const stubBin = mkdtempSync(join(tmpdir(), 'provision-npmstub-'));
  const signal = mkdtempSync(join(tmpdir(), 'provision-signal-'));
  writeExecutable(join(stubBin, 'npm'), REIFY_NPM);
  return {
    root,
    data,
    ws,
    signal,
    env: (extra = {}) =>
      ({
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: data,
        AGENT_COHERENCE_PROVISION_ONLY: '1',
        NPM_SIGNAL: signal,
        ...extra,
      }) as NodeJS.ProcessEnv,
    cleanup: () => {
      for (const dir of [stubBin, signal, root]) rmSync(dir, { recursive: true, force: true });
      cleanup();
    },
  };
}

function provisionNow(rig: ProvisionRig, extra: Record<string, string> = {}) {
  return spawnSync('bash', [join(rig.root, 'bin', 'ensure-coordinator-node')], {
    cwd: rig.ws,
    encoding: 'utf8',
    timeout: 120000,
    env: rig.env(extra),
  });
}

function provisionLater(rig: ProvisionRig, extra: Record<string, string> = {}, detached = false) {
  const child = spawn('bash', [join(rig.root, 'bin', 'ensure-coordinator-node')], {
    cwd: rig.ws,
    env: rig.env(extra),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdout!.resume();
  const exited = new Promise<{ status: number | null; stderr: string }>((resolve) =>
    child.once('exit', (status) => resolve({ status, stderr }))
  );
  return { child, exited, stderr: () => stderr };
}

async function waitUntil(what: string, check: () => boolean, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** What the hook client prints for a pre-edit, run the way Claude Code runs it. */
function runHookClient(rig: ProvisionRig) {
  return spawnSync('bash', [join(rig.root, 'bin', 'hook-client'), 'pre-edit'], {
    cwd: rig.ws,
    encoding: 'utf8',
    input: '{}',
    timeout: 30000,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: rig.root, CLAUDE_PLUGIN_DATA: rig.data } as NodeJS.ProcessEnv,
  });
}

async function waitForPath(path: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('#295: a hook that starts while a session start installs an upgrade runs the client published before', async () => {
  const rig = provisionRig('0.0.1');
  try {
    writeFileSync(join(rig.signal, 'release'), '');
    const first = provisionNow(rig);
    assert.equal(first.status, 0, `first provision failed:\n${first.stderr}`);
    assert.equal(runHookClient(rig).stdout, '{"ok":true,"v":"0.0.1"}');

    // A plugin upgrade: a new package.json and new sources. Its install now
    // blocks with fake-dep removed, as npm's reify leaves a changed package.
    setDependentVersion(rig.root, '0.0.2');
    rmSync(join(rig.signal, 'release'));
    rmSync(join(rig.signal, 'entered'));
    const upgrade = provisionLater(rig);
    await waitForPath(join(rig.signal, 'entered'));
    const during = runHookClient(rig);
    writeFileSync(join(rig.signal, 'release'), '');
    const done = await upgrade.exited;

    assert.equal(during.status, 0, `a hook failed while the upgrade installed:\n${during.stderr}`);
    assert.equal(during.stdout, '{"ok":true,"v":"0.0.1"}', 'the hook ran a whole client: the one published before');
    assert.equal(done.status, 0, `the upgrade failed:\n${done.stderr}`);
    assert.equal(runHookClient(rig).stdout, '{"ok":true,"v":"0.0.2"}', 'the upgrade is published once it is whole');
  } finally {
    rig.cleanup();
  }
});

test('#295: two session starts at once after an upgrade install and build one at a time, and both succeed', async () => {
  const rig = provisionRig('0.0.1');
  try {
    writeFileSync(join(rig.signal, 'release'), '');
    const first = provisionNow(rig);
    assert.equal(first.status, 0, `first provision failed:\n${first.stderr}`);
    rmSync(join(rig.signal, 'entries'));

    // Two session starts (two workspaces, or a Node and a Python one) after
    // the upgrade, each install held open long enough to overlap.
    setDependentVersion(rig.root, '0.0.2');
    const a = provisionLater(rig, { NPM_HOLD_S: '1.5' });
    const b = provisionLater(rig, { NPM_HOLD_S: '1.5' });
    const [doneA, doneB] = await Promise.all([a.exited, b.exited]);

    assert.equal(existsSync(join(rig.signal, 'overlaps')), false, 'two npm installs ran at once');
    assert.equal(
      readFileSync(join(rig.signal, 'entries'), 'utf8').trim().split('\n').length,
      1,
      'the start that waited found the upgrade already done'
    );
    assert.equal(doneA.status, 0, `start A failed:\n${doneA.stderr}`);
    assert.equal(doneB.status, 0, `start B failed:\n${doneB.stderr}`);
    const after = runHookClient(rig);
    assert.equal(after.status, 0, `the hook failed after both starts:\n${after.stderr}`);
    assert.equal(after.stdout, '{"ok":true,"v":"0.0.2"}');
  } finally {
    rig.cleanup();
  }
});

// ------------------------------------------- #295: the provisioning lock and builds

/** The build directories under PLUGIN_DATA, sorted. */
function buildNames(data: string): string[] {
  return existsSync(join(data, 'builds')) ? readdirSync(join(data, 'builds')).sort() : [];
}

test('LOCK: a start that waited for another makes no build of its own', async () => {
  const rig = provisionRig('0.0.1');
  try {
    writeFileSync(join(rig.signal, 'release'), '');
    assert.equal(provisionNow(rig).status, 0);
    setDependentVersion(rig.root, '0.0.2');
    rmSync(join(rig.signal, 'release'));
    rmSync(join(rig.signal, 'entered'));
    const a = provisionLater(rig);
    await waitForPath(join(rig.signal, 'entered'));
    const b = provisionLater(rig);
    await waitUntil('start B to wait for the lock', () => /another session start is provisioning/.test(b.stderr()));
    writeFileSync(join(rig.signal, 'release'), '');
    const [doneA, doneB] = await Promise.all([a.exited, b.exited]);
    assert.equal(doneA.status, 0, doneA.stderr);
    assert.equal(doneB.status, 0, doneB.stderr);
    assert.match(doneB.stderr, /another session start is provisioning .*; waiting up to 120s/);
    // The 0.0.1 build, kept as the one retired last, and the one 0.0.2 build.
    assert.equal(buildNames(rig.data).length, 2, `builds: ${buildNames(rig.data).join(', ')}`);
    assert.equal(runHookClient(rig).stdout, '{"ok":true,"v":"0.0.2"}');
  } finally {
    rig.cleanup();
  }
});

test('LOCK: a start that cannot get the lock in time builds nothing, and says what it runs instead', async () => {
  const rig = provisionRig('0.0.1');
  let holder: Awaited<ReturnType<typeof holdPidFileLock>> | undefined;
  try {
    writeFileSync(join(rig.signal, 'release'), '');
    assert.equal(provisionNow(rig).status, 0);
    const published = publishedBuild(rig.data);
    setDependentVersion(rig.root, '0.0.2');
    holder = await holdPidFileLock(join(rig.data, '.provision.lock'));

    // A Python-backend refresh: nothing built for its key, so it stops.
    // Zero-padded, as an operator may write it: decimal, not octal.
    const refresh = provisionNow(rig, { AGENT_COHERENCE_PROVISION_WAIT_S: '08' });
    assert.equal(refresh.status, 1, refresh.stderr);
    assert.match(refresh.stderr, /held .*\.provision\.lock for 8s and no build for this package and Node .* is ready/);
    assert.deepEqual(buildNames(rig.data), [published], 'it wrote nothing');

    // A coordinator start: the published build was made for this ABI, so it
    // spawns from that one rather than wait or race the holder, and says that
    // the coordinator keeps that older build until it is stopped.
    const start = provisionNow(rig, { AGENT_COHERENCE_PROVISION_WAIT_S: '1', AGENT_COHERENCE_PROVISION_ONLY: '' });
    try {
      assert.equal(start.status, 0, start.stderr);
      assert.match(start.stderr, new RegExp(`this session uses the build published before it \\(${published}\\)`));
      assert.match(start.stderr, /keeps it until it stops: once that start has finished, stop it \(kill "\$\(head -n 1 '.*server\.pid'\)"\)/);
      assert.match(start.stderr, /spawned Node coordinator/);
      assert.equal(publishedBuild(rig.data), published);
      assert.equal(readFileSync(join(rig.ws, '.coherence', 'coordinator_backend'), 'utf8').trim(), 'node');
    } finally {
      killSpawned(start.stderr ?? '');
    }
  } finally {
    if (holder) await killAndWait(holder);
    rig.cleanup();
  }
});

for (const kill of ['SIGKILL', 'SIGTERM then SIGKILL'] as const) {
  test(`LOCK: a provisioner killed mid-install (${kill}) frees the lock and leaves the published build as it was`, async () => {
    const rig = provisionRig('0.0.1');
    let sleeper: number | undefined;
    try {
      writeFileSync(join(rig.signal, 'release'), '');
      assert.equal(provisionNow(rig).status, 0);
      const published = publishedBuild(rig.data);
      setDependentVersion(rig.root, '0.0.2');
      rmSync(join(rig.signal, 'release'));
      rmSync(join(rig.signal, 'entered'));
      const killed = provisionLater(rig, { NPM_SLEEPER: '1' }, true);
      await waitForPath(join(rig.signal, 'entered'));
      sleeper = Number(readFileSync(join(rig.signal, 'sleeper.pid'), 'utf8'));
      // Claude Code's time box signals the hook's whole process group: SIGTERM,
      // then SIGKILL 1.5 s later.
      if (kill === 'SIGTERM then SIGKILL') {
        process.kill(-killed.child.pid!, 'SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      try {
        process.kill(-killed.child.pid!, 'SIGKILL');
      } catch {
        // the group is already gone
      }
      await killed.exited;
      assert.equal(publishedBuild(rig.data), published);
      assert.equal(runHookClient(rig).stdout, '{"ok":true,"v":"0.0.1"}');
      assert.doesNotThrow(() => process.kill(sleeper!, 0), "npm's child outside the group outlived the kill");

      rmSync(join(rig.signal, 'inside'), { recursive: true, force: true });
      writeFileSync(join(rig.signal, 'release'), '');
      const next = provisionNow(rig, { AGENT_COHERENCE_PROVISION_WAIT_S: '5' });
      assert.equal(next.status, 0, next.stderr);
      assert.doesNotMatch(next.stderr, /waiting/, 'nothing still held the lock, not even the surviving child');
      assert.equal(runHookClient(rig).stdout, '{"ok":true,"v":"0.0.2"}');
      // On SIGTERM the EXIT trap removes the unfinished build; after a bare
      // SIGKILL it stays, never published, until a later collection past its hour.
      assert.equal(buildNames(rig.data).length, kill === 'SIGKILL' ? 3 : 2, buildNames(rig.data).join(', '));
    } finally {
      if (sleeper !== undefined) {
        try {
          process.kill(sleeper, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      rig.cleanup();
    }
  });
}

test('LOCK: the provisioning lock is closed on each child or ( subshell ), never on a { group } or a function call', () => {
  // bash 3.2 (macOS /bin/bash) runs `{ cmd; } 9>&-` and `func 9>&-` with fd 9
  // saved on another descriptor that every command inside inherits, so the
  // lock outlives a provisioner killed mid-install in any child npm leaves
  // running. `cmd 9>&-`, `( cmd ) 9>&-` and `(exec 9>&-; cmd)` do close it.
  const script = readFileSync(join(PLUGIN_ROOT, 'bin', 'ensure-coordinator-node'), 'utf8');
  const functions = [...script.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\(\) \{/gm)].map((m) => m[1]!);
  assert.ok(functions.includes('copy_tree'), 'found the functions the script defines');
  const offenders = script.split('\n').flatMap((line, i) => {
    if (/^\s*#/.test(line) || !line.includes('9>&-')) return [];
    const group = /(?:^|[\s;])\}\s*9>&-/.test(line);
    const call = functions.some((name) => new RegExp(`(?:^|[\\s;&|!({])${name}(?:\\s[^;&|]*)?\\s9>&-`).test(line));
    return group || call ? [`bin/ensure-coordinator-node:${i + 1}: ${line.trim()}`] : [];
  });
  assert.deepEqual(
    offenders,
    [],
    'close fd 9 on the child itself or a ( subshell ): bash 3.2 keeps the provisioning lock open, on a saved copy of fd 9, for a { group } or a function call'
  );
});

test('LOCK: the coordinator a start spawns does not hold the provisioning lock', async () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrap(root, data, ws);
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /spawned Node coordinator/);
      // It runs for as long as the workspace is in use; holding the lock it
      // inherited would stop every later provision.
      await killAndWait(await holdPidFileLock(join(data, '.provision.lock')));
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('NO LOCK TOOL: two starts at once provision unlocked and still publish a whole build', async () => {
  // A PATH with every system tool except perl, flock(1) and lockf(1).
  const rig = provisionRig('0.0.1');
  const tools = mkdtempSync(join(tmpdir(), 'provision-nolock-'));
  try {
    // By name, not existsSync: where /bin is a link to /usr/bin each name comes
    // twice, and existsSync follows a dangling link to "absent".
    const linked = new Set<string>();
    for (const dir of ['/bin', '/usr/bin']) {
      for (const name of readdirSync(dir)) {
        if (/^(perl|flock$|lockf$)/.test(name) || linked.has(name)) continue;
        symlinkSync(join(dir, name), join(tools, name));
        linked.add(name);
      }
    }
    symlinkSync(process.execPath, join(tools, 'node'));
    const stubBin = rig.env().PATH!.split(':')[0]!;
    const path = `${stubBin}:${tools}`;
    writeFileSync(join(rig.signal, 'release'), '');
    const first = provisionNow(rig, { PATH: path });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /nothing here can lock .*; provisioning unlocked/);

    setDependentVersion(rig.root, '0.0.2');
    const a = provisionLater(rig, { PATH: path, NPM_HOLD_S: '1' });
    const b = provisionLater(rig, { PATH: path, NPM_HOLD_S: '1' });
    const [doneA, doneB] = await Promise.all([a.exited, b.exited]);
    assert.equal(doneA.status, 0, doneA.stderr);
    assert.equal(doneB.status, 0, doneB.stderr);
    assert.equal(runHookClient(rig).stdout, '{"ok":true,"v":"0.0.2"}');
  } finally {
    rmSync(tools, { recursive: true, force: true });
    rig.cleanup();
  }
});

test('LEGACY: a provision never writes the layout plugin versions 0.7.1 and earlier use', () => {
  const rig = provisionRig('0.0.1');
  try {
    const legacy: Record<string, string> = {
      'package.json': '{"name":"older"}\n',
      'package-lock.json': '{}\n',
      '.node-abi': '131\n',
      'tsconfig.json': '{}\n',
      'src/coordinator.ts': '// older\n',
      'dist/hook_client.js': '// the client an older version built\n',
      'node_modules/fake-dep/index.js': '// older\n',
    };
    const old = new Date('2026-01-01');
    for (const [rel, body] of Object.entries(legacy)) {
      mkdirSync(dirname(join(rig.data, rel)), { recursive: true });
      writeFileSync(join(rig.data, rel), body);
      utimesSync(join(rig.data, rel), old, old);
    }
    writeFileSync(join(rig.signal, 'release'), '');
    assert.equal(provisionNow(rig).status, 0);
    setDependentVersion(rig.root, '0.0.2');
    assert.equal(provisionNow(rig).status, 0);

    for (const [rel, body] of Object.entries(legacy)) {
      assert.equal(readFileSync(join(rig.data, rel), 'utf8'), body, rel);
      assert.equal(statSync(join(rig.data, rel)).mtimeMs, old.getTime(), `${rel} was rewritten`);
    }
    assert.deepEqual(readdirSync(join(rig.data, 'dist')), ['hook_client.js']);
    assert.equal(runHookClient(rig).stdout, '{"ok":true,"v":"0.0.2"}');
  } finally {
    rig.cleanup();
  }
});

test('GC: a publish removes builds no reader can still be loading, and keeps the rest', () => {
  const rig = provisionRig('0.0.1');
  try {
    writeFileSync(join(rig.signal, 'release'), '');
    assert.equal(provisionNow(rig).status, 0);
    const first = publishedBuild(rig.data);
    const builds = join(rig.data, 'builds');
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const fake = (name: string, opts: { sealed: boolean; retiredMinutesAgo?: number; ageMinutes: number }) => {
      mkdirSync(join(builds, name, 'node_modules'), { recursive: true });
      mkdirSync(join(builds, name, 'dist'), { recursive: true });
      writeFileSync(join(builds, name, 'dist', 'coordinator.js'), '');
      if (opts.sealed) writeFileSync(join(builds, name, '.ok'), `${RUNNING_ABI} x\n`);
      if (opts.retiredMinutesAgo !== undefined) {
        writeFileSync(join(builds, name, '.retired'), '');
        utimesSync(join(builds, name, '.retired'), ago(opts.retiredMinutesAgo), ago(opts.retiredMinutesAgo));
      }
      utimesSync(join(builds, name), ago(opts.ageMinutes), ago(opts.ageMinutes));
    };
    fake('retired-long-ago.aaaaaa', { sealed: true, retiredMinutesAgo: 120, ageMinutes: 180 });
    fake('retired-in-grace.bbbbbb', { sealed: true, retiredMinutesAgo: 5, ageMinutes: 180 });
    fake('unfinished-stale.cccccc', { sealed: false, ageMinutes: 120 });
    fake('unfinished-fresh.dddddd', { sealed: false, ageMinutes: 1 });
    // Finished builds nothing published or retired, as a start that lost a race
    // to publish leaves them: one sealed long ago, one sealed just now.
    fake('stray-old.eeeeee', { sealed: true, ageMinutes: 180 });
    utimesSync(join(builds, 'stray-old.eeeeee', '.ok'), ago(180), ago(180));
    fake('stray-fresh.ffffff', { sealed: true, ageMinutes: 1 });
    const freshOk = join(builds, 'stray-fresh.ffffff', '.ok');

    setDependentVersion(rig.root, '0.0.2');
    assert.equal(provisionNow(rig).status, 0);
    const second = publishedBuild(rig.data);
    assert.deepEqual(
      buildNames(rig.data),
      [first, second, 'retired-in-grace.bbbbbb', 'stray-fresh.ffffff', 'unfinished-fresh.dddddd'].sort()
    );
    // A stray's grace runs from when it was sealed, so it never passes for the
    // build retired last: the old one is gone, the fresh one kept.
    const freshRetired = join(builds, 'stray-fresh.ffffff', '.retired');
    assert.equal(statSync(freshRetired).mtimeMs, statSync(freshOk).mtimeMs);
  } finally {
    rig.cleanup();
  }
});

test('SHIMS: hook-client and the CLI shims run the build `current` names, then PLUGIN_DATA/dist', () => {
  const root = mkdtempSync(join(tmpdir(), 'provision-root-'));
  const { data, ws, cleanup } = makeDirs();
  try {
    mkdirSync(join(root, 'bin'), { recursive: true });
    for (const shim of ['hook-client', 'agent-coherence-status']) {
      cpSync(join(PLUGIN_ROOT, 'bin', shim), join(root, 'bin', shim));
      chmodSync(join(root, 'bin', shim), 0o755);
    }
    const put = (dir: string, marker: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'hook_client.js'), `process.stdout.write(${JSON.stringify(marker)});\n`);
      writeFileSync(join(dir, 'cli_status.js'), `process.stdout.write(${JSON.stringify(marker)});\n`);
    };
    put(join(data, 'dist'), 'legacy');
    put(join(data, 'builds', 'k1.aaaaaa', 'dist'), 'published');
    const run = (shim: string) =>
      spawnSync('bash', [join(root, 'bin', shim), 'pre-read'], {
        cwd: ws,
        encoding: 'utf8',
        input: '{}',
        timeout: 30000,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data } as NodeJS.ProcessEnv,
      }).stdout;

    // No build published yet: the copy an older version provisioned.
    assert.equal(run('hook-client'), 'legacy');
    assert.equal(run('agent-coherence-status'), 'legacy');
    writeFileSync(join(data, 'current'), 'k1.aaaaaa\n');
    assert.equal(run('hook-client'), 'published');
    assert.equal(run('agent-coherence-status'), 'published');
    // A line that is not a plain name inside builds/ is ignored.
    for (const line of ['../dist', '.hidden', '']) {
      writeFileSync(join(data, 'current'), `${line}\n`);
      assert.equal(run('hook-client'), 'legacy', `line ${JSON.stringify(line)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

// ------------------------------------------------------- #295: the seal and its checks

/** Provision with a coordinator start, then stop the coordinator it spawned. */
function provisionAndStop(rig: ProvisionRig) {
  const r = provisionNow(rig, { AGENT_COHERENCE_PROVISION_ONLY: '' });
  killSpawned(r.stderr ?? '');
  return r;
}

test('SELF-HEAL: a NODE_MODULE_VERSION crash of a build whose install does not load unseals it, so the next session reprovisions', () => {
  const rig = provisionRig('0.0.1');
  try {
    writeFileSync(join(rig.signal, 'release'), '');
    assert.equal(provisionAndStop(rig).status, 0);
    // The published build's install no longer loads here, and its coordinator
    // dies the way an ABI-stale addon makes it die.
    rmSync(join(publishedDir(rig.data), 'node_modules', 'fake-dep'), { recursive: true });
    writeFileSync(join(publishedDir(rig.data), 'dist', 'coordinator.js'), ABI_CRASH_COORDINATOR_TS);

    const r = provisionAndStop(rig);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /exited before it started serving/);
    // The seal vouched for a tree that cannot load. Removing it is what turns
    // "dead until the user figures it out" into one bad session: the next run
    // finds no finished build for its key and makes one.
    assert.match(r.stderr, /next session reprovisions/);
    assert.equal(existsSync(join(publishedDir(rig.data), '.ok')), false);
  } finally {
    rig.cleanup();
  }
});

test('SELF-HEAL: a stale NODE_MODULE_VERSION line in the shared log does not unseal a build that loads', () => {
  const rig = provisionRig('0.0.1');
  try {
    writeFileSync(join(rig.signal, 'release'), '');
    assert.equal(provisionAndStop(rig).status, 0);
    // coordinator.log is every workspace's: a line from another coordinator,
    // or an older crash, then an unrelated crash of this one.
    writeFileSync(join(rig.data, 'coordinator.log'), 'Error: ... NODE_MODULE_VERSION 131 ...\n', { flag: 'a' });
    writeFileSync(join(publishedDir(rig.data), 'dist', 'coordinator.js'), CRASHING_COORDINATOR_TS);

    const r = provisionAndStop(rig);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /exited before it started serving/);
    assert.doesNotMatch(r.stderr, /next session reprovisions/);
    assert.ok(existsSync(join(publishedDir(rig.data), '.ok')), 'a build whose install loads keeps its seal');
  } finally {
    rig.cleanup();
  }
});

test('SEAL: an install missing a declared package is never sealed, though the package sits in the legacy tree', () => {
  const rig = provisionRig('0.0.1');
  try {
    // The copy an older version installed: Node would resolve fake-dep from it.
    mkdirSync(join(rig.data, 'node_modules', 'fake-dep'), { recursive: true });
    writeFileSync(join(rig.data, 'node_modules', 'fake-dep', 'package.json'), '{"name":"fake-dep","main":"index.js"}\n');
    writeFileSync(join(rig.signal, 'release'), '');
    const r = provisionNow(rig, { NPM_SKIP_UNPACK: '1' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /npm install reported success but node_modules lacks a package package\.json declares/);
    assert.equal(existsSync(join(rig.data, 'current')), false, 'nothing published');
    assert.deepEqual(buildNames(rig.data), [], 'the unsealed build is removed');
  } finally {
    rig.cleanup();
  }
});

test('SEAL: a build whose install no longer loads is not installed over: the next build installs clean', () => {
  const rig = provisionRig('0.0.1');
  try {
    writeFileSync(join(rig.signal, 'release'), '');
    assert.equal(provisionNow(rig).status, 0);
    const broken = publishedBuild(rig.data);
    rmSync(join(publishedDir(rig.data), 'node_modules', 'fake-dep'), { recursive: true });
    writeFileSync(join(publishedDir(rig.data), 'node_modules', 'STALE-SENTINEL'), '');
    // New sources, the same package.json: the broken install would be this
    // build's starting point.
    writeFileSync(join(rig.root, 'src', 'hook_client.ts'), `${dependentClientTs('0.0.1')}// revised\n`);

    const r = provisionNow(rig);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /provisioned native addon does not load under Node .*; reinstalling/);
    assert.notEqual(publishedBuild(rig.data), broken);
    assert.ok(existsSync(join(publishedDir(rig.data), 'node_modules', 'fake-dep', 'package.json')));
    assert.equal(existsSync(join(publishedDir(rig.data), 'node_modules', 'STALE-SENTINEL')), false);
    assert.equal(runHookClient(rig).stdout, '{"ok":true,"v":"0.0.1"}');
  } finally {
    rig.cleanup();
  }
});
