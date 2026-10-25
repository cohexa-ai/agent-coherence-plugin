/**
 * The coordinator's lock on server.pid (#217): one holder per file, visible to
 * the Python coordinator's flock probe, and gone with the process that held it.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_HELPERS, lockPidFile, lockWithHelpers, tryLockPidFile } from "../coordinator_lock.js";
import { holdPidFileLock, killAndWait, pythonFlockProbe } from "./pid_lock_fixture.js";

function withPidFile(run: (pidFile: string, t: TestContext) => Promise<void>): (t: TestContext) => Promise<void> {
  return async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "coordinator-lock-"));
    try {
      await run(join(dir, "server.pid"), t);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function closeIfOpen(lock: ReturnType<typeof tryLockPidFile>): void {
  if (lock.state !== "contended") closeSync(lock.fd);
}

const NO_SUCH_HELPER = ["agent-coherence-no-such-lock-helper", []] as const;
const PERL_HELPER = LOCK_HELPERS.find(([command]) => command === "perl")!;
const FLOCK_HELPER = LOCK_HELPERS.find(([command]) => command === "flock")!;
const HAS_PERL = spawnSync("perl", ["-e", "exit 0"]).status === 0;
// flock(1) ships with util-linux and BusyBox, not with macOS.
const HAS_FLOCK = spawnSync("flock", ["--version"]).error === undefined;

test(
  "a held lock refuses a second one until the process holding it dies",
  withPidFile(async (pidFile) => {
    const holder = await holdPidFileLock(pidFile);
    try {
      assert.equal(tryLockPidFile(pidFile).state, "contended");
    } finally {
      await killAndWait(holder);
    }
    const lock = tryLockPidFile(pidFile);
    try {
      assert.equal(lock.state, "held");
    } finally {
      closeIfOpen(lock);
    }
  }),
);

test(
  "the Python coordinator's flock probe sees the lock",
  withPidFile(async (pidFile, t) => {
    const holder = await holdPidFileLock(pidFile);
    let whileHeld: string | null;
    try {
      whileHeld = pythonFlockProbe(pidFile);
    } finally {
      await killAndWait(holder);
    }
    if (whileHeld === null) {
      t.skip("no python3 on this host");
      return;
    }
    assert.equal(whileHeld, "held");
    assert.equal(pythonFlockProbe(pidFile), "free");
  }),
);

test(
  "a start waits out a holder that lets go within the wait",
  withPidFile(async (pidFile) => {
    const holder = await holdPidFileLock(pidFile);
    const released = new Promise((resolve) => setTimeout(resolve, 300)).then(() => killAndWait(holder));
    const lock = await lockPidFile(pidFile, 5000);
    await released;
    try {
      assert.equal(lock.state, "held");
    } finally {
      closeIfOpen(lock);
    }
  }),
);

test(
  "a start gives up once the wait is over while the holder stays",
  withPidFile(async (pidFile) => {
    const holder = await holdPidFileLock(pidFile);
    try {
      assert.equal((await lockPidFile(pidFile, 200)).state, "contended");
    } finally {
      await killAndWait(holder);
    }
  }),
);

test(
  "the helper path skips a missing helper and holds the lock after the helper exits",
  { skip: HAS_PERL ? false : "no perl on this host" },
  withPidFile(async (pidFile) => {
    const fd = openSync(pidFile, "a+", 0o600);
    try {
      assert.equal(lockWithHelpers(fd, [NO_SUCH_HELPER, PERL_HELPER]), "held");
      assert.equal(tryLockPidFile(pidFile).state, "contended");
      const second = openSync(pidFile, "a+", 0o600);
      try {
        assert.equal(lockWithHelpers(second, [PERL_HELPER]), "contended");
      } finally {
        closeSync(second);
      }
    } finally {
      closeSync(fd);
    }
    const lock = tryLockPidFile(pidFile);
    try {
      assert.equal(lock.state, "held");
    } finally {
      closeIfOpen(lock);
    }
  }),
);

test(
  "with no helper that can lock, the helper path reports no lock rather than a holder",
  withPidFile(async (pidFile) => {
    const fd = openSync(pidFile, "a+", 0o600);
    try {
      assert.equal(lockWithHelpers(fd, [NO_SUCH_HELPER]), null);
      // A helper that fails for another reason than a holder (exit 2: cannot
      // open fd 3) is not a holder either; the next one is asked.
      assert.equal(lockWithHelpers(fd, [["sh", ["-c", "exit 2"]], ["sh", ["-c", "exit 3"]]]), null);
      // Exit 3 says the file system cannot lock: no later helper is asked,
      // since BusyBox flock(1) would answer 1 there and read as a holder. That
      // is also why perl, which can say 3, is asked before flock(1).
      assert.equal(lockWithHelpers(fd, [["sh", ["-c", "exit 3"]], ["sh", ["-c", "exit 1"]]]), null);
      assert.deepEqual(LOCK_HELPERS.map(([command]) => command), ["perl", "flock"]);
    } finally {
      closeSync(fd);
    }
  }),
);

test(
  "the flock(1) helper holds the lock after it exits",
  { skip: HAS_FLOCK ? false : "no flock(1) on this host" },
  withPidFile(async (pidFile) => {
    const fd = openSync(pidFile, "a+", 0o600);
    try {
      assert.equal(lockWithHelpers(fd, [FLOCK_HELPER]), "held");
      assert.equal(tryLockPidFile(pidFile).state, "contended");
      assert.equal(pythonFlockProbe(pidFile) ?? "held", "held");
    } finally {
      closeSync(fd);
    }
  }),
);

test(
  "a server.pid that is a symlink is refused, and the file it points at is left alone",
  withPidFile(async (pidFile) => {
    // A repository can commit .coherence/server.pid as a symlink; locking it
    // would let every coordinator start rewrite the file it points at.
    const target = `${pidFile}.target`;
    writeFileSync(target, "keep\n");
    symlinkSync(target, pidFile);
    assert.throws(() => tryLockPidFile(pidFile), { code: "ELOOP" });
    assert.equal(readFileSync(target, "utf8"), "keep\n");
  }),
);
