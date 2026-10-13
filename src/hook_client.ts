/**
 * Node hook-client — replaces the Python `agent-coherence-hook-client`
 * console script (zero-Python Unit 3 / G1).
 *
 * Invoked by hooks.json as a command-type hook: reads Claude Code's hook
 * JSON payload on stdin, translates it to the coordinator request shape,
 * POSTs, and prints the coordinator's JSON response verbatim on stdout.
 *
 * THE INVARIANT CONTRACT (parity with the Python client): **exit code is
 * ALWAYS 0**, and on ANY failure — TTY stdin, empty/malformed stdin, no git
 * root, coordinator down, HTTP error, builder bug — print `{}` so Claude
 * Code never sees the hook block a tool call.
 *
 * Subcommands + payload translators are verbatim ports of
 * `ccs/cli/coherence_hook_client.py`:
 *   pre-read     PreToolUse:Read        → {session_id, path, content_hash?}
 *                (content_hash computed from disk — PreToolUse fires BEFORE
 *                the read; raw-bytes SHA-256; unreadable → omitted)
 *   pre-edit     PreToolUse:Edit|Write  → {session_id, path}
 *   post-edit    PostToolUse:Edit|Write → {session_id, path, success, content_hash?}
 *   session-stop Stop                   → {session_id}
 *   pre-bash     PreToolUse:Bash        → {session_id, command}
 *   pre-grep     PreToolUse:Grep       → {session_id, search_root}
 *
 * SB-10 U7 (no Python counterpart yet — the gate contract is shared):
 *   session-start SessionStart          → {session_id}, ONLY when the CC
 *                payload carries source == "compact" — any other source
 *                (startup/resume/clear) or an absent source skips fail-open
 *                with NO network call.
 *
 * SB-25 companion: when the CC payload carries a subagent `agent_id`, it is
 * threaded into the request body (additive). Both coordinators derive a
 * composite `(session_id, agent_id)` identity from it so subagents are
 * first-class coherence peers; an absent/malformed `agent_id` resolves to the
 * parent identity (except on subagent-stop, which requires a valid one).
 *
 * Caller principal (library caller-principal plan, U5): every request presents
 * the session's principal in the `Coherence-Caller-Principal` header, obtained
 * once per session and stored under `.coherence/` (see caller_principal.ts).
 * The Python coordinator requires it on its require-class routes for a
 * session a client has claimed. A refusal of it (HTTP 400 with a typed
 * `reason`) is recovered by re-claiming with the SAME stored mint nonce and
 * retrying the refused request once; if that cannot help, the hook degrades to
 * `{}` and says why on stderr. This Node coordinator issues none; its pid file
 * says `backend=node`, so the client does not claim and the request is exactly
 * what it was before.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isValidSubagentId } from "./agent_id.js";
import {
  obtainStoredPrincipal,
  principalHeaders,
  principalRefusalReason,
  recoverFromPrincipalRefusal,
} from "./caller_principal.js";
import {
  type CoordinatorEndpoint,
  CoordinatorUnavailable,
  findCoordinatorRoot,
  hashFile,
  requestJsonStatus,
  resolveEndpoint,
} from "./hook_client_transport.js";

/** Internal signal: nothing meaningful to do — emit `{}` (mirrors Python _SkipHook). */
export class SkipHook extends Error {}

type CcPayload = Record<string, unknown>;

export const SUBCOMMANDS = [
  "pre-read",
  "pre-edit",
  "post-edit",
  "session-stop",
  "subagent-stop",
  "pre-bash",
  "pre-grep",
  "session-start",
] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

const ENDPOINT_BY_SUBCOMMAND: Record<Subcommand, string> = {
  "pre-read": "/hooks/pre-read",
  "pre-edit": "/hooks/pre-edit",
  "post-edit": "/hooks/post-edit",
  "session-stop": "/hooks/session-stop",
  "subagent-stop": "/hooks/session-stop",
  "pre-bash": "/hooks/pre-bash",
  "pre-grep": "/hooks/pre-grep",
  "session-start": "/hooks/session-start",
};

// ----------------------------------------------------------------------
// Payload builders (exported for unit tests)
// ----------------------------------------------------------------------

function requireSessionId(cc: CcPayload): string {
  const sid = cc.session_id;
  if (typeof sid !== "string" || sid === "") throw new SkipHook("session_id missing");
  return sid;
}

function toolInput(cc: CcPayload): Record<string, unknown> {
  const ti = cc.tool_input;
  return ti !== null && typeof ti === "object" && !Array.isArray(ti)
    ? (ti as Record<string, unknown>)
    : {};
}

function requireFilePath(cc: CcPayload): string {
  const fp = toolInput(cc).file_path;
  if (typeof fp !== "string" || fp === "") throw new SkipHook("tool_input.file_path missing");
  return fp;
}

/** Absolute CC path → workspace-relative; outside the root → SkipHook (mirrors Python). */
export function toWorkspaceRelative(filePath: string, root: string): string {
  const rel = relative(root, resolve(filePath));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SkipHook(`path outside workspace root: ${filePath}`);
  }
  return rel;
}

/**
 * SB-25 thread: carry a subagent agent_id through when CC supplies one.
 * snake_case `agent_id` preferred, camelCase `agentId` fallback (wire
 * casing pinned by the R6 live capture) — mirrors readSubagentId.
 */
function withAgentId(cc: CcPayload, body: Record<string, unknown>): Record<string, unknown> {
  const aid = cc.agent_id !== undefined ? cc.agent_id : cc.agentId;
  if (typeof aid === "string" && aid !== "") body.agent_id = aid;
  return body;
}

export function buildPreRead(cc: CcPayload, root: string): Record<string, unknown> {
  const sessionId = requireSessionId(cc);
  const filePath = requireFilePath(cc);
  const rel = toWorkspaceRelative(filePath, root);
  const body: Record<string, unknown> = { session_id: sessionId, path: rel };
  // KTD-O: PreToolUse:Read fires BEFORE the read, so tool_response carries no
  // hash — compute it from disk (raw bytes) so the strict gate's hash_differs
  // branch is reachable. Unreadable → omit (falls back to INVALID-only).
  const contentHash = hashFile(resolve(filePath));
  if (contentHash !== null) body.content_hash = contentHash;
  return withAgentId(cc, body);
}

export function buildPreEdit(cc: CcPayload, root: string): Record<string, unknown> {
  const sessionId = requireSessionId(cc);
  const rel = toWorkspaceRelative(requireFilePath(cc), root);
  return withAgentId(cc, { session_id: sessionId, path: rel });
}

export function buildPostEdit(cc: CcPayload, root: string): Record<string, unknown> {
  const sessionId = requireSessionId(cc);
  const filePath = requireFilePath(cc);
  const rel = toWorkspaceRelative(filePath, root);
  const toolResponse =
    cc.tool_response !== null && typeof cc.tool_response === "object" && !Array.isArray(cc.tool_response)
      ? (cc.tool_response as Record<string, unknown>)
      : {};
  // Missing 'success' → true (if PostToolUse fired, the tool didn't hard-fail).
  const success = toolResponse.success === undefined ? true : Boolean(toolResponse.success);
  let contentHash =
    typeof toolResponse.content_hash === "string" ? toolResponse.content_hash : null;
  if (success && contentHash === null) {
    contentHash = hashFile(resolve(filePath));
  }
  const body: Record<string, unknown> = { session_id: sessionId, path: rel, success };
  if (contentHash !== null) body.content_hash = contentHash;
  return withAgentId(cc, body);
}

export function buildSessionStop(cc: CcPayload): Record<string, unknown> {
  return withAgentId(cc, { session_id: requireSessionId(cc) });
}

/**
 * SB-25 Unit 4: SubagentStop → scoped grant release via the session-stop
 * verb. The subagent identity is MANDATORY here — a SubagentStop payload
 * without an agent id must NOT fall back to the parent identity (that would
 * release the parent's live grants); absence skips (fail-open `{}`).
 */
export function buildSubagentStop(cc: CcPayload): Record<string, unknown> {
  const sessionId = requireSessionId(cc);
  const aid = cc.agent_id !== undefined ? cc.agent_id : cc.agentId;
  // P1 subagent-stop safety: reject a present-but-MALFORMED agent_id here
  // (the same charset/length rule the server applies), not just an absent
  // one. A non-empty invalid id would otherwise pass this guard, get nulled
  // by the server's readSubagentId, and degrade to a PARENT session-stop —
  // releasing the parent's live grants. Fail-open ({}) is correct: skipping
  // a doomed release is strictly safer than performing the wrong one.
  if (!isValidSubagentId(aid)) {
    throw new SkipHook("agent_id missing or malformed for subagent-stop");
  }
  return { session_id: sessionId, agent_id: aid };
}

/**
 * SB-10 U7: SessionStart → post-compaction re-grounding. The `source` gate
 * lives HERE, client-side (the endpoint trusts its caller and treats every
 * request as a compact event — U6 R1): only `source === "compact"` may
 * reach the coordinator. Any other source (startup/resume/clear) or an
 * absent source is not a compaction — SkipHook rides the fail-open ladder
 * to `{}` with NO network call. SessionStart stdin carries no agent_id;
 * withAgentId stays additive-only, so nothing is fabricated.
 */
export function buildSessionStart(cc: CcPayload): Record<string, unknown> {
  if (cc.source !== "compact") throw new SkipHook('source is not "compact"');
  return withAgentId(cc, { session_id: requireSessionId(cc) });
}

export function buildPreBash(cc: CcPayload): Record<string, unknown> {
  const sessionId = requireSessionId(cc);
  const command = toolInput(cc).command;
  if (typeof command !== "string" || command.trim() === "") {
    throw new SkipHook("tool_input.command missing or empty");
  }
  return withAgentId(cc, { session_id: sessionId, command });
}

export function buildPreGrep(cc: CcPayload, root: string): Record<string, unknown> {
  const sessionId = requireSessionId(cc);
  let rawPath = toolInput(cc).path ?? "";
  if (rawPath === null) rawPath = "";
  if (typeof rawPath !== "string") throw new SkipHook("tool_input.path must be a string");
  // Subagent invocations pass ABSOLUTE search roots (2026-05-24 launch-gate
  // finding); direct invocations pass workspace-relative (possibly "./…").
  const searchRoot =
    rawPath !== "" && isAbsolute(rawPath)
      ? toWorkspaceRelative(rawPath, root)
      : rawPath.startsWith("./")
        ? rawPath.slice(2)
        : rawPath;
  return withAgentId(cc, { session_id: sessionId, search_root: searchRoot });
}

export function buildPayload(sub: Subcommand, cc: CcPayload, root: string): Record<string, unknown> {
  switch (sub) {
    case "pre-read":
      return buildPreRead(cc, root);
    case "pre-edit":
      return buildPreEdit(cc, root);
    case "post-edit":
      return buildPostEdit(cc, root);
    case "session-stop":
      return buildSessionStop(cc);
    case "subagent-stop":
      return buildSubagentStop(cc);
    case "pre-bash":
      return buildPreBash(cc);
    case "pre-grep":
      return buildPreGrep(cc, root);
    case "session-start":
      return buildSessionStart(cc);
  }
}

// ----------------------------------------------------------------------
// Entry
// ----------------------------------------------------------------------

function emitEmpty(): void {
  process.stdout.write("{}\n");
}

/** One diagnostic line on stderr; stdout and the exit code are unaffected. */
function report(message: string): void {
  process.stderr.write(`agent-coherence-hook-client: ${message}\n`);
}

/**
 * POST the hook's payload presenting the session's caller principal, and
 * recover a principal refusal: re-claim with the stored mint nonce (see
 * recoverFromPrincipalRefusal) and retry ONCE — safe because a refused request
 * changed nothing. Resolves to the body of a 2xx answer, else null; any other
 * non-2xx degrades to `{}` exactly as before. Rejects on a transport failure.
 */
async function postPresentingPrincipal(
  endpoint: CoordinatorEndpoint,
  root: string,
  route: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const sessionId = String(payload.session_id);
  const post = (principal: string | null) =>
    requestJsonStatus(endpoint, "POST", route, payload, principalHeaders(principal));
  const presented = await obtainStoredPrincipal(endpoint, root, sessionId, report);
  let answer = await post(presented);
  const reason = principalRefusalReason(answer);
  if (reason !== null) {
    const context = { endpoint, root, sessionId, report };
    const retry = await recoverFromPrincipalRefusal(context, presented, reason);
    if (retry !== null) {
      answer = await post(retry.principal);
      const again = principalRefusalReason(answer);
      if (again !== null) {
        report(
          `coordinator refused this hook's caller principal again after the re-claim (${again}); ` +
            "not retrying again",
        );
      }
    }
  }
  return answer.status >= 200 && answer.status < 300 ? answer.body : null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Full dispatch. NEVER throws; always resolves to exit code 0. */
export async function runMain(argv: string[]): Promise<number> {
  try {
    // argv: [sub] or [sub, --root, <path>] in any flag order.
    const positional = argv.filter((a) => !a.startsWith("--"));
    const rootFlagIdx = argv.indexOf("--root");
    const rootArg = rootFlagIdx !== -1 ? argv[rootFlagIdx + 1] : undefined;
    const sub = positional[0] as Subcommand | undefined;
    if (sub === undefined || !SUBCOMMANDS.includes(sub)) {
      emitEmpty();
      return 0;
    }

    if (process.stdin.isTTY) {
      process.stderr.write(
        "agent-coherence-hook-client: stdin is a terminal — this command expects a Claude Code hook JSON payload on stdin.\n",
      );
      emitEmpty();
      return 0;
    }

    const raw = await readStdin();
    if (raw.trim() === "") {
      emitEmpty();
      return 0;
    }
    let cc: CcPayload;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        emitEmpty();
        return 0;
      }
      cc = parsed as CcPayload;
    } catch {
      emitEmpty();
      return 0;
    }

    const root = rootArg ?? findCoordinatorRoot();
    if (root === null || root === undefined) {
      emitEmpty();
      return 0;
    }
    const rootResolved = resolve(root);

    let endpoint;
    try {
      endpoint = resolveEndpoint(rootResolved);
    } catch (err) {
      if (err instanceof CoordinatorUnavailable) {
        emitEmpty();
        return 0;
      }
      throw err;
    }

    let response: Record<string, unknown> | null;
    try {
      const payload = buildPayload(sub, cc, rootResolved);
      const route = ENDPOINT_BY_SUBCOMMAND[sub];
      response = await postPresentingPrincipal(endpoint, rootResolved, route, payload);
    } catch {
      // SkipHook, network error, builder bug — degrade silently.
      emitEmpty();
      return 0;
    }

    if (response === null) {
      emitEmpty();
      return 0;
    }
    process.stdout.write(JSON.stringify(response) + "\n");
    return 0;
  } catch {
    // Top-level backstop: the hook contract is exit 0 + parseable stdout, always.
    emitEmpty();
    return 0;
  }
}

// Run when invoked directly (node dist/hook_client.js <sub>), not on import.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runMain(process.argv.slice(2)).then((code) => process.exit(code));
}
