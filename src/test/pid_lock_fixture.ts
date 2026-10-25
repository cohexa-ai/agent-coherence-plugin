/**
 * Processes that hold or probe the coordinator's lock on server.pid (#217),
 * for tests that need a lock held by a process other than the test's own.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The compiled lock module, as a URL a child process can import. */
export const LOCK_MODULE_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "coordinator_lock.js"),
).href;

/**
 * An ES module run with `node --input-type=module -e`, given the lock module's
 * URL, a server.pid path and the HoldOptions below as arguments ("" for
 * unset): takes the lock as a coordinator does, prints the outcome, and stays
 * alive holding it.
 */
const HOLD_LOCK_SCRIPT =
  "const [moduleUrl, pidFile, publish, publishWhen, exitWhen] = process.argv.slice(1);\n" +
  "const { existsSync } = await import('node:fs');\n" +
  "const { lockPidFile, rewritePidFile } = await import(moduleUrl);\n" +
  "const lock = await lockPidFile(pidFile);\n" +
  "const whenExists = (path, run) => {\n" +
  "  const timer = setInterval(() => { if (existsSync(path)) { clearInterval(timer); run(); } }, 20);\n" +
  "};\n" +
  "if (lock.state === 'held' && publish) {\n" +
  "  const write = () => rewritePidFile(lock.fd, publish.replaceAll('PID', String(process.pid)));\n" +
  "  if (publishWhen) whenExists(publishWhen, write); else write();\n" +
  "}\n" +
  "if (exitWhen) whenExists(exitWhen, () => process.exit(0));\n" +
  "process.stdout.write(lock.state + '\\n');\n" +
  "setInterval(() => {}, 60_000);\n";

export interface HoldOptions {
  /** server.pid content to write once locked; PID stands for the holder's pid. */
  publish?: string;
  /** Write `publish` only once this path exists. */
  publishWhen?: string;
  /** Exit, letting go of the lock, once this path exists. */
  exitWhen?: string;
}

/** Start a process that holds the lock on `pidFile`; resolves once it does. */
export function holdPidFileLock(pidFile: string, options: HoldOptions = {}): Promise<ChildProcess> {
  const args = [LOCK_MODULE_URL, pidFile, options.publish ?? "", options.publishWhen ?? "", options.exitWhen ?? ""];
  const holder = spawn(process.execPath, ["--input-type=module", "-e", HOLD_LOCK_SCRIPT, ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let output = "";
    holder.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (!output.includes("\n")) return;
      if (output.trim() === "held") resolve(holder);
      else {
        holder.kill("SIGKILL");
        reject(new Error(`lock holder did not get the lock: ${output.trim()}`));
      }
    });
    holder.once("exit", (code) => reject(new Error(`lock holder exited (${String(code)}) before locking`)));
  });
}

/** Kill `child` and wait until it is gone. */
export function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

// The probe the Python coordinator's store check runs on server.pid
// (store_check._coordinator_holds_lock): O_RDONLY | O_NOFOLLOW, then a shared
// non-blocking flock.
const PYTHON_FLOCK_PROBE =
  "import fcntl, os, sys\n" +
  "fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)\n" +
  "try:\n" +
  "    fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)\n" +
  "    print('free')\n" +
  "except BlockingIOError:\n" +
  "    print('held')\n";

/** What Python's flock probe says of `pidFile`, or null when python3 is not installed. */
export function pythonFlockProbe(pidFile: string): "held" | "free" | null {
  const probe = spawnSync("python3", ["-I", "-c", PYTHON_FLOCK_PROBE, pidFile], { encoding: "utf8" });
  if (probe.error !== undefined) return null;
  const verdict = probe.stdout.trim();
  if (verdict !== "held" && verdict !== "free") throw new Error(`python3 flock probe failed: ${probe.stderr}`);
  return verdict;
}
