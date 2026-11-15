/**
 * The hook client's refusal of held strict files: its decisions, with no I/O
 * beyond reading the setting. Node twin of the library's Python module
 * `ccs.cli._hook_on_held`, function by function.
 *
 * A workspace turns the refusal on with the one-line file
 * `.coherence/hook_on_held` holding `refuse`. With it on, the hook client's
 * pre-edit of a strict file asks the coordinator for the file only if no other
 * agent holds it, and turns any other answer into a deny. This module decides
 * the setting, the fold profiles under which a path is strict, what the
 * coordinator's `/status` says, whether a subagent id may be sent, and what
 * the hook prints for the coordinator's answer.
 *
 * Every test of a coordinator's JSON is by key presence and exact value, as
 * the Python module's `in` and `is True` are: an admit carrying `degraded:
 * false` is not a clean admit, and a `fold_profile` of null is not an absent
 * one.
 */
import { OTHER_HOLDER_REASON } from "./acquire_or_fail.js";
import { isValidSubagentId, sessionToAgentId } from "./agent_id.js";
import { readStateFile } from "./disk_content.js";
import {
  emitAdmissionUnavailableDeny,
  emitHeldByParentDeny,
  emitHeldPathDeny,
  type HookSpecificOutput,
} from "./hook_payloads.js";
import type { FoldProfile } from "./path_fold.js";
// Type only: the hook client loads the policy module itself, and only for a
// pre-edit with the setting on, so no other hook pays for its import.
import type { PolicyMatchContext, TrackedArtifactPolicy } from "./policy.js";

export const SETTING_FILE = "hook_on_held";
export const SETTING_ON = "on";
export const SETTING_OFF = "off";
export const SETTING_UNKNOWN = "unknown";
export type HoldRefusalSetting = typeof SETTING_ON | typeof SETTING_OFF | typeof SETTING_UNKNOWN;

/** The one stderr line for an unknown setting. Built from constants only. */
export const UNKNOWN_SETTING_MESSAGE =
  ".coherence/hook_on_held holds neither refuse nor displace, so edits of " +
  "held strict files are not refused";

/**
 * The one stderr line when `/status` lacks `pre_edit_if_unheld: true`. Built
 * from constants only.
 */
export const NO_REFUSAL_MESSAGE =
  "the coordinator does not say it refuses edits of held files, so this edit " +
  "of a strict file was not checked for another holder";

/**
 * The tier that carries the capability without walking every session, which
 * on a busy coordinator costs seconds.
 */
export const STATUS_ROUTE = "/status?detail=metrics";

export const RELAY_ADMIT = "relay_admit";
export const RELAY_DENY = "relay_deny";
export const HOLDER_DENY = "holder_deny";
export const PARENT_DENY = "parent_deny";
export const UNAVAILABLE_DENY = "unavailable_deny";
export type AnswerClass =
  | typeof RELAY_ADMIT
  | typeof RELAY_DENY
  | typeof HOLDER_DENY
  | typeof PARENT_DENY
  | typeof UNAVAILABLE_DENY;

/** The opted-in pre-edit as sent: the built payload and `if_unheld: true`. */
export type OptedInRequest = Readonly<Record<string, unknown>> & {
  readonly session_id: string;
  readonly path: string;
};

/** What the hook prints for a deny: the envelope alone, no other top-level key. */
export interface HookDeny {
  hookSpecificOutput: HookSpecificOutput;
}

// The holder a refusal names is an agent id in its 32-hex form; anything else
// cannot be shown as a short id, so the answer is not read as a refusal.
const HOLDER_ID_RE = /^[0-9a-f]{32}$/;

const ON_VALUE = Buffer.from("refuse");
const OFF_VALUES: ReadonlyArray<Buffer> = [Buffer.from(""), Buffer.from("displace")];
// Far above any valid value; a longer file is an unknown value, not a read.
const SETTING_MAX_BYTES = 64;

const FOLD_PROFILES = ["caseless", "nfd", "none"] as const satisfies ReadonlyArray<FoldProfile>;
// The fold_profile a coordinator advertises when its start could not classify
// the disk; it keys names as typed, as under "none".
const UNCLASSIFIED_DISK = "cannot_tell";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * `on`, `off` or `unknown` for `coherenceDir/hook_on_held`. A file that is
 * absent, a link, not a regular file or unreadable (and a linked `.coherence`)
 * reads as off: it says nothing a user wrote. A file over the cap is unknown.
 */
export function readSetting(coherenceDir: string): HoldRefusalSetting {
  let data: Buffer;
  try {
    data = readStateFile(coherenceDir, SETTING_FILE, SETTING_MAX_BYTES);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EFBIG" ? SETTING_UNKNOWN : SETTING_OFF;
  }
  return settingOf(data);
}

/**
 * Compared as bytes, as Python compares them: one trailing newline is the
 * line ending a one-line file carries, so it is dropped, and nothing else is.
 */
function settingOf(data: Buffer): HoldRefusalSetting {
  const value = data.length > 0 && data[data.length - 1] === 0x0a ? data.subarray(0, -1) : data;
  if (value.equals(ON_VALUE)) return SETTING_ON;
  if (OFF_VALUES.some((off) => value.equals(off))) return SETTING_OFF;
  return SETTING_UNKNOWN;
}

/**
 * The fold profiles under which `rel` is strict, each read with the disk
 * spelling a coordinator on that profile would use, which `spellingOf` looks
 * up (undefined when the disk has none to give). Before the client knows the
 * coordinator's profile, a non-empty answer makes `rel` a candidate; once it
 * knows, the profile's membership decides.
 */
export function strictProfiles(
  policy: Pick<TrackedArtifactPolicy, "strictModePaths" | "isStrictMode">,
  rel: string,
  spellingOf: (rel: string) => string | undefined,
): ReadonlySet<FoldProfile> {
  // No strict entry: nothing to match, so the disk is not asked.
  if (policy.strictModePaths.length === 0) return new Set();
  const spelling = spellingOf(rel);
  const strict = (profile: FoldProfile) => policy.isStrictMode(rel, matchContext(profile, spelling));
  return new Set(FOLD_PROFILES.filter(strict));
}

/**
 * Only a folding profile reads the disk's spelling; the same spelling serves
 * every folding profile, so it is looked up once.
 */
function matchContext(profile: FoldProfile, spelling: string | undefined): PolicyMatchContext {
  const onDisk = profile === "none" || spelling === undefined ? {} : { diskSpelling: spelling };
  return { profile, kind: "file", ...onDisk };
}

/**
 * Whether `/status` says this coordinator refuses a pre-edit that opts in
 * while another agent holds the path. Only JSON `true` does: a coordinator
 * without the key ignores the flag and displaces the holder.
 */
export function advertisesRefusal(status: JsonObject): boolean {
  return status.pre_edit_if_unheld === true;
}

/**
 * Whether the path whose strict profiles are `candidates` is strict on the
 * coordinator that answered `status`. An absent `fold_profile` is a
 * coordinator that folds nothing, and `cannot_tell` is a disk its start could
 * not classify, which it keys as `none`. A present null is neither.
 */
export function strictForCoordinator(
  status: JsonObject,
  candidates: ReadonlySet<FoldProfile>,
): boolean {
  const advertised = Object.hasOwn(status, "fold_profile") ? status.fold_profile : "none";
  const profile = advertised === UNCLASSIFIED_DISK ? "none" : advertised;
  if (isFoldProfile(profile)) return candidates.has(profile);
  // A profile this client cannot read may fold the path onto a strict entry,
  // and it is strict under some profile: when unsure, refuse.
  return true;
}

function isFoldProfile(value: unknown): value is FoldProfile {
  return (FOLD_PROFILES as ReadonlyArray<unknown>).includes(value);
}

/**
 * The raw subagent id, snake_case preferred: a present `agent_id`, even null,
 * is not overridden by `agentId`; only an absent one falls back.
 */
function rawSubagentId(body: Readonly<JsonObject>): unknown {
  return Object.hasOwn(body, "agent_id") ? body.agent_id : body.agentId;
}

/**
 * Whether the Claude Code payload carries a subagent id the coordinator would
 * refuse on an opted-in edit. Absent, null and empty are the parent, as on
 * every route; sending a malformed one as the parent would let a subagent take
 * its parent's place.
 */
export function malformedSubagentId(cc: Readonly<JsonObject>): boolean {
  const raw = rawSubagentId(cc);
  return raw !== undefined && raw !== null && raw !== "" && !isValidSubagentId(raw);
}

/**
 * The outcome class of the coordinator's 2xx `body` to the opted-in
 * `request`. An allow-list: only a clean admit admits, a deny the coordinator
 * wrote passes through, a holder refusal with a readable holder is named, and
 * everything else is the unavailable deny. A `collision` or `degraded` key,
 * whatever its value, means the flag was ignored or the check did not run.
 */
export function classifyAnswer(body: unknown, request: OptedInRequest): AnswerClass {
  if (!isJsonObject(body)) return UNAVAILABLE_DENY;
  if (body.ok === true && !Object.hasOwn(body, "degraded") && !Object.hasOwn(body, "collision")) {
    return RELAY_ADMIT;
  }
  const output = body.hookSpecificOutput;
  if (isJsonObject(output) && output.permissionDecision === "deny") return RELAY_DENY;
  const holder = body.holder_agent_id;
  if (body.reason !== OTHER_HOLDER_REASON || !isHolderId(holder)) return UNAVAILABLE_DENY;
  return heldByParent(holder, request) ? PARENT_DENY : HOLDER_DENY;
}

function isHolderId(value: unknown): value is string {
  return typeof value === "string" && HOLDER_ID_RE.test(value);
}

/**
 * Only a subagent can recompute its parent's agent id from what it sent; a
 * parent refused by its own subagent, or a sibling, cannot, so they are told
 * of another holder.
 */
function heldByParent(holder: string, request: OptedInRequest): boolean {
  if (!isValidSubagentId(rawSubagentId(request))) return false;
  return holder === sessionToAgentId(request.session_id);
}

/**
 * What the hook prints when the coordinator could not confirm that no other
 * agent holds `path`.
 */
export function unavailableDeny(path: string): HookDeny {
  return { hookSpecificOutput: emitAdmissionUnavailableDeny(path) };
}

/**
 * What the hook prints for the coordinator's 2xx `body` to the opted-in
 * `request`: the body itself when it admits or already denies, else the deny
 * its class names, with no other top-level key.
 */
export function answerFor(body: unknown, request: OptedInRequest): unknown {
  const outcome = classifyAnswer(body, request);
  if (outcome === RELAY_ADMIT || outcome === RELAY_DENY) return body;
  const path = request.path;
  if (outcome === HOLDER_DENY) {
    const holderAgentId = (body as JsonObject).holder_agent_id as string;
    return { hookSpecificOutput: emitHeldPathDeny({ path, holderAgentId }) };
  }
  if (outcome === PARENT_DENY) return { hookSpecificOutput: emitHeldByParentDeny(path) };
  return unavailableDeny(path);
}
