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
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// The inline `declare` keeps the stub compilable with no @types/node in the
// stub's (empty) node_modules; the runtime global exists in Node regardless.
const HEALTHY_COORDINATOR_TS =
  'declare function setInterval(cb: () => void, ms: number): unknown;\nsetInterval(() => {}, 60_000);\n';
const CRASHING_COORDINATOR_TS = 'throw new Error("stub coordinator crash on boot");\n';
const HEALTHY_PREBUILT_JS = 'setInterval(() => {}, 60_000);\n';

// The exact crash a Node-major change produces once node_modules holds a
// binary built for the previous ABI — the failure this file's ABI-stamp
// tests exist to make self-healing.
const ABI_CRASH_COORDINATOR_TS =
  "throw new Error(\"The module '/x/better_sqlite3.node' was compiled against a " +
  'different Node.js version using NODE_MODULE_VERSION 131. This version of Node.js ' +
  'requires NODE_MODULE_VERSION 137.");\n';

/** The ABI the running node binds native addons to — what the stamp records. */
const RUNNING_ABI = process.versions.modules;
const ABI_STAMP = '.node-abi';

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
        existsSync(join(data, 'dist', 'coordinator.js')),
        'built entry must exist in PLUGIN_DATA'
      );
      const m = /spawned Node coordinator \(pid=(\d+)/.exec(r.stderr);
      assert.ok(m, `no spawn line in stderr:\n${r.stderr}`);
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

    const second = runBootstrap(root, data, ws);
    try {
      assert.equal(
        second.status,
        0,
        `second bootstrap failed:\n${second.stdout}\n${second.stderr}`
      );
      // Same package.json, same ABI, entry already built → no install, no
      // rebuild. The ABI key must not turn every session into a reinstall.
      assert.doesNotMatch(second.stderr, /installing Node deps/);
      assert.doesNotMatch(second.stderr, /building src\//);
      assert.doesNotMatch(second.stderr, /Node ABI changed/);
      assert.match(second.stderr, /spawned Node coordinator/);
      assert.equal(readFileSync(join(data, ABI_STAMP), 'utf8').trim(), RUNNING_ABI);
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
    assert.match(r.stderr, /exited immediately after spawn/);
    // The crash log tail is surfaced so the failure is diagnosable from the
    // hook output alone.
    assert.match(r.stderr, /stub coordinator crash on boot/);
    assert.doesNotMatch(r.stderr, /spawned Node coordinator/);
    // A FAILED boot must not stamp the workspace as node-backed.
    assert.equal(existsSync(join(ws, '.coherence', 'coordinator_backend')), false);
    // ...but a crash with no NODE_MODULE_VERSION in it is NOT an ABI problem,
    // so the ABI stamp must survive. Invalidating it on any crash would turn
    // an ordinary coordinator bug into a full npm reinstall every session.
    assert.equal(readFileSync(join(data, ABI_STAMP), 'utf8').trim(), RUNNING_ABI);
    assert.doesNotMatch(r.stderr, /next session reprovisions/);
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
        existsSync(join(data, 'dist', 'coordinator.js')),
        'mirrored entry must exist in PLUGIN_DATA'
      );
      assert.doesNotMatch(r.stderr, /building src\//);
      assert.match(r.stderr, /spawned Node coordinator/);
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

/** Run the bootstrap with `pathPrefix` ahead of the inherited PATH. */
function runBootstrapWithPath(root: string, data: string, ws: string, pathPrefix: string) {
  return spawnSync('bash', [join(root, 'bin', 'ensure-coordinator-node')], {
    cwd: ws,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      PATH: `${pathPrefix}:${process.env.PATH ?? ''}`,
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_PLUGIN_DATA: data,
    } as NodeJS.ProcessEnv,
  });
}

test('STAGE 0: the unsupported-Node refusal offers the Python backend only on a workspace with no state.db', () => {
  // A Node upgrade to an unsupported major hits this preflight on workspaces
  // the Node coordinator already serves. The Python coordinator fails closed
  // on a Node-created store and nothing converts one, so advising
  // `echo python > .coherence/coordinator_backend` there would leave the
  // workspace with no coordinator at all.
  const root = makeStubRoot({});
  const stubBin = mkdtempSync(join(tmpdir(), 'provision-nodestub-'));
  writeFileSync(join(stubBin, 'node'), '#!/bin/sh\necho v23.11.0\n');
  chmodSync(join(stubBin, 'node'), 0o755);
  const virgin = makeDirs();
  const established = makeDirs();
  try {
    const fresh = runBootstrapWithPath(root, virgin.data, virgin.ws, stubBin);
    assert.equal(fresh.status, 1, `expected the stage-0 refusal:\n${fresh.stdout}\n${fresh.stderr}`);
    assert.match(fresh.stderr, /Node v23\.11\.0 is not supported by the Node coordinator/);
    assert.match(
      fresh.stderr,
      /select the Python backend: echo python > \.coherence\/coordinator_backend/
    );

    mkdirSync(join(established.ws, '.coherence'), { recursive: true });
    writeFileSync(join(established.ws, '.coherence', 'state.db'), '');
    const r = runBootstrapWithPath(root, established.data, established.ws, stubBin);
    assert.equal(r.status, 1, `expected the stage-0 refusal:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /Node v23\.11\.0 is not supported by the Node coordinator/);
    assert.match(r.stderr, /Install Node 22 or 24 \(LTS\)\.$/m);
    assert.match(r.stderr, /refuses a Node-created store/);
    assert.doesNotMatch(r.stderr, /echo python|select the Python backend/);
    assert.equal(existsSync(join(established.ws, '.coherence', 'coordinator_backend')), false);
  } finally {
    rmSync(stubBin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    virgin.cleanup();
    established.cleanup();
  }
});

test('a missing built entry offers the Python-backend workaround only on a workspace with no state.db', () => {
  // tsc builds src/ cleanly, but the package has no coordinator.ts, so the
  // provision check finds no dist/coordinator.js. Same rule as stage 0: an
  // existing state.db may be Node-created, and the Python coordinator
  // refuses one.
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  rmSync(join(root, 'src', 'coordinator.ts'));
  writeFileSync(join(root, 'src', 'other.ts'), 'export {};\n');
  const virgin = makeDirs();
  const established = makeDirs();
  try {
    const fresh = runBootstrap(root, virgin.data, virgin.ws);
    assert.equal(fresh.status, 1, `expected loud failure:\n${fresh.stdout}\n${fresh.stderr}`);
    assert.match(
      fresh.stderr,
      /coordinator\.js missing after provisioning; coordinator will not start this session\. Next session retries\. \(Workaround: echo python > <workspace>\/\.coherence\/coordinator_backend to select the Python backend\.\)$/m
    );

    mkdirSync(join(established.ws, '.coherence'), { recursive: true });
    writeFileSync(join(established.ws, '.coherence', 'state.db'), '');
    const r = runBootstrap(root, established.data, established.ws);
    assert.equal(r.status, 1, `expected loud failure:\n${r.stdout}\n${r.stderr}`);
    assert.match(
      r.stderr,
      /coordinator\.js missing after provisioning; coordinator will not start this session\. Next session retries\.$/m
    );
    assert.doesNotMatch(r.stderr, /Workaround|echo python/);
    assert.doesNotMatch(r.stderr, /spawned Node coordinator/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    virgin.cleanup();
    established.cleanup();
  }
});

test('ABI STAMP: a successful provision records the running Node ABI', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrap(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      // process.versions.modules — NOT the Node version. A binary is bound to
      // the ABI, and two Node majors can share one (as 24 and 25 nearly did).
      assert.equal(readFileSync(join(data, ABI_STAMP), 'utf8').trim(), RUNNING_ABI);
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('REGRESSION: a Node-major change (stale ABI stamp) forces a CLEAN reinstall', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const first = runBootstrap(root, data, ws);
    killSpawned(first.stderr ?? '');
    assert.equal(first.status, 0, `first bootstrap failed:\n${first.stdout}\n${first.stderr}`);

    // Stand in for the tree a previous Node major left behind: node_modules
    // present, holding a binary compiled for ABI 131 (Node 23). The sentinel
    // is the load-bearing part — a plain `npm install` over this tree leaves
    // it untouched, because npm sees a satisfying version already installed,
    // which is exactly how the 0.3.1 -> 0.4.0 bump shipped a stale binary to
    // a Node 24 user. Only a teardown removes it.
    const sentinel = join(data, 'node_modules', 'STALE-ABI-131-ARTIFACT');
    mkdirSync(join(data, 'node_modules'), { recursive: true });
    writeFileSync(sentinel, 'compiled for NODE_MODULE_VERSION 131\n');
    writeFileSync(join(data, ABI_STAMP), '131\n');

    const second = runBootstrap(root, data, ws);
    try {
      assert.equal(
        second.status,
        0,
        `second bootstrap failed:\n${second.stdout}\n${second.stderr}`
      );
      assert.match(second.stderr, new RegExp(`Node ABI changed \\(131 -> ${RUNNING_ABI}\\)`));
      assert.match(second.stderr, /installing Node deps/);
      assert.equal(
        existsSync(sentinel),
        false,
        'stale node_modules must be torn down, not installed over'
      );
      assert.equal(readFileSync(join(data, ABI_STAMP), 'utf8').trim(), RUNNING_ABI);
      assert.match(second.stderr, /spawned Node coordinator/);
    } finally {
      killSpawned(second.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('a stamp left behind by a hand-deleted node_modules does not vouch for the missing tree', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const first = runBootstrap(root, data, ws);
    killSpawned(first.stderr ?? '');
    assert.equal(first.status, 0, `first bootstrap failed:\n${first.stdout}\n${first.stderr}`);

    // A CURRENT-ABI stamp over a tree that isn't there. Reading the stamp
    // without checking the tree would take the fast path and spawn straight
    // into a MODULE_NOT_FOUND crash loop.
    rmSync(join(data, 'node_modules'), { recursive: true, force: true });
    writeFileSync(join(data, ABI_STAMP), `${RUNNING_ABI}\n`);

    const second = runBootstrap(root, data, ws);
    try {
      assert.equal(
        second.status,
        0,
        `second bootstrap failed:\n${second.stdout}\n${second.stderr}`
      );
      assert.match(second.stderr, /spawned Node coordinator/);
      assert.equal(readFileSync(join(data, ABI_STAMP), 'utf8').trim(), RUNNING_ABI);
    } finally {
      killSpawned(second.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('SELF-HEAL: a NODE_MODULE_VERSION crash invalidates the stamp so the next session reprovisions', () => {
  const root = makeStubRoot({ srcCoordinatorTs: ABI_CRASH_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrap(root, data, ws);
    assert.equal(r.status, 1, `expected loud failure:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /exited immediately after spawn/);
    assert.doesNotMatch(r.stderr, /spawned Node coordinator/);
    // The stamp vouched for a tree that cannot load. Dropping it is what
    // turns "dead until the user figures it out" into one bad session: the
    // next run finds no stamp, probes, and reinstalls.
    assert.match(r.stderr, /next session reprovisions/);
    assert.equal(existsSync(join(data, ABI_STAMP)), false);
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
      assert.match(readFileSync(join(data, 'dist', 'coordinator.js'), 'utf8'), /SECOND-REVISION/);
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
  writeFileSync(join(stubBin, 'npm'), stubNpmScript(npmOutput));
  chmodSync(join(stubBin, 'npm'), 0o755);
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
  writeFileSync(join(stubBin, 'npm'), stubNpmScript(onlyFilteredLines, 0));
  chmodSync(join(stubBin, 'npm'), 0o755);
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
  writeFileSync(
    join(stubBin, 'npm'),
    stubNpmScript(
      `${chatter}\n` +
        `npm http fetch GET 200 https://registry.npmjs.org/other 12ms\n` +
        `npm error prebuild-install http 503 https://github.com/x/a.tar.gz\n` +
        `npm error prebuild-install warn install No prebuilt binaries found (target=${process.versions.node} runtime=node arch=x64 libc= platform=linux)`
    )
  );
  chmodSync(join(stubBin, 'npm'), 0o755);
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
  writeFileSync(join(stubBin, 'npm'), `#!/usr/bin/env bash\necho "npm error boom"\nexit 1\n`);
  chmodSync(join(stubBin, 'npm'), 0o755);
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
