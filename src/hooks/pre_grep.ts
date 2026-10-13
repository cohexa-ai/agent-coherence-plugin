/**
 * POST /hooks/pre-grep — KTD-N H4 mitigation, Grep variant (zero-Python Unit 2).
 *
 * Node port of Python `_handle_pre_grep` (coordinator_server.py:2424).
 * Enumerates registry-known artifacts under `search_root` and surfaces
 * stale-read warnings. Unlike pre-bash there is NO first-observation
 * seeding (unknown artifacts are skipped) and the re-grant trigger is
 * "post_stale_grep". Warn-parity in Unit 2; strict lands in Unit 6.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MESIState } from "../states.js";
import { emitStrictDeny, nowUnix, type StaleSummary } from "../hook_payloads.js";
import {
  applyRegrants,
  drainNoticeText,
  isValidPath,
  isValidSessionId,
  nowTick as nowTickFn,
  readJsonBody,
  readSubagentId,
  type HookDeps,
  type Regrant,
  writeError,
  writeJson,
} from "./_common.js";
import { deliverPendingReground, writeFastAdmit } from "./reground.js";

interface PreGrepBody {
  session_id?: unknown;
  search_root?: unknown;
}

export async function handlePreGrep(
  body: PreGrepBody,
  res: ServerResponse,
  deps: HookDeps,
): Promise<void> {
  if (!isValidSessionId(body.session_id)) {
    writeError(res, 400, "missing session_id");
    return;
  }
  const searchRoot = body.search_root ?? "";
  if (typeof searchRoot !== "string") {
    writeError(res, 400, "missing or empty path");
    return;
  }
  // "" = workspace root; a non-empty root must be a safe relative path.
  if (searchRoot !== "" && !isValidPath(searchRoot)) {
    writeError(res, 400, "missing or empty path");
    return;
  }
  const sessionId: string = body.session_id;

  // SB-10 U8 (KTD6): the allow-attach seam — runs after the strict-deny
  // decision; deny bodies pass through untouched.
  const withReground = (result: object): Record<string, unknown> =>
    deliverPendingReground(deps, sessionId, body as Record<string, unknown>, result);

  // SB-10 U8 (KTD6): the zero-tracked exit goes through writeFastAdmit's compact-pending peek.
  const trackedPaths = deps.registry.artifactNamesUnderPrefix(searchRoot);
  if (trackedPaths.length === 0) {
    writeFastAdmit(res, deps, sessionId, body as Record<string, unknown>, { status: "fresh" });
    return;
  }

  const agentId = deps.sessions.registerSession(body.session_id, readSubagentId(body as Record<string, unknown>));
  const now = nowTickFn();

  const staleSummaries: Array<{ path: string; current_version: number }> = [];
  let strictStaleFirst: StaleSummary | null = null;
  const regrants: Regrant[] = [];
  for (const path of trackedPaths) {
    const existing = deps.registry.getArtifactByName(path);
    if (existing === null) continue; // no seeding on the grep path
    const agentState = deps.registry.getAgentState(existing.id, agentId);
    if (agentState !== null && agentState !== MESIState.INVALID) continue;
    staleSummaries.push({ path, current_version: existing.version });
    if (strictStaleFirst === null && deps.policy.isStrictMode(path)) {
      // R7: the registry's handle for the writer, not a recovered session id.
      const lastWriterAgent = existing.last_writer_id;
      strictStaleFirst = {
        path,
        current_version: existing.version,
        // R8: the observed version, not the inferred one -- see pre_read.ts.
        prior_version_seen_by_session:
          agentState === MESIState.INVALID
            ? (deps.registry.lastObservedVersionFor(existing.id, agentId) ??
              (existing.version > 0 ? existing.version - 1 : 0))
            : null,
        last_writer_session_id: lastWriterAgent ?? "<unknown>",
        last_writer_at_unix_ts: existing.updated_at,
        warning_generated_at_unix_ts: nowUnix(),
        hash_differs: false,
      };
    }
    regrants.push({ artifactId: existing.id, trigger: "post_stale_grep" });
  }

  // No held paths: a Grep over a root does not read every file under it --
  // see applyRegrants.
  applyRegrants(deps, agentId, regrants, {
    commandRuns: strictStaleFirst === null,
    nowTick: now,
    held: [],
  });

  // v0.2 KTD-Q strict short-circuit — same shape as pre-bash (Unit 6).
  if (strictStaleFirst !== null) {
    writeJson(res, 200, {
      hookSpecificOutput: emitStrictDeny({
        source: "pre_grep_strict_deny",
        summary: strictStaleFirst,
      }),
      status: "stale",
      stale_paths: staleSummaries.map((s) => s.path),
    });
    return;
  }

  const noticeText = drainNoticeText(deps, agentId);

  if (staleSummaries.length === 0 && noticeText === null) {
    writeJson(res, 200, withReground({ status: "fresh" }));
    return;
  }

  const parts: string[] = [];
  if (noticeText !== null) parts.push(noticeText);
  if (staleSummaries.length > 0) {
    const pathsStr = staleSummaries
      .map((s) => `${s.path} (current v${s.current_version})`)
      .join(", ");
    // Byte-parity with Python _handle_pre_grep's prose — do not reword.
    parts.push(
      `⚠ Grep search over tracked artifacts your session has ` +
        `not freshened since peer commits: ${pathsStr}. The ` +
        `results may reflect outdated content. Consider re-reading ` +
        `via Read before acting on Grep output.`,
    );
  }

  const resp: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: parts.join("\n\n"),
    },
  };
  if (staleSummaries.length > 0) {
    resp.status = "stale";
    resp.stale_paths = staleSummaries.map((s) => s.path);
  } else {
    resp.status = "fresh";
  }
  // Notices/stale prose are already merged, so the re-ground block lands last.
  writeJson(res, 200, withReground(resp));
}

/** Parse + dispatch helper for use from server.ts. */
export async function preGrepRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HookDeps,
  maxBytes: number,
): Promise<void> {
  if (req.method !== "POST") {
    writeError(res, 404, "not found");
    return;
  }
  const body = await readJsonBody(req, res, maxBytes);
  if (body === null) return;
  await handlePreGrep(body as PreGrepBody, res, deps);
}
