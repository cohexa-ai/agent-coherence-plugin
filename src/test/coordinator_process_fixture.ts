/**
 * The real compiled coordinator, started as a child process on a test's own
 * workspace, and the waits a test needs around it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COORDINATOR_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'coordinator.js');
export const START_TIMEOUT_MS = 30_000;

export interface Coordinator {
  child: ChildProcess;
  stderr: () => string;
  exited: Promise<number | null>;
}

export function startCoordinator(ws: string, env: NodeJS.ProcessEnv = {}): Coordinator {
  const child = spawn(process.execPath, [COORDINATOR_JS], {
    cwd: ws,
    env: { ...process.env, AGENT_COHERENCE_WORKSPACE: ws, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code))
  );
  return { child, stderr: () => stderr, exited };
}

export function within<T>(
  what: string,
  promise: Promise<T>,
  timeoutMs = START_TIMEOUT_MS
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function waitFor<T>(
  what: string,
  probe: () => T | null,
  timeoutMs = START_TIMEOUT_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function pidFileOf(ws: string): string {
  return join(ws, '.coherence', 'server.pid');
}

/** The pid server.pid publishes with a port, or null while none is published. */
export function publishedPid(ws: string): number | null {
  let text: string;
  try {
    text = readFileSync(pidFileOf(ws), 'utf8');
  } catch {
    return null;
  }
  const [pid, port] = text.split('\n');
  return pid && port ? Number(pid) : null;
}
