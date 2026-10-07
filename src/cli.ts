/**
 * Node CLI surface backing the slash commands (zero-Python Unit 4 / G3):
 * track / untrack / status. Ports the Python console scripts
 * (`ccs/cli/coherence_track.py`, `coherence_untrack.py`, `coherence_status.py`).
 *
 * Exit codes (Python parity): 0 success · 1 not-in-git / nothing valid to
 * send · 2 coordinator unavailable or HTTP error. Unlike the hook-client
 * (fail-open, always 0), the CLIs are operator-facing and DO signal failure.
 *
 * Path normalization ($ARGUMENTS-verbatim learning, 2026-05-26): operators
 * paste absolute paths from their shell/IDE; absolute-inside-root is
 * auto-stripped to workspace-relative, absolute-outside-root is rejected —
 * absolute paths must NEVER leak into tracked.yaml / ignored.yaml.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  CoordinatorUnavailable,
  findCoordinatorRoot,
  requestJson,
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
  "--self-test": "runs a live four-step pre-read → pre-edit → post-edit → stale-read sequence",
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
      return (
        `${prog}: ${name} is not supported by the bundled Node CLI (it ${pythonOnly}). ` +
        `Install the Python library (\`pip install "agent-coherence>=0.8.0"\`) and run the ` +
        `console script directly, or select the Python backend for this workspace ` +
        `(\`printf 'python\\n' > .coherence/coordinator_backend\`).`
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

async function runPolicyMutation(
  prog: "agent-coherence-track" | "agent-coherence-untrack",
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
    for (const [p, reason] of invalid) err(`${prog}: rejected '${p}': ${reason}`);
    return 1;
  }

  let answer: { status: number; body: Record<string, unknown> | null };
  try {
    const endpoint = resolveEndpoint(resolve(root));
    answer = await requestJsonStatus(endpoint, "POST", endpointPath, { paths: valid });
  } catch (exc) {
    if (exc instanceof CoordinatorUnavailable) {
      err(`${prog}: ${exc.message}`);
      return 2;
    }
    err(`${prog}: ${(exc as Error).message}`);
    return 2;
  }
  // A refusal's `error` says what is wrong and how to fix it (a policy file
  // that will not load, the byte cap); print it in the Python CLI's
  // `HTTP <status>: <error>` form. Without a string `error`, print the status.
  if (answer.status < 200 || answer.status >= 300) {
    const error = answer.body?.error;
    err(typeof error === "string" ? `${prog}: HTTP ${answer.status}: ${error}` : `${prog}: HTTP ${answer.status}`);
    return 2;
  }
  const payload = answer.body;
  if (payload === null) {
    err(`${prog}: coordinator returned a non-JSON response`);
    return 2;
  }

  const applied = Array.isArray(payload[resultKey]) ? (payload[resultKey] as string[]) : [];
  const rejected = Array.isArray(payload.rejected)
    ? (payload.rejected as Array<Record<string, unknown>>)
    : [];
  for (const p of applied) out(`${prog}: ${verb} ${p}`);
  for (const entry of rejected) {
    err(`${prog}: rejected ${String(entry.path ?? "")}: ${String(entry.reason ?? "")}`);
  }
  for (const [p, reason] of invalid) err(`${prog}: rejected '${p}': ${reason}`);
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
  if (detail !== null && !["metrics", "full"].includes(detail)) {
    err(`agent-coherence-status: --detail must be 'metrics' or 'full' (got '${detail}')`);
    return 2;
  }
  const root = rootArg ?? findCoordinatorRoot();
  if (root === null) {
    err("agent-coherence-status: not in a git repository");
    return 1;
  }
  let payload: Record<string, unknown> | null;
  try {
    const endpoint = resolveEndpoint(resolve(root));
    // ?detail=full additionally requires the Coherence-Local-Operator header
    // server-side; without it the coordinator answers 403 and that surfaces here.
    const path = detail === null ? "/status" : `/status?detail=${encodeURIComponent(detail)}`;
    payload = await requestJson(endpoint, "GET", path);
  } catch (exc) {
    err(`agent-coherence-status: ${(exc as Error).message}`);
    return 2;
  }
  if (payload === null) {
    err("agent-coherence-status: coordinator rejected the request");
    return 2;
  }
  out(JSON.stringify(payload, null, 2));
  return 0;
}
