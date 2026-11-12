/**
 * The door every hook route passes a request's name through before the
 * policy and the registry see it.
 *
 * A request names a file (the default) or a key (`name_kind: "key"`): a name
 * that is not a workspace file, such as a row or object key, kept exactly as
 * sent and looked up by that exact name. A file is tidied and keyed by the
 * fold the workspace disk applies, so every spelling the disk treats as one
 * file reaches one row. On a disk that folds, the door also finds the disk's
 * own spelling of the request: it names a new row, and a glob written against
 * it matches.
 *
 * An answer repeats a request's name as `requested`, the bytes the client
 * sent, because clients compare what comes back with what they sent.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { Artifact, FileName } from '../registry.js';
import type { NameKind, PolicyMatchContext } from '../policy.js';
import {
  exceedsFoldLimit,
  foldKey,
  tidyPath,
  type FoldingProfile,
  type FoldProfile,
} from '../path_fold.js';
import { indexKeyOf, isInsideRoot } from '../fold_merge.js';
import { isValidRequestPath, type HookDeps } from './_common.js';

export interface FileRequest {
  readonly kind: 'file';
  /** The name as the request sent it. */
  readonly requested: string;
  readonly file: FileName;
  readonly policy: PolicyMatchContext;
}

export interface KeyRequest {
  readonly kind: 'key';
  /** The name as the request sent it, which is also the row's name. */
  readonly requested: string;
  readonly policy: PolicyMatchContext;
}

export type RequestName = FileRequest | KeyRequest;

export function policyProfileOf(deps: HookDeps): FoldProfile {
  return deps.registry.foldIndexProfile() ?? 'none';
}

/** The policy context of a file name with no disk spelling. */
export function storedFilePolicy(deps: HookDeps): PolicyMatchContext {
  return { profile: policyProfileOf(deps), kind: 'file' };
}

function nameKindOf(raw: unknown): NameKind | null {
  if (raw === undefined || raw === 'file') return 'file';
  return raw === 'key' ? 'key' : null;
}

/**
 * The name a hook request's `path` and `name_kind` carry, or null when the
 * route refuses it with its path error: an invalid path, a path over the fold
 * limit (a file or a key), or an unknown kind.
 */
export function readRequestName(body: Record<string, unknown>, deps: HookDeps): RequestName | null {
  const path = body['path'];
  if (!isValidRequestPath(path)) return null;
  const kind = nameKindOf(body['name_kind']);
  if (kind === null) return null;
  if (kind === 'file') return fileRequest(deps, path);
  return { kind, requested: path, policy: { profile: policyProfileOf(deps), kind } };
}

export function fileRequest(deps: HookDeps, requested: string): FileRequest {
  const profile = deps.registry.foldIndexProfile();
  const tidied = tidyPath(requested);
  const key = profile === null ? tidied : indexKeyOf(tidied, profile);
  const policy: PolicyMatchContext = { profile: profile ?? 'none', kind: 'file' };
  const diskSpelling = isFolding(profile)
    ? diskSpellingOf(rootOf(deps), { tidied, key }, profile)
    : undefined;
  if (diskSpelling === undefined) return { kind: 'file', requested, file: { key, tidied }, policy };
  const file = { key, tidied, diskSpelling };
  return { kind: 'file', requested, file, policy: { ...policy, diskSpelling } };
}

/**
 * A Bash token as a file request. A token whose tidied name is over the fold
 * limit is taken exactly as typed, neither tidied nor folded: the index lists
 * a stored name over the limit under itself, so the token is stored and found
 * that way. The limit is applied after tidying because the policy reads the
 * tidied name: a token over it only by `./` padding is that file, and must
 * meet that file's row and its stale and strict checks.
 */
export function tokenRequest(deps: HookDeps, token: string): FileRequest {
  if (!exceedsFoldLimit(tidyPath(token))) return fileRequest(deps, token);
  const policy = storedFilePolicy(deps);
  return { kind: 'file', requested: token, file: { key: token, tidied: token }, policy };
}

/** `tokenRequest`, once per distinct token of one command: a disk spelling costs a resolver call. */
export function tokenRequests(deps: HookDeps): (token: string) => FileRequest {
  const known = new Map<string, FileRequest>();
  return (token) => {
    let name = known.get(token);
    if (name === undefined) {
      name = tokenRequest(deps, token);
      known.set(token, name);
    }
    return name;
  };
}

export function findRequested(deps: HookDeps, name: RequestName): Artifact | null {
  return name.kind === 'key'
    ? deps.registry.findKeyArtifact(name.requested)
    : deps.registry.findFileArtifact(name.file);
}

export function resolveRequested(deps: HookDeps, name: RequestName, contentHash: string): string {
  return name.kind === 'key'
    ? deps.registry.resolveOrRegisterKey(name.requested, contentHash)
    : deps.registry.resolveOrRegisterFile(name.file, contentHash);
}

export function isTrackedRequest(deps: HookDeps, name: RequestName): boolean {
  return deps.policy.isTracked(name.requested, name.policy);
}

export function isStrictRequest(deps: HookDeps, name: RequestName): boolean {
  return deps.policy.isStrictMode(name.requested, name.policy);
}

function isFolding(profile: FoldProfile | null): profile is FoldingProfile {
  return profile === 'caseless' || profile === 'nfd';
}

/**
 * The root a disk spelling is relative to: the coordinator's canonical root,
 * or the policy's root as given where a test built the server without a start.
 */
function rootOf(deps: HookDeps): string {
  return deps.canonicalRoot ?? deps.policy.get().coordinatorRoot;
}

/**
 * The disk's own spelling of a file request, relative to the root, when the
 * request reaches a place inside the root under the same key. A request
 * through a link reaches another key, and so has none: the link's target is
 * another file.
 */
function diskSpellingOf(
  root: string,
  file: { readonly tidied: string; readonly key: string },
  profile: FoldingProfile
): string | undefined {
  const resolved = resolveDeepest(join(root, file.tidied));
  if (resolved === null) return undefined;
  const spelling = relative(root, resolved);
  return isInsideRoot(spelling) && foldKey(spelling, profile) === file.key ? spelling : undefined;
}

/**
 * The platform resolver's spelling of the deepest existing ancestor of
 * `absolute`, with the rest appended as typed, so a file about to be created
 * still gets its directories' disk spelling. Null when the resolver fails for
 * another reason (a loop, a denied directory, a name too long).
 */
function resolveDeepest(absolute: string): string | null {
  const tail: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    try {
      return join(realpathSync.native(current), ...tail);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (typeof code !== 'string') throw err;
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || dirname(current) === current) return null;
      tail.unshift(basename(current));
    }
  }
}
