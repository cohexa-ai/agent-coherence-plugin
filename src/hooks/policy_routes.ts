/**
 * POST /policy/track + /policy/untrack — live policy mutation
 * (zero-Python Unit 2).
 *
 * Node port of Python `_handle_policy_track` (coordinator_server.py:2144) +
 * `_handle_policy_untrack` (:2203). Wire parity:
 *  - not a list of strings → 400 `{"error":"paths must be a list of strings"}`
 *  - > 20 paths → 400 `{"error":"max 20 paths per request"}`
 *  - YAML byte cap → 400 `{"error": <writer message>}`
 *  - policy file unreadable, not loadable as a list, or in a layout an
 *    appended line would break → 400 `{"error": <writer message>}`, nothing
 *    written (Python still appends to a file it can read, and answers 500
 *    for one it cannot; see `appendPolicyYaml`)
 *  - track   → `{ok:true, added:[…], rejected:[{path,reason},…]}`
 *  - untrack → `{ok:true, removed:[…], rejected:[…]}` (key is `removed`)
 *  - untrack of an entry (path or glob) covering a path the live policy holds
 *    in strict mode → 409 `{ok:false, error, reason:"untrack_strict_path",
 *    refused:[{path, strict_patterns}], rejected}`, and the whole request
 *    writes nothing (Cohexa-ai/agent-coherence#261). Clients classify by
 *    `reason`; `error` is prose.
 *
 * After a successful append the policy is atomically swapped via
 * `PolicyRef.reload()` — the Python `coordinator.policy = policy.reloaded()`
 * equivalent; live handlers see the new policy immediately (Unit 1's
 * stale-by-reference guard), and a reload never drops a live strict pattern.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  appendPolicyYaml,
  MAX_POLICY_PATHS_PER_REQUEST,
  partitionPolicyPaths,
  type TrackedArtifactPolicy,
} from "../policy.js";
import { type HookDeps, writeJson, writeError, readJsonBody } from "./_common.js";

const UNTRACK_STRICT_PATH_REASON = "untrack_strict_path";

interface RefusedEntry {
  path: string;
  strict_patterns: string[];
}

interface StrictUntrackRefusal {
  refused: RefusedEntry[];
  rejected: Array<{ path: string; reason: string }>;
}

function untrackStrictError(refused: ReadonlyArray<RefusedEntry>): string {
  const named = refused.map((r) => `${r.path} (strict: ${r.strict_patterns.join(", ")})`).join("; ");
  return (
    `refusing to untrack paths the coordinator enforces in strict mode: ${named}. ` +
    "A strict path stays enforced while the coordinator runs; to untrack it, " +
    "remove its entry from .coherence/strict_mode.yaml and restart the " +
    `coordinator (${UNTRACK_STRICT_PATH_REASON})`
  );
}

/**
 * The entries of an untrack request that cover a strict path (#261), with the
 * request's invalid entries, or null when none does. Untracking a strict path
 * put it on the untracked fast path, where a CAS commit at any expected
 * version is accepted: a silent lost update. Strict wins over ignore in the
 * policy anyway, so the refusal is what tells the operator the entry would
 * not take effect.
 */
function strictUntrackRefusal(
  paths: ReadonlyArray<string>,
  policy: TrackedArtifactPolicy,
): StrictUntrackRefusal | null {
  const { valid, rejected } = partitionPolicyPaths(paths);
  const coverage = policy.strictPatternsCoveringEach(valid);
  const refused: RefusedEntry[] = valid.flatMap((path, i) =>
    coverage[i]!.length > 0 ? [{ path, strict_patterns: coverage[i]! }] : [],
  );
  return refused.length > 0 ? { refused, rejected } : null;
}

interface PolicyBody {
  paths?: unknown;
}

function handlePolicyMutation(
  body: PolicyBody,
  res: ServerResponse,
  deps: HookDeps,
  yamlFileName: "tracked.yaml" | "ignored.yaml",
  resultKey: "added" | "removed",
): void {
  const paths = body.paths;
  if (!Array.isArray(paths) || !paths.every((p): p is string => typeof p === "string")) {
    writeError(res, 400, "paths must be a list of strings");
    return;
  }
  if (paths.length > MAX_POLICY_PATHS_PER_REQUEST) {
    writeError(res, 400, `max ${MAX_POLICY_PATHS_PER_REQUEST} paths per request`);
    return;
  }
  // Decided and acted on within this one synchronous handler, so no reload can
  // land between the check and the append below.
  const refusal = yamlFileName === "ignored.yaml" ? strictUntrackRefusal(paths, deps.policy.get()) : null;
  if (refusal !== null) {
    writeJson(res, 409, {
      ok: false,
      error: untrackStrictError(refusal.refused),
      reason: UNTRACK_STRICT_PATH_REASON,
      refused: refusal.refused,
      rejected: refusal.rejected,
    });
    return;
  }

  const root = deps.policy.get().coordinatorRoot;
  const yamlPath = join(root, ".coherence", yamlFileName);

  let result;
  try {
    result = appendPolicyYaml(yamlPath, paths);
  } catch (err) {
    writeError(res, 400, (err as Error).message);
    return;
  }

  // Atomic policy swap — Python's `coordinator.policy = coordinator.policy.reloaded()`.
  deps.policy.reload();

  writeJson(res, 200, {
    ok: true,
    [resultKey]: result.added,
    rejected: result.rejected,
  });
}

export async function policyTrackRoute(
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
  handlePolicyMutation(body as PolicyBody, res, deps, "tracked.yaml", "added");
}

export async function policyUntrackRoute(
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
  handlePolicyMutation(body as PolicyBody, res, deps, "ignored.yaml", "removed");
}
