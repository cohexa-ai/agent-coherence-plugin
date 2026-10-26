/**
 * POST /hooks/post-edit-cas — OCC commit surface (zero-Python Unit 2,
 * founder decision A: kept for mixed Python-library + Node-coordinator use).
 *
 * Node port of Python `_handle_post_edit_cas` (coordinator_server.py:1920).
 * Wire bodies are byte-parity with Python (STABLE, per its docstring):
 *  - 400 `{error: …}` with Python's exact validation strings
 *  - untracked → `{ok: true}`; unknown-at-commit → `{ok:true, note:"untracked-at-commit"}`
 *  - WIN → `{ok: true, version: N+1}`
 *  - conflict → `{ok: false, reason, current_version}` (reason matched EXACTLY
 *    by consumers — typed-signal discipline)
 *  - corruption / M-E-caller → `{ok: false, reason: <verbose string>}` (no
 *    current_version — mirrors Python's CoherenceError → str(exc) path; the
 *    id representations differ across runtimes, so corpus fixtures normalize
 *    or node-exclude these two bodies)
 *
 * `caller_in_transient_state` and `stale_read_generation` are structurally
 * unreachable on Node (see registry.commitCas docs).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { CoherenceError } from "../coherence_error.js";
import {
  assertNever,
  type HookDeps,
  writeJson,
  writeError,
  readJsonBody,
  isValidSessionId,
  isValidContentHashRequired,
  nowTick as nowTickFn,
  readSubagentId,
} from "./_common.js";

interface PostEditCasBody {
  session_id?: unknown;
  path?: unknown;
  content_hash?: unknown;
  expected_version?: unknown;
}

export async function handlePostEditCas(
  body: PostEditCasBody,
  res: ServerResponse,
  deps: HookDeps,
): Promise<void> {
  if (!isValidSessionId(body.session_id)) {
    writeError(res, 400, "missing session_id");
    return;
  }
  const path = body.path ?? "";
  if (typeof path !== "string" || path === "" || path.startsWith("/") || path.split("/").includes("..")) {
    writeError(res, 400, "missing or empty path");
    return;
  }
  if (!isValidContentHashRequired(body.content_hash)) {
    writeError(res, 400, "content_hash must be 64-char hex");
    return;
  }
  const expectedVersion = body.expected_version;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    writeError(res, 400, "expected_version must be a non-negative integer");
    return;
  }

  if (!deps.policy.isTracked(path)) {
    writeJson(res, 200, { ok: true });
    return;
  }

  const agentId = deps.sessions.registerSession(body.session_id, readSubagentId(body as Record<string, unknown>));
  const artifact = deps.registry.getArtifactByName(path);
  if (artifact === null) {
    writeJson(res, 200, { ok: true, note: "untracked-at-commit" });
    return;
  }

  let outcome;
  try {
    outcome = deps.registry.commitCas(
      artifact.id,
      agentId,
      expectedVersion,
      body.content_hash,
      nowTickFn(),
    );
  } catch (err) {
    // D4 M/E-caller rejection → Python's CoherenceError wire shape:
    // {ok:false, reason: str(exc)}.
    if (!(err instanceof CoherenceError)) throw err;
    writeJson(res, 200, { ok: false, reason: err.message });
    return;
  }

  switch (outcome.kind) {
    case "win":
      writeJson(res, 200, { ok: true, version: outcome.artifact.version });
      return;
    case "conflict":
      writeJson(res, 200, {
        ok: false,
        reason: outcome.reason,
        current_version: outcome.currentVersion,
      });
      return;
    case "corruption":
      // Mirror Python's service-level CoherenceError message shape (str(exc),
      // no current_version field on the wire).
      writeJson(res, 200, {
        ok: false,
        reason:
          `commit_cas_corruption agent=${agentId} artifact=${artifact.id} ` +
          `expected_version=${expectedVersion} ` +
          `current_version=${outcome.currentVersion} ` +
          `(expected > current — corruption or multi-coordinator violation)`,
      });
      return;
    default:
      // Exhaustiveness guard: because this handler returns Promise<void>,
      // tsc's noImplicitReturns does NOT catch a missing CasOutcome variant.
      // assertNever makes a future 4th kind a COMPILE error instead of a
      // silently-dropped HTTP response.
      return assertNever(outcome);
  }
}

/** Parse + dispatch helper for use from server.ts. */
export async function postEditCasRoute(
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
  await handlePostEditCas(body as PostEditCasBody, res, deps);
}
