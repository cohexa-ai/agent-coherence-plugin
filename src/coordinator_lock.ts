/**
 * The single-coordinator lock on `.coherence/server.pid` (#217).
 *
 * A coordinator holds an exclusive BSD flock(2) on server.pid for its whole
 * life. It is the lock the Python coordinator takes on the same file
 * (lifecycle.py `_open_pidfile`, then `fcntl.flock(LOCK_EX | LOCK_NB)`) and the
 * one its liveness probe tests (`store_check._coordinator_holds_lock`, a
 * `LOCK_SH | LOCK_NB` attempt), so a second coordinator of either backend sees
 * this one, and the kernel drops the lock when the process dies, however it
 * dies.
 *
 * Node has no flock(). On macOS open(2) takes it in the same call, with
 * O_EXLOCK. Elsewhere a short-lived helper, perl or else flock(1), locks the
 * open file through an inherited descriptor and exits: a flock belongs to the
 * open file, not to the process that asked for it, so the lock stays with this
 * process's descriptor. A host with neither tool runs unlocked, as every Node
 * coordinator did before.
 *
 * The lock is on the inode. Unlinking server.pid while it is held lets the
 * next coordinator lock a new file beside a live one, so it is rewritten in
 * place and never unlinked.
 */
import { closeSync, constants, fsyncSync, ftruncateSync, openSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** From macOS <fcntl.h>; Node's fs.constants does not export it. */
const O_EXLOCK = 0x20;

/**
 * How long a start retries a held lock before it gives up. The lock is also
 * held for an instant by every probe (the bootstrap's, Python's store check)
 * and by a Python start that finds a Node store, so one refusal does not yet
 * mean a coordinator serves.
 */
export const LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 50;

export type PidFileLock =
  | { state: "held"; fd: number }
  | { state: "unlocked"; fd: number; reason: string }
  | { state: "contended" };

type LockHelper = readonly [command: string, args: readonly string[]];

/**
 * Each takes LOCK_EX | LOCK_NB on its fd 3 and exits 0 when it got it, 1 when
 * another holds it, 3 when the file system cannot lock it. perl comes first:
 * BusyBox flock(1) exits 1 for that last case too.
 */
export const LOCK_HELPERS: readonly LockHelper[] = [
  [
    "perl",
    [
      "-MFcntl=:flock",
      "-e",
      'open(my $fh, "+<&=", 3) or exit 2; exit 0 if flock($fh, LOCK_EX | LOCK_NB); exit($!{EWOULDBLOCK} ? 1 : 3)',
    ],
  ],
  ["flock", ["-x", "-n", "3"]],
];

/**
 * Lock the open file behind `fd` with the first helper that answers: "held",
 * "contended", or null when the file cannot be locked or no helper could say
 * (missing, or failing some other way).
 */
export function lockWithHelpers(fd: number, helpers: readonly LockHelper[] = LOCK_HELPERS): "held" | "contended" | null {
  for (const [command, args] of helpers) {
    const result = spawnSync(command, args, { stdio: ["ignore", "ignore", "ignore", fd] });
    if (result.status === 0) return "held";
    if (result.status === 1) return "contended";
    if (result.status === 3) return null;
  }
  return null;
}

// O_NOFOLLOW: a server.pid committed to a repository as a symlink must not
// let every coordinator start rewrite the file it points at.
function openPidFile(pidFile: string, extraFlags = 0): number {
  return openSync(pidFile, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | extraFlags, 0o600);
}

/** Errors meaning the file system cannot lock, not that another process holds the lock. */
const CANNOT_LOCK = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOLCK"]);

function tryLockWithOpenFlags(pidFile: string): PidFileLock {
  try {
    return { state: "held", fd: openPidFile(pidFile, O_EXLOCK | constants.O_NONBLOCK) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") return { state: "contended" };
    if (code === undefined || !CANNOT_LOCK.has(code)) throw err;
    return { state: "unlocked", fd: openPidFile(pidFile), reason: `its file system cannot lock it (${code})` };
  }
}

function tryLockWithHelpers(pidFile: string): PidFileLock {
  const fd = openPidFile(pidFile);
  const outcome = lockWithHelpers(fd);
  if (outcome === "held") return { state: "held", fd };
  if (outcome === null) return { state: "unlocked", fd, reason: "neither perl nor flock(1) could lock it" };
  closeSync(fd);
  return { state: "contended" };
}

/** One attempt to lock `pidFile`, creating it if needed. */
export function tryLockPidFile(pidFile: string): PidFileLock {
  // Gated on the platform: Linux ignores the O_EXLOCK bit and would open the
  // file without locking it, silently.
  return process.platform === "darwin" ? tryLockWithOpenFlags(pidFile) : tryLockWithHelpers(pidFile);
}

/** Lock `pidFile`, retrying a held lock for up to `waitMs`. */
export async function lockPidFile(pidFile: string, waitMs = LOCK_WAIT_MS): Promise<PidFileLock> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = tryLockPidFile(pidFile);
    if (lock.state !== "contended" || Date.now() >= deadline) return lock;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

/** Replace the content of the file open on `fd` in place, keeping its inode. */
export function rewritePidFile(fd: number, content: string): void {
  ftruncateSync(fd, 0);
  writeSync(fd, content, 0);
  fsyncSync(fd);
}
