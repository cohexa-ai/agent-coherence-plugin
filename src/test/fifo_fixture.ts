/**
 * FIFOs for tests of code that must never block on one, and a bounded child
 * process to run that code in.
 *
 * A blocking open or read of a FIFO stops the whole event loop it runs on. In
 * the test runner's own process that would park every test, so code that could
 * block runs in a child: the test gets its answer, or a timeout, and the child
 * is released and killed either way.
 */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { killAndWait } from './pid_lock_fixture.js';

/** A compiled module under `dist/`, as a URL a child process can import. */
export function compiledModuleUrl(file: string): string {
  return pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', file)).href;
}

export function makeFifo(path: string): void {
  execFileSync('mkfifo', [path]);
}

/**
 * Open and close the FIFO at `path` for writing, without blocking, so a reader
 * held in open(2) or read(2) on it goes on. Anything else at `path` is left
 * alone.
 */
export function releaseFifo(path: string): void {
  try {
    closeSync(openSync(path, constants.O_RDWR | constants.O_NONBLOCK));
  } catch {
    // Gone, or not a FIFO: nothing is waiting on it.
  }
}

export interface BoundedRun {
  stdout: string;
  stderr: string;
  /** True when the child had not exited within the time it was given. */
  timedOut: boolean;
}

/**
 * Run `script` as an ES module (`node --input-type=module -e`) with `args`,
 * and wait at most `timeoutMs` for it to exit. Afterwards each of `fifos` is
 * released and the child, if still running, is killed and waited for.
 */
export async function runBounded(
  script: string,
  args: string[],
  options: { timeoutMs: number; fifos: string[] }
): Promise<BoundedRun> {
  return runCommandBounded(
    process.execPath,
    ['--input-type=module', '-e', script, ...args],
    options
  );
}

/**
 * Run `command` with `args` as `runBounded` runs a script, in `cwd` with `env`
 * when given. `status` is the exit code, or null when the child had not exited
 * in time or a signal ended it.
 */
export async function runCommandBounded(
  command: string,
  args: string[],
  options: { timeoutMs: number; fifos: string[]; cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<BoundedRun & { status: number | null }> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  let timer: NodeJS.Timeout | undefined;
  const exited = new Promise<number | null>((resolve) =>
    child.once('close', (code) => resolve(code))
  );
  const expired = new Promise<'running'>((resolve) => {
    timer = setTimeout(() => resolve('running'), options.timeoutMs);
  });
  try {
    const outcome = await Promise.race([exited, expired]);
    return outcome === 'running'
      ? { stdout, stderr, timedOut: true, status: null }
      : { stdout, stderr, timedOut: false, status: outcome };
  } finally {
    clearTimeout(timer);
    for (const fifo of options.fifos) releaseFifo(fifo);
    await killAndWait(child);
  }
}
