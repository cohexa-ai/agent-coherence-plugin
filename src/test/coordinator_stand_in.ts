/**
 * The lock a running coordinator holds on server.pid, for tests that stand in
 * a coordinator of their own (cohexa-ai/agent-coherence#503).
 *
 * A client sends a request only while server.pid names a coordinator that
 * still holds the lock a start takes on that file. A test that writes the pid
 * file for a server it runs itself holds that lock too. The lock belongs to the
 * open file, so a client in this same process, or in a child it spawns, reads
 * it as held; it stays held until the test file's process exits.
 */
import { writeFileSync } from 'node:fs';
import { tryLockPidFile } from '../coordinator_lock.js';

const HELD = new Set<string>();

/** Hold the lock a running coordinator holds on `pidFile`. A file already held stays held. */
export function holdCoordinatorLock(pidFile: string): void {
  if (HELD.has(pidFile)) return;
  const lock = tryLockPidFile(pidFile);
  if (lock.state === 'contended') throw new Error(`another process holds the lock on ${pidFile}`);
  HELD.add(pidFile);
}

/** Write `content` to `pidFile` for a server the test runs, and hold its lock as that server's coordinator would. */
export function writeStandInPidFile(pidFile: string, content: string): void {
  writeFileSync(pidFile, content);
  holdCoordinatorLock(pidFile);
}
