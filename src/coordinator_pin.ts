/**
 * Whether the coordinator a server.pid names still runs
 * (cohexa-ai/agent-coherence#503). Node port of the library's
 * `coordinator_pin`.
 *
 * A client finds the coordinator through the port in .coherence/server.pid
 * and sends the workspace bearer with every request. Once the coordinator
 * exits, its port is free and any local process can bind it. A coordinator
 * holds an exclusive flock on server.pid for its whole life
 * (coordinator_lock.ts), so a free lock means the coordinator the file names
 * is gone. A Node coordinator records `backend=node`, and there its pid
 * decides unless the lock is seen held: its lock dies with its pid, and where
 * it runs unlocked the probe cannot tell either.
 *
 * Every answer leans toward "still running": only evidence that the
 * coordinator exited reads as gone, a free lock or a Node pid that no longer
 * runs, and a lock this cannot probe is evidence of nothing.
 * server.pid is read as a regular file only, never through a link at it or at
 * .coherence.
 */
import { join } from 'node:path';
import { linkRefusalMessage } from './coherence_dir.js';
import { probePidFileLock } from './coordinator_lock.js';
import { NOT_REGULAR, readStateFile } from './disk_content.js';

export const PID_FILE_NAME = 'server.pid';
/** A pid file holds three short lines; anything longer is not one. */
export const PID_FILE_MAX_BYTES = 4096;
/** The `backend=` value a Node coordinator writes on the pid file's third line. */
export const NODE_BACKEND = 'node';

/** What a pid file says; each is null when its line is absent or malformed. */
export interface PidFileLines {
  pid: number | null;
  port: number | null;
  backend: string | null;
}

/** Why a pid file was not read. */
export type PidFileUnread = 'absent' | 'unreadable' | 'link' | 'not_regular' | 'too_large';

export type PidFileRead =
  { status: 'read'; path: string; lines: PidFileLines } | { status: PidFileUnread; path: string };

/** The lines of a pid file: `<pid>`, `<port>`, `backend=<name>`; a pid is positive, a port 1..65535. */
export function parsePidFile(text: string): PidFileLines {
  const lines = text.split(/\r?\n/);
  const pid = intLine(lines[0]);
  const port = intLine(lines[1]);
  return {
    pid: pid !== null && pid > 0 ? pid : null,
    port: port !== null && port >= 1 && port <= 65535 ? port : null,
    backend: backendLine(lines[2]),
  };
}

function intLine(line: string | undefined): number | null {
  if (line === undefined) return null;
  const value = Number.parseInt(line.trim(), 10);
  return Number.isInteger(value) ? value : null;
}

function backendLine(line: string | undefined): string | null {
  if (line === undefined || !line.startsWith('backend=')) return null;
  const backend = line.slice('backend='.length).trim();
  return backend === '' ? null : backend;
}

const FAILED_READS: Readonly<Record<string, PidFileUnread>> = {
  ENOENT: 'absent',
  ELOOP: 'link',
  EISDIR: 'not_regular',
  [NOT_REGULAR]: 'not_regular',
  EFBIG: 'too_large',
};

/**
 * `name` in `coherenceDir` read as a pid file. A link's `path` is what was
 * refused: the file, or `coherenceDir` itself.
 */
export function readPidFile(coherenceDir: string, name = PID_FILE_NAME): PidFileRead {
  const path = join(coherenceDir, name);
  let text: string;
  try {
    text = readStateFile(coherenceDir, name, PID_FILE_MAX_BYTES).toString('utf8');
  } catch (err) {
    const { code, path: refused } = err as NodeJS.ErrnoException;
    const status = FAILED_READS[code ?? ''] ?? 'unreadable';
    return { status, path: status === 'link' ? (refused ?? path) : path };
  }
  return { status: 'read', path, lines: parsePidFile(text) };
}

/**
 * Whether a process may run with `pid`. Signal 0 checks without signalling.
 * EPERM means a process exists that this one may not signal: another user's,
 * or this user's own behind a sandbox that denies signals, so it counts as
 * alive. Any other error (no such process, a pid no process can have) does not.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * What shows that the coordinator `lines` name has exited, or null while
 * nothing does. Without `backend=node`, a free lock. With it, a pid that no
 * longer runs, unless the lock is seen held: a Node coordinator's lock dies
 * with its pid, and where it runs unlocked a probe cannot tell either.
 */
export function exitEvidence(pidFile: string, lines: PidFileLines): string | null {
  if (lines.backend !== NODE_BACKEND) {
    return probePidFileLock(pidFile) === 'free' ? 'no longer holds the workspace lock' : null;
  }
  // A live pid is no evidence whatever the lock says, so it costs no probe: a
  // helper process where open(2) cannot lock.
  if (lines.pid === null || isPidAlive(lines.pid)) return null;
  return probePidFileLock(pidFile) === 'held' ? null : 'is no longer running';
}

/** The coordinator a local client resolved: the lines its pid file held at that read. */
export interface CoordinatorPin {
  coherenceDir: string;
  lines: PidFileLines;
}

/**
 * Why the coordinator `pin` names may no longer be the one on its port, or
 * null while it still is or this cannot tell.
 */
export function pinDeparture(pin: CoordinatorPin): string | null {
  const read = readPidFile(pin.coherenceDir);
  if (read.status !== 'read') return unreadDeparture(pin, read);
  const { pid, port } = read.lines;
  const { pid: pinnedPid, port: pinnedPort } = pin.lines;
  if (pid !== pinnedPid || port !== pinnedPort) {
    return (
      `${read.path} now names pid ${pid} on port ${port}, ` +
      `not the coordinator this client resolved (pid ${pinnedPid}, port ${pinnedPort})`
    );
  }
  const evidence = exitEvidence(read.path, read.lines);
  return evidence === null
    ? null
    : `the coordinator ${read.path} names (pid ${pinnedPid}) ${evidence}`;
}

/**
 * pinDeparture for a pid file that could not be read. Gone or unreadable is
 * cannot tell, so an attached client keeps working, except that a Node
 * coordinator, which removes the file when it stops unlocked, is still judged
 * by its pid. A link or a file that is no pid file is never read, and refuses.
 */
function unreadDeparture(pin: CoordinatorPin, read: PidFileRead): string | null {
  const { pid, backend } = pin.lines;
  switch (read.status) {
    case 'absent':
    case 'unreadable':
      if (backend !== NODE_BACKEND || pid === null || isPidAlive(pid)) return null;
      return `the Node coordinator ${read.path} named (pid ${pid}) is no longer running`;
    case 'link':
      return linkRefusalMessage(read.path, pin.coherenceDir);
    case 'too_large':
      return `${read.path} is larger than a pid file (${PID_FILE_MAX_BYTES} bytes)`;
    default:
      return `${read.path} is no longer a regular file`;
  }
}
