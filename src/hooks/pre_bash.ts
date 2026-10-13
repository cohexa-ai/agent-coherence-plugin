/**
 * POST /hooks/pre-bash — KTD-N H4 mitigation (zero-Python Unit 2).
 *
 * Node port of Python `_handle_pre_bash` (coordinator_server.py:2241).
 * Detects tracked-artifact READS in a Bash command; per detected path runs
 * the same stale-vs-fresh logic as /hooks/pre-read (first-observation seed
 * with trigger "first_bash_read"; stale → re-grant SHARED "post_stale_bash").
 *
 * Warn-parity only in Unit 2: the strict-mode deny short-circuit lands in
 * Unit 6 (plan decision C gates user exposure on it). Response bodies are
 * byte-parity with Python's warn path:
 *  - `{status:"fresh"}` — no tracked paths / all fresh, no notices
 *  - `{hookSpecificOutput:{hookEventName,permissionDecision:"allow",additionalContext}, status:"stale", stale_paths:[…]}`
 *  - notices-only → same envelope with `status:"fresh"`, no stale_paths
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MESIState } from "../states.js";
import {
  emitStrictDeny,
  nowUnix,
  type StaleSummary,
} from "../hook_payloads.js";
import { detectTrackedPaths } from "./bash_path_detector.js";
import {
  applyRegrants,
  drainNoticeText,
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

const MAX_COMMAND_LENGTH = 16384;

interface PreBashBody {
  session_id?: unknown;
  command?: unknown;
}

export async function handlePreBash(
  body: PreBashBody,
  res: ServerResponse,
  deps: HookDeps,
): Promise<void> {
  if (!isValidSessionId(body.session_id)) {
    writeError(res, 400, "missing session_id");
    return;
  }
  const command = body.command;
  if (typeof command !== "string" || command.trim() === "") {
    writeError(res, 400, "missing or empty command");
    return;
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    writeError(res, 413, "command too long");
    return;
  }
  const sessionId: string = body.session_id;

  // SB-10 U8 (KTD6): the allow-attach seam — runs after the strict-deny
  // decision; deny bodies pass through untouched.
  const withReground = (result: object): Record<string, unknown> =>
    deliverPendingReground(deps, sessionId, body as Record<string, unknown>, result);

  // Policy gate — untracked commands exit via writeFastAdmit's SB-10 U8 compact-pending peek.
  const trackedPaths = detectTrackedPaths(command, (p) => deps.policy.isTracked(p));
  if (trackedPaths.length === 0) {
    writeFastAdmit(res, deps, sessionId, body as Record<string, unknown>, { status: "fresh" });
    return;
  }

  const agentId = deps.sessions.registerSession(body.session_id, readSubagentId(body as Record<string, unknown>));
  const now = nowTickFn();

  const staleSummaries: Array<{ path: string; current_version: number }> = [];
  // v0.2 KTD-Q (Unit 6): first strict + stale path drives a deny on the
  // whole command (multi-path commands re-deny with the next path's reason
  // on retry, bounded by the model's own retry loop — mirrors Python).
  let strictStaleFirst: StaleSummary | null = null;
  // The SHARED grants this command earns, and the SHARED grants it already
  // holds, both applied only once the deny decision is known — see applyRegrants.
  const regrants: Regrant[] = [];
  const held: string[] = [];
  for (const path of trackedPaths) {
    const existing = deps.registry.getArtifactByName(path);
    if (existing === null) {
      // First observation per KTD-9 — seed v1 + SHARED so subsequent reads are
      // fresh. detectTrackedPaths deduplicates, so deferring the grant cannot
      // make a later iteration read this path as stale.
      const artifactId = deps.registry.resolveOrRegisterArtifact(path, "");
      regrants.push({ artifactId, trigger: "first_bash_read" });
      continue;
    }
    const agentState = deps.registry.getAgentState(existing.id, agentId);
    if (agentState !== null && agentState !== MESIState.INVALID) {
      if (agentState === MESIState.SHARED) held.push(existing.id);
      continue; // fresh on this path
    }
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
    // Re-grant SHARED to suppress repeat fires (warn-mode contract; Python
    // pre-bash re-grants even on the strict path — the deny fires this once).
    regrants.push({ artifactId: existing.id, trigger: "post_stale_bash" });
  }

  applyRegrants(deps, agentId, regrants, {
    commandRuns: strictStaleFirst === null,
    nowTick: now,
    held,
  });

  if (strictStaleFirst !== null) {
    writeJson(res, 200, {
      hookSpecificOutput: emitStrictDeny({
        source: "pre_bash_strict_deny",
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

  // Merged additionalContext: notices first (most-urgent), then the
  // bash-multipath stale warning — exact Python prose (byte-parity).
  const parts: string[] = [];
  if (noticeText !== null) parts.push(noticeText);
  if (staleSummaries.length > 0) {
    const pathsStr = staleSummaries
      .map((s) => `${s.path} (current v${s.current_version})`)
      .join(", ");
    parts.push(
      `⚠ Bash command reads tracked artifacts that have been ` +
        `updated since your session's last fresh read: ${pathsStr}. ` +
        `The command will still execute (v0.1.1 is warn-only), but ` +
        `consider re-reading via the Read tool before relying on ` +
        `the output as ground truth.`,
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
export async function preBashRoute(
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
  await handlePreBash(body as PreBashBody, res, deps);
}
