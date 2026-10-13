/**
 * Node CLI surface backing the slash commands (zero-Python Unit 4 / G3):
 * track / untrack / status. Ports the Python console scripts
 * (`ccs/cli/coherence_track.py`, `coherence_untrack.py`, `coherence_status.py`).
 *
 * Exit codes (Python parity): 0 success · 1 not-in-git / nothing valid to
 * send · 2 coordinator unavailable, HTTP error, or an answer of the wrong
 * shape (including a /status that carries no artifact or session list, such
 * as a degraded one) · 3 untrack refused because a path is enforced in strict
 * mode. Unlike the hook-client (fail-open, always 0), the CLIs are
 * operator-facing and DO signal failure.
 *
 * Every string taken from a coordinator answer is escaped before it is
 * printed (see cli_output.ts): an answer is not trusted terminal text.
 *
 * Path normalization ($ARGUMENTS-verbatim learning, 2026-05-26): operators
 * paste absolute paths from their shell/IDE; absolute-inside-root is
 * auto-stripped to workspace-relative, absolute-outside-root is rejected —
 * absolute paths must NEVER leak into tracked.yaml / ignored.yaml.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { escapeNonprintable, httpErrorLine, pyRepr } from "./cli_output.js";
import {
  CLI_REQUEST_TIMEOUT_MS,
  findCoordinatorRoot,
  requestJsonStatus,
  resolveEndpoint,
} from "./hook_client_transport.js";

function err(line: string): void {
  process.stderr.write(line + "\n");
}
function out(line: string): void {
  process.stdout.write(line + "\n");
}

/** Pure-string relative-path rules (mirror of Python validate_relative_path). */
function validateRelativePath(p: string): string | null {
  if (p === "") return "empty";
  if (p.startsWith("/")) return "absolute path";
  if (p.replace(/\\/g, "/").split("/").includes("..")) return "contains '..'";
  return null;
}

/**
 * Normalize a CLI path argument to workspace-relative form (mirror of Python
 * `normalize_workspace_path`). Returns [normalized, null] or [original, reason].
 */
export function normalizeWorkspacePath(p: string, root: string): [string, string | null] {
  if (p === "") return [p, "empty"];
  if (isAbsolute(p)) {
    const rel = relative(resolve(root), resolve(p));
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return [p, "path outside workspace root"];
    }
    const reason = validateRelativePath(rel);
    return reason === null ? [rel, null] : [p, reason];
  }
  const reason = validateRelativePath(p);
  return reason === null ? [p, null] : [p, reason];
}

function parseArgs(argv: string[]): { paths: string[]; root: string | null } {
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx !== -1 ? (argv[rootIdx + 1] ?? null) : null;
  const paths = argv.filter((a, i) => !a.startsWith("--") && (rootIdx === -1 || i !== rootIdx + 1));
  return { paths, root };
}

/**
 * Flags the bundled Node CLI accepts. Anything else is REJECTED rather than
 * silently discarded — 0.3.1 fix. Before this, the CLI dropped unknown flags
 * on the floor, so README-advertised options (`--self-test`, `--detail`) printed
 * ordinary status and exited 0: a false-positive "your install is fine" for the
 * exact command the docs call the best signal that the install works.
 */
const FLAGS_BY_PROG: Record<string, ReadonlySet<string>> = {
  "agent-coherence-status": new Set(["--root", "--detail"]),
  "agent-coherence-track": new Set(["--root"]),
  "agent-coherence-untrack": new Set(["--root"]),
};

/** Flags the Python console script implements that the Node CLI does not. */
const PYTHON_ONLY_FLAGS: Record<string, string> = {
  // The counters clause is load-bearing: the Python self-test run against the
  // Node coordinator passes all four steps, then exits 3 because this
  // coordinator's `/status?detail=metrics` serves no counters.
  "--self-test":
    "runs a live four-step pre-read → pre-edit → post-edit → stale-read sequence, " +
    "then checks counters only the Python coordinator serves",
};

/** Returns an error message if argv carries a flag this CLI cannot honor. */
function rejectUnsupportedFlags(prog: string, argv: string[]): string | null {
  const allowed = FLAGS_BY_PROG[prog] ?? new Set(["--root"]);
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (allowed.has(name)) continue;
    const pythonOnly = PYTHON_ONLY_FLAGS[name];
    if (pythonOnly !== undefined) {
      // Names no backend switch. Writing `python` to
      // .coherence/coordinator_backend on a store the Node coordinator created
      // leaves the workspace with no coordinator (the Python one fails closed
      // on a Node ledger), and `--prepare-for-migration` does not convert the
      // store. "By its install path" because the plugin's shim of the same
      // name prefers this CLI whenever node is on PATH.
      return (
        `${prog}: ${name} is not supported by the bundled Node CLI (it ${pythonOnly}). ` +
        `It needs the Python library's console script (\`pip install "agent-coherence>=0.8.0"\`, ` +
        `run by its install path) on a workspace the Python coordinator serves. On a Node ` +
        `workspace, plain \`agent-coherence-status\` confirms the coordinator answers.`
      );
    }
    return `${prog}: unknown option ${name}`;
  }
  return null;
}

/** Value of a `--flag value` / `--flag=value` pair, or null. */
function flagValue(argv: string[], flag: string): string | null {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  return idx !== -1 ? (argv[idx + 1] ?? null) : null;
}

type PolicyProg = "agent-coherence-track" | "agent-coherence-untrack";
type Answer = { status: number; body: Record<string, unknown> | null };

/** The reason a coordinator gives when it refuses to untrack a strict path. */
const UNTRACK_STRICT_PATH_REASON = "untrack_strict_path";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRefusedEntry(entry: unknown): entry is { path: string; strict_patterns: string[] } {
  if (!isPlainObject(entry) || typeof entry.path !== "string") return false;
  const patterns = entry.strict_patterns;
  return Array.isArray(patterns) && patterns.length > 0 && patterns.every((p) => typeof p === "string");
}

/**
 * The refused entries of a strict untrack refusal, or null for any other
 * body. Mirrors the Python CLI: classified by the typed reason, never by the
 * error text, and only when every entry names its path and its strict
 * patterns. Anything else reads as the HTTP error it is.
 */
function strictRefusalEntries(
  body: Record<string, unknown> | null,
): Array<{ path: string; strict_patterns: string[] }> | null {
  if (body === null || body.reason !== UNTRACK_STRICT_PATH_REASON) return null;
  const refused = body.refused;
  if (!Array.isArray(refused) || refused.length === 0 || !refused.every(isRefusedEntry)) return null;
  return refused;
}

function reportStrictRefusal(entries: Array<{ path: string; strict_patterns: string[] }>): void {
  for (const entry of entries) {
    const named = entry.strict_patterns.map(escapeNonprintable).join(", ");
    err(`agent-coherence-untrack: refused ${pyRepr(entry.path)}: enforced in strict mode by ${named}`);
  }
  err(
    "agent-coherence-untrack: nothing was untracked. A strict path stays enforced while the " +
      "coordinator runs; remove its entry from .coherence/strict_mode.yaml and restart the " +
      "coordinator to untrack it.",
  );
}

/** The paths an answer applied and the entries it rejected, or null when either has the wrong type. */
function readPolicyAnswer(
  payload: Record<string, unknown>,
  resultKey: "added" | "removed",
): { applied: string[]; rejected: Array<Record<string, unknown>> } | null {
  // Checked before anything prints: a string iterates as its characters and
  // an object as its keys, each of which would print as a path.
  const applied = payload[resultKey] ?? [];
  const rejected = payload.rejected ?? [];
  if (!Array.isArray(applied) || !applied.every((p) => typeof p === "string")) return null;
  if (!Array.isArray(rejected) || !rejected.every(isPlainObject)) return null;
  return { applied, rejected };
}

function rejectedPath(entry: Record<string, unknown>): string {
  const path = entry.path ?? "";
  return typeof path === "string" ? pyRepr(path) : escapeNonprintable(path);
}

async function postPolicy(
  prog: PolicyProg,
  endpointPath: "/policy/track" | "/policy/untrack",
  root: string,
  paths: string[],
): Promise<Answer | null> {
  try {
    const endpoint = resolveEndpoint(resolve(root));
    return await requestJsonStatus(endpoint, "POST", endpointPath, { paths }, undefined, CLI_REQUEST_TIMEOUT_MS);
  } catch (exc) {
    err(`${prog}: ${escapeNonprintable((exc as Error).message)}`);
    return null;
  }
}

/**
 * Exit code for a non-2xx answer. A refusal's `error` says what is wrong and
 * how to fix it (a policy file that will not load, the byte cap), so it is
 * printed in the Python CLI's `HTTP <status>: <error>` form. An untrack that
 * a coordinator refused because a path is enforced in strict mode exits 3,
 * classified on any error status, as the Python CLI does.
 */
function reportRefusal(prog: PolicyProg, answer: Answer): number {
  const refused = prog === "agent-coherence-untrack" && answer.status >= 400 ? strictRefusalEntries(answer.body) : null;
  if (refused !== null) {
    reportStrictRefusal(refused);
    return 3;
  }
  err(`${prog}: ${httpErrorLine(answer.status, answer.body)}`);
  return 2;
}

function printApplied(prog: PolicyProg, verb: "tracked" | "untracked", root: string, applied: string[]): void {
  for (const p of applied) {
    out(`${prog}: ${verb} ${escapeNonprintable(p)}`);
    // Operationally fine (the path is seeded on its first Read), but worth
    // surfacing, as the Python CLI does. A lookup that fails reads as present.
    if (verb === "tracked" && !existsQuietly(join(root, p))) {
      err(`${prog}: warning: ${escapeNonprintable(p)} does not exist on disk yet`);
    }
  }
}

function existsQuietly(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return true;
  }
}

async function runPolicyMutation(
  prog: PolicyProg,
  endpointPath: "/policy/track" | "/policy/untrack",
  resultKey: "added" | "removed",
  verb: "tracked" | "untracked",
  argv: string[],
): Promise<number> {
  const flagErr = rejectUnsupportedFlags(prog, argv);
  if (flagErr !== null) {
    err(flagErr);
    return 2;
  }
  const { paths, root: rootArg } = parseArgs(argv);
  const root = rootArg ?? findCoordinatorRoot();
  if (root === null) {
    err(`${prog}: not in a git repository`);
    return 1;
  }

  const invalid: Array<[string, string]> = [];
  const valid: string[] = [];
  for (const p of paths) {
    const [normalized, reason] = normalizeWorkspacePath(p, root);
    if (reason !== null) invalid.push([p, reason]);
    else valid.push(normalized);
  }
  if (valid.length === 0) {
    for (const [p, reason] of invalid) err(`${prog}: rejected ${pyRepr(p)}: ${reason}`);
    return 1;
  }

  const answer = await postPolicy(prog, endpointPath, root, valid);
  if (answer === null) return 2;
  if (answer.status < 200 || answer.status >= 300) return reportRefusal(prog, answer);
  if (answer.body === null) {
    err(`${prog}: coordinator returned a non-JSON response`);
    return 2;
  }
  const result = readPolicyAnswer(answer.body, resultKey);
  if (result === null) {
    err(`${prog}: unexpected ${endpointPath} answer shape`);
    return 2;
  }

  printApplied(prog, verb, root, result.applied);
  for (const entry of result.rejected) {
    err(`${prog}: rejected ${rejectedPath(entry)}: ${escapeNonprintable(entry.reason ?? "")}`);
  }
  for (const [p, reason] of invalid) err(`${prog}: rejected ${pyRepr(p)}: ${reason}`);
  return 0;
}

export function runTrack(argv: string[]): Promise<number> {
  return runPolicyMutation("agent-coherence-track", "/policy/track", "added", "tracked", argv);
}

export function runUntrack(argv: string[]): Promise<number> {
  return runPolicyMutation("agent-coherence-untrack", "/policy/untrack", "removed", "untracked", argv);
}

export async function runStatus(argv: string[]): Promise<number> {
  const flagErr = rejectUnsupportedFlags("agent-coherence-status", argv);
  if (flagErr !== null) {
    err(flagErr);
    return 2;
  }
  const { root: rootArg } = parseArgs(argv);
  const detail = flagValue(argv, "--detail");
  // `minimal` is the default tier asked for by name: both coordinators answer
  // it as they answer a bare /status, and the Python CLI accepts it too, so
  // the status command can pass it to whichever CLI the shim runs.
  if (detail !== null && !["minimal", "metrics", "full"].includes(detail)) {
    err(`agent-coherence-status: --detail must be 'minimal', 'metrics' or 'full' (got '${detail}')`);
    return 2;
  }
  const root = rootArg ?? findCoordinatorRoot();
  if (root === null) {
    err("agent-coherence-status: not in a git repository");
    return 1;
  }
  let answer: { status: number; body: Record<string, unknown> | null };
  try {
    const endpoint = resolveEndpoint(resolve(root));
    const path = detail === null ? "/status" : `/status?detail=${encodeURIComponent(detail)}`;
    // The Python coordinator answers ?detail=full with 403 unless the request
    // carries the Coherence-Local-Operator opt-in, so an operator asking for
    // the full tier sends it. The other tiers do not need it and go without.
    const extra = detail === "full" ? { "Coherence-Local-Operator": "true" } : undefined;
    answer = await requestJsonStatus(endpoint, "GET", path, undefined, extra, CLI_REQUEST_TIMEOUT_MS);
  } catch (exc) {
    err(`agent-coherence-status: ${escapeNonprintable((exc as Error).message)}`);
    return 2;
  }
  // Same `HTTP <status>: <error>` form as track/untrack and the Python CLI:
  // the Node coordinator's 501 for ?detail=full says why, and so does a 403.
  if (answer.status < 200 || answer.status >= 300) {
    err(`agent-coherence-status: ${httpErrorLine(answer.status, answer.body)}`);
    return 2;
  }
  if (answer.body === null) {
    err("agent-coherence-status: coordinator returned a non-JSON response");
    return 2;
  }
  out(JSON.stringify(answer.body, null, 2));
  // The metrics tier carries no lists. Any other tier without them cannot say
  // what is tracked, which is never "nothing tracked": a coordinator that could
  // not read its registry in time answers with both set to null and
  // `degraded: true`. The body still prints, for the operator who asked for it.
  if (detail !== "metrics" && listsUnavailable(answer.body)) {
    err(answer.body.degraded === true ? DEGRADED_LINE : SHAPE_LINE);
    return 2;
  }
  return 0;
}

const SHAPE_LINE = "agent-coherence-status: unexpected /status shape";
const DEGRADED_LINE =
  "agent-coherence-status: the coordinator's registry is busy (lock contention), " +
  "so tracked artifacts and sessions are unavailable; try again shortly";

function listsUnavailable(body: Record<string, unknown>): boolean {
  return !Array.isArray(body.tracked_artifacts) || !Array.isArray(body.sessions);
}
