/**
 * #251: hook.secret is read without following a link, without blocking and as
 * a regular file only, by the coordinator that makes it and by every client
 * that sends it as the bearer. A client also refuses a `.coherence` that is
 * itself a link before it reads anything there (cohexa-ai/agent-coherence#498).
 * Before, a linked hook.secret made the file it names the bearer, so a
 * repository could hand a hook another workspace's secret, and a FIFO there
 * held the coordinator's start, every hook and the CLIs.
 *
 * Every call that could block runs in a bounded child process: a read held on
 * a FIFO would otherwise park the test runner as well.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coherenceDirRefusalMessage } from '../coherence_dir.js';
import { compiledModuleUrl, makeFifo, releaseFifo, runBounded } from './fifo_fixture.js';
import { killAndWait } from './pid_lock_fixture.js';
import { writeStandInPidFile } from './coordinator_stand_in.js';

const HOOK_CLIENT_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hook_client.js');
const SESSION_ID = '44444444-4444-4444-8444-444444444444';

/** Generous for a loaded host: the child's own start-up counts against it, not only the reads. */
const CHILD_TIMEOUT_MS = 30_000;
/**
 * A hook that reads no FIFO answers in well under a second, its own start-up
 * included; this only has to tell it from a hook held on one, which never
 * answers.
 */
const AT_ONCE_MS = 5_000;

const OURS = '0a'.repeat(32);
const THEIRS = 'f1'.repeat(32);

function withBase(run: (base: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const base = mkdtempSync(join(tmpdir(), 'hook-secret-reads-'));
    try {
      await run(base);
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  };
}

/** The refusal of a link: `.coherence` itself when `path` is `coherenceDir`, else an entry in it. */
function linkRefusal(path: string, coherenceDir: string): string {
  return coherenceDirRefusalMessage({ kind: 'link', path, more: 0 }, coherenceDir);
}

/** What is at `path`, without following a link there. */
function stateOf(path: string): string {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return `link to ${readlinkSync(path)}`;
    return info.isFIFO() ? 'FIFO' : `file ${JSON.stringify(readFileSync(path, 'utf8'))}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
}

/**
 * Calls `fn` of the compiled module given first on each [name, path] case
 * given as JSON, and prints one JSON line per case as it is answered: what it
 * returned, or the error's class and message.
 */
function casesScript(fn: string): string {
  return (
    'const [moduleUrl, cases] = process.argv.slice(1);\n' +
    'const module = await import(moduleUrl);\n' +
    'for (const [name, path] of JSON.parse(cases)) {\n' +
    '  let row;\n' +
    '  try {\n' +
    `    row = { name, value: module.${fn}(path) };\n` +
    '  } catch (err) {\n' +
    '    const unavailable = module.CoordinatorUnavailable !== undefined && err instanceof module.CoordinatorUnavailable;\n' +
    '    row = { name, message: err.message, ...(unavailable ? { unavailable } : {}) };\n' +
    '  }\n' +
    "  process.stdout.write(JSON.stringify(row) + '\\n');\n" +
    '}\n'
  );
}

/**
 * Each case run in one child process, in order: a call that wrongly blocks on
 * a FIFO then holds the child, not this test runner, and the rows answered
 * before it show.
 */
async function callInChild(
  fn: string,
  file: string,
  cases: Array<[name: string, path: string]>,
  fifos: string[]
): Promise<{ timedOut: boolean; rows: Record<string, unknown> }> {
  const run = await runBounded(casesScript(fn), [compiledModuleUrl(file), JSON.stringify(cases)], {
    timeoutMs: CHILD_TIMEOUT_MS,
    fifos,
  });
  const rows = run.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { name: string });
  return {
    timedOut: run.timedOut,
    rows: Object.fromEntries(rows.map(({ name, ...row }) => [name, row])),
  };
}

test(
  'ensureSecret refuses a linked hook.secret and returns none of what it names',
  { skip: process.platform === 'win32' },
  withBase(async (base) => {
    const theirs = join(base, 'theirs');
    writeFileSync(theirs, `${THEIRS}\n`);
    const fifo = join(base, 'pipe');
    makeFifo(fifo);
    const plant: Record<string, (secret: string) => void> = {
      'a regular secret': (secret) => writeFileSync(secret, `${OURS}\n`),
      'a link to a secret': (secret) => symlinkSync(theirs, secret),
      'a dangling link': (secret) => symlinkSync(join(base, 'gone'), secret),
      // Last: a read that blocks on one of these holds every case after it.
      'a link to a FIFO': (secret) => symlinkSync(fifo, secret),
      'a FIFO': (secret) => makeFifo(secret),
    };
    const cases = Object.entries(plant).map(([name, plantAt], index) => {
      const coherenceDir = join(base, String(index), '.coherence');
      mkdirSync(coherenceDir, { recursive: true });
      const secret = join(coherenceDir, 'hook.secret');
      plantAt(secret);
      return { name, coherenceDir, secret };
    });

    const at = (name: string) => cases.find((c) => c.name === name)!;
    const run = await callInChild(
      'ensureSecret',
      'auth.js',
      cases.map(({ name, coherenceDir }) => [name, coherenceDir]),
      [fifo, at('a FIFO').secret]
    );

    const refused = (name: string) => ({
      message: linkRefusal(at(name).secret, at(name).coherenceDir),
    });
    assert.deepEqual(
      {
        ...run,
        after: [stateOf(theirs), stateOf(join(base, 'gone'))],
        links: cases.map(({ secret }) => stateOf(secret)),
      },
      {
        timedOut: false,
        rows: {
          'a regular secret': { value: OURS },
          'a link to a secret': refused('a link to a secret'),
          'a dangling link': refused('a dangling link'),
          'a link to a FIFO': refused('a link to a FIFO'),
          'a FIFO': {
            message: `ensureSecret: ${at('a FIFO').secret} is not a regular file; remove it, then restart.`,
          },
        },
        after: [`file ${JSON.stringify(`${THEIRS}\n`)}`, 'absent'],
        links: [
          `file ${JSON.stringify(`${OURS}\n`)}`,
          `link to ${theirs}`,
          `link to ${join(base, 'gone')}`,
          `link to ${fifo}`,
          'FIFO',
        ],
      }
    );
  })
);

/** A workspace whose `.coherence` holds a server.pid naming `port`, and a hook.secret holding `secret`. */
function workspaceWith(root: string, port: number, secret: string): string {
  const coherenceDir = join(root, '.coherence');
  mkdirSync(coherenceDir, { recursive: true });
  writeStandInPidFile(join(coherenceDir, 'server.pid'), `${process.pid}\n${port}\n`);
  writeFileSync(join(coherenceDir, 'hook.secret'), `${secret}\n`);
  return coherenceDir;
}

test(
  'resolveEndpoint refuses a linked hook.secret, a FIFO there, and a linked .coherence before it reads server.pid',
  { skip: process.platform === 'win32' },
  withBase(async (base) => {
    const theirs = workspaceWith(join(base, 'theirs'), 4343, THEIRS);
    // A linked .coherence whose server.pid would hold a read of it.
    const held = join(base, 'held', '.coherence');
    mkdirSync(held, { recursive: true });
    makeFifo(join(held, 'server.pid'));
    const fifo = join(base, 'pipe');
    makeFifo(fifo);
    const plant: Record<string, (root: string) => string> = {
      'a regular hook.secret': (root) => workspaceWith(root, 4242, OURS),
      'hook.secret linked to a secret': (root) => {
        const dir = workspaceWith(root, 4242, OURS);
        rmSync(join(dir, 'hook.secret'));
        symlinkSync(join(theirs, 'hook.secret'), join(dir, 'hook.secret'));
        return dir;
      },
      'hook.secret a dangling link': (root) => {
        const dir = workspaceWith(root, 4242, OURS);
        rmSync(join(dir, 'hook.secret'));
        symlinkSync(join(base, 'gone'), join(dir, 'hook.secret'));
        return dir;
      },
      '.coherence linked to another workspace': (root) => {
        mkdirSync(root);
        symlinkSync(theirs, join(root, '.coherence'));
        return join(root, '.coherence');
      },
      // Last: a read that blocks on one of these holds every case after it.
      'hook.secret linked to a FIFO': (root) => {
        const dir = workspaceWith(root, 4242, OURS);
        rmSync(join(dir, 'hook.secret'));
        symlinkSync(fifo, join(dir, 'hook.secret'));
        return dir;
      },
      'hook.secret a FIFO': (root) => {
        const dir = workspaceWith(root, 4242, OURS);
        rmSync(join(dir, 'hook.secret'));
        makeFifo(join(dir, 'hook.secret'));
        return dir;
      },
      '.coherence linked to one whose server.pid is a FIFO': (root) => {
        mkdirSync(root);
        symlinkSync(held, join(root, '.coherence'));
        return join(root, '.coherence');
      },
    };
    const cases = Object.entries(plant).map(([name, plantAt], index) => {
      const root = join(base, String(index));
      return { name, root, coherenceDir: plantAt(root) };
    });

    const at = (name: string) => cases.find((c) => c.name === name)!;
    const fifoSecret = join(at('hook.secret a FIFO').coherenceDir, 'hook.secret');
    const run = await callInChild(
      'resolveEndpoint',
      'hook_client_transport.js',
      cases.map(({ name, root }) => [name, root]),
      [fifo, join(held, 'server.pid'), fifoSecret]
    );

    const unavailable = (message: string) => ({ message, unavailable: true });
    const secretRefused = (name: string) =>
      unavailable(linkRefusal(join(at(name).coherenceDir, 'hook.secret'), at(name).coherenceDir));
    const dirRefused = (name: string) =>
      unavailable(linkRefusal(at(name).coherenceDir, at(name).coherenceDir));
    assert.deepEqual(run, {
      timedOut: false,
      rows: {
        'a regular hook.secret': {
          value: {
            port: 4242,
            bearer: OURS,
            pin: {
              coherenceDir: at('a regular hook.secret').coherenceDir,
              lines: { pid: process.pid, port: 4242, backend: null },
            },
          },
        },
        'hook.secret linked to a secret': secretRefused('hook.secret linked to a secret'),
        'hook.secret a dangling link': secretRefused('hook.secret a dangling link'),
        '.coherence linked to another workspace': dirRefused(
          '.coherence linked to another workspace'
        ),
        'hook.secret linked to a FIFO': secretRefused('hook.secret linked to a FIFO'),
        'hook.secret a FIFO': unavailable(`${fifoSecret} is not a regular file`),
        '.coherence linked to one whose server.pid is a FIFO': dirRefused(
          '.coherence linked to one whose server.pid is a FIFO'
        ),
      },
    });
  })
);

interface Recorder {
  port: number;
  /** Each distinct Authorization header a request carried. */
  bearers: () => string[];
  close: () => Promise<void>;
}

/** A loopback HTTP server that answers every request `{}` and records the bearer it was sent. */
async function startRecorder(): Promise<Recorder> {
  const seen = new Set<string>();
  const server = createServer((req, res) => {
    seen.add(req.headers.authorization ?? '');
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    bearers: () => [...seen],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface HookRun {
  /** The exit code, or 'running' when the hook had not exited in the time it was given. */
  status: number | null | 'running';
  stdout: string;
}

/**
 * The real hook client's pre-read on `root`, waited for at most `timeoutMs`.
 * Afterwards each of `fifos` is released and the hook, if still running, is
 * killed and waited for.
 */
async function runPreRead(
  root: string,
  options: { timeoutMs: number; fifos: string[] }
): Promise<HookRun> {
  const child = spawn(process.execPath, [HOOK_CLIENT_JS, 'pre-read', '--root', root], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  const closed = new Promise<number | null>((resolve) =>
    child.once('close', (code) => resolve(code))
  );
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'running'>((resolve) => {
    timer = setTimeout(() => resolve('running'), options.timeoutMs);
  });
  child.stdin.end(
    JSON.stringify({ session_id: SESSION_ID, tool_input: { file_path: join(root, 'notes.md') } })
  );
  try {
    return { status: await Promise.race([closed, expired]), stdout: stdout.trim() };
  } finally {
    clearTimeout(timer);
    for (const fifo of options.fifos) releaseFifo(fifo);
    await killAndWait(child);
  }
}

test(
  'hook client: a linked hook.secret is never sent as the bearer',
  withBase(async (base) => {
    // Each workspace's server.pid names its own recorder, so a request shows
    // which workspace sent it and with which bearer.
    const recorders = await Promise.all([startRecorder(), startRecorder(), startRecorder()]);
    try {
      const [own, linkedSecret, linkedDir] = recorders;
      const ownRoot = join(base, 'own');
      workspaceWith(ownRoot, own!.port, OURS);
      const theirs = workspaceWith(join(base, 'theirs'), linkedDir!.port, THEIRS);

      const secretRoot = join(base, 'linked-secret');
      const secretDir = workspaceWith(secretRoot, linkedSecret!.port, OURS);
      rmSync(join(secretDir, 'hook.secret'));
      symlinkSync(join(theirs, 'hook.secret'), join(secretDir, 'hook.secret'));
      // Its server.pid names the other workspace's coordinator, and its
      // hook.secret is that coordinator's bearer.
      const dirRoot = join(base, 'linked-dir');
      mkdirSync(dirRoot);
      symlinkSync(theirs, join(dirRoot, '.coherence'));

      const roots = {
        'its own secret': ownRoot,
        'a linked hook.secret': secretRoot,
        'a linked .coherence': dirRoot,
      };
      const runs = await Promise.all(
        Object.values(roots).map((root) =>
          runPreRead(root, { timeoutMs: CHILD_TIMEOUT_MS, fifos: [] })
        )
      );
      assert.deepEqual(
        Object.fromEntries(
          Object.keys(roots).map((name, i) => [
            name,
            { ...runs[i], bearers: recorders[i]!.bearers() },
          ])
        ),
        {
          // The same set-up reaches its recorder: a hook that sends nothing below is refusing.
          'its own secret': { status: 0, stdout: '{}', bearers: [`Bearer ${OURS}`] },
          'a linked hook.secret': { status: 0, stdout: '{}', bearers: [] },
          'a linked .coherence': { status: 0, stdout: '{}', bearers: [] },
        }
      );
    } finally {
      await Promise.all(recorders.map((recorder) => recorder.close()));
    }
  })
);

test(
  'hook client: a FIFO hook.secret answers {} at once instead of holding the tool call',
  { skip: process.platform === 'win32' },
  withBase(async (base) => {
    const recorder = await startRecorder();
    try {
      // Each row has its own FIFO, released only by its own run: a row that
      // finished first must not let the other's hook, held on it, go on.
      const cases = (['a FIFO', 'a link to a FIFO'] as const).map((name, index) => {
        const root = join(base, String(index));
        const secret = join(workspaceWith(root, recorder.port, OURS), 'hook.secret');
        rmSync(secret);
        const fifo = name === 'a FIFO' ? secret : join(root, 'pipe');
        makeFifo(fifo);
        if (name !== 'a FIFO') symlinkSync(fifo, secret);
        return { name, root, fifo };
      });
      // A hook that opened the FIFO would wait for a writer until it is
      // released, which happens only after the bound.
      const runs = await Promise.all(
        cases.map(({ root, fifo }) => runPreRead(root, { timeoutMs: AT_ONCE_MS, fifos: [fifo] }))
      );
      assert.deepEqual(
        {
          runs: Object.fromEntries(cases.map(({ name }, i) => [name, runs[i]])),
          bearers: recorder.bearers(),
        },
        {
          runs: {
            'a FIFO': { status: 0, stdout: '{}' },
            'a link to a FIFO': { status: 0, stdout: '{}' },
          },
          bearers: [],
        }
      );
    } finally {
      await recorder.close();
    }
  })
);
