/**
 * POST /hooks/pre-read handler.
 *
 * Mirrors Python `_handle_pre_read` at
 * `src/ccs/adapters/claude_code/coordinator_server.py:402` — stale-read
 * check + KTD-9 first-observation seeding + pending-notice surfacing.
 *
 * Wire-shape parity with Python per KTD-B:
 * - Request body: `{session_id, path, content_hash?}` (snake_case, KTD-B.3 C3)
 * - Response shapes:
 *   - Fresh: `{status: "fresh"}`
 *   - Fresh with pending notice: `{status: "fresh", hookSpecificOutput: {...}}`
 *   - Stale: `{hookSpecificOutput: {...}, status: "stale", summary: {...}}`
 *   - 400: `{error: "<lowercase phrase>"}` per KTD-B.3 C1
 *
 * H4 mitigation (KTD-N): this handler matches the `Read` tool. Unit 4
 * lands the `Bash` + `Grep` hook coverage that catches `bash cat plan.md`
 * routing.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MESIState } from "../states.js";
import {
  buildStaleResponse,
  buildFreshWithNotice,
  emitStrictDeny,
  nowUnix,
  type StaleSummary,
} from "../hook_payloads.js";

/** Synthetic launch-gate sentinel hash — carries no content claim (Python `_F_SENTINEL_CONTENT_HASH`). */
const F_SENTINEL_CONTENT_HASH = "f".repeat(64);
/** Survivor #6 R2: self-commit → disk-flush lag window (Python `_SHARED_FOREIGN_DENY_LAG_WINDOW_SEC`). */
const SHARED_FOREIGN_DENY_LAG_WINDOW_SEC = 5.0;
import {
  drainNoticeText,
  isValidContentHashOrAbsent,
  isValidPath,
  isValidSessionId,
  readJsonBody,
  readSubagentId,
  type HookDeps,
  writeError,
  writeJson,
} from "./_common.js";
import { deliverPendingReground, writeFastAdmit } from "./reground.js";

export type PreReadDeps = HookDeps;

interface PreReadBody {
  session_id?: unknown;
  path?: unknown;
  content_hash?: unknown;
}

export async function handlePreRead(
  body: PreReadBody,
  res: ServerResponse,
  deps: PreReadDeps,
): Promise<void> {
  // Validation. Mirror Python error envelope: lowercase, no trailing punctuation.
  if (!isValidSessionId(body.session_id)) {
    writeError(res, 400, "missing session_id");
    return;
  }
  if (!isValidPath(body.path)) {
    writeError(res, 400, "missing or empty path");
    return;
  }
  if (!isValidContentHashOrAbsent(body.content_hash)) {
    writeError(res, 400, "content_hash must be 64-char hex if provided");
    return;
  }

  const sessionId: string = body.session_id;
  const path: string = body.path;
  const contentHash: string | null = (body.content_hash as string | null | undefined) ?? null;

  // SB-10 U8 (KTD6): the allow-attach seam — runs after every deny
  // decision; a non-qualifying result (strict deny) passes through as the
  // SAME object, byte-identical, and keeps the flag pending.
  const withReground = (result: object): Record<string, unknown> =>
    deliverPendingReground(deps, sessionId, body as Record<string, unknown>, result);

  // Tracked-policy gate (R8 budget): untracked paths fast-path to {fresh}
  // via writeFastAdmit's SB-10 U8 compact-pending peek.
  if (!deps.policy.isTracked(path)) {
    writeFastAdmit(res, deps, sessionId, body as Record<string, unknown>, { status: "fresh" });
    return;
  }

  const agentId = deps.sessions.registerSession(sessionId, readSubagentId(body as Record<string, unknown>));
  const nowTick = Math.floor(Date.now() / 1000);

  // Lookup artifact by path. None → KTD-9 first observation.
  const existingArtifact = deps.registry.getArtifactByName(path);

  if (existingArtifact === null) {
    // First observation per KTD-9 — seed v1 with the on-disk hash if the
    // caller supplied one, else use empty string sentinel (matches Python).
    const seedHash = contentHash ?? "";
    const artifactId = deps.registry.resolveOrRegisterArtifact(path, seedHash);
    // Grant SHARED to the first reader so subsequent reads see themselves as
    // known-fresh.
    deps.registry.grantShared(artifactId, agentId, nowTick, "first_read");
    // Even on first observation, check if THIS session has pending notices
    // from prior interactions on OTHER artifacts.
    const notice = drainNoticeText(deps, agentId);
    if (notice !== null) {
      writeJson(res, 200, withReground(buildFreshWithNotice(notice)));
      return;
    }
    writeJson(res, 200, withReground({ status: "fresh" }));
    return;
  }

  const artifactId = existingArtifact.id;
  const agentState = deps.registry.getAgentState(artifactId, agentId);

  if (agentState !== null && agentState !== MESIState.INVALID) {
    // Survivor #6 v1 SHARED-holder foreign-edit arm (Unit 6, mirrors Python
    // pre-read): a still-SHARED reader proves no peer commit since its grant,
    // so a disk-hash mismatch is either this session's own commit→disk-flush
    // lag (≤5s, suppress) or a foreign out-of-band edit (strict → deny).
    // Sentinel recorded hashes carry no content claim and must not fire.
    if (
      agentState === MESIState.SHARED &&
      contentHash !== null &&
      contentHash !== "" &&
      existingArtifact.content_hash !== "" &&
      existingArtifact.content_hash !== F_SENTINEL_CONTENT_HASH &&
      contentHash !== existingArtifact.content_hash &&
      deps.policy.isStrictMode(path)
    ) {
      const now = nowUnix();
      // R7: name the writer by the agent id the registry stores, not by the
      // session id that id was derived from.
      const lastWriterAgent = existingArtifact.last_writer_id;
      // P1: compare the raw writer identity against THIS caller's composite
      // agentId — NOT the session id the writer's agent id was derived from.
      // SB-25 made that (now removed, R7) reverse lookup return a subagent's
      // bare attribution id, so the old session-string comparison could never
      // match for a subagent's own commit and its immediate self-re-read was
      // wrongly denied as a "foreign edit." (lastWriterAgent is kept only for
      // the summary field.)
      const isSelfCommitLag =
        existingArtifact.last_writer_id === agentId &&
        now - existingArtifact.updated_at <= SHARED_FOREIGN_DENY_LAG_WINDOW_SEC;
      if (!isSelfCommitLag) {
        const sharedSummary: StaleSummary = {
          path,
          current_version: existingArtifact.version,
          // A SHARED holder was granted on the current version.
          prior_version_seen_by_session: existingArtifact.version,
          last_writer_session_id: lastWriterAgent ?? "<unknown>",
          last_writer_at_unix_ts: existingArtifact.updated_at,
          warning_generated_at_unix_ts: now,
          hash_differs: true,
        };
        // KTD-T: leave the grant untouched so retries re-deny byte-stably.
        writeJson(res, 200, {
          hookSpecificOutput: emitStrictDeny({
            source: "pre_read_shared_hash_deny",
            summary: sharedSummary,
          }),
          status: "stale",
          summary: sharedSummary,
        });
        return;
      }
    }
    // Reader has a valid grant (SHARED, EXCLUSIVE, or MODIFIED) on the
    // current version. Fresh, and the read is allowed. A SHARED grant that a
    // denied Bash / Grep command re-armed certifies no read, so this one is
    // the read to record (mirrors Python pre-read's fresh arm).
    if (agentState === MESIState.SHARED) deps.registry.recordObservation(artifactId, agentId);
    const notice = drainNoticeText(deps, agentId);
    if (notice !== null) {
      writeJson(res, 200, withReground(buildFreshWithNotice(notice)));
      return;
    }
    writeJson(res, 200, withReground({ status: "fresh" }));
    return;
  }

  // Stale: either first time this session sees the artifact OR they were
  // invalidated by a peer commit.
  // R8: the version this agent last ACTUALLY observed. This used to be
  // inferred as `version - 1`, which is only correct if the invalidation came
  // from a commit; when a peer merely TAKES the grant
  // (Cohexa-ai/agent-coherence#196) the version does not move, so the
  // inference reported a version the session never saw and made an unchanged
  // version look changed -- which is also what hid the false "was updated by"
  // claim, because `current > prior` then held unconditionally.
  // `agent_states.last_observed_version` is written with every non-INVALID
  // grant and PRESERVED across the transition to INVALID. The old inference
  // survives only as the fallback for a NULL value: a row written before the
  // v4 migration added the column, or a row whose only grant certified no read
  // (the agent's first grant on the path came from a DENIED Bash/Grep command —
  // see applyRegrants). `version - 1` is always below current, so either case takes
  // the write wording and asks for a re-read. Mirrors Python
  // `_prior_version_observed`.
  const priorSeen =
    agentState === MESIState.INVALID
      ? (deps.registry.lastObservedVersionFor(artifactId, agentId) ??
        (existingArtifact.version > 0 ? existingArtifact.version - 1 : 0))
      : null;

  // hash_differs: caller's current Read content vs registry's last-recorded hash.
  const hashDiffers =
    contentHash !== null &&
    existingArtifact.content_hash !== "" &&
    contentHash !== existingArtifact.content_hash;

  // R7: the registry's own handle for the writer; "<unknown>" only when
  // nothing has been committed.
  const lastWriterSessionId = existingArtifact.last_writer_id ?? "<unknown>";

  const summary: StaleSummary = {
    path,
    current_version: existingArtifact.version,
    prior_version_seen_by_session: priorSeen,
    last_writer_session_id: lastWriterSessionId,
    last_writer_at_unix_ts: existingArtifact.updated_at,
    warning_generated_at_unix_ts: nowUnix(),
    hash_differs: hashDiffers,
  };

  // v0.2 KTD-O/KTD-P strict-mode deny gate (Unit 6, mirrors Python):
  // 1. INVALID — true preemption; the session's context carries stale beliefs.
  // 2. None AND hash_differs — no prior grant AND the disk bytes diverge from
  //    the registry's recorded canonical. Hashes matching falls through to
  //    the warn-mode allow (the (None, matches) truth-table cell must NOT deny).
  // KTD-T: do NOT re-grant SHARED on deny — the state stays INVALID/None so
  // every retry produces the same byte-stable deny text.
  if (
    deps.policy.isStrictMode(path) &&
    (agentState === MESIState.INVALID || (agentState === null && hashDiffers))
  ) {
    writeJson(res, 200, {
      hookSpecificOutput: emitStrictDeny({ source: "pre_read_strict_deny", summary }),
      status: "stale",
      summary,
    });
    return;
  }

  // Re-grant SHARED so this read doesn't re-fire stale on every call.
  deps.registry.grantShared(artifactId, agentId, nowTick, "post_stale_read");

  const resp = buildStaleResponse(summary);
  // A1: if THIS session has pending preemption notices, prepend them to the
  // additionalContext.
  const notice = drainNoticeText(deps, agentId);
  if (notice !== null) {
    resp.hookSpecificOutput.additionalContext =
      notice + "\n\n" + resp.hookSpecificOutput.additionalContext;
  }
  // Notices are already merged above, so the re-grounding block lands last.
  writeJson(res, 200, withReground(resp));
}


/** Parse + dispatch helper for use from server.ts. */
export async function preReadRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PreReadDeps,
  maxBytes: number,
): Promise<void> {
  if (req.method !== "POST") {
    writeError(res, 404, "not found");
    return;
  }
  const body = await readJsonBody(req, res, maxBytes);
  if (body === null) return;
  await handlePreRead(body as PreReadBody, res, deps);
}
