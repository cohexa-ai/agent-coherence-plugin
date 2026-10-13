/**
 * Hook-client transport — Node port of the Python `_coherence_client.py`
 * endpoint resolution + authenticated HTTP (zero-Python Unit 3).
 *
 * Contract (parity-critical, see plan §Review corrections #4):
 * - Port ← `<root>/.coherence/server.pid` **line index 1 ONLY**. The Python
 *   coordinator writes 2 lines (`pid\nport\n`), the Node coordinator writes 3
 *   (`pid\nport\nbackend=node\n`) — the client must accept both and must
 *   NEVER depend on a `backend=` line existing.
 * - Bearer ← `<root>/.coherence/hook.secret`, trimmed, non-empty.
 * - POST/GET to `http://127.0.0.1:{port}{path}` with `Authorization: Bearer`,
 *   `Host: 127.0.0.1`, JSON content type. Redirects are NOT followed (node:http
 *   doesn't follow them; the bearer never leaves the original request).
 * - Workspace root ← `git rev-parse --git-common-dir` (absolute ⇒ linked
 *   worktree ⇒ parent-repo root = dirname(common)) else `--show-toplevel`;
 *   null when not in a git repo or git is missing (caller degrades silently).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { request } from "node:http";

export class CoordinatorUnavailable extends Error {}

/** Per-git-call wall-clock bound (mirrors the Python resolver's timeout=5.0). */
const GIT_TIMEOUT_MS = 5000;

export interface CoordinatorEndpoint {
  port: number;
  bearer: string;
}

/** Parent repo root from any path inside it (mirrors Python resolver.find_coordinator_root). */
export function findCoordinatorRoot(start?: string): string | null {
  const cwd = start ?? process.cwd();
  let common: string;
  try {
    common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // P1: bound every git call (mirrors Python's subprocess timeout=5.0). A
      // hung git (index.lock contention, stalled NFS) must NOT hang the
      // hook-client forever — that would defeat the always-exit-0 fail-open
      // contract on the critical path of every tool call. A timeout throws,
      // which the catch below turns into a clean null → {} at runMain.
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    return null;
  }
  if (common === "") return null;
  if (isAbsolute(common)) {
    // Linked worktree: common is .../parent-repo/.git — parent root is its dirname.
    return resolve(dirname(common));
  }
  try {
    const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    return toplevel === "" ? null : resolve(toplevel);
  } catch {
    return null;
  }
}

/** Port from server.pid: line index 1, int, 1..65535 — else null (mirrors Python read_port_from_file). */
export function readPortFromPidFile(pidFilePath: string): number | null {
  let text: string;
  try {
    text = readFileSync(pidFilePath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return null;
  const port = Number.parseInt(lines[1]!.trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * The `backend=<name>` a coordinator recorded on line index 2 of server.pid,
 * or null when there is none. The Node coordinator writes
 * `<pid>\n<port>\nbackend=node\n`; the Python coordinator writes no backend
 * line. Never needed to REACH a coordinator (the port is line 1 only) — read
 * solely to skip work a Node coordinator could never answer.
 */
export function readBackendFromPidFile(pidFilePath: string): string | null {
  let text: string;
  try {
    text = readFileSync(pidFilePath, 'utf8');
  } catch {
    return null;
  }
  const line = text.split(/\r?\n/)[2];
  if (line === undefined || !line.startsWith('backend=')) return null;
  const backend = line.slice('backend='.length).trim();
  return backend === '' ? null : backend;
}

/** Read port + bearer from `<root>/.coherence/` or throw CoordinatorUnavailable. */
export function resolveEndpoint(coordinatorRoot: string): CoordinatorEndpoint {
  const coherenceDir = join(coordinatorRoot, ".coherence");
  const pidFile = join(coherenceDir, "server.pid");
  const secretFile = join(coherenceDir, "hook.secret");

  const port = readPortFromPidFile(pidFile);
  if (port === null) {
    throw new CoordinatorUnavailable(`no coordinator running for this workspace (no port in ${pidFile})`);
  }
  let bearer: string;
  try {
    bearer = readFileSync(secretFile, "utf8").trim();
  } catch {
    throw new CoordinatorUnavailable(`coordinator authentication unavailable (missing ${secretFile})`);
  }
  if (bearer === "") {
    throw new CoordinatorUnavailable(`${secretFile} is empty`);
  }
  return { port, bearer };
}

/**
 * How long a hook waits for the coordinator. A hook runs on every tool call
 * and fails open, so a stalled coordinator must not hold the tool call long.
 */
export const HOOK_REQUEST_TIMEOUT_MS = 5000;

/**
 * How long `agent-coherence-status`, `-track` and `-untrack` wait: as long as
 * the Python console scripts do, so a /status answer the Python coordinator
 * sends after a late-won registry lock still arrives.
 */
export const CLI_REQUEST_TIMEOUT_MS = 6000;

/**
 * Authenticated JSON request. Resolves to the parsed body on 2xx, null on a
 * non-2xx response (the Python HTTPError→None degrade), and rejects on a
 * network error (caller maps to CoordinatorUnavailable semantics).
 */
export async function requestJson(
  endpoint: CoordinatorEndpoint,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const answer = await requestJsonStatus(endpoint, method, path, body, extraHeaders);
  return answer.status >= 200 && answer.status < 300 ? answer.body : null;
}

/**
 * The same request, resolving to the HTTP status beside the parsed body (null
 * when the body is not JSON). For callers that must tell a 404 (a route the
 * coordinator does not implement) from other refusals, or read a 400's
 * `{error}` — the caller-principal claim and its refusal report. `timeoutMs`
 * bounds how long the socket may sit idle; the hooks' limit unless given.
 */
export function requestJsonStatus(
  endpoint: CoordinatorEndpoint,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
  timeoutMs: number = HOOK_REQUEST_TIMEOUT_MS,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${endpoint.bearer}`,
      Host: "127.0.0.1",
      ...(payload !== null
        ? { "Content-Type": "application/json", "Content-Length": String(payload.length) }
        : {}),
      ...(extraHeaders ?? {}),
    };
    const req = request(
      { host: "127.0.0.1", port: endpoint.port, method, path, headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        // A connection that drops after the headers never fires `end`, and a
        // promise that never settles lets the process drain and exit 0, so a
        // caller would read a failed request as an empty success. Treat an
        // incomplete response as the network error it is.
        const cutOff = () =>
          rejectPromise(new Error("coordinator closed the connection before the response was complete"));
        res.on("error", cutOff);
        res.on("close", () => {
          if (!res.complete) cutOff();
        });
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          let parsed: Record<string, unknown> | null = null;
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            parsed =
              value !== null && typeof value === "object" && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : null;
          } catch {
            parsed = null;
          }
          resolvePromise({ status, body: parsed });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", (err) => rejectPromise(err));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * SHA-256 of the file at an absolute path, over RAW BYTES (parity-critical:
 * the Python client reads `rb` — no text decode, no newline normalization).
 * Returns null on any read failure (never crash the hook).
 */
export function hashFile(absolutePath: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  } catch {
    return null;
  }
}
