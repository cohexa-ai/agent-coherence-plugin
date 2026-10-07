/**
 * POST /hooks/session-start handler — SB-10 U6 post-compaction re-grounding.
 *
 * Mirrors Python `_handle_session_start` + `_build_session_start_context`
 * (agent-coherence 2bd756c, coordinator_server.py). Returns the re-grounding
 * `additionalContext` payload for a compacted session and arms the
 * process-local compact-pending flag for deferred delivery on the next
 * qualifying admit (consumption is implemented by reground.ts's
 * deliverPendingReground, wired into the four admit hooks (SB-10 U8)). The
 * `source == "compact"` gate lives client-side (the hook-client ladder):
 * this endpoint trusts its caller and treats every request as a compact
 * event (R1).
 *
 * Shape notes (byte-parity with Python):
 * - Empty session → literal `{}` and NO flag (R5): the deferred path must
 *   stay unarmed when there is nothing to deliver.
 * - Internal build failure → literal `{}` (KTD7 degraded shape): advisory
 *   re-grounding must never block, and a degraded response leaves the
 *   deferred path unarmed (the flag is set only AFTER a successful
 *   non-empty build).
 * - Optional `agent_id` resolves per SB-25 like the read paths, but the
 *   payload and the flag are SESSION-scoped either way — the parent agent
 *   id is derivable without prior registration, and the payload always
 *   covers the parent plus every registered subagent.
 * - No observation recording: the endpoint is read-only toward the registry
 *   (R6 — its own snapshot must never count as the session "seeing" bytes),
 *   and pending preemption notices are PEEKED, never popped — consumption
 *   ownership stays with the admit-endpoint drains.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MESIState } from "../states.js";
import { sessionToAgentId } from "../agent_id.js";
import {
  emitSessionStart,
  fmt,
  preemptionNoticeText,
  shortSessionId,
  SESSION_START_HEADER,
  SESSION_START_GRANT_LINE_TEMPLATE,
  SESSION_START_STALE_LINE_TEMPLATE,
  SESSION_START_TOUCHED_LINE_TEMPLATE,
  SESSION_START_OVERFLOW_LINE_TEMPLATE,
  PREEMPTION_NOTICE_OVERFLOW_LINE_TEMPLATE,
  SESSION_START_SUBAGENT_PREFIX_TEMPLATE,
  SESSION_START_CLOSING_LINE,
} from "../hook_payloads.js";
import {
  type HookDeps,
  writeJson,
  writeError,
  readJsonBody,
  isValidSessionId,
  readSubagentId,
} from "./_common.js";

export type SessionStartDeps = HookDeps;

/**
 * SB-10 (R5): at most this many artifact lines render verbatim; the rest
 * coalesce into one overflow line pointing at the status surface. Mirrors
 * Python `_SESSION_START_ARTIFACT_VERBATIM_CAP` — keeps the payload
 * constant-size regardless of how many artifacts a session touched. The
 * same cap bounds the prepended preemption-notice block, whose notices are
 * flattened across the parent and every registered subagent: without it the
 * payload would be unbounded and the 10KB additionalContext ceiling only a
 * hope.
 */
export const SESSION_START_ARTIFACT_VERBATIM_CAP = 3;

interface SessionStartBody {
  session_id?: unknown;
}

interface SessionStartContext {
  /** Rendered additionalContext, or null when the session holds no state (R5). */
  text: string | null;
  /** Feeds the R8 breadcrumb decision in the handler. */
  workspaceHasState: boolean;
}

/**
 * SB-10: render the post-compaction re-grounding prose for a session.
 *
 * KTD2: the payload is rebuilt from registry truth on EVERY delivery, from
 * ONE consistent read pass — better-sqlite3 is synchronous and the event
 * loop serializes handlers, so the walk below cannot interleave with a peer
 * commit (the Node analogue of Python's single `abort_guard` hold). The
 * pass is read-only: R6 forbids this endpoint from recording observations,
 * and pending preemption notices are PEEKED, never popped.
 *
 * Rendering (KTD8, byte-mirrored across backends):
 * - header first; the existing preemption-notice prose (if any) next; then
 *   artifact lines — the parent agent's first, then each registered
 *   subagent's under a `Subagent {name}:` prefix, groups sorted by name,
 *   artifacts sorted by path within a group;
 * - a held E/M/S row renders the event-anchored grant line with the
 *   CURRENT version; any other row (INVALID) renders the stale line only
 *   when the version advanced past a RECORDED last-observed value and the
 *   last writer is not this very agent (R7: never-observed admits, own
 *   edits are exempt — KTD4's second layer — and no 0-sentinel compares);
 * - at most `SESSION_START_ARTIFACT_VERBATIM_CAP` artifact lines render
 *   verbatim, the rest coalesce into the overflow line (R5) — a group
 *   fully swallowed by the cap renders no subagent prefix; the notice
 *   block honours the same cap with its own overflow line;
 * - the self-qualifying closing line is always last. No timestamps.
 *
 * Exported for SB-10 U8: the deferred-delivery seam rebuilds the prose from
 * registry truth at the moment of attach (KTD2) via this exact builder.
 */
export function buildSessionStartContext(
  deps: SessionStartDeps,
  sessionId: string,
  /**
   * Whether to render this session's pending preemption notices.
   *
   * True for the real `/hooks/session-start` endpoint, which is the whole
   * point of its notice block. FALSE for the deferred re-grounding seam,
   * which rebuilds this prose at attach time onto an ADMIT response that has
   * already drained and rendered notices of its own. Without this, the
   * rebuild peeks whatever the admit drain left behind and emits a second
   * notice block whose intro reports the REMAINING count — so the model reads
   * two different revocation totals for one backlog, and sees rows the first
   * block just promised for its next tracked-file operation. That second
   * block also renders again on the next attach, because a peek consumes
   * nothing.
   */
  includeNotices: boolean = true,
): SessionStartContext {
  const agents = deps.sessions.agentsForSession(sessionId);

  const artifacts = deps.registry.listArtifacts();
  const workspaceHasState = artifacts.length > 0;
  // KTD8: artifacts sorted by path (ASCII-lexicographic — identical to the
  // Python backend's default string sort for the path charset).
  const sortedArtifacts = [...artifacts].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  // One SELECT covers every (artifact, agent) pair THIS session can render
  // — state AND recorded last-observed version together, so the staleness
  // test below never re-prepares a per-pair statement inside this
  // synchronous walk. Scoped to `agents`: a peer session's rows could never
  // reach the output (the lookup below skips them), and `agent_states` is
  // never garbage-collected, so reading them would put the workspace's
  // whole history on a hook path. The `?.get` consumers tolerate an
  // artifact with no outer entry.
  const stateByArtifact = deps.registry.allStateMaps(agents.map((a) => a.agentId));

  const notices: Array<{ artifactId: string; preempterAgentId: string; preemptedAtUnixTs: number }> =
    [];
  const groups: Array<{ subagentName: string | null; lines: string[] }> = [];
  for (const { agentId, subagentName } of agents) {
    // Per-agent peek keyed by artifact so notices collect in the same
    // artifact-path order Python's per-pair peek produces.
    const pendingByArtifact = new Map<string, { preempterAgentId: string; preemptedAtUnixTs: number }>();
    for (const n of deps.registry.peekPendingNoticesForAgent(agentId)) {
      pendingByArtifact.set(n.artifactId, n);
    }
    const lines: string[] = [];
    for (const art of sortedArtifacts) {
      const pending = pendingByArtifact.get(art.id);
      if (pending !== undefined) {
        notices.push({
          artifactId: art.id,
          preempterAgentId: pending.preempterAgentId,
          preemptedAtUnixTs: pending.preemptedAtUnixTs,
        });
      }
      const snapshot = stateByArtifact.get(art.id)?.get(agentId);
      if (snapshot === undefined) continue;
      const state = snapshot.state;
      const path = art.name;
      const current = art.version;
      if (state !== MESIState.INVALID) {
        lines.push(
          fmt(SESSION_START_GRANT_LINE_TEMPLATE, { state, path, version: String(current) }),
        );
        continue;
      }
      const last = snapshot.lastObserved;
      const stale = last !== null && current > last && art.last_writer_id !== agentId;
      if (stale) {
        lines.push(
          fmt(SESSION_START_STALE_LINE_TEMPLATE, {
            path,
            current: String(current),
            last: String(last),
          }),
        );
      } else {
        lines.push(fmt(SESSION_START_TOUCHED_LINE_TEMPLATE, { path, current: String(current) }));
      }
    }
    if (lines.length > 0) {
      groups.push({ subagentName, lines });
    }
  }
  if (groups.length === 0 && notices.length === 0) {
    return { text: null, workspaceHasState };
  }

  // Render notices via the existing admit-path prose builder so the model
  // sees the same preemption surface on every channel. Artifact names come
  // from the same snapshot as the notice collection (one consistent pass).
  let noticeText: string | null = null;
  if (includeNotices && notices.length > 0) {
    const artifactNameById = new Map(sortedArtifacts.map((a) => [a.id, a.name]));
    // R5 size bound: `notices` is flattened across the parent AND every
    // registered subagent, so it needs the same verbatim cap the artifact
    // lines carry — `preemptionNoticeText` renders one bullet per notice
    // with no cap of its own and its admit-path bytes must not move.
    //
    // Newest-first BEFORE the cap, mirroring Python `_build_preemption_text`
    // (`sorted(key=ts, reverse=True)`): the most recent preemption is the
    // most informative signal for the agent's next decision, and collection
    // order here is artifact-PATH order, which would otherwise decide
    // arbitrarily which notices survive — dropping exactly the ones Python
    // keeps. The true pre-cap count still goes to the intro; the bullets are
    // what the cap bounds, never the number the operator is told.
    const newestFirst = [...notices].sort((a, b) => b.preemptedAtUnixTs - a.preemptedAtUnixTs);
    const verbatimNotices = newestFirst.slice(0, SESSION_START_ARTIFACT_VERBATIM_CAP);
    noticeText = preemptionNoticeText(
      verbatimNotices.map((n) => {
        return {
          artifactPath: artifactNameById.get(n.artifactId) ?? "<unknown-artifact>",
          // Raw preempter id, not the resolved session: the prose builder
          // matches it against the sweep-reclamation sentinel so a coordinator
          // sweep is named as such rather than rendered as a peer session.
          preempterAgentId: n.preempterAgentId,
          // R7: the agent id, not a session id recovered from it.
          preempterAgentShort: shortSessionId(n.preempterAgentId),
          preemptedAtUnixTs: n.preemptedAtUnixTs,
        };
      }),
      notices.length,
    );
    const noticeOverflow = notices.length - verbatimNotices.length;
    if (noticeOverflow > 0) {
      noticeText +=
        "\n" + fmt(PREEMPTION_NOTICE_OVERFLOW_LINE_TEMPLATE, { count: String(noticeOverflow) });
    }
  }

  const rendered: string[] = [SESSION_START_HEADER];
  if (noticeText !== null) {
    rendered.push(noticeText);
  }
  const totalLines = groups.reduce((sum, g) => sum + g.lines.length, 0);
  let budget = SESSION_START_ARTIFACT_VERBATIM_CAP;
  for (const group of groups) {
    if (budget <= 0) break;
    const take = group.lines.slice(0, budget);
    if (group.subagentName !== null) {
      rendered.push(fmt(SESSION_START_SUBAGENT_PREFIX_TEMPLATE, { name: group.subagentName }));
    }
    rendered.push(...take);
    budget -= take.length;
  }
  const overflow = totalLines - SESSION_START_ARTIFACT_VERBATIM_CAP;
  if (overflow > 0) {
    rendered.push(fmt(SESSION_START_OVERFLOW_LINE_TEMPLATE, { count: String(overflow) }));
  }
  rendered.push(SESSION_START_CLOSING_LINE);
  return { text: rendered.join("\n"), workspaceHasState };
}

export async function handleSessionStart(
  body: SessionStartBody,
  res: ServerResponse,
  deps: SessionStartDeps,
): Promise<void> {
  if (!isValidSessionId(body.session_id)) {
    writeError(res, 400, "missing session_id");
    return;
  }
  const sessionId: string = body.session_id;
  const subagentId = readSubagentId(body as Record<string, unknown>);

  // R8 breadcrumb precondition: sample seen-ness BEFORE registration erases
  // it — registration below makes this session "seen" for every later
  // request, which is exactly what keeps the breadcrumb a once-per-rotation
  // signal rather than log spam.
  const neverSeen = deps.sessions.agentIdToName(sessionToAgentId(sessionId)) === null;
  deps.sessions.registerSession(sessionId);
  if (subagentId !== null) {
    deps.sessions.registerSession(sessionId, subagentId);
  }

  let built: SessionStartContext;
  try {
    built = buildSessionStartContext(deps, sessionId);
  } catch (err) {
    // KTD7 degraded shape: a failed build answers the empty payload — never
    // block, never claim state it could not read — and the compact-pending
    // flag stays unarmed (nothing to deliver later that was never built).
    process.stderr.write(`agent-coherence: session-start build failed: ${String(err)}\n`);
    writeJson(res, 200, {});
    return;
  }
  if (neverSeen && built.workspaceHasState) {
    // R8: a compact event for a session this coordinator never saw, while
    // the workspace demonstrably holds coordination state, is the signature
    // of a silent session-id rotation (or a coordinator restart) — a
    // debug-level observable, not an alarm.
    process.stderr.write(
      `agent-coherence: session-start for never-seen session ${sessionId} while the ` +
        `workspace holds coordination state — possible session-id rotation or ` +
        `coordinator restart (SB-10 R8)\n`,
    );
  }
  if (built.text === null) {
    writeJson(res, 200, {});
    return;
  }
  // Non-empty payload → arm deferred delivery (KTD5). Ordering matters: the
  // flag is set only AFTER a successful build, so a degraded or failed
  // request leaves the deferred path unarmed.
  deps.sessions.markCompactPending(sessionId);
  writeJson(res, 200, {
    hookSpecificOutput: emitSessionStart({ additionalContext: built.text }),
  });
}

export async function sessionStartRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SessionStartDeps,
  maxBytes: number,
): Promise<void> {
  if (req.method !== "POST") {
    writeError(res, 404, "not found");
    return;
  }
  const body = await readJsonBody(req, res, maxBytes);
  if (body === null) return;
  await handleSessionStart(body as SessionStartBody, res, deps);
}
