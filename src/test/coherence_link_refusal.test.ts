/**
 * #251: a coordinator start refuses a `.coherence` that is a symlink, or that
 * holds a symlink, FIFO, socket or device directly inside it, before it
 * creates, locks or writes anything there (cohexa-ai/agent-coherence#498).
 * Before, a start made its pid file, `.gitignore`, secret and store through
 * the link, so a repository that committed one chose where they went, and a
 * FIFO behind a link held the start for good.
 *
 * Every start here is the compiled coordinator in a child process: a start
 * held on a FIFO would otherwise park the test runner as well.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT_REFUSED,
  coherenceDirRefusalMessage,
  type CoherenceDirRefusal,
} from '../coherence_dir.js';
import {
  START_TIMEOUT_MS,
  serving,
  startCoordinator,
  within,
} from './coordinator_process_fixture.js';
import { writeExecutable } from './executable_fixture.js';
import { makeFifo, releaseFifo } from './fifo_fixture.js';
import { killAndWait } from './pid_lock_fixture.js';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A start that only lstats and lists before it refuses exits in well under a
 * second, the child's own start-up included; this only has to tell it from a
 * start held on a FIFO, which never exits.
 */
const AT_ONCE_MS = 5_000;

function withBase(run: (base: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const base = mkdtempSync(join(tmpdir(), 'coherence-link-refusal-'));
    try {
      await run(base);
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  };
}

interface StartOutcome {
  /** The exit code, or 'running' when the coordinator had not exited in the time it was given. */
  code: number | null | 'running';
  stderr: string;
}

/**
 * Start a coordinator on `ws` and wait at most `timeoutMs` for it to exit.
 * Afterwards each of `fifos` is released and the coordinator, if still
 * running, is killed and waited for.
 */
async function startAndWait(
  ws: string,
  options: { timeoutMs?: number; fifos?: string[] } = {}
): Promise<StartOutcome> {
  const coordinator = startCoordinator(ws);
  // 'close', not 'exit': by then the whole of stderr has been read.
  const closed = new Promise<number | null>((resolve) =>
    coordinator.child.once('close', (code) => resolve(code))
  );
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'running'>((resolve) => {
    timer = setTimeout(() => resolve('running'), options.timeoutMs ?? START_TIMEOUT_MS);
  });
  try {
    const code = await Promise.race([closed, expired]);
    return { code, stderr: coordinator.stderr() };
  } finally {
    clearTimeout(timer);
    for (const fifo of options.fifos ?? []) releaseFifo(fifo);
    await killAndWait(coordinator.child);
  }
}

/** The one stderr line of a start refused for `refusal`. */
function refusalLine(refusal: CoherenceDirRefusal, coherenceDir: string): string {
  return `agent-coherence-coordinator: ${coherenceDirRefusalMessage(refusal, coherenceDir)}\n`;
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** What is at `path`, without following a link there: enough to tell whether a start changed it. */
function stateOf(path: string): string {
  if (!lexists(path)) return 'absent';
  const info = lstatSync(path);
  const mode = (info.mode & 0o777).toString(8);
  if (info.isSymbolicLink()) return `link to ${readlinkSync(path)}`;
  if (info.isDirectory()) return `directory ${mode} [${readdirSync(path).sort().join(', ')}]`;
  return `file ${mode} ${JSON.stringify(readFileSync(path, 'utf8'))}`;
}

const LINK_NAMES = [
  '.gitignore',
  'server.pid',
  'server.port',
  'hook.secret',
  'state.db',
  'state.db-wal',
  'state.db-shm',
  'tracked.yaml',
  'ignored.yaml',
  'strict_mode.yaml',
  'coordinator_backend',
  `caller-principal-${'0123456789abcdef'.repeat(2)}.nonce`,
  // A name no coordinator opens: the rule is every entry, not a list of the files a start uses.
  'notes.txt',
];

test(
  'a coordinator start refuses a link at any name in .coherence and changes nothing',
  withBase(async (base) => {
    const cases = LINK_NAMES.flatMap((name, index) =>
      (['existing', 'dangling'] as const).map((shape) => {
        const ws = join(base, `${index}-${shape}`);
        const coherenceDir = join(ws, '.coherence');
        mkdirSync(coherenceDir, { recursive: true });
        const target = join(ws, shape === 'existing' ? 'target' : 'gone');
        if (shape === 'existing') writeFileSync(target, 'keep\n', { mode: 0o640 });
        const link = join(coherenceDir, name);
        symlinkSync(target, link);
        return { where: `${name} (${shape})`, ws, coherenceDir, name, link, target };
      })
    );
    const planted = cases.map(({ link, target }) => [stateOf(link), stateOf(target)]);
    // All at once: a start that is not refused serves until it is killed, so
    // one at a time would wait out every start's bound in turn.
    const outcomes = await Promise.all(cases.map(({ ws }) => startAndWait(ws)));

    const seen = Object.fromEntries(
      cases.map(({ where, coherenceDir, link, target }, i) => [
        where,
        {
          code: outcomes[i]!.code,
          stderr: outcomes[i]!.stderr,
          namesTheWayOut: outcomes[i]!.stderr.includes('mount a directory at '),
          listing: readdirSync(coherenceDir).sort(),
          planted: [stateOf(link), stateOf(target)],
        },
      ])
    );
    const expected = Object.fromEntries(
      cases.map(({ where, coherenceDir, name, link }, i) => [
        where,
        {
          code: EXIT_REFUSED,
          stderr: refusalLine({ kind: 'link', path: link, more: 0 }, coherenceDir),
          namesTheWayOut: true,
          listing: [name],
          planted: planted[i],
        },
      ])
    );
    assert.deepEqual(seen, expected);
  })
);

test(
  'a start refuses a linked .coherence and writes nothing into the directory it names',
  withBase(async (base) => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    chmodSync(outside, 0o755);
    const toOutside = join(base, 'to-outside');
    mkdirSync(toOutside);
    symlinkSync(outside, join(toOutside, '.coherence'));
    // .coherence names the workspace itself, so a start would write into its root.
    const toItself = join(base, 'to-itself');
    mkdirSync(toItself);
    symlinkSync('.', join(toItself, '.coherence'));
    const dangling = join(base, 'dangling');
    mkdirSync(dangling);
    symlinkSync(join(base, 'gone'), join(dangling, '.coherence'));

    const cases = [
      { where: 'a directory outside', ws: toOutside, target: outside },
      { where: 'the workspace itself', ws: toItself, target: toItself },
      { where: 'nothing (dangling)', ws: dangling, target: join(base, 'gone') },
    ].map((c) => ({ ...c, coherenceDir: join(c.ws, '.coherence') }));
    const planted = cases.map(({ coherenceDir, target }) => [
      stateOf(coherenceDir),
      stateOf(target),
    ]);
    const outcomes = await Promise.all(cases.map(({ ws }) => startAndWait(ws)));

    const seen = Object.fromEntries(
      cases.map(({ where, coherenceDir, target }, i) => [
        where,
        {
          code: outcomes[i]!.code,
          stderr: outcomes[i]!.stderr,
          planted: [stateOf(coherenceDir), stateOf(target)],
        },
      ])
    );
    const expected = Object.fromEntries(
      cases.map(({ where, coherenceDir }, i) => [
        where,
        {
          code: EXIT_REFUSED,
          stderr: refusalLine({ kind: 'link', path: coherenceDir, more: 0 }, coherenceDir),
          planted: planted[i],
        },
      ])
    );
    assert.deepEqual(seen, expected);
  })
);

test(
  'a start refuses a FIFO-linked server.pid or hook.secret at once',
  { skip: process.platform === 'win32' },
  withBase(async (base) => {
    const cases = ['server.pid', 'hook.secret'].map((name) => {
      const ws = join(base, name);
      const coherenceDir = join(ws, '.coherence');
      mkdirSync(coherenceDir, { recursive: true });
      const fifo = join(ws, 'pipe');
      makeFifo(fifo);
      const link = join(coherenceDir, name);
      symlinkSync(fifo, link);
      return { name, ws, coherenceDir, fifo, link };
    });
    // A start that opened what the link names would wait on the FIFO until it
    // is released, which happens only after the bound.
    const outcomes = await Promise.all(
      cases.map(({ ws, fifo }) => startAndWait(ws, { timeoutMs: AT_ONCE_MS, fifos: [fifo] }))
    );

    assert.deepEqual(
      Object.fromEntries(cases.map(({ name }, i) => [name, outcomes[i]])),
      Object.fromEntries(
        cases.map(({ name, coherenceDir, link }) => [
          name,
          {
            code: EXIT_REFUSED,
            stderr: refusalLine({ kind: 'link', path: link, more: 0 }, coherenceDir),
          },
        ])
      )
    );
  })
);

test(
  'a serving coordinator writes no server.port',
  withBase(async (base) => {
    const ws = join(base, 'ws');
    mkdirSync(ws);
    const portFile = join(ws, '.coherence', 'server.port');
    const coordinator = startCoordinator(ws);
    try {
      await serving(ws, coordinator);
      // Its port is in server.pid, where every client reads it.
      assert.equal(lexists(portFile), false, 'no coordinator writes server.port');
      assert.equal(readFileSync(join(ws, '.coherence', '.gitignore'), 'utf8'), '*\n');
      coordinator.child.kill('SIGTERM');
      assert.equal(
        await within('the coordinator to stop', coordinator.exited),
        0,
        coordinator.stderr()
      );
      assert.equal(lexists(portFile), false);
    } finally {
      await killAndWait(coordinator.child);
    }
  })
);

test(
  'a serving coordinator leaves an older release server.port and an operator .gitignore as they are',
  withBase(async (base) => {
    const ws = join(base, 'ws');
    const coherenceDir = join(ws, '.coherence');
    mkdirSync(coherenceDir, { recursive: true });
    // An older coordinator's port file: nothing reads it any more, so it is
    // left alone rather than rewritten or removed.
    const portFile = join(coherenceDir, 'server.port');
    writeFileSync(portFile, '12345\n', { mode: 0o600 });
    const gitignore = join(coherenceDir, '.gitignore');
    writeFileSync(gitignore, '*\n!notes.txt\n', { mode: 0o600 });
    const before = [stateOf(portFile), stateOf(gitignore)];
    const coordinator = startCoordinator(ws);
    try {
      await serving(ws, coordinator);
      assert.deepEqual([stateOf(portFile), stateOf(gitignore)], before, 'while serving');
      coordinator.child.kill('SIGTERM');
      assert.equal(
        await within('the coordinator to stop', coordinator.exited),
        0,
        coordinator.stderr()
      );
      assert.deepEqual([stateOf(portFile), stateOf(gitignore)], before, 'after it stopped');
    } finally {
      await killAndWait(coordinator.child);
    }
  })
);

/**
 * The SessionStart dispatcher with stub bootstraps that print which one it
 * chose, and a PATH whose Node (24) has a better-sqlite3 prebuilt, so the
 * default does not depend on the Node that runs this suite.
 */
function stubDispatcher(dir: string): { dispatcher: string; path: string } {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const dispatcher = join(bin, 'ensure-coordinator-dispatch');
  cpSync(join(PLUGIN_ROOT, 'bin', 'ensure-coordinator-dispatch'), dispatcher);
  writeExecutable(join(bin, 'ensure-coordinator'), '#!/usr/bin/env bash\necho PYTHON-BOOTSTRAP\n');
  writeExecutable(
    join(bin, 'ensure-coordinator-node'),
    '#!/usr/bin/env bash\necho NODE-BOOTSTRAP\n'
  );
  const node24 = join(dir, 'node-24');
  mkdirSync(node24);
  writeExecutable(join(node24, 'node'), '#!/bin/sh\necho 24\n');
  writeExecutable(join(node24, 'npm'), '#!/bin/sh\nexit 0\n');
  return { dispatcher, path: `${node24}:/usr/bin:/bin` };
}

test(
  'a refused start leaves no state.db, so the next session start still picks the default backend',
  withBase(async (base) => {
    const { dispatcher, path } = stubDispatcher(join(base, 'plugin'));
    const ws = join(base, 'ws');
    mkdirSync(ws);
    spawnSync('git', ['init', '-q'], { cwd: ws });
    const coherenceDir = join(ws, '.coherence');
    mkdirSync(coherenceDir);
    const link = join(coherenceDir, 'state.db-wal');
    symlinkSync(join(base, 'gone'), link);

    const start = await startAndWait(ws);
    // Once the link is fixed, the next session start chooses a backend. A
    // state.db left by the failed start would read as an established store
    // and route the workspace to Python, with no coordinator behind it.
    unlinkSync(link);
    const dispatch = spawnSync('/bin/bash', [dispatcher], {
      cwd: ws,
      encoding: 'utf8',
      env: { PATH: path, HOME: ws } as NodeJS.ProcessEnv,
      timeout: 10_000,
    });

    assert.deepEqual(
      {
        code: start.code,
        stateDb: lexists(join(coherenceDir, 'state.db')),
        backend: dispatch.stdout.trim(),
      },
      { code: EXIT_REFUSED, stateDb: false, backend: 'NODE-BOOTSTRAP' },
      start.stderr
    );
    assert.equal(existsSync(join(base, 'gone')), false);
  })
);
