/**
 * The coordinator's lock on server.pid (#217): one holder per file, visible to
 * the Python coordinator's flock probe, and gone with the process that held it.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LOCK_HELPERS,
  SHARED_LOCK_HELPERS,
  lockPidFile,
  lockWithHelpers,
  pidFileDeparture,
  probeLockWithHelpers,
  probePidFileLock,
  rewritePidFile,
  tryLockPidFile,
} from "../coordinator_lock.js";
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
const PERL_SHARED_HELPER = SHARED_LOCK_HELPERS.find(([command]) => command === "perl")!;
const FLOCK_SHARED_HELPER = SHARED_LOCK_HELPERS.find(([command]) => command === "flock")!;
const HAS_PERL = spawnSync("perl", ["-e", "exit 0"]).status === 0;
// flock(1) ships with util-linux and BusyBox, not with macOS.
const HAS_FLOCK = spawnSync("flock", ["--version"]).error === undefined;
const HAS_PYTHON = spawnSync("python3", ["-c", "pass"]).status === 0;

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

// The probe a client runs before it sends anything (cohexa-ai/agent-coherence#503).

test(
  "the probe reads a held lock as held and a free one as free, and leaves no lock behind",
  withPidFile(async (pidFile) => {
    writeFileSync(pidFile, "1\n2\n");
    const holder = await holdPidFileLock(pidFile);
    try {
      assert.equal(probePidFileLock(pidFile), "held");
    } finally {
      await killAndWait(holder);
    }
    assert.equal(probePidFileLock(pidFile), "free");
    const lock = tryLockPidFile(pidFile);
    try {
      assert.equal(lock.state, "held");
    } finally {
      closeIfOpen(lock);
    }
  }),
);

test(
  "the shared-lock helpers answer as the exclusive ones do",
  withPidFile(async (pidFile) => {
    writeFileSync(pidFile, "1\n2\n");
    const fd = openSync(pidFile, "r");
    try {
      assert.equal(probeLockWithHelpers(fd, [NO_SUCH_HELPER, ["sh", ["-c", "exit 2"]]]), null);
      assert.equal(probeLockWithHelpers(fd, [["sh", ["-c", "exit 3"]], ["sh", ["-c", "exit 0"]]]), null);
      assert.deepEqual(SHARED_LOCK_HELPERS.map(([command]) => command), ["perl", "flock"]);
    } finally {
      closeSync(fd);
    }
  }),
);

const SHARED_HELPERS = [
  ["perl", PERL_SHARED_HELPER, HAS_PERL],
  ["flock(1)", FLOCK_SHARED_HELPER, HAS_FLOCK],
] as const;

for (const [name, helper, present] of SHARED_HELPERS) {
  test(
    `the ${name} shared-lock helper reads a free lock as free and a coordinator holding it as held`,
    { skip: present ? false : `no ${name} on this host` },
    withPidFile(async (pidFile) => {
      writeFileSync(pidFile, "1\n2\n");
      const free = openSync(pidFile, "r");
      try {
        assert.equal(probeLockWithHelpers(free, [helper]), "free");
      } finally {
        closeSync(free);
      }
      const holder = await holdPidFileLock(pidFile);
      const fd = openSync(pidFile, "r");
      try {
        assert.equal(probeLockWithHelpers(fd, [helper]), "held");
      } finally {
        closeSync(fd);
        await killAndWait(holder);
      }
    }),
  );

  test(
    `the ${name} probe takes a shared lock, so a client probing never reads as a coordinator to another`,
    { skip: present ? false : `no ${name} on this host` },
    withPidFile(async (pidFile) => {
      writeFileSync(pidFile, "1\n2\n");
      // Another client in the middle of its probe: a shared lock on its own open of the file.
      const other = openSync(pidFile, "r");
      const second = openSync(pidFile, "r");
      try {
        assert.equal(probeLockWithHelpers(other, [helper]), "free");
        assert.equal(probeLockWithHelpers(second, [helper]), "free");
        assert.equal(probePidFileLock(pidFile), "free");
        assert.equal(tryLockPidFile(pidFile).state, "contended");
      } finally {
        closeSync(second);
        closeSync(other);
      }
    }),
  );
}

// Holds LOCK_EX on its own read-write open of argv[1], as the Python
// coordinator does (lifecycle.py), until its stdin closes.
const PYTHON_HOLD_LOCK =
  "import fcntl, os, sys\n" +
  "fd = os.open(sys.argv[1], os.O_RDWR)\n" +
  "fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\n" +
  "print('held', flush=True)\n" +
  "sys.stdin.read()\n";

test(
  "the probe reads a lock held as the Python coordinator holds it as held, and as free once that process is gone",
  { skip: HAS_PYTHON ? false : "no python3 on this host" },
  withPidFile(async (pidFile) => {
    writeFileSync(pidFile, "1\n2\n");
    const holder = spawn("python3", ["-I", "-c", PYTHON_HOLD_LOCK, pidFile], { stdio: ["pipe", "pipe", "inherit"] });
    const gone = new Promise((resolve) => holder.once("exit", resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        holder.stdout!.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("\n")) {
            if (output.trim() === "held") resolve();
            else reject(new Error(`python3 did not lock: ${output.trim()}`));
          }
        });
        holder.once("exit", (code) => reject(new Error(`python3 exited (${String(code)}) before locking`)));
      });
      assert.equal(probePidFileLock(pidFile), "held");
    } finally {
      holder.stdin!.end();
      await gone;
    }
    assert.equal(probePidFileLock(pidFile), "free");
  }),
);

// Whether server.pid still leads clients to the coordinator that published it (#234).

test(
  "server.pid still holding what a coordinator published, in the file it opened, leads clients to it",
  withPidFile(async (pidFile) => {
    const lock = tryLockPidFile(pidFile);
    try {
      assert.notEqual(lock.state, "contended");
      if (lock.state === "contended") return;
      rewritePidFile(lock.fd, "4242\n5151\nbackend=node\n");
      assert.equal(pidFileDeparture(pidFile, lock.fd, "4242\n5151\nbackend=node\n"), null);
    } finally {
      closeIfOpen(lock);
    }
  }),
);

test(
  "server.pid removed, alone or with its workspace, no longer leads clients to the coordinator",
  withPidFile(async (pidFile) => {
    const published = "4242\n5151\nbackend=node\n";
    const lock = tryLockPidFile(pidFile);
    try {
      if (lock.state === "contended") assert.fail("the lock is held");
      rewritePidFile(lock.fd, published);
      unlinkSync(pidFile);
      assert.match(pidFileDeparture(pidFile, lock.fd, published) ?? "", /server\.pid is gone/);
      rmSync(dirname(pidFile), { recursive: true, force: true });
      assert.match(pidFileDeparture(pidFile, lock.fd, published) ?? "", /server\.pid is gone/);
    } finally {
      closeIfOpen(lock);
    }
  }),
);

test(
  "server.pid replaced by another file, even with the same lines or a link to the old one, no longer leads clients to the coordinator",
  withPidFile(async (pidFile) => {
    const published = "4242\n5151\nbackend=node\n";
    const lock = tryLockPidFile(pidFile);
    try {
      if (lock.state === "contended") assert.fail("the lock is held");
      rewritePidFile(lock.fd, published);
      const kept = `${pidFile}.kept`;
      renameSync(pidFile, kept);
      writeFileSync(pidFile, published);
      assert.match(pidFileDeparture(pidFile, lock.fd, published) ?? "", /server\.pid is another file now/);
      unlinkSync(pidFile);
      symlinkSync(kept, pidFile);
      assert.match(pidFileDeparture(pidFile, lock.fd, published) ?? "", /server\.pid is another file now/);
    } finally {
      closeIfOpen(lock);
    }
  }),
);

test(
  "server.pid rewritten in place with other lines, as a second unlocked coordinator does, no longer leads clients to the coordinator",
  withPidFile(async (pidFile) => {
    const published = "4242\n5151\nbackend=node\n";
    const lock = tryLockPidFile(pidFile);
    try {
      if (lock.state === "contended") assert.fail("the lock is held");
      rewritePidFile(lock.fd, published);
      writeFileSync(pidFile, "6363\n7474\nbackend=node\n");
      assert.match(pidFileDeparture(pidFile, lock.fd, published) ?? "", /server\.pid no longer names this coordinator/);
    } finally {
      closeIfOpen(lock);
    }
  }),
);

test(
  "the probe never follows a link at server.pid",
  withPidFile(async (pidFile) => {
    const target = `${pidFile}.target`;
    writeFileSync(target, "1\n2\n");
    const holder = await holdPidFileLock(target);
    symlinkSync(target, pidFile);
    try {
      assert.equal(probePidFileLock(pidFile), null);
    } finally {
      await killAndWait(holder);
    }
  }),
);
