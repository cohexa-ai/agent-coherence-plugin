/**
 * Hook response builders — Node port of Python `hook_payloads.py`.
 *
 * Produces the exact `hookSpecificOutput` shapes Claude Code injects into
 * the agent's context: stale-read warnings, edit-collision warnings,
 * preemption-notice prose. Per-invocation variation in the text is
 * structural defense for v0.2 strict mode (the §13.5 retry-loop hazard the
 * Phase 0 falsifiability experiment investigated — see
 * docs/probes/2026-05-19-ktd-e-falsifiability/REPORT.md).
 *
 * Per KTD-B.3 C3: the OUTER response keys are snake_case (we own them).
 * Per the same: `hookSpecificOutput` and all keys inside it are camelCase
 * (Claude Code owns the hook-output schema — this is the documented
 * boundary).
 *
 * Per KTD-13: NEVER include content bytes, content hashes, or diff text
 * in the response surface. Stale-read summary is structural metadata only.
 */

export interface StaleSummary {
  path: string;
  current_version: number;
  /**
   * The version this session last actually OBSERVED, read from the
   * registry's per-agent `last_observed_version` rather than inferred as
   * `current_version - 1`. The inference assumed the invalidation came from
   * a commit; when a peer merely took the grant it reported a version the
   * session never saw and made an unchanged version look changed
   * (Cohexa-ai/agent-coherence#196). `null` = never observed.
   */
  prior_version_seen_by_session: number | null;
  /**
   * The writer's AGENT id (`artifacts.last_writer_id`), or the literal
   * `<unknown>` when nothing has been committed. Named for the session id it
   * used to carry; the wire key is kept so hook scripts, the CLI and the
   * recorded corpus keep parsing by exact shape. R7: this used to be the
   * session id, recovered by running `sessionToAgentId` backwards.
   */
  last_writer_session_id: string;
  last_writer_at_unix_ts: number;
  warning_generated_at_unix_ts: number;
  hash_differs: boolean;
}

export interface HookSpecificOutput {
  hookEventName: "PreToolUse";
  /**
   * REQUIRED, deliberately: this interface is the DECIDING envelope, and
   * `writeJson` is a bare `JSON.stringify` with no runtime schema check, so
   * this field being mandatory is the only thing that stops a deciding
   * emitter from shipping a body Claude Code would read as "no opinion".
   * An advisory envelope that carries context WITHOUT deciding anything is
   * a different shape with its own type — see `PreToolUseContextOutput`.
   */
  permissionDecision: "allow" | "deny" | "ask";
  /**
   * OPTIONAL (Unit 6 review correction): Python's `emit_strict_deny` returns
   * NO `additionalContext` key at all, and `emit_allow` includes it only
   * when non-None. Byte-parity requires OMITTING the key, not sending "".
   */
  additionalContext?: string;
  permissionDecisionReason?: string;
}

/**
 * SB-10: the context-only `hookSpecificOutput` envelope for a PreToolUse
 * response — advisory prose with NO permission decision. Node port of
 * Python `PreToolUseContextOutput` (hook_payloads.py).
 *
 * Distinct from `HookSpecificOutput` by the ABSENCE of
 * `permissionDecision`: this envelope delivers text to the model without
 * touching the tool call's permission outcome, so Claude Code's ordinary
 * prompting still applies. Used by the SB-10 deferred re-grounding attach,
 * whose payload is advisory (KD3) and must never widen a permission
 * decision.
 */
export interface PreToolUseContextOutput {
  hookEventName: "PreToolUse";
  additionalContext: string;
}

/**
 * Either PreToolUse envelope shape, for the seams that INSPECT a response
 * body they did not build (the deferred re-ground attach). Reading
 * `permissionDecision` off this union requires an `in` narrowing, which is
 * the point: a context-only envelope has no decision to read.
 */
export type PreToolUseEnvelope = HookSpecificOutput | PreToolUseContextOutput;

/**
 * Build a context-only `hookSpecificOutput` envelope: `additionalContext`
 * prose and nothing else. Node port of Python `emit_pretooluse_context`.
 *
 * Deliberately NOT routed through `emitAllow` — and deliberately emitting
 * no `permissionDecision`. An advisory payload must never widen a
 * permission decision: promoting a bare admit body to
 * `permissionDecision: "allow"` just to carry prose would short-circuit
 * Claude Code's own permission prompting for that tool call.
 *
 * Empirical basis: a PreToolUse `hookSpecificOutput` with `hookEventName` +
 * `additionalContext` and no `permissionDecision` IS rendered to the model
 * — A/B capture against Claude Code CLI 2.1.233 on 2026-08-25 (the
 * marker-primed model quoted the injected line verbatim in both arms).
 */
export function emitPreToolUseContext(args: {
  additionalContext: string;
}): PreToolUseContextOutput {
  return {
    hookEventName: "PreToolUse",
    additionalContext: args.additionalContext,
  };
}

// ----------------------------------------------------------------------
// v0.2 strict-mode emitters — Node port of Python hook_payloads.py
// (KTD-P static deny text · KTD-U terminal denial) — zero-Python Unit 6
// ----------------------------------------------------------------------

/**
 * KTD-U security invariant: denial classes that must NEVER be converted to
 * `permissionDecision: "allow"`. `emitAllow` throws on membership.
 */
export const TERMINAL_DENIAL_CLASSES: ReadonlySet<string> = new Set([
  "permissions_deny_strict_mode",
]);

/**
 * KTD-P static deny text — BYTE-IDENTICAL to the Python
 * `STRICT_MODE_DENY_REASON_TEMPLATE`. Phase 0 H1 proved varied deny text
 * WORSENS opus retry behavior (5 retries vs 2); every substitution is
 * deterministic per-artifact / per-preempter / per-commit-tick. Do not
 * reword, respace, or add fields.
 *
 * R7 reworded it once, "session" → "agent", in the same change on both
 * backends: `last_writer_short` shortens an AGENT id now, because the
 * registry stores `artifacts.last_writer_id` as one and the response renders
 * it as-is instead of mapping it back to the session id it was derived from.
 * Byte-stability is a property of the same inputs producing the same bytes,
 * which a one-time reword landed on both sides does not disturb.
 */
export const STRICT_MODE_DENY_REASON_TEMPLATE =
  "Stale read denied: {path} was updated by agent {last_writer_short} " +
  "at {last_writer_ts_iso}. Re-read {path} via the Read tool before " +
  "proceeding. This denial is structural (v0.2 strict mode); retrying " +
  "the same operation will produce the same denial.";

/**
 * The deny text for the arm where nothing was written (R8) — BYTE-IDENTICAL
 * to the Python `GRANT_CHANGE_DENY_REASON_TEMPLATE`.
 *
 * Cohexa-ai/agent-coherence#196: a peer's `pre-edit` invalidates a live
 * holder WITHOUT committing. The holder's next read was denied with "was
 * updated by session <unknown> at <t>" — a write that never happened, named
 * against a writer that does not exist, at a timestamp when nothing was
 * written. `summaryReportsAWrite` picks between the two templates.
 *
 * Carries no timestamp at all: a revocation the summary can see has no event
 * tick of its own (`last_writer_at_unix_ts` is the last real commit, which is
 * not what happened here), and the version is the honest thing to report.
 * That makes this arm byte-stable for the same reason the other one is.
 */
export const GRANT_CHANGE_DENY_REASON_TEMPLATE =
  "Stale read denied: your grant on {path} was revoked and no new version " +
  "was committed \u2014 {path} is still at v{current_version}. Re-read " +
  "{path} via the Read tool before proceeding. This denial is structural " +
  "(v0.2 strict mode); retrying the same operation will produce the same " +
  "denial.";

/**
 * Does this summary support the claim that the artifact was WRITTEN?
 * Mirrors Python `hook_payloads.summary_reports_a_write` exactly.
 *
 * Three admitting cases, one refusing one:
 * - `prior_version_seen_by_session === null` — the session never observed
 *   this artifact, so there is no grant of its own that could have changed
 *   hands and no baseline to call unchanged.
 * - `hash_differs` — the bytes the caller just hashed differ from the
 *   coordinator's recorded content. Something was written, in-band or out.
 * - `current_version > prior_version_seen_by_session` — a commit landed.
 *
 * Otherwise the version this session observed is still the current one and
 * its bytes still match: nothing was written, and the only thing that moved
 * is the grant. Both branches are pinned by tests, because a predicate
 * asserted only in the admitting direction is indistinguishable from one
 * that always admits — which is what the single template this replaces
 * effectively was.
 */
export function summaryReportsAWrite(summary: StaleSummary): boolean {
  const prior = summary.prior_version_seen_by_session;
  if (prior === null) return true;
  if (summary.hash_differs) return true;
  return summary.current_version > prior;
}

/**
 * Python `datetime.fromtimestamp(ts, tz=utc).isoformat()` semantics —
 * NOT `Date.toISOString()` (which emits `Z` + fixed 3-digit ms and would
 * byte-diverge on every fractional timestamp; plan review finding):
 * - offset rendered as `+00:00`
 * - microsecond precision, 6 digits zero-padded, OMITTED entirely when the
 *   fractional part rounds to 0.
 */
export function pythonIsoUtc(unixSeconds: number): string {
  const totalMicros = Math.round(unixSeconds * 1e6);
  const micros = ((totalMicros % 1_000_000) + 1_000_000) % 1_000_000;
  const seconds = (totalMicros - micros) / 1_000_000;
  const d = new Date(seconds * 1000);
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const base =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}` +
    `T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}`;
  return micros === 0 ? `${base}+00:00` : `${base}.${pad(micros, 6)}+00:00`;
}

/**
 * Build the allow envelope. ALL allow emissions route through here so the
 * KTD-U invariant is structurally enforced: converting a terminal-class
 * denial back to allow throws (mirrors Python's AssertionError).
 */
export function emitAllow(args: {
  source: string;
  additionalContext?: string | null;
  denialClass?: string | null;
}): HookSpecificOutput {
  if (args.denialClass != null && TERMINAL_DENIAL_CLASSES.has(args.denialClass)) {
    throw new Error(
      `emitAllow(source=${args.source}, denialClass=${args.denialClass}): ` +
        `refused to convert TERMINAL_DENIAL_CLASSES member to allow. ` +
        `This is the KTD-U security invariant — strict-mode denials are structurally terminal.`,
    );
  }
  const out: HookSpecificOutput = {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
  };
  if (args.additionalContext != null) out.additionalContext = args.additionalContext;
  return out;
}

/**
 * The 8-char short form of an identity handle, EXCEPT for a `<...>` sentinel.
 *
 * A placeholder like `"<unknown>"` is prose, not an identifier: slicing it to
 * 8 chars drops the closing angle bracket and ships malformed text
 * ("<unknown"). Real handles are 36-char session UUIDs or 32-char agent-id
 * hex, so an 8-char prefix is unambiguous whenever one is present. Every
 * renderer that shortens an identity handle for prose goes through here — the guard used to live in `emitStrictDeny`
 * alone, and the two warn-mode renderers sliced the sentinel. Mirrors Python's
 * `hook_payloads.short_session_id`.
 */
export function shortSessionId(identityId: string): string {
  return identityId.startsWith("<") && identityId.endsWith(">") ? identityId : identityId.slice(0, 8);
}

/**
 * Literal `{key}` template substitution in ONE pass over the template, so a
 * substituted value is never re-scanned — a tracked path carrying a brace
 * token (`docs/{current}/plan.md` passes isValidPath) must render verbatim,
 * exactly as Python's single-pass `str.format` renders it. The replacer
 * form also keeps values containing `$` patterns from corrupting the prose
 * — the templates are the byte-parity contract.
 */
export function fmt(template: string, subs: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match: string, key: string) =>
    Object.hasOwn(subs, key) ? subs[key] : match,
  );
}

/**
 * Build the strict-mode deny envelope — byte-parity with Python
 * `emit_strict_deny`:
 * - null/absent last_writer → the literal `<unknown>`;
 * - a `<…>` sentinel is preserved VERBATIM (a naive [:8] slice would emit
 *   `<unknown` — the plan-review finding);
 * - otherwise the 8-char short form;
 * - timestamp via `pythonIsoUtc` (never toISOString);
 * - NO additionalContext key.
 * The `source` arg is kept for call-site telemetry parity with Python.
 */
export function emitStrictDeny(args: { source: string; summary: StaleSummary }): HookSpecificOutput {
  if (!summaryReportsAWrite(args.summary)) {
    return {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: fmt(GRANT_CHANGE_DENY_REASON_TEMPLATE, {
        path: args.summary.path,
        current_version: String(args.summary.current_version),
      }),
    };
  }
  const lastWriterFull = args.summary.last_writer_session_id || "<unknown>";
  const lastWriterShort = shortSessionId(lastWriterFull);
  const lastWriterTsIso = pythonIsoUtc(args.summary.last_writer_at_unix_ts);
  const reason = fmt(STRICT_MODE_DENY_REASON_TEMPLATE, {
    path: args.summary.path,
    last_writer_short: lastWriterShort,
    last_writer_ts_iso: lastWriterTsIso,
  });
  return {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  };
}

export interface StaleResponse {
  hookSpecificOutput: HookSpecificOutput;
  status: "stale";
  summary: StaleSummary;
}

export interface CollisionResponse {
  hookSpecificOutput: HookSpecificOutput;
  ok: true;
  collision: true;
}

export interface FreshResponse {
  status: "fresh";
}

export interface FreshWithNoticeResponse {
  status: "fresh";
  hookSpecificOutput: HookSpecificOutput;
}

/** Single source of truth for "now" in unix-seconds; tests can mock later. */
export function nowUnix(): number {
  return Date.now() / 1000;
}

/**
 * Build the stale-read additionalContext text. Per-invocation variation
 * via `warning_generated_at_unix_ts` (handler-time now()) guarantees
 * byte-different text across retries — structural defense for any future
 * strict-mode flip. Matches Python `stale_read_warning` prose pattern.
 */
export function staleReadWarning(summary: StaleSummary): string {
  if (!summaryReportsAWrite(summary)) return grantChangeWarning(summary);
  const lastWriterShort = shortSessionId(summary.last_writer_session_id);
  const lastWriterTs = pythonIsoUtc(summary.last_writer_at_unix_ts);
  const generatedTs = pythonIsoUtc(summary.warning_generated_at_unix_ts);

  const priorClause =
    summary.prior_version_seen_by_session !== null
      ? `you previously saw v${summary.prior_version_seen_by_session}`
      : "this is the first time your session has observed this artifact " +
        "(another session in this workspace registered it before you)";

  const divergence = summary.hash_differs
    ? "Your worktree's current content also differs from the coordinator's " +
      "last-recorded hash, which suggests in-flight local edits or a " +
      "different branch checkout."
    : "Your worktree's content matches the last-recorded hash; the divergence " +
      "is purely about version-tracking metadata.";

  return (
    `⚠ Stale read [warning emitted ${generatedTs}]: ${summary.path} was ` +
    `updated by agent ${lastWriterShort} at ${lastWriterTs}. ` +
    `Current version is v${summary.current_version}; ${priorClause}. ` +
    `${divergence} ` +
    `Consider re-reading ${summary.path} before acting on stale assumptions.`
  );
}

/**
 * The warn-mode counterpart of `GRANT_CHANGE_DENY_REASON_TEMPLATE` —
 * BYTE-IDENTICAL to Python `_grant_change_warning`.
 *
 * Reached only when `summaryReportsAWrite` refuses, which fixes both of the
 * other two facts this prose states: `hash_differs` is false there (so the
 * worktree really does still match) and `prior_version_seen_by_session`
 * equals `current_version` (so "the version you last saw" is exact).
 *
 * The advice differs from the write arm on purpose. Nothing moved under the
 * reader, so re-reading buys it nothing; what it lost is the grant, and the
 * next thing that will fail is a write.
 */
function grantChangeWarning(summary: StaleSummary): string {
  const generatedTs = pythonIsoUtc(summary.warning_generated_at_unix_ts);
  const path = summary.path;
  return (
    `⚠ Stale read [warning emitted ${generatedTs}]: your grant on ${path} ` +
    `was revoked and no new version was committed. ${path} is still at ` +
    `v${summary.current_version}, the version you last saw. ` +
    `Re-acquire before writing to ${path}.`
  );
}

/**
 * Build the edit-collision additionalContext text. Per-invocation variation
 * via `detected_ts = now()` matches Python's structural defense.
 */
export function editCollisionWarning(
  holderSessionId: string,
  holderAcquiredAtUnixTs: number,
  path: string,
): string {
  const holderShort = shortSessionId(holderSessionId);
  const holderTs = pythonIsoUtc(holderAcquiredAtUnixTs);
  const detectedTs = pythonIsoUtc(nowUnix());
  return (
    `⚠ Concurrent edit detected at ${detectedTs} (UTC): another agent ` +
    `(${holderShort}) has been editing ${path} since ${holderTs}. ` +
    `Your edit will land in your own worktree, but only one session's ` +
    `commit will be accepted by the coordinator. Consider waiting for the ` +
    `other session to finish or coordinating which one should proceed.`
  );
}

/**
 * Build the preemption-notice additionalContext text for a session whose
 * grant was silently revoked by a peer. Mirrors Python's
 * `_build_preemption_text`.
 */
/**
 * Render pending preemption notices as admit-path prose.
 *
 * THE ADMIT CALLERS ARE NOW BOUNDED. They drain through `drainNoticeText`
 * (src/hooks/_common.ts), which passes `ADMIT_NOTICE_VERBATIM_CAP` to
 * `popPendingNoticesForAgent` and coalesces the remainder into one line.
 *
 * This block previously argued at length that they were deliberately
 * uncapped, on the grounds that the pop DELETEs every row before returning,
 * so capping the RENDER would destroy the difference rather than defer it.
 * That reasoning was sound and it is what a render-only bound (PR #150) got
 * wrong. What it missed is that Python does not cap the render either: it
 * bounds the CONSUME. `pop_pending_notices(consume_limit=)` deletes only the
 * slice the caller renders and returns the whole queue, so the tail stays in
 * the table and the intro still reports a true total. Node's registry now
 * does the same, which is why the bound is safe here without the TTL sweep
 * the old argument said was a prerequisite: nothing is dropped, so nothing
 * needs reclaiming for correctness. Rows for an agent that never returns do
 * linger -- bounded by `PRIMARY KEY (agent_id, artifact_id)`, so by the
 * tracked-artifact count -- and a session-stop drain is the cheap backstop if
 * that ever matters.
 *
 * What the bound achieved, measured end-to-end on /hooks/pre-read: at 80
 * notices with 60-char paths the composed additionalContext went from 11,037
 * bytes to 2,022, and is now independent of the notice COUNT.
 *
 * What it does NOT bound is path length. Every bullet carries a path, and the
 * composed payload renders notice bullets twice -- once here and again inside
 * the deferred re-grounding block, which is rebuilt at attach time and peeks
 * whatever this drain left. At ~700+ character paths that still breaches the
 * ceiling; `src/test/composed_context_budget.test.ts` pins it as a RESIDUAL
 * with the measurements. No real tracked path approaches that.
 *
 * The ceiling is the PLATFORM's, not a house convention: Claude Code routes
 * every hook's `additionalContext` through one helper that returns the string
 * unchanged only while `length <= 1e4`, and above it persists the prose to a
 * file and hands the model a 2,000-byte preview plus a path. The derivation
 * and the exact bundle symbols are recorded on the constant in
 * src/test/composed_context_budget.test.ts.
 *
 * Do not add a notice COUNT to this comment as a threshold: bullet size scales
 * with path length, so any "N notices" figure is a point value that reads as a
 * constant and is not one. Cohexa-ai/agent-coherence-plugin#138 carries the
 * measurements and the method that reproduces them.
 */
export function preemptionNoticeText(
  notices: ReadonlyArray<{
    artifactPath: string;
    preempterAgentShort: string;
    preemptedAtUnixTs: number;
  }>,
  /**
   * How many notices are actually pending, when the caller renders only a
   * capped slice of them (SB-10's session-start block does). The intro
   * counts what the operator HAS, not how many bullets fit — reporting the
   * slice length would tell them three grants were revoked when forty were.
   * Defaults to `notices.length` for a caller that renders everything it was
   * given. Both capped callers pass it explicitly: session-start at
   * `session_start.ts` and the shared admit drain `drainNoticeText` in
   * `hooks/_common.ts`, which passes the whole queue's length while
   * rendering only `ADMIT_NOTICE_VERBATIM_CAP` of it.
   */
  totalCount: number = notices.length,
): string {
  if (notices.length === 0) return "";
  const lines = notices.map(
    (n) =>
      `  • ${n.artifactPath} preempted by agent ${n.preempterAgentShort} at ${pythonIsoUtc(n.preemptedAtUnixTs)}`,
  );
  const intro =
    totalCount === 1
      ? "⚠ Your EXCLUSIVE grant on this artifact was silently revoked by another session:"
      : `⚠ ${totalCount} of your EXCLUSIVE grants were silently revoked by other sessions:`;
  return `${intro}\n${lines.join("\n")}`;
}

export function buildStaleResponse(summary: StaleSummary): StaleResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow", // v0.1.1 warn-only; v0.2 may flip per KTD-E
      additionalContext: staleReadWarning(summary),
    },
    status: "stale",
    summary,
  };
}

export function buildCollisionResponse(
  holderSessionId: string,
  holderAcquiredAtUnixTs: number,
  path: string,
): CollisionResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: editCollisionWarning(holderSessionId, holderAcquiredAtUnixTs, path),
    },
    ok: true,
    collision: true,
  };
}

export function buildFreshWithNotice(notice: string): FreshWithNoticeResponse {
  return {
    status: "fresh",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: notice,
    },
  };
}

// ----------------------------------------------------------------------
// SB-10 post-compaction re-grounding prose (KTD8) — Node port of Python
// hook_payloads.py, byte-parity contract
// ----------------------------------------------------------------------
//
// The Python coordinator (agent-coherence 2bd756c) renders these exact
// strings, and the protocol corpus byte-matches the rendered payload. NO
// timestamps may appear in any of them (corpus normalization keys stay
// untouched), and grant prose is EVENT-ANCHORED, not present-tense — a
// turn-end Stop drain can release E/M before the attachment ever renders,
// so "you hold" would emit a false claim. Every dash is U+2014 EM DASH
// with surrounding spaces. Any wording change must land in both backends
// plus the corpus fixtures in the same change.

/**
 * SB-10 U2: `hookSpecificOutput` envelope for the SessionStart hook.
 * Unlike PreToolUse there is no permissionDecision — SessionStart cannot
 * gate anything (KD3: re-grounding is advisory, never blocking); the
 * envelope carries only the re-grounding prose.
 */
export interface SessionStartHookOutput {
  hookEventName: "SessionStart";
  additionalContext: string;
}

/** First line of every non-empty re-grounding payload. */
export const SESSION_START_HEADER = "Post-compaction re-grounding (agent-coherence):";

/**
 * R3 held-grant line. `{state}` is the full MESI state name
 * (EXCLUSIVE/MODIFIED/SHARED); `{version}` is the CURRENT coordinated
 * version from the snapshot, not the granted-at version.
 */
export const SESSION_START_GRANT_LINE_TEMPLATE =
  "At compaction you held {state} on {path} (v{version}) — re-acquire " + "before writing.";

/**
 * R4 stale-divergence line (KD1 shape B): both versions render so the
 * model can judge how far behind its cached view is.
 */
export const SESSION_START_STALE_LINE_TEMPLATE =
  "{path} advanced to v{current} past your last-observed v{last} — " +
  "re-read before relying on it.";

/**
 * R4 touched-but-current line — also the R7 admit rendering for
 * never-observed rows and own-edit-exempt rows.
 */
export const SESSION_START_TOUCHED_LINE_TEMPLATE = "{path} is at v{current}.";

/**
 * R5 overflow line, mirroring the preemption-prose cap pattern: at most 3
 * artifact lines render verbatim; the rest coalesce here.
 */
export const SESSION_START_OVERFLOW_LINE_TEMPLATE =
  "Plus {count} more — run agent-coherence-status for the full picture.";

/**
 * R5 overflow line for the PREEMPTION-NOTICE block. Deliberately not the
 * artifact template above.
 *
 * That line names `agent-coherence-status`, which is honest for coalesced
 * artifact lines — `GET /status` carries `tracked_artifacts[].path/.version`.
 * It carries no notice data at ANY disclosure tier, so pointing a coalesced
 * notice there promises a surface that cannot answer. Session-start PEEKS the
 * notice queue rather than popping it, so the overflowed rows genuinely do
 * survive and reach the model on the next tracked-file admit; this says that
 * instead. Mirrors Python's `_build_preemption_text`, which dropped the same
 * /status pointer for the same reason.
 *
 * The leading `  • ` is load-bearing, not decoration: this line closes a
 * bulleted list and Python's counterpart carries the same marker
 * (`_build_preemption_text`, coordinator_server.py). Without it the block
 * ends in an unbulleted orphan on every surface that renders it.
 */
export const PREEMPTION_NOTICE_OVERFLOW_LINE_TEMPLATE =
  "  • Plus {count} more preemptions since your last activity, still queued — " +
  "they surface on your next tracked-file operation.";

/**
 * KTD8 grouping: the parent agent's lines render first (no prefix), then
 * each registered subagent's lines under this prefix, groups sorted by
 * agent name.
 */
export const SESSION_START_SUBAGENT_PREFIX_TEMPLATE = "Subagent {name}:";

/**
 * Self-qualifier, always the last line when any lines rendered — R2
 * accepts one residual duplicate delivery, so the prose must read
 * correctly when seen twice (a later read wins over a stale re-emission).
 */
export const SESSION_START_CLOSING_LINE =
  "Versions are as of this re-grounding; a more recent read supersedes " + "this notice.";

/**
 * Build the `hookSpecificOutput` envelope for a SessionStart response.
 * Mirrors Python `emit_session_start` — deliberately NOT routed through
 * `emitAllow`: there is no permissionDecision on SessionStart, and the
 * KTD-U meta-test counts allow-path surface, which this is not.
 */
export function emitSessionStart(args: { additionalContext: string }): SessionStartHookOutput {
  return {
    hookEventName: "SessionStart",
    additionalContext: args.additionalContext,
  };
}
