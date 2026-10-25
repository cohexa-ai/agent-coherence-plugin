/**
 * POST /hooks/post-edit handler.
 *
 * Mirrors Python `_handle_post_edit` at coordinator_server.py:616 — commit
 * on success (bumps artifact.version), release on failure (invalidate
 * without version bump). Per KTD-1: PreToolUse Edit/Write acquires E;
 * PostToolUse Edit/Write commits or releases.
 *
 * Wire shape per KTD-B / KTD-B.3 C3:
 * - Request: `{session_id, path, success, content_hash?}` where
 *   content_hash is REQUIRED when success=true (hook script computes it
 *   from worktree's post-write state).
 * - Response: `{ok: true}` on commit success; `{ok: true, released: true}`
 *   on success=false release; `{ok: false, reason}` on protocol error.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { CoherenceError } from "../coherence_error.js";
import {
  type HookDeps,
  writeJson,
  writeError,
  readJsonBody,
  isValidSessionId,
  isValidPath,
  isValidContentHashRequired,
  isValidContentHashOrAbsent,
  readSubagentId,
} from "./_common.js";

export type PostEditDeps = HookDeps;

interface PostEditBody {
  session_id?: unknown;
  path?: unknown;
  success?: unknown;
  content_hash?: unknown;
}

export async function handlePostEdit(
  body: PostEditBody,
  res: ServerResponse,
  deps: PostEditDeps,
): Promise<void> {
  if (!isValidSessionId(body.session_id)) {
    writeError(res, 400, "missing session_id");
    return;
  }
  if (!isValidPath(body.path)) {
    writeError(res, 400, "missing or empty path");
    return;
  }
  // Default success=true mirrors Python (`bool(body.get("success", True))`).
  const success: boolean = body.success === undefined ? true : Boolean(body.success);
  if (success) {
    if (!isValidContentHashRequired(body.content_hash)) {
      writeError(res, 400, "content_hash required when success=true (64-char hex)");
      return;
    }
  } else {
    if (!isValidContentHashOrAbsent(body.content_hash)) {
      writeError(res, 400, "content_hash must be 64-char hex if provided");
      return;
    }
  }

  const sessionId: string = body.session_id;
  const path: string = body.path;
  const contentHash: string | null = (body.content_hash as string | null | undefined) ?? null;

  if (!deps.policy.isTracked(path)) {
    writeJson(res, 200, { ok: true });
    return;
  }

  const agentId = deps.sessions.registerSession(sessionId, readSubagentId(body as Record<string, unknown>));
  const nowTick = Math.floor(Date.now() / 1000);

  const existing = deps.registry.getArtifactByName(path);
  if (existing === null) {
    // No prior pre-edit / pre-read; nothing to commit against. Matches Python.
    writeJson(res, 200, { ok: true, note: "untracked-at-commit" });
    return;
  }
  const artifactId = existing.id;

  if (!success) {
    // Tool failure path — release the grant without bumping version.
    try {
      deps.registry.invalidate(artifactId, agentId, nowTick, "post_edit_failure");
    } catch (err) {
      if (!(err instanceof CoherenceError)) throw err;
      writeJson(res, 200, { ok: false, reason: err.message });
      return;
    }
    writeJson(res, 200, { ok: true, released: true });
    return;
  }

  // Success path — commit and bump version.
  try {
    deps.registry.commit(artifactId, agentId, contentHash!, nowTick, null);
  } catch (err) {
    if (!(err instanceof CoherenceError)) throw err;
    writeJson(res, 200, { ok: false, reason: err.message });
    return;
  }
  writeJson(res, 200, { ok: true });
}

export async function postEditRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PostEditDeps,
  maxBytes: number,
): Promise<void> {
  if (req.method !== "POST") {
    writeError(res, 404, "not found");
    return;
  }
  const body = await readJsonBody(req, res, maxBytes);
  if (body === null) return;
  await handlePostEdit(body as PostEditBody, res, deps);
}
