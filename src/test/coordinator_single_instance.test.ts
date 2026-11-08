/**
 * One coordinator per workspace (#217), on the real compiled coordinator.
 *
 * A coordinator locks .coherence/server.pid before it opens state.db, so a
 * second start, from another session or at the same instant, exits and
 * leaves the store and the serving coordinator's files alone. Before, both
 * served: each wrote its own port into server.pid, and the first to stop
 * deleted the file the other still served under.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdPidFileLock, killAndWait, pythonFlockProbe } from "./pid_lock_fixture.js";
import {
  type Coordinator,
  pidFileOf,
  publishedPid,
  startCoordinator,
  waitFor,
  within,
} from "./coordinator_process_fixture.js";

/** server.pid's content once `pid` has published it with a port, or null before then. */
function publishedWithPortBy(ws: string, pid: number | undefined): string | null {
  let pidText: string;
  try {
    pidText = readFileSync(pidFileOf(ws), "utf8");
  } catch {
    return null;
  }
  const [publishedBy, port] = pidText.split("\n");
  return Number(publishedBy) === pid && port ? pidText : null;
}

function withWorkspace(
  run: (ws: string, started: Coordinator[], t: TestContext) => Promise<void>,
): (t: TestContext) => Promise<void> {
  return async (t) => {
    const ws = mkdtempSync(join(tmpdir(), "single-coordinator-"));
    const started: Coordinator[] = [];
    try {
      await run(ws, started, t);
    } finally {
      await Promise.all(started.map((c) => killAndWait(c.child)));
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  };
}

test(
  "two coordinators started at once on a fresh workspace: one serves, the other exits before opening the store",
  withWorkspace(async (ws, started) => {
    const a = startCoordinator(ws);
    const b = startCoordinator(ws);
    started.push(a, b);
    const { loser, winner, code } = await within(
      "either coordinator to exit",
      Promise.race([
        a.exited.then((exitCode) => ({ loser: a, winner: b, code: exitCode })),
        b.exited.then((exitCode) => ({ loser: b, winner: a, code: exitCode })),
      ]),
    );
    assert.equal(code, 0, `loser stderr:\n${loser.stderr()}`);
    assert.match(loser.stderr(), new RegExp(`another coordinator holds .*server\\.pid; exiting \\(pid=${loser.child.pid}\\)`));
    assert.doesNotMatch(loser.stderr(), /registry opened|fatal/);
    assert.equal(await waitFor("the winner to publish", () => publishedPid(ws)), winner.child.pid);
    assert.equal(winner.child.exitCode, null, `winner stderr:\n${winner.stderr()}`);
    assert.doesNotMatch(winner.stderr(), /fatal/);
  }),
);

test(
  "a coordinator started while one serves exits and leaves server.pid as it was",
  withWorkspace(async (ws, started) => {
    const serving = startCoordinator(ws);
    started.push(serving);
    await waitFor("the first coordinator to publish", () => publishedPid(ws));
    const before = readFileSync(pidFileOf(ws), "utf8");
    // The 3-line format the Python coordinator and the bootstrap read.
    assert.match(before, new RegExp(`^${serving.child.pid}\\n\\d+\\nbackend=node\\n$`));
    const inode = statSync(pidFileOf(ws)).ino;

    const second = startCoordinator(ws);
    started.push(second);
    assert.equal(await within("the second coordinator to exit", second.exited), 0, second.stderr());
    assert.match(second.stderr(), /another coordinator holds/);
    assert.equal(readFileSync(pidFileOf(ws), "utf8"), before);
    assert.equal(statSync(pidFileOf(ws)).ino, inode);
    assert.equal(serving.child.exitCode, null);
  }),
);

test(
  "a stopped coordinator keeps server.pid in place without its port, and the next one locks the same file",
  withWorkspace(async (ws, started, t) => {
    const first = startCoordinator(ws);
    started.push(first);
    await waitFor("the first coordinator to publish", () => publishedPid(ws));
    const inode = statSync(pidFileOf(ws)).ino;
    const pythonSaw = pythonFlockProbe(pidFileOf(ws));
    if (pythonSaw === null) t.diagnostic("no python3 on this host: the Python probe check did not run");
    else assert.equal(pythonSaw, "held", "the Python coordinator's probe must see a serving Node coordinator");

    first.child.kill("SIGTERM");
    assert.equal(await within("the first coordinator to stop", first.exited), 0, first.stderr());
    assert.equal(readFileSync(pidFileOf(ws), "utf8"), `${first.child.pid}\n`);
    assert.equal(statSync(pidFileOf(ws)).ino, inode);
    assert.equal(existsSync(join(ws, ".coherence", "server.port")), false, "no coordinator writes server.port");

    const next = startCoordinator(ws);
    started.push(next);
    await waitFor("the next coordinator to publish", () => (publishedPid(ws) === next.child.pid ? true : null));
    assert.equal(statSync(pidFileOf(ws)).ino, inode);
  }),
);

test(
  "a SIGKILLed coordinator's lock goes with it: the next start serves",
  withWorkspace(async (ws, started) => {
    const killed = startCoordinator(ws);
    started.push(killed);
    await waitFor("the first coordinator to publish", () => publishedPid(ws));
    await killAndWait(killed.child);

    const next = startCoordinator(ws);
    started.push(next);
    // The killed coordinator's lines stay in server.pid until the next one
    // takes the lock, so wait for the next one's own pid.
    await waitFor("the next coordinator to publish", () => (publishedPid(ws) === next.child.pid ? true : null));
    assert.doesNotMatch(next.stderr(), /another coordinator holds/);
  }),
);

test(
  "a start that finds the lock held only for an instant waits it out and serves",
  withWorkspace(async (ws, started) => {
    // Every probe of the lock (the bootstrap's, Python's store check) holds it
    // for an instant; a start that gave up at once would leave no coordinator.
    mkdirSync(join(ws, ".coherence"), { recursive: true });
    const holder = await holdPidFileLock(pidFileOf(ws));
    const coordinator = startCoordinator(ws);
    started.push(coordinator);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await killAndWait(holder);
    await waitFor("the coordinator to publish", () => (publishedPid(ws) === coordinator.child.pid ? true : null));
    assert.doesNotMatch(coordinator.stderr(), /another coordinator holds/);
  }),
);

test(
  "a start that fails after taking the lock leaves no dead coordinator's port behind",
  withWorkspace(async (ws, started) => {
    // Lines from a coordinator that died without stopping are cleared once
    // the lock is taken, before anything can fail, so no client keeps dialing
    // that dead port.
    mkdirSync(join(ws, ".coherence"), { recursive: true });
    writeFileSync(pidFileOf(ws), "99999\n12345\nbackend=node\n");
    mkdirSync(join(ws, ".coherence", "state.db"));
    const failing = startCoordinator(ws);
    started.push(failing);
    assert.equal(await within("the coordinator to fail", failing.exited), 1, failing.stderr());
    assert.match(failing.stderr(), /fatal/);
    assert.equal(readFileSync(pidFileOf(ws), "utf8"), "");
  }),
);

test(
  "on a host that cannot lock, coordinators run unlocked as before and remove only their own files on stop",
  { skip: process.platform === "darwin" ? "macOS always locks, with open(2)" : false },
  withWorkspace(async (ws, started) => {
    // An empty PATH leaves no perl and no flock(1); node itself is
    // process.execPath. Nothing stops a second coordinator here.
    const emptyBin = join(ws, "empty-bin");
    mkdirSync(emptyBin);
    const first = startCoordinator(ws, { PATH: emptyBin });
    started.push(first);
    await waitFor("the first coordinator to publish", () => publishedWithPortBy(ws, first.child.pid));
    assert.match(first.stderr(), /is not locked: neither perl nor flock\(1\) could lock it/);
    const second = startCoordinator(ws, { PATH: emptyBin });
    started.push(second);
    const secondPidFile = await waitFor("the second coordinator to publish", () => publishedWithPortBy(ws, second.child.pid));

    first.child.kill("SIGTERM");
    assert.equal(await within("the first coordinator to stop", first.exited), 0, first.stderr());
    assert.equal(readFileSync(pidFileOf(ws), "utf8"), secondPidFile);

    second.child.kill("SIGTERM");
    assert.equal(await within("the second coordinator to stop", second.exited), 0, second.stderr());
    assert.equal(existsSync(pidFileOf(ws)), false, "an unlocked coordinator removes its own server.pid, as before #217");
    assert.equal(existsSync(join(ws, ".coherence", "server.port")), false, "no coordinator writes server.port");
  }),
);
