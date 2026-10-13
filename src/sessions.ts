/**
 * Session registry — in-memory mapping between Claude Code session_id strings
 * and the derived agent_id UUID hex used in agent_states / pending_notices.
 *
 * Per KTD-A.5 minor finding + Python pattern (`coordinator_server.py:282-289`
 * `register_session`): the agent_id is deterministic (UUID5 of the session_id,
 * see `agent_id.ts`), so this map could be reconstructed on the fly. But the
 * reverse direction (agent_id → session_id) is needed for stale-warning prose
 * — `last_writer_id` is stored as an agent_id; surfacing it as the short
 * 8-char session prefix requires the reverse lookup.
 *
 * In-memory, process-local. Coordinator restart clears the map; stale
 * warnings emitted before any session re-introduces itself show
 * `<unknown>` for the writer. Matches Python's `_agent_names` semantics.
 *
 * The `agent_names` field referenced in v0.1 plan's KTD-K residual-risk
 * "_agent_names mutation relies on CPython GIL" finding maps to THIS module;
 * since Node is single-threaded by design (no GIL concept; event loop
 * serializes JS access), the Python locking concern doesn't apply.
 */
import { sessionToAgentId, sessionToAgentName } from "./agent_id.js";

export class SessionRegistry {
  // Forward: agent_id → session_id. Used for last_writer_session_id lookup.
  // Forward: session_id → agent_id. Avoids re-running uuid5 on every hook.
  private readonly bySessionId = new Map<string, string>();
  // Reverse: agent_id → session_id. Used for last_writer_session_id lookup.
  private readonly byAgentId = new Map<string, string>();

  // agent_id → human-readable agent name (parent linkage stays visible on
  // /status for subagent identities). SB-25.
  private readonly nameByAgentId = new Map<string, string>();

  // SB-10 U6 (KTD5): compact-pending flags, keyed by session_id. Set by
  // /hooks/session-start when the re-grounding payload is non-empty;
  // consumed by reground.ts's claim at the allow-attach seam (SB-10 U8).
  // Expiry is Stop-event-driven only (`expireCompactPending`; a coordinator
  // restart clears implicitly) — never age-based. Mirrors Python
  // `CoordinatorHTTPServer._compact_pending` — process-local, so a
  // coordinator restart drops undelivered flags (accepted degradation:
  // re-grounding is advisory, never load-bearing).
  private readonly compactPending = new Set<string>();

  /**
   * Register a session by its Claude Code session_id, optionally scoped to a
   * subagent identity (SB-25 composite derivation — see agent_id.ts).
   * Returns the deterministic agent_id (UUID hex). Idempotent.
   *
   * R2 attribution: a subagent gets an agent id DISTINCT from its parent's,
   * so the `[:8]` short form in warn/deny prose names the actual writer. The
   * parent linkage stays in `nameByAgentId`; /status does not render it (R6:
   * this coordinator serves no operator tier).
   */
  registerSession(sessionId: string, subagentId?: string | null): string {
    const cacheKey =
      subagentId != null && subagentId !== "" ? `${sessionId}:${subagentId}` : sessionId;
    const cached = this.bySessionId.get(cacheKey);
    if (cached !== undefined) return cached;
    const agentId = sessionToAgentId(sessionId, subagentId);
    this.bySessionId.set(cacheKey, agentId);
    this.byAgentId.set(
      agentId,
      subagentId != null && subagentId !== "" ? subagentId : sessionId,
    );
    this.nameByAgentId.set(
      agentId,
      subagentId != null && subagentId !== ""
        ? `${sessionToAgentName(sessionId)}:subagent-${subagentId}`
        : sessionToAgentName(sessionId),
    );
    return agentId;
  }

  /*
   * R7: `agentIdToSessionId` used to live here. It reversed the derivation so
   * the four hooks could print a session id in prose; every one of them now
   * prints the agent id the registry already holds, and the accessor is
   * DELETED rather than left unused -- kept around, the next renderer that
   * wants a friendlier label reaches for it and re-introduces the mapping.
   * `byAgentId` stays because `knownAgentIds` is built from its keys. Mirrors
   * the removal of Python's `_agent_id_to_session`.
   */

  /** Human-readable agent name; mirrors Python `session_to_agent_name`. */
  agentIdToName(agentId: string): string | null {
    return this.nameByAgentId.get(agentId) ?? null;
  }

  /** All currently-known agent_ids. For /status diagnostics. */
  knownAgentIds(): string[] {
    return [...this.byAgentId.keys()];
  }

  /**
   * SB-10 U6: the session's coherence agents as `{agentId, subagentName}`
   * pairs — the parent first (`subagentName: null`, derivable via uuid5
   * WITHOUT prior registration), then registered subagents sorted by agent
   * name (KTD8 group order). Mirrors Python `agents_for_session`.
   *
   * Enumeration is a prefix scan of the in-memory name map using the
   * deterministic SB-25 naming scheme (`claude-session-<sid>:subagent-<name>`)
   * — the registry has no session→subagents accessor, and this adapter-owned
   * map is the SB-25 source of truth for registration. Session ids are
   * fixed-shape UUIDs, so one session's prefix can never be a prefix of
   * another's. A restart-empty map is an accepted degradation (KTD5):
   * subagents re-enter on their next hook call.
   */
  agentsForSession(sessionId: string): Array<{ agentId: string; subagentName: string | null }> {
    const subagentPrefix = `${sessionToAgentName(sessionId)}:subagent-`;
    const subagents: Array<{ agentId: string; subagentName: string }> = [];
    for (const [agentId, name] of this.nameByAgentId) {
      if (name.startsWith(subagentPrefix)) {
        subagents.push({ agentId, subagentName: name.slice(subagentPrefix.length) });
      }
    }
    // Same-prefix names sort identically by full name or by suffix; the
    // suffix is what the Subagent group prefix renders.
    subagents.sort((a, b) =>
      a.subagentName < b.subagentName ? -1 : a.subagentName > b.subagentName ? 1 : 0,
    );
    return [{ agentId: sessionToAgentId(sessionId), subagentName: null }, ...subagents];
  }

  /**
   * SB-10 U6 (KTD5): arm the compact-pending flag for a session. Idempotent:
   * a second compaction before delivery simply re-marks.
   */
  markCompactPending(sessionId: string): void {
    this.compactPending.add(sessionId);
  }

  /**
   * SB-10 U6 (KTD5): ATOMIC test-and-clear of the compact-pending flag —
   * true iff the flag was set (and this call cleared it). Node's
   * single-threaded event loop makes Set.delete's presence-return the
   * exact test-and-clear primitive; the shape is kept so racing consumers
   * (reground.ts's claim at the allow seam) get exactly one winner.
   */
  consumeCompactPending(sessionId: string): boolean {
    return this.compactPending.delete(sessionId);
  }

  /**
   * SB-10 U8 (KTD6): NON-consuming advisory peek at the flag — the cheap
   * process-local Map lookup the admit handlers hoist above their untracked
   * fast-path exits, so no-flag traffic keeps today's exact response bytes
   * and never touches the artifact registry. Advisory only: the
   * authoritative at-most-once decision stays with the test-and-clear in
   * `consumeCompactPending` at the allow-attach seam.
   */
  hasCompactPending(sessionId: string): boolean {
    return this.compactPending.has(sessionId);
  }

  /** SB-10 U6 (KTD5): drop an unconsumed flag (parent-Stop expiry wiring). */
  expireCompactPending(sessionId: string): void {
    this.compactPending.delete(sessionId);
  }
}
