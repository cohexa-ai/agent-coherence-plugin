/**
 * A local client sends nothing to a coordinator that is gone
 * (cohexa-ai/agent-coherence#503).
 *
 * A client finds the coordinator through the port in .coherence/server.pid and
 * sends the workspace secret with every request. Once the coordinator exits,
 * its port is free and any local process can bind it. So before each request a
 * local client checks that the pid file still names the coordinator it
 * resolved, and that this coordinator still holds the workspace lock (the
 * flock a start takes on server.pid). A real loopback listener stands in for
 * the coordinator, or for a stranger that took its port, and records each
 * bearer it is sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTrack, runUntrack } from '../cli.js';
import { linkRefusalMessage } from '../coherence_dir.js';
import { tryLockPidFile } from '../coordinator_lock.js';
import {
  CoordinatorDeparted,
  CoordinatorUnavailable,
  readBackendFromPidFile,
  readPortFromPidFile,
  requestJson,
  resolveEndpoint,
  type CoordinatorEndpoint,
} from '../hook_client_transport.js';
import { writeExecutable } from './executable_fixture.js';
import { killAndWait } from './pid_lock_fixture.js';

const SECRET = 's3cret-for-the-test';
const CLI_STATUS_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli_status.js');

interface Listener {
  port: number;
  /** The Authorization header of each request that arrived, in order. */
  seen: string[];
  close: () => Promise<void>;
}

/** Something listening on a port: a coordinator, or a stranger that bound the port a coordinator left. */
async function listen(): Promise<Listener> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? '');
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface Workspace {
  base: string;
  root: string;
  coherenceDir: string;
  pidFile: string;
  listener: Listener;
}

/** A workspace with a hook.secret and no server.pid yet, and a listener; both gone afterwards. */
function withWorkspace(run: (ws: Workspace) => Promise<void>): () => Promise<void> {
  return async () => {
    const base = mkdtempSync(join(tmpdir(), 'coordinator-pin-'));
    const root = join(base, 'ws');
    const coherenceDir = join(root, '.coherence');
    mkdirSync(coherenceDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(coherenceDir, 'hook.secret'), `${SECRET}\n`, { mode: 0o600 });
    const listener = await listen();
    try {
      await run({ base, root, coherenceDir, pidFile: join(coherenceDir, 'server.pid'), listener });
    } finally {
      await listener.close();
      rmSync(base, { recursive: true, force: true });
    }
  };
}

function pidLines(pid: number | string, port: number, backend?: string): string {
  return `${pid}\n${port}\n${backend === undefined ? '' : `backend=${backend}\n`}`;
}

/** Take the lock a running coordinator holds on `pidFile`; the function returned is that coordinator exiting. */
function hold(pidFile: string): () => void {
  const lock = tryLockPidFile(pidFile);
  if (lock.state !== 'held') throw new Error(`could not lock ${pidFile}: ${lock.state}`);
  return () => closeSync(lock.fd);
}

/** The pid of a process that has exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

/** A process this test starts, and kills, to stand for a Node coordinator's pid. */
function startSleeper(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
}

const post = (endpoint: CoordinatorEndpoint) => requestJson(endpoint, 'POST', '/hooks/x', {});
const get = (endpoint: CoordinatorEndpoint) => requestJson(endpoint, 'GET', '/status');

/** The message resolveEndpoint refuses `root` with. */
function refusalAtResolve(root: string): string {
  try {
    resolveEndpoint(root);
  } catch (err) {
    assert.ok(err instanceof CoordinatorUnavailable, `not CoordinatorUnavailable: ${String(err)}`);
    return err.message;
  }
  assert.fail('resolveEndpoint did not refuse');
}

/** A lock helper that says the file system cannot lock the file (exit 3). */
const CANNOT_LOCK = '#!/bin/sh\nexit 3\n';

/**
 * A lock helper that says another process holds the lock (exit 1) the first
 * time it probes, and that it got the lock (exit 0) every later time; run with
 * no arguments, as the warm-up runs it, it does nothing.
 */
const HELD_THEN_FREE =
  '#!/bin/sh\n[ "$#" -eq 0 ] && exit 0\n[ -e "$0.probed" ] && exit 0\n: > "$0.probed"\nexit 1\n';

/**
 * Run `run` with the lock probed through `script` as perl, the only helper on
 * PATH: the probe a host without O_SHLOCK makes.
 */
async function withLockHelper<T>(base: string, script: string, run: () => Promise<T>): Promise<T> {
  const helpers = join(base, 'helpers');
  mkdirSync(helpers, { recursive: true });
  writeExecutable(join(helpers, 'perl'), script);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const path = process.env.PATH;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  process.env.PATH = helpers;
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', platform);
    process.env.PATH = path;
  }
}

/** Asserts that `request` is refused unsent, for the reason `departure` gives. */
async function assertDeparted(request: Promise<unknown>, departure: string): Promise<void> {
  await assert.rejects(request, (err: unknown) => {
    assert.ok(err instanceof CoordinatorDeparted, `not CoordinatorDeparted: ${String(err)}`);
    assert.ok(err instanceof CoordinatorUnavailable);
    assert.equal(err.message, `${departure}; nothing was sent`);
    return true;
  });
}

test(
  'a running coordinator is reached',
  withWorkspace(async ({ root, pidFile, listener }) => {
    writeFileSync(pidFile, pidLines(process.pid, listener.port));
    const exit = hold(pidFile);
    try {
      assert.deepEqual(await post(resolveEndpoint(root)), { ok: true });
      assert.deepEqual(await get(resolveEndpoint(root)), { ok: true });
    } finally {
      exit();
    }
    assert.deepEqual(listener.seen, [`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
  })
);

test(
  'a coordinator that exited is refused at resolve, before its secret is sent',
  withWorkspace(async ({ root, pidFile, listener }) => {
    // Its pid file still names its port, where a stranger now listens.
    writeFileSync(pidFile, pidLines(process.pid, listener.port));
    assert.equal(
      refusalAtResolve(root),
      `no coordinator running for this workspace (${pidFile} names pid ${process.pid}, ` +
        'which no longer holds the workspace lock); start one'
    );
    assert.deepEqual(listener.seen, []);
  })
);

test(
  'a listener on the port after the coordinator exits receives nothing',
  withWorkspace(async ({ root, pidFile, listener }) => {
    writeFileSync(pidFile, pidLines(process.pid, listener.port));
    const exit = hold(pidFile);
    const endpoint = resolveEndpoint(root);
    exit();
    const gone = `the coordinator ${pidFile} names (pid ${process.pid}) no longer holds the workspace lock`;
    await assertDeparted(post(endpoint), gone);
    await assertDeparted(get(endpoint), gone);
    assert.deepEqual(listener.seen, []);
  })
);

test(
  'a new coordinator on the same port is treated as a new one',
  withWorkspace(async ({ root, pidFile, listener }) => {
    const { port } = listener;
    writeFileSync(pidFile, pidLines(process.pid, port));
    const exit = hold(pidFile);
    try {
      const endpoint = resolveEndpoint(root);
      writeFileSync(pidFile, pidLines(process.pid + 1, port));
      await assertDeparted(
        post(endpoint),
        `${pidFile} now names pid ${process.pid + 1} on port ${port}, ` +
          `not the coordinator this client resolved (pid ${process.pid}, port ${port})`
      );
    } finally {
      exit();
    }
    assert.deepEqual(listener.seen, []);
  })
);

test(
  'a coordinator that is stopping is refused',
  withWorkspace(async ({ root, pidFile, listener }) => {
    const { port } = listener;
    writeFileSync(pidFile, pidLines(process.pid, port));
    const exit = hold(pidFile);
    try {
      const endpoint = resolveEndpoint(root);
      // A stop rewrites the file to its pid alone before it lets go of the lock.
      writeFileSync(pidFile, `${process.pid}\n`);
      await assertDeparted(
        post(endpoint),
        `${pidFile} now names pid ${process.pid} on port null, ` +
          `not the coordinator this client resolved (pid ${process.pid}, port ${port})`
      );
    } finally {
      exit();
    }
    assert.deepEqual(listener.seen, []);
  })
);

test(
  'a pid file that disappeared cannot tell, so the request goes',
  withWorkspace(async ({ root, pidFile, listener }) => {
    writeFileSync(pidFile, pidLines(process.pid, listener.port));
    const exit = hold(pidFile);
    try {
      const endpoint = resolveEndpoint(root);
      unlinkSync(pidFile);
      assert.deepEqual(await post(endpoint), { ok: true });
    } finally {
      exit();
    }
    assert.equal(listener.seen.length, 1);
  })
);

test(
  'a server.pid replaced by a link after resolve is refused',
  withWorkspace(async ({ base, root, coherenceDir, pidFile, listener }) => {
    writeFileSync(pidFile, pidLines(process.pid, listener.port));
    const exit = hold(pidFile);
    try {
      const endpoint = resolveEndpoint(root);
      const elsewhere = join(base, 'elsewhere.pid');
      writeFileSync(elsewhere, pidLines(process.pid, listener.port));
      unlinkSync(pidFile);
      symlinkSync(elsewhere, pidFile);
      await assertDeparted(post(endpoint), linkRefusalMessage(pidFile, coherenceDir));
    } finally {
      exit();
    }
    assert.deepEqual(listener.seen, []);
  })
);

test(
  "a linked server.pid is refused at resolve, though the file it names is a running coordinator's",
  withWorkspace(async ({ base, root, coherenceDir, pidFile, listener }) => {
    const elsewhere = join(base, 'elsewhere.pid');
    writeFileSync(elsewhere, pidLines(process.pid, listener.port));
    const exit = hold(elsewhere);
    symlinkSync(elsewhere, pidFile);
    try {
      assert.equal(refusalAtResolve(root), linkRefusalMessage(pidFile, coherenceDir));
    } finally {
      exit();
    }
    assert.deepEqual(listener.seen, []);
  })
);

test(
  'a server.pid that is not a regular file is refused at resolve',
  withWorkspace(async ({ root, pidFile }) => {
    mkdirSync(pidFile);
    assert.equal(
      refusalAtResolve(root),
      `${pidFile} is not a regular file; restart the coordinator`
    );
  })
);

test(
  'a pid file that grows past any pid file after resolve is refused',
  withWorkspace(async ({ root, pidFile, listener }) => {
    writeFileSync(pidFile, pidLines(process.pid, listener.port));
    const exit = hold(pidFile);
    try {
      const endpoint = resolveEndpoint(root);
      appendFileSync(pidFile, '#'.repeat(4096));
      await assertDeparted(post(endpoint), `${pidFile} is larger than a pid file (4096 bytes)`);
    } finally {
      exit();
    }
    assert.deepEqual(listener.seen, []);
  })
);

test(
  'a server.pid replaced by a directory after resolve is refused',
  withWorkspace(async ({ root, pidFile, listener }) => {
    writeFileSync(pidFile, pidLines(process.pid, listener.port));
    const exit = hold(pidFile);
    try {
      const endpoint = resolveEndpoint(root);
      unlinkSync(pidFile);
      mkdirSync(pidFile);
      await assertDeparted(post(endpoint), `${pidFile} is no longer a regular file`);
    } finally {
      exit();
    }
    assert.deepEqual(listener.seen, []);
  })
);

test(
  'a .coherence replaced by a link after resolve is refused by name',
  withWorkspace(async ({ base, root, coherenceDir, pidFile, listener }) => {
    writeFileSync(pidFile, pidLines(process.pid, listener.port));
    const exit = hold(pidFile);
    try {
      const endpoint = resolveEndpoint(root);
      const moved = join(base, 'moved');
      renameSync(coherenceDir, moved);
      symlinkSync(moved, coherenceDir);
      await assertDeparted(post(endpoint), linkRefusalMessage(coherenceDir, coherenceDir));
    } finally {
      exit();
    }
    assert.deepEqual(listener.seen, []);
  })
);

test(
  'a Node coordinator that runs unlocked is judged by its pid',
  withWorkspace(async ({ root, pidFile, listener }) => {
    // Nothing holds the lock, so the pid decides: a live pid is reached, an
    // exited one is refused.
    writeFileSync(pidFile, pidLines(process.pid, listener.port, 'node'));
    assert.deepEqual(await post(resolveEndpoint(root)), { ok: true });
    const gone = await exitedPid();
    writeFileSync(pidFile, pidLines(gone, listener.port, 'node'));
    assert.equal(
      refusalAtResolve(root),
      `no coordinator running for this workspace (${pidFile} names pid ${gone}, ` +
        'which is no longer running); start one'
    );
    assert.equal(listener.seen.length, 1);
  })
);

test(
  'a Node coordinator that exits after resolve is named as no longer running',
  withWorkspace(async ({ root, pidFile, listener }) => {
    const child = startSleeper();
    let endpoint: CoordinatorEndpoint;
    try {
      writeFileSync(pidFile, pidLines(child.pid!, listener.port, 'node'));
      endpoint = resolveEndpoint(root);
    } finally {
      await killAndWait(child);
    }
    await assertDeparted(
      post(endpoint),
      `the coordinator ${pidFile} names (pid ${child.pid}) is no longer running`
    );
    assert.deepEqual(listener.seen, []);
  })
);

test(
  'a Node coordinator that removes its pid file is judged by its pid',
  withWorkspace(async ({ root, pidFile, listener }) => {
    // An unlocked Node coordinator removes server.pid when it stops. While its
    // pid runs a missing file cannot tell, and requests go.
    const child = startSleeper();
    let endpoint: CoordinatorEndpoint;
    try {
      writeFileSync(pidFile, pidLines(child.pid!, listener.port, 'node'));
      endpoint = resolveEndpoint(root);
      unlinkSync(pidFile);
      assert.deepEqual(await post(endpoint), { ok: true });
    } finally {
      await killAndWait(child);
    }
    await assertDeparted(
      post(endpoint),
      `the Node coordinator ${pidFile} named (pid ${child.pid}) is no longer running`
    );
    assert.equal(listener.seen.length, 1);
  })
);

test(
  'a Node pid this client may not signal counts as running',
  withWorkspace(async ({ root, pidFile, listener }) => {
    // EPERM shows a process exists: another user's, or this user's behind a
    // sandbox that denies signals. Here it is the only sign the pid lives.
    const pid = await exitedPid();
    writeFileSync(pidFile, pidLines(pid, listener.port, 'node'));
    const realKill = process.kill;
    process.kill = ((target: number, signal?: string | number) => {
      if (target === pid) throw Object.assign(new Error(`kill ${pid}: EPERM`), { code: 'EPERM' });
      return realKill.call(process, target, signal);
    }) as typeof process.kill;
    try {
      const endpoint = resolveEndpoint(root);
      assert.deepEqual(await post(endpoint), { ok: true });
      unlinkSync(pidFile);
      assert.deepEqual(await post(endpoint), { ok: true });
    } finally {
      process.kill = realKill;
    }
    assert.equal(listener.seen.length, 2);
  })
);

test(
  'a Node pid no process can have is not the coordinator',
  withWorkspace(async ({ root, pidFile, listener }) => {
    writeFileSync(pidFile, pidLines('1180591620717411303424', listener.port, 'node'));
    assert.match(refusalAtResolve(root), /, which is no longer running\); start one$/);
    assert.deepEqual(listener.seen, []);
  })
);

test(
  'a lock this host cannot probe cannot tell, so the coordinator is reached',
  withWorkspace(async ({ base, root, pidFile, listener }) => {
    // A server.pid with no backend=node line: a helper that says the file
    // system cannot lock is no evidence that the coordinator exited.
    writeFileSync(pidFile, pidLines(process.pid, listener.port));
    const answer = await withLockHelper(base, CANNOT_LOCK, () => post(resolveEndpoint(root)));
    assert.deepEqual(answer, { ok: true });
    assert.equal(listener.seen.length, 1);
  })
);

test(
  'a Node coordinator whose pid has exited is refused where the lock cannot be probed',
  withWorkspace(async ({ base, root, pidFile, listener }) => {
    // There a Node coordinator runs unlocked, so its pid is all that tells.
    const gone = await exitedPid();
    writeFileSync(pidFile, pidLines(gone, listener.port, 'node'));
    const refusal = await withLockHelper(base, CANNOT_LOCK, async () => refusalAtResolve(root));
    assert.equal(
      refusal,
      `no coordinator running for this workspace (${pidFile} names pid ${gone}, ` +
        'which is no longer running); start one'
    );
    assert.deepEqual(listener.seen, []);
  })
);

test(
  'a Node pid file whose pid has exited is reached while its lock is held, and refused once it is free',
  withWorkspace(async ({ root, pidFile, listener }) => {
    // A coordinator that holds the lock runs, whatever pid the file names.
    const gone = await exitedPid();
    writeFileSync(pidFile, pidLines(gone, listener.port, 'node'));
    const exit = hold(pidFile);
    let endpoint: CoordinatorEndpoint;
    try {
      endpoint = resolveEndpoint(root);
      assert.deepEqual(await post(endpoint), { ok: true });
    } finally {
      exit();
    }
    await assertDeparted(
      post(endpoint),
      `the coordinator ${pidFile} names (pid ${gone}) is no longer running`
    );
    assert.equal(listener.seen.length, 1);
  })
);

for (const [command, run] of [
  ['track', runTrack],
  ['untrack', runUntrack],
] as const) {
  test(
    `agent-coherence-${command} sends nothing to a coordinator that leaves after resolve, and prints only why`,
    withWorkspace(async ({ base, root, pidFile, listener }) => {
      // The probe at resolve sees the lock held; the one before the request
      // sees it free. Nothing was sent, so the paths the command rejected
      // itself stay unprinted, as when no coordinator is found at all.
      writeFileSync(pidFile, pidLines(process.pid, listener.port));
      const written: string[] = [];
      const write = process.stderr.write;
      process.stderr.write = ((chunk: string) => written.push(chunk) > 0) as typeof write;
      let status: number;
      try {
        status = await withLockHelper(base, HELD_THEN_FREE, () =>
          run(['notes.md', '../outside', '--root', root])
        );
      } finally {
        process.stderr.write = write;
      }
      assert.equal(status, 2);
      assert.equal(
        written.join(''),
        `agent-coherence-${command}: the coordinator ${pidFile} names (pid ${process.pid}) ` +
          'no longer holds the workspace lock; nothing was sent\n'
      );
      assert.deepEqual(listener.seen, []);
    })
  );
}

test(
  'the port and backend lines are never read through a link',
  withWorkspace(async ({ base, pidFile }) => {
    const elsewhere = join(base, 'elsewhere.pid');
    writeFileSync(elsewhere, '1\n2\nbackend=node\n');
    symlinkSync(elsewhere, pidFile);
    assert.equal(readPortFromPidFile(pidFile), null);
    assert.equal(readBackendFromPidFile(pidFile), null);
    unlinkSync(pidFile);
    writeFileSync(pidFile, '1\n2\nbackend=node\n');
    assert.equal(readPortFromPidFile(pidFile), 2);
    assert.equal(readBackendFromPidFile(pidFile), 'node');
  })
);

test(
  'agent-coherence-status sends nothing to a coordinator that exited, and says why',
  withWorkspace(async ({ root, pidFile, listener }) => {
    writeFileSync(pidFile, pidLines(process.pid, listener.port));
    const child = spawn(process.execPath, [CLI_STATUS_JS, '--root', root], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const status = await new Promise<number | null>((resolve) => child.once('close', resolve));
    assert.equal(status, 2);
    assert.equal(
      stderr,
      `agent-coherence-status: no coordinator running for this workspace (${pidFile} names pid ` +
        `${process.pid}, which no longer holds the workspace lock); start one\n`
    );
    assert.deepEqual(listener.seen, []);
  })
);
