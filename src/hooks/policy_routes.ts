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
 *
 * After a successful append the policy is atomically swapped via
 * `PolicyRef.reload()` — the Python `coordinator.policy = load(root)`
 * equivalent; live handlers see the new policy immediately (Unit 1's
 * stale-by-reference guard).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { appendPolicyYaml, MAX_POLICY_PATHS_PER_REQUEST } from "../policy.js";
import { type HookDeps, writeJson, writeError, readJsonBody } from "./_common.js";

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

  const root = deps.policy.get().coordinatorRoot;
  const yamlPath = join(root, ".coherence", yamlFileName);

  let result;
  try {
    result = appendPolicyYaml(yamlPath, paths);
  } catch (err) {
    writeError(res, 400, (err as Error).message);
    return;
  }

  // Atomic policy swap — Python's `coordinator.policy = TrackedArtifactPolicy.load(root)`.
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
