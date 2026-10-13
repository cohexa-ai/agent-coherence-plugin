/**
 * Caller principal — the hook client's half (library caller-principal plan, U5).
 *
 * The bearer in `.coherence/hook.secret` authenticates the WORKSPACE. A caller
 * principal is a value a coordinator mints and binds to ONE acting identity on
 * that identity's first claim (`POST /principal/claim`, Python coordinator
 * only); a request naming the identity presents it in the
 * `Coherence-Caller-Principal` header. Once a session is bound, the Python
 * coordinator refuses a request naming it without that principal on the routes
 * where an absent principal admits harm (pre-edit, post-edit, post-edit-cas,
 * session-stop, ...); a session nobody has claimed is admitted without one and
 * counted (KTD15), which is what keeps a client that predates principals
 * working. A presented principal that is not the bound one is refused on every
 * route. This Node coordinator issues none: it answers 404 on the claim and
 * ignores the header. Its pid file says `backend=node`, so against it the
 * client does not claim at all — one request per hook, exactly as before,
 * instead of a 404 round trip on every event. A pid file without that line
 * (the Python coordinator's format) is claimed against, and a 404 there (an
 * older Python coordinator) still means "send no header".
 *
 * A refusal is HTTP 400 carrying a typed `reason` (`caller_principal_absent` /
 * `caller_principal_foreign`), and the client classifies it by that key alone,
 * never by the error prose. It recovers the one way that cannot reopen the
 * first-claim gate: a re-claim presenting the SAME stored mint nonce (R20). A
 * coordinator that lost its bindings (state.db removed or restored) binds the
 * session afresh to that nonce; one that still holds the binding hands its
 * principal back; one holding it under a different nonce refuses, and the
 * client reports that and stops. A principal the re-claim returns replaces the
 * stored one and the refused request is retried once — a refused request
 * changed nothing, so the retry cannot apply anything twice.
 *
 * Parity with the Python client (`ccs/cli/_coherence_client.py`
 * `obtain_stored_principal` + `ccs/adapters/claude_code/auth.py`):
 * - One process per hook event, so the values live on disk in the existing
 *   0700 `.coherence/`, at 0600. The nonce is created with O_CREAT|O_EXCL — the
 *   hook.secret discipline — and never rewritten or removed. A nonce file that
 *   exists but holds no complete nonce is waited on (bounded) only while it is
 *   young enough to be a racer's write in progress (age <= 2000 ms), and if it
 *   is still incomplete after the wait it is reported as a write that may still
 *   be in progress, with no step to take; an older one is reported at once,
 *   naming the file and the operator's step, and the session runs without a
 *   principal until it is removed by hand. The principal is written whole to
 *   a temporary file and renamed into place, so no reader sees it torn; it is
 *   replaced only by a value the coordinator handed back for the stored nonce,
 *   never by a claim under a new one.
 * - Keyed by the PARENT session's derived agent id (32 hex), never the raw
 *   session id: `caller-principal-<key>.nonce` / `.principal`. The file names
 *   and formats are identical across the two clients, so they share one
 *   binding per session.
 * - The mint nonce is persisted BEFORE the claim is sent (so a retry after a
 *   lost response presents the same nonce and receives the same principal); a
 *   concurrent loser of the exclusive create adopts the winner's nonce.
 * - A refused claim (`caller_principal_claimed`) is reported and the client
 *   proceeds without a principal. It never deletes a stored value and never
 *   claims under a new nonce: that would reopen the gate first-claim-wins
 *   closes.
 * - Nothing prints a principal or a nonce (R5): a report carries a typed
 *   reason, an HTTP status, a file path or a transport error, never the
 *   coordinator's prose. A coordinator `reason` is named only when it is one of
 *   the known tokens; any other value — another string, a value that is not a
 *   string, or none at all — is reported as `unrecognised`, and classifying it
 *   never throws.
 *
 * What this buys on the hook surface is convention-enforcement and a
 * detectable unbound caller: any process that can read `.coherence/` can read
 * these files for any session, so it is not separation between callers of the
 * same OS user.
 */
import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { sessionToAgentId } from './agent_id.js';
import {
  type CoordinatorEndpoint,
  readBackendFromPidFile,
  requestJsonStatus,
} from './hook_client_transport.js';

export const CALLER_PRINCIPAL_HEADER = 'Coherence-Caller-Principal';
export const PRINCIPAL_CLAIM_ROUTE = '/principal/claim';
export const CALLER_PRINCIPAL_FILE_PREFIX = 'caller-principal-';
/** The Python coordinator's typed refusal for a second claimant. */
export const CALLER_PRINCIPAL_CLAIMED_REASON = 'caller_principal_claimed';
/** The Python coordinator's typed 400 refusals of the principal a request presented (or did not). */
export const CALLER_PRINCIPAL_ABSENT_REASON = 'caller_principal_absent';
export const CALLER_PRINCIPAL_FOREIGN_REASON = 'caller_principal_foreign';
const PRINCIPAL_REFUSAL_REASONS: ReadonlySet<unknown> = new Set([
  CALLER_PRINCIPAL_ABSENT_REASON,
  CALLER_PRINCIPAL_FOREIGN_REASON,
]);
/** The Python claim route's watchdog degrade envelope (`{ok: false, degraded: true, reason}`). */
export const CLAIM_UNCONFIRMED_REASON = 'claim_unconfirmed';
/**
 * What a report calls a coordinator `reason` that is not a known token: any
 * other string, a value that is not a string, or no reason at all. The value is
 * never relayed — a coordinator's fields are data, and whatever it put there
 * (an echoed nonce or principal included) must not reach stderr (R5).
 */
export const UNRECOGNISED_REASON = 'unrecognised';
/** The coordinator reasons a report may name, by exact membership. */
const REPORTABLE_REASONS: ReadonlySet<unknown> = new Set([
  CALLER_PRINCIPAL_ABSENT_REASON,
  CALLER_PRINCIPAL_FOREIGN_REASON,
  CALLER_PRINCIPAL_CLAIMED_REASON,
  CLAIM_UNCONFIRMED_REASON,
]);
/** The pid-file backend that issues no principals (this package's own coordinator). */
export const NODE_BACKEND = 'node';

/** base64url of 32 random bytes — the shape of a nonce this client makes and a principal the coordinator mints. */
const VALUE_RE = /^[A-Za-z0-9_-]{43}$/;
const KEY_RE = /^[0-9a-f]{32}$/;
/**
 * The session ids a client claims (or re-claims) a principal for: the
 * coordinators' UUID shape, held to the whole string. The Python client applies
 * the same rule (`claims_for_session`); the Python coordinator's own check also
 * admits one trailing newline, which neither client claims for, so the two
 * clients share one binding per session.
 */
const SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Twin of auth.ts RECOVERY_MAX_ATTEMPTS / Python ENSURE_SECRET_MAX_RETRIES. */
const NONCE_MAX_ATTEMPTS = 5;
/** Twin of Python ENSURE_SECRET_RETRY_SLEEP_SEC. */
const NONCE_RETRY_MS = 20;
/**
 * Twin of Python auth.TORN_FILE_GRACE_SEC (2.0 s): how long an existing nonce
 * file that holds no complete nonce is treated as a racer's write still in
 * progress. The edge is strict, as in the Python rule (`age > 2.0`): a file
 * aged exactly 2000 ms is still young. A YOUNG one is waited on (the bounded
 * wait), so a loser adopts the winner's nonce, and if it is still incomplete
 * afterwards the report names no step; an OLDER one was left by a writer that
 * was killed or ran out of space, and is reported at once, naming the
 * operator's step, instead of charging every later hook of the session the
 * whole wait. Either way the file is never overwritten, so the grace decides
 * only whether to wait and whether a report may tell the operator to remove it.
 */
export const TORN_NONCE_GRACE_MS = 2000;

export type PrincipalClaimOutcome = 'bound' | 'unsupported' | 'refused' | 'unconfirmed';

/**
 * `reason` as a report may name it: a known token (REPORTABLE_REASONS), else
 * UNRECOGNISED_REASON. Never throws and never returns coordinator text,
 * whatever `reason` is.
 */
export function reportableReason(reason: unknown): string {
  return typeof reason === 'string' && REPORTABLE_REASONS.has(reason)
    ? reason
    : UNRECOGNISED_REASON;
}

export interface PrincipalClaim {
  outcome: PrincipalClaimOutcome;
  principal: string | null;
  /** Diagnostic prose; never carries the principal or the nonce. */
  detail: string;
}

function principalFile(root: string, key: string, suffix: '.nonce' | '.principal'): string {
  if (!KEY_RE.test(key))
    throw new Error('caller principal key must be 32 lowercase hex characters');
  return join(root, '.coherence', `${CALLER_PRINCIPAL_FILE_PREFIX}${key}${suffix}`);
}

/** The stored value, or null when absent or not (yet) well-formed — a file a racer created but has not finished writing. */
function readValue(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
  return VALUE_RE.test(text) ? text : null;
}

/** O_CREAT|O_EXCL at 0600; false when the file already existed (never truncated or rewritten). */
function createExclusive(path: string, value: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, `${value}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** The file key for a session: its PARENT session's derived agent id (a subagent shares it). */
export function callerPrincipalKey(sessionId: string): string {
  return sessionToAgentId(sessionId);
}

function newValue(): string {
  return randomBytes(32).toString('base64url');
}

/** Whether `path` was last written longer ago than TORN_NONCE_GRACE_MS; false when it cannot be stat'ed (waiting is the safe default). */
function isPastGrace(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > TORN_NONCE_GRACE_MS;
  } catch {
    return false;
  }
}

/** The operator's step, as the Python client words it (parity): the file is never repaired automatically. */
function nonceRemediation(path: string): string {
  return (
    `The session runs without a principal until it is fixed: remove ${path} by ` +
    'hand if no hook of this session is running.'
  );
}

/**
 * The report for a file still incomplete after the bounded wait but NOT past
 * the grace — byte for byte the Python client's young-path message (parity).
 * It names no step: a live racer's write lands moments later and becomes the
 * nonce the session is bound under, so removing the file then would leave that
 * binding under a nonce no hook can present again. If the write never lands,
 * the file ages past the grace and a later hook reports it as abandoned, with
 * the step.
 */
function youngNonceMessage(path: string): string {
  return (
    `${path} exists but its write was still in progress across ${NONCE_MAX_ATTEMPTS} ` +
    'attempts; not overwriting it. This invocation proceeds without a principal; a later ' +
    `one adopts the nonce if that write lands, or reports ${path} as an interrupted write ` +
    `once it has stayed incomplete for ${TORN_NONCE_GRACE_MS / 1000} s.`
  );
}

/**
 * The mint nonce for `key`, generating and persisting it first if no process
 * has. Throws if `.coherence/` is missing (a hook client never creates it) or
 * if an existing file never holds a complete nonce: at once, without waiting
 * and naming the operator's step, when it is older than TORN_NONCE_GRACE_MS
 * (its age is re-read at every attempt); else after the bounded wait, as a
 * write that may still be in progress, with no step. The file is never
 * overwritten or removed.
 */
export function ensureMintNonce(root: string, key: string): string {
  const path = principalFile(root, key, '.nonce');
  for (let attempt = 1; attempt <= NONCE_MAX_ATTEMPTS; attempt++) {
    const existing = readValue(path);
    if (existing !== null) return existing;
    const candidate = newValue();
    if (createExclusive(path, candidate)) return candidate;
    if (isPastGrace(path)) {
      throw new Error(
        `${path} exists but holds no complete nonce (an interrupted write); not overwriting it. ` +
          nonceRemediation(path)
      );
    }
    if (attempt < NONCE_MAX_ATTEMPTS)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, NONCE_RETRY_MS);
  }
  throw new Error(youngNonceMessage(path));
}

export function loadCallerPrincipal(root: string, key: string): string | null {
  return readValue(principalFile(root, key, '.principal'));
}

/**
 * Persist `principal` for `key`: written whole to a temporary file in
 * `.coherence/` (O_CREAT|O_EXCL, 0600) and renamed into place, so no reader
 * ever sees it torn. It replaces whatever is stored — a torn file, or a value
 * the coordinator no longer binds. Callers only ever pass a value the
 * coordinator handed back for the stored mint nonce, so a replacement is never
 * a claim under a new nonce.
 */
export function storeCallerPrincipal(root: string, key: string, principal: string): void {
  const path = principalFile(root, key, '.principal');
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    if (!createExclusive(temporary, principal)) throw new Error(`${temporary} already exists`);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** One `POST /principal/claim`. Transport failures come back as `unconfirmed`. */
export async function claimCallerPrincipal(
  endpoint: CoordinatorEndpoint,
  sessionId: string,
  mintNonce: string
): Promise<PrincipalClaim> {
  let answer: { status: number; body: Record<string, unknown> | null };
  try {
    answer = await requestJsonStatus(endpoint, 'POST', PRINCIPAL_CLAIM_ROUTE, {
      session_id: sessionId,
      mint_nonce: mintNonce,
    });
  } catch (err) {
    return {
      outcome: 'unconfirmed',
      principal: null,
      detail: `claim failed: ${(err as Error).message}`,
    };
  }
  if (answer.status === 404) {
    return {
      outcome: 'unsupported',
      principal: null,
      detail: 'the coordinator issues no caller principals',
    };
  }
  const body = answer.body;
  const principal = body?.principal;
  // Only a 2xx body carries the claim contract — the rule the Python client
  // applies — so a status outside it is an unconfirmed claim that names only
  // its status and a known reason token, whatever its body says.
  const contract = answer.status >= 200 && answer.status < 300;
  if (contract && body?.ok === true && typeof principal === 'string' && principal !== '') {
    return { outcome: 'bound', principal, detail: '' };
  }
  if (contract && body?.reason === CALLER_PRINCIPAL_CLAIMED_REASON) {
    return { outcome: 'refused', principal: null, detail: CALLER_PRINCIPAL_CLAIMED_REASON };
  }
  // The status and a known reason token only — an absent, unknown or non-string
  // reason is `unrecognised` — so the coordinator's own fields are never relayed (R5).
  return {
    outcome: 'unconfirmed',
    principal: null,
    detail: `HTTP ${answer.status}, reason=${reportableReason(body?.reason)}`,
  };
}

/**
 * The principal to present for `sessionId`: stored → else nonce, claim, store.
 * A stored file that is empty or malformed is not a value: the principal is
 * claimed with the stored nonce and the file replaced. `null` means send no
 * header: the coordinator issues none (404), the claim is unconfirmed (a later
 * invocation retries with the same nonce), or it was refused (reported;
 * nothing deleted, nothing re-minted). Against a `backend=node` pid file
 * nothing is claimed, read or created.
 */
export async function obtainStoredPrincipal(
  endpoint: CoordinatorEndpoint,
  root: string,
  sessionId: string,
  report: (message: string) => void
): Promise<string | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  if (readBackendFromPidFile(join(root, '.coherence', 'server.pid')) === NODE_BACKEND) return null;
  const key = callerPrincipalKey(sessionId);
  const stored = loadCallerPrincipal(root, key);
  if (stored !== null) return stored;
  let nonce: string;
  try {
    nonce = ensureMintNonce(root, key);
  } catch (err) {
    report(`caller principal unavailable: no usable mint nonce (${(err as Error).message})`);
    return null;
  }
  const claim = await claimCallerPrincipal(endpoint, sessionId, nonce);
  if (claim.outcome === 'bound' && claim.principal !== null) {
    try {
      storeCallerPrincipal(root, key, claim.principal);
    } catch (err) {
      report(`caller principal not stored (${(err as Error).message}); it will be re-obtained`);
    }
    return claim.principal;
  }
  if (claim.outcome === 'refused') {
    report(
      'caller principal refused: this session is already bound under a different mint nonce; ' +
        'proceeding without a principal and NOT re-minting (routes that require one will refuse this session)'
    );
  }
  return null;
}

/**
 * The typed principal refusal an answer carries — HTTP 400 whose `reason` is
 * `caller_principal_absent` or `caller_principal_foreign` — or null. Classified
 * by equality on the `reason` key alone, never by the error prose (the Python
 * client's `principal_refusal_reason` applies the same rule).
 */
export function principalRefusalReason(answer: {
  status: number;
  body: Record<string, unknown> | null;
}): string | null {
  if (answer.status !== 400) return null;
  const reason = answer.body?.reason;
  return typeof reason === 'string' && PRINCIPAL_REFUSAL_REASONS.has(reason) ? reason : null;
}

export interface PrincipalContext {
  endpoint: CoordinatorEndpoint;
  root: string;
  sessionId: string;
  report: (message: string) => void;
}

/**
 * After a request presenting `presented` (null: none) was refused for
 * `reason`, what to retry it with — ONCE — or null to stop, the refusal
 * reported (naming `reason` only if it is a known token). Re-claims with the
 * SAME stored mint nonce, never a new one, and deletes nothing (KTD11):
 * - bound to a principal other than the one presented: it replaces the stored
 *   one and is the retry's principal (the coordinator lost the binding, or the
 *   claim that made it lost its response);
 * - bound to the one presented: the refusal is not about a stale value — stop;
 * - refused (`caller_principal_claimed`): another claimant holds the session —
 *   stop, never re-mint;
 * - 404: the coordinator issues no principals now — retry without the header.
 * Without a stored nonce there is nothing to re-claim with — stop.
 */
export async function recoverFromPrincipalRefusal(
  context: PrincipalContext,
  presented: string | null,
  reason: string
): Promise<{ principal: string | null } | null> {
  const { endpoint, root, sessionId, report } = context;
  const refused = `coordinator refused this hook's caller principal (${reportableReason(reason)})`;
  if (!SESSION_ID_RE.test(sessionId)) {
    report(`${refused}; the session id is malformed, so nothing was re-claimed`);
    return null;
  }
  const key = callerPrincipalKey(sessionId);
  const nonce = readValue(principalFile(root, key, '.nonce'));
  if (nonce === null) {
    report(`${refused}; no stored mint nonce for this session, so nothing was re-claimed`);
    return null;
  }
  const claim = await claimCallerPrincipal(endpoint, sessionId, nonce);
  if (claim.outcome === 'unsupported') return { principal: null };
  if (claim.outcome === 'refused') {
    report(
      `${refused}; this session is bound under a different mint nonce, so nothing was re-minted`
    );
    return null;
  }
  if (claim.outcome !== 'bound' || claim.principal === null) {
    report(
      `${refused}; the re-claim with the stored mint nonce was not confirmed (${claim.detail})`
    );
    return null;
  }
  if (claim.principal === presented) {
    report(
      `${refused}; the re-claim returned the principal already presented, so it is not retried`
    );
    return null;
  }
  try {
    storeCallerPrincipal(root, key, claim.principal);
  } catch (err) {
    report(`caller principal not stored (${(err as Error).message}); it will be re-obtained`);
  }
  return { principal: claim.principal };
}

/** The extra header presenting `principal`, or undefined for none. */
export function principalHeaders(principal: string | null): Record<string, string> | undefined {
  return principal === null ? undefined : { [CALLER_PRINCIPAL_HEADER]: principal };
}
