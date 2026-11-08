/**
 * POST /hooks/session-stop handler.
 *
 * Mirrors Python `_handle_session_stop` at coordinator_server.py:703. Per
 * KTD-11: when a Claude Code session reaches end-of-turn (Stop hook), release
 * any uncommitted EXCLUSIVE/MODIFIED grants the session still holds. Without
 * this, abandoned mid-edit grants would block peer sessions for the full
 * crash-recovery timeout window (default 120s). The session keeps a read
 * (SHARED) of each released file, so its next turn can read and edit it
 * again.
 *
 * Wire shape per KTD-B / KTD-B.3 C3:
 * - Request: `{session_id}`, plus `agent_id` for a subagent or a
 *   `CoherentVolume` attempt, and an optional `ended: true` with which the
 *   volume reports that attempt over (Cohexa-ai/agent-coherence#525).
 * - Response: `{ok: true, released_artifacts: ["plan.md", ...]}` listing the
 *   repo-relative paths whose grants were released.
 *
 * After the releases, an `ended` stop forgets the identity: its rows leave
 * the store and its entry leaves the session maps, so `/status` stops
 * listing it. A grant still held after the releases refuses the forget, and
 * the identity keeps every row. Only the explicit flag ends an identity: a
 * stopped subagent keeps its rows, because a SubagentStop can be blocked and
 * the subagent resumed under the same id, and a deleted row would turn the
 * deny of its stale edit into an admit.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { CoherenceError } from "../coherence_error.js";
import { MESIState } from "../states.js";
import {
  type HookDeps,
  writeJson,
  writeError,
  readJsonBody,
  isValidSessionId,
  readSubagentId,
  hasSubagentIdField,
} from "./_common.js";

export type SessionStopDeps = HookDeps;

interface SessionStopBody {
  session_id?: unknown;
  ended?: unknown;
}

/** The 400 text for a malformed `ended`, or null when it is absent or usable. */
function endedError(body: SessionStopBody): string | null {
  if (body.ended === undefined) return null;
  if (typeof body.ended !== "boolean") return "ended must be a boolean";
  // A parent Stop is a session between turns, never an end.
  if (body.ended && !hasSubagentIdField(body as Record<string, unknown>)) {
    return "ended requires agent_id";
  }
  return null;
}

/**
 * Forget an ended identity. A refusal (it still holds a write grant) is
 * logged and the stop answers as usual; a store fault propagates to the
 * failure envelope, as in the release loop.
 */
function forgetEndedAgent(deps: SessionStopDeps, agentId: string): void {
  try {
    deps.registry.forgetAgent(agentId);
  } catch (err) {
    if (!(err instanceof CoherenceError)) throw err;
    process.stderr.write(
      `agent-coherence: session_stop kept the records of an ended agent: ${String(err)}\n`,
    );
    return;
  }
  deps.sessions.forget(agentId);
}

export async function handleSessionStop(
  body: SessionStopBody,
  res: ServerResponse,
  deps: SessionStopDeps,
): Promise<void> {
  if (!isValidSessionId(body.session_id)) {
    writeError(res, 400, "missing session_id");
    return;
  }
  const endedRefusal = endedError(body);
  if (endedRefusal !== null) {
    writeError(res, 400, endedRefusal);
    return;
  }
  const sessionId: string = body.session_id;
  const subagentId = readSubagentId(body as Record<string, unknown>);

  // P1 subagent-stop safety: session-stop RELEASES grants, so a malformed
  // agent_id must NOT silently degrade to the parent identity — that would
  // release the parent's live grants. Absent agent_id = a legitimate parent
  // Stop (release the parent's own grants, unchanged). Present-but-invalid =
  // refuse (no-op), since the caller intended a scoped subagent release the
  // server can't resolve. This fail-closed guard is why the read paths (where
  // a malformed id degrading to parent attribution is benign) can stay lax.
  if (subagentId === null && hasSubagentIdField(body as Record<string, unknown>)) {
    writeJson(res, 200, { ok: true, released_artifacts: [] });
    return;
  }

  // SB-10 U8 (R2): the deferred re-grounding flag lives at most one parent
  // turn. A PARENT Stop — the wire carries NO agent_id field; SubagentStop
  // always carries one (SB-25) — ends that turn, so an undelivered flag
  // expires here instead of leaking into a later turn. A SubagentStop (or a
  // malformed subagent id, which also presents the field and returned above)
  // leaves the flag untouched: the parent turn is still in flight and its
  // next admit may yet deliver.
  if (!hasSubagentIdField(body as Record<string, unknown>)) {
    deps.sessions.expireCompactPending(sessionId);
  }

  const agentId = deps.sessions.registerSession(sessionId, subagentId);
  const nowTick = Math.floor(Date.now() / 1000);

  // Per KTD-11: enumerate held M/E grants and release each. Released paths
  // surface in the response so /status logs / debugging can see what fired.
  const heldArtifactIds = deps.registry.artifactsHeldByAgent(agentId, [
    MESIState.MODIFIED,
    MESIState.EXCLUSIVE,
  ]);

  const releasedPaths: string[] = [];
  for (const artifactId of heldArtifactIds) {
    try {
      deps.registry.releaseToReader(artifactId, agentId, nowTick);
      const art = deps.registry.getArtifactById(artifactId);
      if (art !== null) releasedPaths.push(art.name);
    } catch (err) {
      // A refused release on one artifact does NOT abort the loop — best-effort
      // release of remaining held grants matters more than reporting one
      // refusal. A store fault does: it answers the failure envelope rather
      // than a clean release while the grant is still held (#214).
      if (!(err instanceof CoherenceError)) throw err;
      process.stderr.write(
        `agent-coherence: session_stop release failed for artifact=${artifactId}: ${String(err)}\n`,
      );
    }
  }

  // A release refused above left its grant held, so the forget refuses.
  if (body.ended === true) forgetEndedAgent(deps, agentId);

  writeJson(res, 200, { ok: true, released_artifacts: releasedPaths });
}

export async function sessionStopRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SessionStopDeps,
  maxBytes: number,
): Promise<void> {
  if (req.method !== "POST") {
    writeError(res, 404, "not found");
    return;
  }
  const body = await readJsonBody(req, res, maxBytes);
  if (body === null) return;
  await handleSessionStop(body as SessionStopBody, res, deps);
}
