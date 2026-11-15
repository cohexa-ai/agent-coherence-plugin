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
 *   - Fresh: `{status: "fresh"}` on an untracked file; on a tracked one
 *     `{status: "fresh", version}`, the version of the record the read was
 *     classified against, plus `hash_differs: true` when a valid grant's
 *     bytes differ from the record (#205)
 *   - Fresh with pending notice or an out-of-band notice: `{status: "fresh", ..., hookSpecificOutput: {...}}`
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
  emitUnrecordedBytesDeny,
  nowUnix,
  outOfBandChangeNotice,
  type StaleSummary,
  type TrackedFreshAnswer,
} from "../hook_payloads.js";
import type { Artifact } from "../registry.js";
import {
  aWriteIsInFlight,
  drainNoticeText,
  holdsContentClaim,
  isRecentSelfCommitLag,
  isValidContentHashOrAbsent,
  isValidSessionId,
  readJsonBody,
  readSubagentId,
  type HookDeps,
  writeError,
  writeJson,
} from "./_common.js";
import { attachPreToolUseContext, deliverPendingReground, writeFastAdmit } from "./reground.js";
import {
  findRequested,
  isStrictRequest,
  isTrackedRequest,
  readRequestName,
  resolveRequested,
} from "./door.js";

export type PreReadDeps = HookDeps;

interface PreReadBody {
  session_id?: unknown;
  path?: unknown;
  content_hash?: unknown;
  name_kind?: unknown;
  want_owner_generation?: unknown;
  verify_only?: unknown;
}

/**
 * Fields only callers other than the Claude Code hook clients send: the
 * effect fence's verification read (`verify_only`), CoherentVolume and the
 * documented raw capture (`want_owner_generation`), and the substrate
 * adapter (`name_kind`). The hook clients send `{session_id, path,
 * content_hash, agent_id}`.
 */
const NON_HOOK_READ_FIELDS = ["want_owner_generation", "verify_only", "name_kind"] as const;

/**
 * Whether this pre-read is a Claude Code hook Read. Only such a Read arms,
 * uses up or is admitted by the stale-deny record: the other callers document
 * `reacquire()` or a new agent id as their recovery, and the substrate's
 * commit gate relies on a stale deny staying in place. Presence decides,
 * whatever the value, so no such caller can reach the admit.
 */
function isHookRead(body: Record<string, unknown>): boolean {
  return NON_HOOK_READ_FIELDS.every((field) => !Object.hasOwn(body, field));
}

/**
 * The caller read the bytes of the version the coordinator recorded, or the
 * record claims no bytes. A missing hash, sent when the file is gone, never
 * matches a claim.
 */
function readsRecordedBytes(artifact: Artifact, contentHash: string | null): boolean {
  return !holdsContentClaim(artifact.content_hash) || contentHash === artifact.content_hash;
}

/**
 * The Read after a stale deny, of the recorded bytes: granted at the current
 * version through the stale-arm re-grant, which records the observation, and
 * answered on the fresh arm with any drained notices and no stale warning.
 * The record is used up, so the next staleness of the file starts from a deny.
 */
function admitRereadAfterDeny(
  deps: PreReadDeps,
  read: { artifactId: string; agentId: string; nowTick: number; version: number },
): Record<string, unknown> {
  deps.registry.grantShared(read.artifactId, read.agentId, read.nowTick, "post_stale_read");
  deps.sessions.dropStaleDeny(read.agentId, read.artifactId);
  const fresh: TrackedFreshAnswer = { status: "fresh", version: read.version };
  const notice = drainNoticeText(deps, read.agentId);
  return notice === null ? fresh : buildFreshWithNotice(notice, fresh);
}

/**
 * The strict deny of a stale or never-read Read. The recorded bytes get the
 * stale-copy text, which says the next Read returns the current version.
 * Other bytes, or no hash, get a text naming what clears the deny instead:
 * the commit of another session's write in flight, or of the change made
 * outside the coordinator.
 */
function staleReadDeny(
  denied: { deps: PreReadDeps; summary: StaleSummary; artifactId: string; agentId: string },
  recordedBytes: boolean,
): Record<string, unknown> {
  const { deps, summary, artifactId, agentId } = denied;
  const source = "pre_read_strict_deny";
  const hookSpecificOutput = recordedBytes
    ? emitStrictDeny({ source, summary })
    : emitUnrecordedBytesDeny({ source, summary, writeInFlight: aWriteIsInFlight(deps, artifactId, agentId) });
  return { hookSpecificOutput, status: "stale", summary };
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
  const name = readRequestName(body as Record<string, unknown>, deps);
  if (name === null) {
    writeError(res, 400, "missing or empty path");
    return;
  }
  if (!isValidContentHashOrAbsent(body.content_hash)) {
    writeError(res, 400, "content_hash must be 64-char hex if provided");
    return;
  }

  const sessionId: string = body.session_id;
  const path: string = name.requested;
  const contentHash: string | null = (body.content_hash as string | null | undefined) ?? null;

  // SB-10 U8 (KTD6): the allow-attach seam — runs after every deny
  // decision; a non-qualifying result (strict deny) passes through as the
  // SAME object, byte-identical, and keeps the flag pending.
  const withReground = (result: object): Record<string, unknown> =>
    deliverPendingReground(deps, sessionId, body as Record<string, unknown>, result);

  // Tracked-policy gate (R8 budget): untracked paths fast-path to {fresh}
  // via writeFastAdmit's SB-10 U8 compact-pending peek.
  if (!isTrackedRequest(deps, name)) {
    writeFastAdmit(res, deps, sessionId, body as Record<string, unknown>, { status: "fresh" });
    return;
  }

  const agentId = deps.sessions.registerSession(sessionId, readSubagentId(body as Record<string, unknown>));
  const nowTick = Math.floor(Date.now() / 1000);

  // Lookup artifact by path. None → KTD-9 first observation.
  const existingArtifact = findRequested(deps, name);

  if (existingArtifact === null) {
    // First observation per KTD-9 — seed v1 with the on-disk hash if the
    // caller supplied one, else use empty string sentinel (matches Python).
    const seedHash = contentHash ?? "";
    const artifactId = resolveRequested(deps, name, seedHash);
    // Grant SHARED to the first reader so subsequent reads see themselves as
    // known-fresh.
    deps.registry.grantShared(artifactId, agentId, nowTick, "first_read");
    // The version is read from the record after the grant, the order the
    // Python coordinator keeps. Nothing awaits between the lookup and here
    // and one coordinator owns the store, so no commit lands in between: this
    // is the row this read created, and grantShared has just checked that it
    // exists.
    const created = deps.registry.getArtifactById(artifactId) as Artifact;
    const fresh: TrackedFreshAnswer = { status: "fresh", version: created.version };
    // Even on first observation, check if THIS session has pending notices
    // from prior interactions on OTHER artifacts.
    const notice = drainNoticeText(deps, agentId);
    writeJson(res, 200, withReground(notice === null ? fresh : buildFreshWithNotice(notice, fresh)));
    return;
  }

  const artifactId = existingArtifact.id;
  const agentState = deps.registry.getAgentState(artifactId, agentId);

  if (agentState !== null && agentState !== MESIState.INVALID) {
    // Valid-grant out-of-band arm (Survivor #6, #205; mirrors Python
    // `decide_tracked_read`): a reader holding any valid grant (SHARED,
    // EXCLUSIVE or MODIFIED) proves no peer commit since its grant, so a
    // disk-hash mismatch is either this session's own commit→disk-flush lag
    // (≤5s: flag only) or a change made outside the coordinator (strict →
    // deny; warn → flag plus a context-only notice). Sentinel recorded hashes
    // carry no content claim and must not fire. The version is the one this
    // read was classified against, read in this same synchronous section.
    const fresh: TrackedFreshAnswer = { status: "fresh", version: existingArtifact.version };
    let outOfBandVersion: number | null = null;
    if (
      contentHash !== null &&
      contentHash !== "" &&
      holdsContentClaim(existingArtifact.content_hash) &&
      contentHash !== existingArtifact.content_hash
    ) {
      const now = nowUnix();
      // R7: name the writer by the agent id the registry stores, not by the
      // session id that id was derived from.
      const lastWriterAgent = existingArtifact.last_writer_id;
      const isSelfCommitLag = isRecentSelfCommitLag(existingArtifact, agentId, now);
      if (isStrictRequest(deps, name) && !isSelfCommitLag) {
        const sharedSummary: StaleSummary = {
          path,
          current_version: existingArtifact.version,
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
            outOfBand: true,
          }),
          status: "stale",
          summary: sharedSummary,
        });
        return;
      }
      fresh.hash_differs = true;
      if (!isSelfCommitLag) outOfBandVersion = existingArtifact.version;
    }
    // Reader has a valid grant (SHARED, EXCLUSIVE, or MODIFIED) on the
    // current version. Fresh, and the read is allowed. A SHARED grant that a
    // denied Bash / Grep command re-armed certifies no read, so this one is
    // the read to record (mirrors Python pre-read's fresh arm).
    if (agentState === MESIState.SHARED) deps.registry.recordObservation(artifactId, agentId);
    // A record a shell read's re-grant left armed is used up here, so it
    // cannot skip the deny of a later staleness event.
    if (isHookRead(body as Record<string, unknown>)) deps.sessions.dropStaleDeny(agentId, artifactId);
    // Python's order: drained notices ride an allow envelope, the out-of-band
    // notice is appended to it (or becomes a context-only one), then any
    // pending re-grounding.
    const notice = drainNoticeText(deps, agentId);
    let result: Record<string, unknown> =
      notice === null ? fresh : buildFreshWithNotice(notice, fresh);
    if (outOfBandVersion !== null) {
      result = attachPreToolUseContext(result, outOfBandChangeNotice(path, outOfBandVersion));
    }
    writeJson(res, 200, withReground(result));
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

  // v0.2 strict-mode gate on a stale copy (mirrors Python), #514:
  // 1. INVALID — the session's context carries a copy older than the record.
  //    The first stale Read or Edit is denied, which arms the session's
  //    stale-deny record. While it is armed, the session's next hook Read is
  //    admitted and granted at the current version when the bytes it read
  //    are the recorded ones (or the record claims no bytes). A Read of other
  //    bytes, or with no hash because the file is gone, stays denied: an Edit
  //    built on it would write bytes the coordinator never recorded. No grant
  //    is given on the deny itself, so an Edit sent before that Read is still
  //    denied by pre-edit. Callers other than the hook clients keep the
  //    sticky deny: they document their own recovery.
  // 2. None AND hash_differs — no prior grant AND the disk bytes diverge from
  //    the registry's recorded canonical. Always denied, with no record: the
  //    session has no row to recover. Hashes matching falls through to the
  //    warn-mode allow (the (None, matches) truth-table cell must NOT deny).
  // The deny text follows the check that decides the next Read, so no deny
  // promises a Read that would then be refused. The second arm's next Read is
  // refused while the bytes still differ, so it never gets the stale-copy text.
  const denied = { deps, summary, artifactId, agentId };
  if (isStrictRequest(deps, name) && agentState === MESIState.INVALID) {
    const hookRead = isHookRead(body as Record<string, unknown>);
    const recordedBytes = readsRecordedBytes(existingArtifact, contentHash);
    // Nothing awaits between the lookup above and the grant, and one
    // coordinator owns the store, so the version this read was classified
    // against is still the current one when it is granted.
    if (hookRead && recordedBytes && deps.sessions.isStaleDenyArmed(agentId, artifactId)) {
      const fresh = admitRereadAfterDeny(deps, { artifactId, agentId, nowTick, version: existingArtifact.version });
      writeJson(res, 200, withReground(fresh));
      return;
    }
    if (hookRead) deps.sessions.armStaleDeny(agentId, artifactId);
    writeJson(res, 200, staleReadDeny(denied, recordedBytes));
    return;
  }
  if (isStrictRequest(deps, name) && agentState === null && hashDiffers) {
    writeJson(res, 200, staleReadDeny(denied, false));
    return;
  }

  // Re-grant SHARED so this read doesn't re-fire stale on every call.
  deps.registry.grantShared(artifactId, agentId, nowTick, "post_stale_read");
  if (isHookRead(body as Record<string, unknown>)) deps.sessions.dropStaleDeny(agentId, artifactId);

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
