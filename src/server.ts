/**
 * HTTP server for the Node coordinator.
 *
 * Wires auth middleware (Bearer + Host allowlist) per KTD-A.5 + KTD-12, and
 * dispatches to per-route handlers. v0.1.1 Unit 1 lands /health only;
 * subsequent commits / units add /status (three-tier per KTD-K),
 * /hooks/pre-read, /hooks/pre-edit, /hooks/post-edit, /hooks/session-stop,
 * /policy/track, /policy/untrack.
 *
 * Conventions (matching Python coordinator's coordinator_server.py per KTD-B.3):
 * - Error envelope: `{"error": "<lowercase phrase>"}` — single key, no trailing punctuation
 * - HTTP status mapping: bad Host → 403; missing Bearer → 401; oversized body → 413;
 *   coordinator mid-shutdown → 503; unknown route → 404; unhandled → 500
 *   with `{"error": "internal: <ErrorName>"}` (class name leaks deliberately),
 *   except a hook route, whose unhandled error answers 200 `{"ok": false,
 *   "reason": "internal: <ErrorName>"}`, Python's failure envelope (#214)
 * - Field naming: snake_case for all coordinator-owned JSON keys; camelCase
 *   ONLY at the Claude Code hookSpecificOutput boundary (none of those yet
 *   in this commit)
 * - R21: MAX_REQUEST_BODY_BYTES = 64 KiB; reject Content-Length above with 413
 *   before reading the body
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { verifyBearer, verifyHost } from "./auth.js";
import type { Artifact, ArtifactRegistry } from "./registry.js";
import type { PolicyPatternLists, PolicyRef, PolicySummary } from "./policy.js";
import type { SessionRegistry } from "./sessions.js";
import type { FoldProfileResult } from "./fs_profile.js";
import { FOLD_TABLE_UNICODE_VERSION, type FoldProfile } from "./path_fold.js";
import {
  writeJson,
  writeError,
  writeHandlerFailure,
  internalFailureLabel,
  type HookDeps,
} from "./hooks/_common.js";
import { preReadRoute } from "./hooks/pre_read.js";
import { preEditRoute } from "./hooks/pre_edit.js";
import { postEditRoute } from "./hooks/post_edit.js";
import { sessionStopRoute } from "./hooks/session_stop.js";
import { sessionStartRoute } from "./hooks/session_start.js";
import { preBashRoute } from "./hooks/pre_bash.js";
import { preGrepRoute } from "./hooks/pre_grep.js";
import { postEditCasRoute } from "./hooks/post_edit_cas.js";
import { policyTrackRoute, policyUntrackRoute } from "./hooks/policy_routes.js";

/** R21: per KTD-B.2 security-parity corpus + v0.1.1 plan KTD-K. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/** Bind address: locked invariant per Open Questions; no user-configurable override. */
export const BIND_HOST = "127.0.0.1";

export interface ServerOptions {
  /** Bearer secret returned by ensureSecret(); used for verifyBearer auth. */
  secret: string;
  /** Coordinator-process startup timestamp (epoch ms); surfaces in /health + /status. */
  startedAtMs: number;
  /** Coordinator-process semver; surfaces in /health + /status for version-skew diagnostics. */
  version: string;
  /** SQLite registry handle; surfaces stats in /status default tier. */
  registry: ArtifactRegistry;
  /** Mutable tracked-artifact policy holder; handlers read through it (Unit 2). */
  policy: PolicyRef;
  /** In-memory session_id ↔ agent_id map for hook handlers. */
  sessions: SessionRegistry;
  /**
   * The workspace disk's fold profile, probed once by the coordinator's start
   * before the store opened, and kept only in memory. Absent where a test
   * builds a server without a coordinator start.
   */
  foldProfile?: FoldProfileResult;
  /**
   * The workspace root as the platform's resolver spells it (links followed,
   * the disk's case), found once at start. Absent where a test builds a
   * server without a coordinator start: the policy's root is used as given.
   */
  canonicalRoot?: string;
}

/**
 * Auth middleware: rejects on bad Host (403), missing/invalid Bearer (401),
 * or oversized Content-Length (413). Returns true if the request passed all
 * gates and should proceed to the route handler.
 */
function checkAuth(req: IncomingMessage, res: ServerResponse, secret: string): boolean {
  if (!verifyHost(req)) {
    writeError(res, 403, "host header not allowlisted");
    return false;
  }
  if (!verifyBearer(req, secret)) {
    writeError(res, 401, "missing or invalid bearer token");
    return false;
  }
  const lenHeader = req.headers["content-length"];
  if (typeof lenHeader === "string") {
    const len = Number.parseInt(lenHeader, 10);
    if (Number.isNaN(len) || len < 0) {
      writeError(res, 400, "invalid content-length header");
      return false;
    }
    if (len > MAX_REQUEST_BODY_BYTES) {
      writeError(res, 413, "request body too large");
      return false;
    }
  }
  return true;
}

interface HealthBody {
  status: "ok";
  version: string;
  backend: "node";
  uptime_seconds: number;
}

function handleHealth(req: IncomingMessage, res: ServerResponse, options: ServerOptions): void {
  if (req.method !== "GET") {
    writeError(res, 404, "not found");
    return;
  }
  const body: HealthBody = {
    status: "ok",
    version: options.version,
    backend: "node",
    uptime_seconds: Math.floor((Date.now() - options.startedAtMs) / 1000),
  };
  writeJson(res, 200, body);
}

/**
 * /status answers three tiers, chosen by `?detail=` (matched ignoring case;
 * any other value is the default tier, so a typo never shows more):
 *
 * - **Default** (`/status`, `?detail=minimal`): bearer only. Repo-relative
 *   paths and counts; each session is its `agent_id`, a uuid5 of the session
 *   id that cannot be reversed, with `agent_name` null; the policy summary
 *   carries counts and `coordinator_root: "."`.
 * - **`?detail=metrics`**: bearer only. Counters and facts about this start;
 *   no paths and no session identifiers, so it is safe to paste into a bug
 *   report.
 * - **`?detail=full`**, the operator view: bearer plus the
 *   `Coherence-Local-Operator: true` header (any case), checked after the Host
 *   and bearer checks and before any registry read. The header keeps the view
 *   from being fetched and pasted by accident; it is not authentication, since
 *   any holder of the bearer secret can send it. The body is the default body
 *   with the four pattern lists the live policy enforces added to
 *   `policy_summary`, each as written: `tracked_patterns`,
 *   `user_added_patterns`, `ignored_patterns` and `strict_mode_patterns`, what
 *   a client checks its own globs against. It adds nothing else: session names
 *   stay null, the root stays ".", there is no pid, and a rejected pattern
 *   shows only in its count. A reader needs only the lists, and every further
 *   field would widen what a holder of the bearer secret sees.
 *
 * Every tier carries `pre_edit_if_unheld: true` at the top level: this
 * coordinator refuses a pre-edit that sends `if_unheld: true` while another
 * session holds the file, rather than displacing the holder, and a client that
 * relies on the refusal reads this key from whichever tier it asks for.
 */

type StatusDetail = "default" | "metrics" | "full";

/** Node lowercases header names. */
const OPERATOR_OPT_IN_HEADER = "coherence-local-operator";
const OPERATOR_OPT_IN_REFUSAL =
  "detail=full (the operator view) requires the Coherence-Local-Operator: true header";

interface StatusDefaultBody {
  status: "ok";
  backend: "node";
  version: string;
  coordinator_uptime_seconds: number;
  schema_version: number;
  /** A pre-edit sending `if_unheld: true` is refused while another session holds the file. */
  pre_edit_if_unheld: true;
  // AC-03 (cross-backend parity): tracked_artifacts entries use `path`,
  // sessions entries carry `agent_name` + `states` (per-artifact MESI
  // map). Mirrors Python's `_handle_status` shape so dashboards and
  // CLIs work identically across backends.
  tracked_artifacts: ReadonlyArray<{ id: string; path: string; version: number }>;
  sessions: ReadonlyArray<{
    agent_id: string;
    /**
     * `null` on every row this tier serves (R6), and structurally nullable for
     * the reason it always was: the SessionRegistry map is process-local while
     * the holder set comes from durable `agent_states`, so a grant that
     * outlived the coordinator process that issued it has no recoverable name
     * — `agent_id` is a one-way uuid5 of the session id. Python emits `null`
     * in both cases; a sentinel string would put "no name" into the same type
     * and namespace as real names. The field is kept rather than dropped
     * because the wire shape is parity-pinned to Python's, where the operator
     * tier still carries a name.
     */
    agent_name: string | null;
    states: Record<string, string>;
  }>;
  counts: {
    tracked_artifacts: number;
    sessions: number;
  };
  policy_summary: PolicySummary;
  /**
   * What the workspace disk treats as one file name, so a client keys names
   * the way this coordinator does. `cannot_tell` is keyed as `none`, but stays
   * visible as a disk that could not be classified.
   */
  fold_profile: AdvertisedFoldProfile;
  /** The Unicode version of the fold table; a client with another table keys by `none`. */
  fold_table_unicode: string;
}

/** The operator view: the default body, with the four pattern lists added to its policy summary. */
type StatusOperatorBody = Omit<StatusDefaultBody, "policy_summary"> & {
  policy_summary: PolicySummary & PolicyPatternLists;
};

type AdvertisedFoldProfile = FoldProfile | "cannot_tell";

function advertisedFoldProfile(result: FoldProfileResult | undefined): AdvertisedFoldProfile {
  if (result === undefined) return "none";
  return result.status === "cannot_tell" ? "cannot_tell" : result.profile;
}

interface StatusMetricsBody {
  backend: "node";
  version: string;
  pre_edit_if_unheld: true;
  counters: Record<string, number>;
  fold_profile: AdvertisedFoldProfile;
  fold_table_unicode: string;
}

function parseDetailParam(rawUrl: string): StatusDetail {
  // Use a fixed base because IncomingMessage.url is a path+query, not an absolute URL.
  const url = new URL(rawUrl, "http://localhost");
  // Matched ignoring case, as the Python coordinator matches it.
  const detail = url.searchParams.get("detail")?.toLowerCase();
  if (detail === "metrics") return "metrics";
  if (detail === "full") return "full";
  return "default";
}

/** Whether the request opted into the operator view: the header is `true`, in any case. */
function hasOperatorOptIn(req: IncomingMessage): boolean {
  const value = req.headers[OPERATOR_OPT_IN_HEADER];
  return typeof value === "string" && value.toLowerCase() === "true";
}

function handleStatus(req: IncomingMessage, res: ServerResponse, options: ServerOptions): void {
  if (req.method !== "GET") {
    writeError(res, 404, "not found");
    return;
  }
  const detail = parseDetailParam(req.url ?? "/status");
  // Decided before any registry read; the refusal echoes nothing of the request.
  if (detail === "full" && !hasOperatorOptIn(req)) {
    writeError(res, 403, OPERATOR_OPT_IN_REFUSAL);
    return;
  }
  writeJson(res, 200, statusBody(detail, options));
}

function statusBody(
  detail: StatusDetail,
  options: ServerOptions,
): StatusDefaultBody | StatusMetricsBody | StatusOperatorBody {
  if (detail === "metrics") return metricsStatusBody(options);
  if (detail === "full") return operatorStatusBody(options);
  return defaultStatusBody(options);
}

function metricsStatusBody(options: ServerOptions): StatusMetricsBody {
  return {
    backend: "node",
    version: options.version,
    pre_edit_if_unheld: true,
    // No counter is wired yet. The empty object keeps the shape stable, so
    // consumers can parse the body before counters land.
    counters: {},
    fold_profile: advertisedFoldProfile(options.foldProfile),
    fold_table_unicode: FOLD_TABLE_UNICODE_VERSION,
  };
}

/**
 * The default tier, and the base of the operator view. tracked_artifacts
 * entries carry `path` and session rows `agent_name` + `states`, the Python
 * coordinator's shape, so agent-coherence-status renders the same table
 * against either backend.
 */
function defaultStatusBody(options: ServerOptions): StatusDefaultBody {
  const artifactList = options.registry.listArtifacts();
  // `name` is already repo-relative, per the resolveOrRegister contract.
  const artifacts = artifactList.map((a) => ({ id: a.id, path: a.name, version: a.version }));
  const sessions = statusSessions(options.registry, artifactList);
  return {
    status: "ok",
    backend: "node",
    version: options.version,
    coordinator_uptime_seconds: Math.floor((Date.now() - options.startedAtMs) / 1000),
    schema_version: options.registry.getStats().schemaVersion,
    pre_edit_if_unheld: true,
    tracked_artifacts: artifacts,
    sessions,
    counts: { tracked_artifacts: artifacts.length, sessions: sessions.length },
    // The summary carries the absolute workspace root. Every tier, the operator
    // view included, gets the "." the Python default tier reports instead.
    policy_summary: { ...options.policy.summary(), coordinator_root: "." },
    fold_profile: advertisedFoldProfile(options.foldProfile),
    fold_table_unicode: FOLD_TABLE_UNICODE_VERSION,
  };
}

/**
 * The default body plus the pattern lists of the policy as this request reads
 * it, the patterns enforced now.
 */
function operatorStatusBody(options: ServerOptions): StatusOperatorBody {
  const body = defaultStatusBody(options);
  return { ...body, policy_summary: { ...body.policy_summary, ...options.policy.patternLists() } };
}

/**
 * Each holder by its `agent_id`, a uuid5 of the session id that cannot be
 * reversed, with its per-artifact states. `agent_name` is null at every tier,
 * the operator view included: it is `claude-session-<session id>`, so it would
 * publish the raw session id beside that session's states. null, not a
 * sentinel such as `<unknown>`: this field is machine-read, and a string there
 * could not be told from a session actually named that. null is also what a
 * holder the session map has not seen (one whose grant outlived the process
 * that issued it) always carried.
 */
function statusSessions(
  registry: ArtifactRegistry,
  artifactList: Artifact[],
): StatusDefaultBody["sessions"] {
  return registry.listActiveAgents().map((agentId) => ({
    agent_id: agentId,
    agent_name: null,
    states: heldStates(registry, artifactList, agentId),
  }));
}

/** The agent's state per artifact, INVALID left out, as the Python coordinator lists it. */
function heldStates(
  registry: ArtifactRegistry,
  artifactList: Artifact[],
  agentId: string,
): Record<string, string> {
  const states: Record<string, string> = {};
  for (const art of artifactList) {
    const state = registry.getAgentState(art.id, agentId);
    if (state !== null && state !== "INVALID") states[art.name] = state;
  }
  return states;
}

export function createServer(options: ServerOptions): Server {
  const server = createHttpServer((req, res) => {
    // Top-level wrapper handles sync exceptions; the policy routes chain
    // their own catch to the same 500, as on the Python coordinator.
    const handle500 = (err: unknown): void => {
      try {
        writeError(res, 500, internalFailureLabel(err));
      } catch {
        // Response already started; nothing left to do.
      }
    };
    const handleHookFailure = (err: unknown): void => writeHandlerFailure(res, err);

    try {
      if (!checkAuth(req, res, options.secret)) {
        return;
      }
      // Route dispatch on path only (query string handled per-route).
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/health") {
        handleHealth(req, res, options);
        return;
      }
      if (path === "/status") {
        handleStatus(req, res, options);
        return;
      }
      const hookDeps: HookDeps = {
        registry: options.registry,
        policy: options.policy,
        sessions: options.sessions,
        ...(options.canonicalRoot === undefined ? {} : { canonicalRoot: options.canonicalRoot }),
      };
      if (path === "/hooks/pre-read") {
        preReadRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handleHookFailure);
        return;
      }
      if (path === "/hooks/pre-edit") {
        preEditRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handleHookFailure);
        return;
      }
      if (path === "/hooks/post-edit") {
        postEditRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handleHookFailure);
        return;
      }
      if (path === "/hooks/session-stop") {
        sessionStopRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handleHookFailure);
        return;
      }
      // SB-10 U6 — post-compaction re-grounding (Python coordinator parity).
      if (path === "/hooks/session-start") {
        sessionStartRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handleHookFailure);
        return;
      }
      // Zero-Python Unit 2 routes (Python coordinator parity).
      if (path === "/hooks/pre-bash") {
        preBashRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handleHookFailure);
        return;
      }
      if (path === "/hooks/pre-grep") {
        preGrepRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handleHookFailure);
        return;
      }
      if (path === "/hooks/post-edit-cas") {
        postEditCasRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handleHookFailure);
        return;
      }
      if (path === "/policy/track") {
        policyTrackRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handle500);
        return;
      }
      if (path === "/policy/untrack") {
        policyUntrackRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handle500);
        return;
      }
      writeError(res, 404, "not found");
    } catch (err) {
      handle500(err);
    }
  });
  return server;
}
