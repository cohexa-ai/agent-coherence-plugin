/**
 * POST /hooks/pre-edit handler.
 *
 * Mirrors Python `_handle_pre_edit` at coordinator_server.py:531 — acquires
 * EXCLUSIVE per KTD-1 single-writer + KTD-9 collision surfacing.
 *
 * Wire shape per KTD-B / KTD-B.3 C3:
 * - Request: `{session_id, path, if_unheld?}`
 * - Response: `{ok: true}` on clean acquire; `{ok: true, hookSpecificOutput: {...}}`
 *   with collision warning if another session held M/E; `disk_differs: true`
 *   with the out-of-band notice when the file on disk no longer holds the
 *   recorded content (#205); `{ok: false, reason}` on protocol error
 *   (single-writer violation propagated).
 * - Opted in (`if_unheld` is exactly JSON `true`): `{ok: false, reason:
 *   "other_holder", holder_agent_id}` while another agent holds the path for
 *   writing, in that key order; otherwise an admit that never carries a
 *   collision warning. Any other `if_unheld` value is an ordinary request.
 *
 * Note on collision detection ordering: the Python handler peeks `exclusiveHolder`
 * BEFORE calling `write()` (which would invalidate the holder). We mirror this:
 * snapshot the holder identity first so the response can name them, THEN call
 * `acquireExclusive` which silently revokes their grant + writes a pending notice
 * the victim will see on their next hook. An opted-in request skips the peek:
 * its own decision names any holder, and its admit displaces no writer.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Artifact } from "../registry.js";
import { join } from "node:path";
import { OTHER_HOLDER_REASON } from "../acquire_or_fail.js";
import { CoherenceError } from "../coherence_error.js";
import { hashRegularFile } from "../disk_content.js";
import { MESIState } from "../states.js";
import {
  buildCollisionResponse,
  emitStrictDeny,
  nowUnix,
  outOfBandChangeNotice,
  type StaleSummary,
} from "../hook_payloads.js";
import {
  assertNever,
  drainNoticeText,
  holdsContentClaim,
  isRecentSelfCommitLag,
  isValidPath,
  isValidSessionId,
  readJsonBody,
  readSubagentId,
  type HookDeps,
  writeError,
  writeJson,
} from "./_common.js";
import { attachPreToolUseContext, deliverPendingReground, writeFastAdmit } from "./reground.js";

export type PreEditDeps = HookDeps;

/**
 * Python `_a_write_is_in_flight`: another session holds an uncommitted write
 * claim whose bytes may still be landing, so a differing disk proves nothing.
 * Node records no heartbeats, so only Python's no-heartbeat arm applies: any
 * peer in EXCLUSIVE counts as in flight. Python skips the check only when
 * that peer's heartbeat is within 5 s, so the two differ only for a peer
 * that has held EXCLUSIVE silently for longer, and the check never denies.
 */
function aWriteIsInFlight(deps: PreEditDeps, artifactId: string, agentId: string): boolean {
  for (const [peer, state] of deps.registry.getStateMap(artifactId)) {
    if (peer !== agentId && state === MESIState.EXCLUSIVE) return true;
  }
  return false;
}

/**
 * Python `_recorded_content_missing_from_disk` (#205): the recorded version
 * when the file on disk no longer holds the content the coordinator recorded
 * and the caller's own recent commit does not explain it; else null.
 */
function recordedContentMissingFromDisk(deps: PreEditDeps, artifact: Artifact | null, agentId: string): number | null {
  // The acquire writes grants and notices only, so the row read before it is current.
  if (artifact === null || !holdsContentClaim(artifact.content_hash)) return null;
  // Checked first: the caller's own commit explains a differing disk, so the read is wasted.
  if (isRecentSelfCommitLag(artifact, agentId, nowUnix())) return null;
  const diskHash = hashRegularFile(join(deps.policy.get().coordinatorRoot, artifact.name));
  return diskHash === null || diskHash === artifact.content_hash ? null : artifact.version;
}

interface PreEditBody {
  session_id?: unknown;
  path?: unknown;
  if_unheld?: unknown;
}

/**
 * The opted-in acquire: check and grant in one registry transaction. Answers
 * the refusal itself and returns false; returns true when the caller now
 * holds the grant. A holder reclaimed after `MAX_HOLD_SEC` is logged once,
 * after the transaction committed.
 */
function acquireIfUnheld(
  res: ServerResponse,
  deps: PreEditDeps,
  ids: { artifactId: string; agentId: string; nowTick: number },
): boolean {
  const outcome = deps.registry.acquireExclusiveIfUnheld(ids.artifactId, ids.agentId, ids.nowTick);
  switch (outcome.kind) {
    case "other_holder":
      // Key order is the cross-runtime contract: ok, reason, holder_agent_id.
      writeJson(res, 200, {
        ok: false,
        reason: OTHER_HOLDER_REASON,
        holder_agent_id: outcome.holderAgentId,
      });
      return false;
    case "granted":
      if (outcome.reclaimed !== null) {
        // No raw path: a path may hold a newline, and coordinator.log is shared
        // by every workspace of one plugin install.
        process.stderr.write(
          `agent-coherence: reclaimed artifact=${ids.artifactId} holder=${outcome.reclaimed.agentId} ` +
            `held=${outcome.reclaimed.heldForSec}s for=${ids.agentId}\n`,
        );
      }
      return true;
    default:
      return assertNever(outcome);
  }
}

export async function handlePreEdit(
  body: PreEditBody,
  res: ServerResponse,
  deps: PreEditDeps,
): Promise<void> {
  if (!isValidSessionId(body.session_id)) {
    writeError(res, 400, "missing session_id");
    return;
  }
  if (!isValidPath(body.path)) {
    writeError(res, 400, "missing or empty path");
    return;
  }
  const sessionId: string = body.session_id;
  const path: string = body.path;
  // Only JSON `true` opts in; "true", 1 and the rest are ordinary requests.
  const optedIn = body.if_unheld === true;

  // SB-10 U8 (KTD6): the allow-attach seam — runs after every deny
  // decision; strict-deny and refusal bodies pass through untouched.
  const withReground = (result: object): Record<string, unknown> =>
    deliverPendingReground(deps, sessionId, body as Record<string, unknown>, result);

  // SB-10 U8 (KTD6): the untracked exit goes through writeFastAdmit's compact-pending peek.
  if (!deps.policy.isTracked(path)) {
    writeFastAdmit(res, deps, sessionId, body as Record<string, unknown>, { ok: true });
    return;
  }

  const agentId = deps.sessions.registerSession(sessionId, readSubagentId(body as Record<string, unknown>));
  const nowTick = Math.floor(Date.now() / 1000);

  // Resolve-or-seed the artifact. Empty content_hash sentinel matches Python:
  // pre-edit doesn't get the post-write hash; post-edit supplies the real one.
  let artifactId: string;
  const existing = deps.registry.getArtifactByName(path);
  if (existing === null) {
    artifactId = deps.registry.resolveOrRegisterArtifact(path, "");
  } else {
    artifactId = existing.id;
  }

  // v0.2 KTD-Q strict-mode deny gate — Edit/Write surface (Unit 6, mirrors
  // Python pre-edit). INVALID-only: pre-edit carries no content_hash, so the
  // hash_differs disambiguation is unavailable; a first-time editor (state
  // None) falls through to the normal acquire flow. Fires only after this
  // session has been explicitly preempted.
  //
  // A preempted session can also hold SHARED without having read the current
  // version: a strict Bash / Grep deny re-arms SHARED so the retry it invites
  // goes through, and records no observation because the command never ran
  // (applyRegrants in _common.ts). Admitting that grant lets a whole-file
  // write from the copy read before the peer's commit overwrite the commit
  // (Cohexa-ai/agent-coherence#275), so it is stale too until a retried
  // Bash command or a Read records the current version (a retried Grep
  // records none: it never showed the file). A SHARED holder with no
  // observation at all has acted on no version and is admitted like a
  // first-time editor. Mirrors Python pre-edit.
  if (existing !== null && deps.policy.isStrictMode(path)) {
    const editorState = deps.registry.getAgentState(artifactId, agentId);
    const observed = deps.registry.lastObservedVersionFor(artifactId, agentId);
    const unobservedShared =
      editorState === MESIState.SHARED && observed !== null && observed < existing.version;
    if (existing.version > 0 && (editorState === MESIState.INVALID || unobservedShared)) {
      const summary: StaleSummary = {
        path,
        current_version: existing.version,
        // R8: the observed version, not the inferred one -- see pre_read.ts.
        prior_version_seen_by_session:
          observed ?? (existing.version > 0 ? existing.version - 1 : 0),
        // R7: the registry's handle for the writer, not a recovered session id.
        last_writer_session_id: existing.last_writer_id ?? "<unknown>",
        last_writer_at_unix_ts: existing.updated_at,
        warning_generated_at_unix_ts: nowUnix(),
        hash_differs: false, // pre-edit doesn't carry content_hash
      };
      writeJson(res, 200, {
        ok: false,
        hookSpecificOutput: emitStrictDeny({ source: "pre_edit_strict_deny", summary }),
        status: "stale",
        summary,
      });
      return;
    }
  }

  // Collision detection: snapshot exclusive holder BEFORE acquireExclusive
  // (the acquire silently revokes their grant). Skipped when opted in.
  const holder = optedIn ? null : deps.registry.exclusiveHolder(artifactId, agentId);
  // R7: name the incumbent by its agent id.
  const holderSessionId = holder !== null ? holder.agentId : null;
  const holderAcquiredAt = holder?.grantedAtTick ?? null;
  const peerWriteInFlight = aWriteIsInFlight(deps, artifactId, agentId);

  // Acquire EXCLUSIVE — invalidates any peers in M/E/S + writes pending
  // notices for those who held M/E (peers in S don't get a notice).
  try {
    if (optedIn) {
      if (!acquireIfUnheld(res, deps, { artifactId, agentId, nowTick })) return;
    } else {
      deps.registry.acquireExclusive(artifactId, agentId, nowTick);
    }
  } catch (err) {
    if (!(err instanceof CoherenceError)) throw err;
    writeJson(res, 200, {
      ok: false,
      reason: err.message,
    });
    return;
  }

  // #205: only an admitted editor is told, and the check never denies.
  const outOfBandVersion = peerWriteInFlight
    ? null
    : recordedContentMissingFromDisk(deps, existing, agentId);
  const finish = (result: object): Record<string, unknown> => {
    if (outOfBandVersion === null) return withReground(result);
    return withReground({
      ...attachPreToolUseContext(result as Record<string, unknown>, outOfBandChangeNotice(path, outOfBandVersion)),
      disk_differs: true,
    });
  };

  // Pop any pending notices for THIS session — they accumulated from prior
  // preemptions before this pre-edit. Bounded and rendered by the one shared
  // drain in _common.ts, which deletes only what it renders.
  const noticeText = drainNoticeText(deps, agentId, optedIn);

  // If we silently preempted someone in M/E, surface a collision warning.
  // Per Python convention: permissionDecision stays "allow" in v0.1.1 warn-only;
  // v0.2 may flip to "deny" per KTD-E (Phase 0 falsifiability gates the design).
  if (holder !== null) {
    const collisionResp = buildCollisionResponse(
      holderSessionId ?? "<unknown>",
      // granted_at_tick is wall-clock Unix seconds (Date.now() floored at
      // the grant), the scale nowUnix() uses, so the warning prose can show
      // it as is. Python uses the artifact's updated_at field (RIGHTness:
      // that's when the grant was stamped); we approximate via
      // holder.grantedAtTick, the start of the holder's continuous hold. For
      // warn-only this is acceptable; v0.2 may want stricter semantics.
      holderAcquiredAt ?? nowUnix(),
      path,
    );
    if (noticeText !== null) {
      collisionResp.hookSpecificOutput.additionalContext =
        noticeText + "\n\n" + collisionResp.hookSpecificOutput.additionalContext;
    }
    writeJson(res, 200, finish(collisionResp));
    return;
  }

  // No collision, but the calling session may have had pending notices from
  // prior preemptions on OTHER artifacts. Surface them.
  if (noticeText !== null) {
    writeJson(
      res,
      200,
      finish({
        ok: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          additionalContext: noticeText,
        },
      }),
    );
    return;
  }

  writeJson(res, 200, finish({ ok: true }));
}

export async function preEditRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PreEditDeps,
  maxBytes: number,
): Promise<void> {
  if (req.method !== "POST") {
    writeError(res, 404, "not found");
    return;
  }
  const body = await readJsonBody(req, res, maxBytes);
  if (body === null) return;
  await handlePreEdit(body as PreEditBody, res, deps);
}
