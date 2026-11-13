/**
 * Executables a test writes for itself: stub bootstraps, a fake `node` or
 * `gh`, a fake console script.
 *
 * macOS checks a newly written executable the first time it runs, and that
 * check is shared by every process on the machine. While the full suite runs
 * in parallel it queues: a first run measured 0.6 s on a busy host and over
 * 3 s under the suite's load, against about 20 ms for a file that has already
 * run. A test that spawns a stub it has just written, under a spawn timeout,
 * therefore failed only when the machine was busy (#219). Linux does no such
 * check, which is why CI never saw it.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** How long the one warm-up run may take before the fixture itself fails. */
const WARM_UP_TIMEOUT_MS = 120_000;

/**
 * Run `path` once with no arguments, untimed, so a timed run later never pays
 * macOS's first-run check. The check is per file, and a fresh checkout or
 * worktree writes this repo's own scripts anew, so a test that times one of
 * them runs it here first. The run must be harmless; its output and exit
 * status are ignored.
 */
export function runOnce(path: string, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): void {
  const run = spawnSync(path, [], { ...options, stdio: "ignore", timeout: WARM_UP_TIMEOUT_MS });
  if (run.error !== undefined) throw new Error(`could not run ${path}: ${run.error.message}`);
}

/** Write `content` to `path` as an executable, then `runOnce` it. */
export function writeExecutable(path: string, content: string): string {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
  runOnce(path);
  return path;
}
