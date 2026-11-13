/**
 * #248 and #251: the policy routes and the policy load read a policy file
 * without following a link and without blocking, and accept a regular file
 * only (cohexa-ai/agent-coherence#498). Before, a tracked.yaml linked to a
 * FIFO held the coordinator's only event loop: the route never answered,
 * /health timed out and SIGTERM did nothing. A link to a regular file was read
 * through, then renamed over.
 *
 * A start refuses all of these, so each is planted while a coordinator serves.
 * Every coordinator, and every load, runs in a child process: a read held on
 * a FIFO would otherwise park the test runner as well.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type CoordinatorEndpoint,
  requestJsonStatus,
  resolveEndpoint,
} from '../hook_client_transport.js';
import {
  type Coordinator,
  serving,
  startCoordinator,
  within,
} from './coordinator_process_fixture.js';
import { compiledModuleUrl, makeFifo, releaseFifo, runBounded } from './fifo_fixture.js';
import { killAndWait } from './pid_lock_fixture.js';

/** A hook waits this long for its coordinator; a route that blocks never answers within it. */
const ROUTE_TIMEOUT_MS = 5_000;
/** /health reads nothing from disk; any wait beyond this is an event loop held by something else. */
const HEALTH_TIMEOUT_MS = 2_000;
/** A coordinator whose event loop runs stops on SIGTERM in well under a second. */
const STOP_TIMEOUT_MS = 5_000;
/** Generous for a loaded host: the child's own start-up counts against it, not only the load. */
const CHILD_TIMEOUT_MS = 30_000;

function withBase(run: (base: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const base = mkdtempSync(join(tmpdir(), 'policy-link-refusal-'));
    try {
      await run(base);
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  };
}

function linkRefusal(file: string): string {
  return (
    `.coherence/${file} is a symlink; nothing was written. Replace it with a copy of the file ` +
    'it names, or mount a directory at .coherence.'
  );
}

/** What is at `path`, without following a link there: enough to tell whether a route changed it. */
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

type Answer = { status: number; body: Record<string, unknown> | null } | { error: string };

/** What a request was answered, or the error that left it unanswered. */
async function answerOf(
  request: Promise<{ status: number; body: Record<string, unknown> | null }>
): Promise<Answer> {
  try {
    return await request;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function postPaths(endpoint: CoordinatorEndpoint, route: string, paths: string[]): Promise<Answer> {
  return answerOf(
    requestJsonStatus(endpoint, 'POST', route, { paths }, undefined, ROUTE_TIMEOUT_MS)
  );
}

/** SIGTERM, then the exit code, or 'running' when the coordinator did not stop in time. */
async function stopOf(coordinator: Coordinator): Promise<number | null | 'running'> {
  coordinator.child.kill('SIGTERM');
  try {
    return await within('the coordinator to stop', coordinator.exited, STOP_TIMEOUT_MS);
  } catch {
    return 'running';
  }
}

/**
 * Start a coordinator on a new workspace `ws` and, once it serves, put `file`
 * into its `.coherence` with `plant`. Then post `route` a path, ask /health,
 * and send SIGTERM. Afterwards each of `fifos` is released and the
 * coordinator, if still running, is killed and waited for.
 */
async function routeOverPlanted(
  ws: string,
  options: {
    file: string;
    plant: (path: string) => void;
    route: '/policy/track' | '/policy/untrack';
    fifos: string[];
  }
): Promise<{ seen: Record<string, unknown>; stderr: string }> {
  mkdirSync(ws);
  const coordinator = startCoordinator(ws);
  try {
    await serving(ws, coordinator);
    const endpoint = resolveEndpoint(ws);
    const planted = join(ws, '.coherence', options.file);
    options.plant(planted);
    const route = await postPaths(endpoint, options.route, ['new.md']);
    const health = await answerOf(
      requestJsonStatus(endpoint, 'GET', '/health', undefined, undefined, HEALTH_TIMEOUT_MS)
    );
    const stopped = await stopOf(coordinator);
    return {
      seen: {
        route,
        health: 'error' in health ? health : health.status,
        stopped,
        planted: stateOf(planted),
      },
      stderr: coordinator.stderr(),
    };
  } finally {
    for (const fifo of options.fifos) releaseFifo(fifo);
    await killAndWait(coordinator.child);
  }
}

test(
  'a policy route over a tracked.yaml linked to a FIFO after the start answers 400 at once, and the coordinator still serves and stops',
  { skip: process.platform === 'win32' },
  withBase(async (base) => {
    const fifo = join(base, 'pipe');
    makeFifo(fifo);
    const { seen, stderr } = await routeOverPlanted(join(base, 'ws'), {
      file: 'tracked.yaml',
      plant: (path) => symlinkSync(fifo, path),
      route: '/policy/track',
      fifos: [fifo],
    });
    assert.deepEqual(
      seen,
      {
        route: { status: 400, body: { error: linkRefusal('tracked.yaml') } },
        health: 200,
        stopped: 0,
        planted: `link to ${fifo}`,
      },
      stderr
    );
  })
);

test(
  'a policy route over a FIFO placed at tracked.yaml after the start answers 400 at once',
  { skip: process.platform === 'win32' },
  withBase(async (base) => {
    const ws = join(base, 'ws');
    const fifo = join(ws, '.coherence', 'tracked.yaml');
    const { seen, stderr } = await routeOverPlanted(ws, {
      file: 'tracked.yaml',
      plant: (path) => makeFifo(path),
      route: '/policy/track',
      fifos: [fifo],
    });
    assert.deepEqual(
      seen,
      {
        route: {
          status: 400,
          body: {
            error:
              '.coherence/tracked.yaml could not be read (not a regular file); nothing was written.',
          },
        },
        health: 200,
        stopped: 0,
        planted: 'FIFO',
      },
      stderr
    );
  })
);

test(
  'an untrack over an ignored.yaml linked to a FIFO after the start answers 400 at once',
  { skip: process.platform === 'win32' },
  withBase(async (base) => {
    const fifo = join(base, 'pipe');
    makeFifo(fifo);
    const { seen, stderr } = await routeOverPlanted(join(base, 'ws'), {
      file: 'ignored.yaml',
      plant: (path) => symlinkSync(fifo, path),
      route: '/policy/untrack',
      fifos: [fifo],
    });
    assert.deepEqual(
      seen,
      {
        route: { status: 400, body: { error: linkRefusal('ignored.yaml') } },
        health: 200,
        stopped: 0,
        planted: `link to ${fifo}`,
      },
      stderr
    );
  })
);

test(
  'a policy route refuses a tracked.yaml linked to a regular file, keeps the link and its target, and a reload counts it rejected',
  withBase(async (base) => {
    const target = join(base, 'theirs.yaml');
    writeFileSync(target, '- "theirs/**"\n');
    const ws = join(base, 'ws');
    mkdirSync(ws);
    const tracked = join(ws, '.coherence', 'tracked.yaml');
    const coordinator = startCoordinator(ws);
    try {
      await serving(ws, coordinator);
      const endpoint = resolveEndpoint(ws);
      symlinkSync(target, tracked);
      const track = await postPaths(endpoint, '/policy/track', ['new.md']);
      // An untrack writes ignored.yaml, a regular file, and then reloads every policy file.
      const untrack = await postPaths(endpoint, '/policy/untrack', ['other.md']);
      const status = await requestJsonStatus(
        endpoint,
        'GET',
        '/status',
        undefined,
        undefined,
        ROUTE_TIMEOUT_MS
      );
      const summary = status.body?.['policy_summary'] as Record<string, unknown> | undefined;
      assert.deepEqual(
        {
          track,
          untrack,
          planted: [stateOf(tracked), stateOf(target)],
          policy: {
            user_added_pattern_count: summary?.['user_added_pattern_count'],
            rejected_pattern_count: summary?.['rejected_pattern_count'],
          },
          warned: coordinator
            .stderr()
            .includes(
              `agent-coherence: WARNING — ${tracked} is a symlink; it loads as no entries\n`
            ),
        },
        {
          track: { status: 400, body: { error: linkRefusal('tracked.yaml') } },
          untrack: { status: 200, body: { ok: true, removed: ['other.md'], rejected: [] } },
          planted: [`link to ${target}`, `file ${JSON.stringify('- "theirs/**"\n')}`],
          policy: { user_added_pattern_count: 0, rejected_pattern_count: 1 },
          warned: true,
        },
        coordinator.stderr()
      );
    } finally {
      await killAndWait(coordinator.child);
    }
  })
);

/**
 * PolicyRef.load on each root given as JSON, one JSON line per root: the
 * patterns it loaded and what it rejected.
 */
const POLICY_LOAD_SCRIPT =
  'const [moduleUrl, roots] = process.argv.slice(1);\n' +
  'const { PolicyRef } = await import(moduleUrl);\n' +
  'for (const root of JSON.parse(roots)) {\n' +
  '  const policy = PolicyRef.load(root).get();\n' +
  '  const { userAddedPatterns: added, ignoredPatterns: ignored, strictModePaths: strict } = policy;\n' +
  "  process.stdout.write(JSON.stringify({ added, ignored, strict, rejected: policy.rejectedPatterns }) + '\\n');\n" +
  '}\n';

test(
  'PolicyRef.load loads none of a linked policy file and counts it rejected',
  { skip: process.platform === 'win32' },
  withBase(async (base) => {
    const target = join(base, 'theirs.yaml');
    writeFileSync(target, '- "theirs/**"\n');
    const fifo = join(base, 'pipe');
    makeFifo(fifo);
    const linked = join(base, 'linked', '.coherence');
    mkdirSync(linked, { recursive: true });
    symlinkSync(target, join(linked, 'tracked.yaml'));
    symlinkSync(join(base, 'gone'), join(linked, 'ignored.yaml'));
    symlinkSync(fifo, join(linked, 'strict_mode.yaml'));
    // Not a link: anything but a regular file still loads as no entries, without a word.
    const special = join(base, 'special', '.coherence');
    mkdirSync(special, { recursive: true });
    makeFifo(join(special, 'tracked.yaml'));

    const run = await runBounded(
      POLICY_LOAD_SCRIPT,
      [compiledModuleUrl('policy.js'), JSON.stringify([dirname(linked), dirname(special)])],
      { timeoutMs: CHILD_TIMEOUT_MS, fifos: [fifo, join(special, 'tracked.yaml')] }
    );

    const rows = run.stdout.split('\n').filter((line) => line !== '');
    const symlinkRejected = (file: string) => ({
      pattern: `.coherence/${file}`,
      reason: 'a symlink, so the file loads as no entries',
    });
    assert.deepEqual(
      {
        timedOut: run.timedOut,
        rows: rows.map((line) => JSON.parse(line) as unknown),
        warnings: run.stderr.split('\n').filter((line) => line !== ''),
      },
      {
        timedOut: false,
        rows: [
          {
            added: [],
            ignored: [],
            strict: [],
            rejected: [
              symlinkRejected('tracked.yaml'),
              symlinkRejected('ignored.yaml'),
              symlinkRejected('strict_mode.yaml'),
            ],
          },
          { added: [], ignored: [], strict: [], rejected: [] },
        ],
        warnings: ['tracked.yaml', 'ignored.yaml', 'strict_mode.yaml'].map(
          (file) =>
            `agent-coherence: WARNING — ${join(linked, file)} is a symlink; it loads as no entries`
        ),
      }
    );
  })
);
