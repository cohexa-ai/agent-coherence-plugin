/**
 * Node coordinator entry point.
 *
 * Wires ensureSecret + HTTP server. Listens on an ephemeral port on
 * 127.0.0.1; writes <pid>\n<port>\nbackend=node\n to
 * <workspace>/.coherence/server.pid for hook clients to discover.
 *
 * v0.1.1 Unit 1 (this commit) lands the minimal startup path:
 *   - resolve workspace root (env var, fallback to CWD)
 *   - ensure .coherence/ dir + hook.secret
 *   - start HTTP server on ephemeral port (R21 body cap + auth wired)
 *   - write server.pid with 3-line format (KTD-A.5 point 1 backend field)
 *   - graceful shutdown on SIGINT/SIGTERM (drops the port from server.pid; closes server)
 *
 * Since #217 it also locks server.pid for its whole life (coordinator_lock.ts),
 * so a workspace has one coordinator of either backend.
 *
 * NOT in this commit (deferred to subsequent Unit 1 commits / Unit 2):
 *   - lifecycle: idle-shutdown, race-safe spawn-or-join
 *   - SQLite registry + migration runner (Unit 2)
 *   - /status three-tier (KTD-K)
 *   - hook handler routes (Unit 3)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { ensureSecret } from "./auth.js";
import { createServer, BIND_HOST } from "./server.js";
import { ArtifactRegistry } from "./registry.js";
import { PolicyRef } from "./policy.js";
import { SessionRegistry } from "./sessions.js";
import { readPackageVersion } from "./version.js";
import { lockPidFile, rewritePidFile } from "./coordinator_lock.js";

interface Workspace {
  root: string;
  coherenceDir: string;
  pidFile: string;
  portFile: string;
  databasePath: string;
}

function resolveWorkspace(): Workspace {
  const root = resolve(process.env["AGENT_COHERENCE_WORKSPACE"] ?? process.cwd());
  const coherenceDir = join(root, ".coherence");
  return {
    root,
    coherenceDir,
    pidFile: join(coherenceDir, "server.pid"),
    portFile: join(coherenceDir, "server.port"),
    databasePath: join(coherenceDir, "state.db"),
  };
}

function pidFileContent(pid: number, port: number, backend: "node"): string {
  // 3-line format: extends v0.1's <pid>\n<port>\n with a backend= field per
  // KTD-A.5 point 1. Python's read_port_from_file picks line 2 as port and
  // ignores subsequent lines for backwards compatibility; v0.1.1 Python
  // coordinator (Unit 6) gains backend-discrimination via the third line.
  return `${pid}\n${port}\nbackend=${backend}\n`;
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function writePortFile(portFile: string, port: number): void {
  // Mirror Python coordinator's <workspace>/.coherence/server.port (single-line port).
  writeFileSync(portFile, `${port}\n`, { mode: 0o600 });
}

function logInfo(message: string): void {
  // Stderr-only logging per Claude Code hook conventions; stdout is reserved
  // for hook response JSON (when invoked as a hook command). The coordinator
  // process itself is long-running, so stdout/stderr both go to the operator's
  // log surface — but stderr is the conventional channel.
  process.stderr.write(`agent-coherence-coordinator: ${message}\n`);
}

async function main(): Promise<void> {
  const startedAtMs = Date.now();
  // Read before any filesystem side effects: an unreadable package.json means
  // a broken install, surfaced via the main().catch fatal path below.
  const version = readPackageVersion();
  const workspace = resolveWorkspace();

  mkdirSync(workspace.coherenceDir, { recursive: true, mode: 0o700 });
  // #217: one coordinator per workspace. Locked before anything else here
  // touches the workspace, so a start that loses leaves the store and the
  // serving coordinator's files alone.
  const pidLock = await lockPidFile(workspace.pidFile);
  if (pidLock.state === "contended") {
    // The pid tells a session's bootstrap that the coordinator it started lost.
    logInfo(`another coordinator holds ${workspace.pidFile}; exiting (pid=${process.pid})`);
    return;
  }
  if (pidLock.state === "unlocked") {
    logInfo(`${workspace.pidFile} is not locked: ${pidLock.reason}; nothing stops a second coordinator for this workspace`);
  } else {
    // Lines a coordinator that died without stopping left behind. Cleared
    // before binding, as the Python coordinator does, so no client dials
    // that dead port while this one starts.
    rewritePidFile(pidLock.fd, "");
  }
  // KTD-13 + README "auto-gitignored" claim: write .coherence/.gitignore
  // containing `*` so a careless `git add .` doesn't accidentally commit
  // state.db (MESI state + agent UUIDs), hook.secret (a credential), or
  // server.pid. Mirrors lifecycle._ensure_coherence_dir in the library's
  // Python coordinator. Idempotent — only write if missing so operator
  // customizations are never clobbered.
  const gitignorePath = join(workspace.coherenceDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "*\n", { mode: 0o600 });
  }
  const secret = ensureSecret(workspace.coherenceDir);

  // Open the SQLite registry. Unit 1 ships with an empty MIGRATIONS list so
  // this is just an open-WAL-and-close lifecycle wired into shutdown; Unit 2
  // appends real migrations and exposes MESI methods on the registry.
  const registry = new ArtifactRegistry(workspace.databasePath);
  logInfo(
    `registry opened at ${workspace.databasePath} ` +
      `(schema_version=${registry.getStats().schemaVersion}, ` +
      `migrations_applied=${registry.getStats().migrationsApplied})`,
  );

  const policy = PolicyRef.load(workspace.root);
  const policySummary = policy.summary();
  logInfo(
    `policy loaded (defaults=${policySummary.default_pattern_count}, ` +
      `user_added=${policySummary.user_added_pattern_count}, ` +
      `ignored=${policySummary.ignored_pattern_count}, ` +
      `rejected=${policySummary.rejected_pattern_count})`,
  );

  const sessions = new SessionRegistry();

  const server = createServer({
    secret,
    startedAtMs,
    version,
    registry,
    policy,
    sessions,
  });

  // What this coordinator published, once it has: on shutdown an unlocked
  // coordinator touches the files only while they are still these.
  let publishedPidFile: string | null = null;
  let publishedPortFile: string | null = null;

  // Bind to ephemeral port on loopback. Per KTD-A.5 + Open Questions:
  // BIND_HOST = "127.0.0.1" is a code-level invariant; no operator override.
  server.listen(0, BIND_HOST, () => {
    // ce-review correctness fix: the previous version threw from inside this
    // callback. The throw becomes an uncaughtException at event-loop turn,
    // produces a noisy stack trace, and leaves no pid file behind for the
    // SessionStart hook to interrogate. Log + clean exit instead.
    const address = server.address();
    if (address === null || typeof address === "string") {
      process.stderr.write(
        `agent-coherence-coordinator: fatal: unexpected server address shape: ${String(address)}\n`,
      );
      process.exit(1);
    }
    const port = address.port;

    try {
      // Through the locked descriptor: the lock is on this inode.
      publishedPidFile = pidFileContent(process.pid, port, "node");
      rewritePidFile(pidLock.fd, publishedPidFile);
      writePortFile(workspace.portFile, port);
      publishedPortFile = `${port}\n`;
    } catch (err) {
      process.stderr.write(
        `agent-coherence-coordinator: fatal: failed to write pid/port file: ${String(err)}\n`,
      );
      process.exit(1);
    }

    logInfo(`spawned at ${BIND_HOST}:${port} (pid=${process.pid}, host=${hostname()})`);
    logInfo(`workspace=${workspace.root}; pid_file=${workspace.pidFile}`);
  });

  // Graceful shutdown. Drops the port from server.pid and removes server.port
  // so peer hook clients see no stale references; closes the HTTP server
  // (in-flight requests get drained by Node's default close-on-idle behavior
  // — Unit 5 lands the explicit in-flight semaphore drain per KTD-I).
  // A locked server.pid stays: the lock is on its inode, and the next
  // coordinator must lock the same file (#217). Its port goes before the exit
  // releases the lock, as on the Python coordinator, so a start that takes
  // the lock next finds no port to dial. Unlocked, both files are removed as
  // before #217, and only while they still hold what this coordinator wrote:
  // they may be another coordinator's.
  const shutdown = (signal: NodeJS.Signals): void => {
    logInfo(`shutting down on ${signal}`);
    const holdsLock = pidLock.state === "held";
    if (holdsLock && publishedPidFile !== null) {
      try {
        rewritePidFile(pidLock.fd, `${process.pid}\n`);
      } catch (err) {
        logInfo(`dropping the port from pidFile failed: ${String(err)}`);
      }
    } else if (publishedPidFile !== null && readFileOrNull(workspace.pidFile) === publishedPidFile) {
      try {
        unlinkSync(workspace.pidFile);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          logInfo(`unlink pidFile failed: ${String(err)}`);
        }
      }
    }
    if (publishedPortFile !== null && (holdsLock || readFileOrNull(workspace.portFile) === publishedPortFile)) {
      try {
        unlinkSync(workspace.portFile);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          logInfo(`unlink portFile failed: ${String(err)}`);
        }
      }
    }
    server.close((closeErr) => {
      try {
        registry.close();
      } catch (err) {
        logInfo(`registry.close error: ${String(err)}`);
      }
      if (closeErr !== undefined) {
        logInfo(`server.close error: ${String(closeErr)}`);
        process.exit(1);
      }
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`agent-coherence-coordinator: fatal: ${String(err)}\n`);
  process.exit(1);
});
