/**
 * Tracked-artifact policy — Node port of Python adapters/claude_code/policy.py.
 *
 * Decides whether a parent-repo-relative path is coordinated. Loaded from
 * `<workspace>/.coherence/{tracked,ignored}.yaml` on coordinator startup;
 * the defaults below ship in code so a fresh workspace with no YAML files
 * still tracks the canonical coordination files.
 *
 * Per KTD-L: DECISIONS.md is included in the default tracked set as of
 * v0.1.1 (operator-rulings append-only ledger pattern surfaced by
 * kcarriedo in anthropics/claude-code#59309).
 *
 * KTD-A.5 point 4: YAML file locking interop with the Python coordinator
 * requires fd-level POSIX flock(2), NOT proper-lockfile's sidecar-lock
 * approach. v0.1.1 Unit 1 does not yet wire write-time locking (writes
 * happen via `/policy/track` + `/policy/untrack` endpoints landing in
 * Unit 3 / Unit 6); this module is read-only at the registry layer for now.
 *
 * Cross-language glob semantics: hand-rolled regex translation mirrors
 * Python's _glob_match exactly — `*` matches within a path segment,
 * `**` matches zero-or-more segments, `?` matches a single non-slash char.
 * fnmatch's fnmatchcase semantics; KTD-B.3 C5 prefix contract applies to
 * the parity scenarios that cover policy decisions.
 */
import { readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { dump as yamlDump, load as yamlLoad, type YAMLException } from "js-yaml";

/** Mirror of Python coordinator_server.MAX_POLICY_PATHS_PER_REQUEST. */
export const MAX_POLICY_PATHS_PER_REQUEST = 20;
/** Mirror of Python coordinator_server.MAX_POLICY_YAML_BYTES. */
export const MAX_POLICY_YAML_BYTES = 64 * 1024;
/** Mirror of Python coordinator_server.MAX_PATH_LEN. */
export const MAX_POLICY_PATH_LEN = 1024;

/**
 * Authoritative server-side track/untrack path gate — a byte-for-byte port of
 * Python `validate_path` (reason strings included; the corpus pins them).
 *
 * Two things this fixes vs the prior inline check: (1) it rejects control
 * characters — the newline-injection vector that let `"a\n- /etc/passwd"`
 * re-parse into extra YAML entries, bypassing the absolute/traversal/cap
 * guards; (2) leading-backslash + a length cap. Returns the rejection reason,
 * or null if the path is safe. Order of checks matches Python exactly so the
 * `rejected[]` reason is identical on both backends.
 */
export function validatePolicyPath(path: string): string | null {
  if (path === "") return "path is empty";
  if (path.length > MAX_POLICY_PATH_LEN) return `path exceeds ${MAX_POLICY_PATH_LEN} chars`;
  if (path.startsWith("/")) return "path must be relative (no leading /)";
  if (path.startsWith("\\")) return "path must be relative (no leading \\)";
  // ANY control char rejected — newline injection into YAML + terminal mischief.
  for (const ch of path) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return "path contains control characters";
  }
  if (path.replace(/\\/g, "/").split("/").includes("..")) return "path contains '..' traversal";
  return null;
}

/**
 * Default tracked patterns (Unit 2 commit 4 + KTD-L).
 *
 * Cross-language safe — pattern set must not produce false positives on
 * Node, Rust, Django, or other-ecosystem path samples. Unit 8 lands the
 * 1000-path benchmark that locks the false-positive rate.
 */
export const DEFAULT_TRACKED_PATTERNS: ReadonlyArray<string> = [
  // Repo-root coordination files
  "CLAUDE.md",
  "AGENTS.md",
  // KTD-L: operator-rulings append-only ledger pattern (added 2026-05-18)
  "DECISIONS.md",
  // Spec/plan/brainstorm directories
  "docs/specs/**/*.md",
  "docs/plans/**/*.md",
  "docs/brainstorms/**/*.md",
  // Conventional coordination filenames at any depth
  "**/plan.md",
  "**/task.md",
  "**/spec.md",
];

export interface PolicySummary {
  coordinator_root: string;
  default_pattern_count: number;
  user_added_pattern_count: number;
  ignored_pattern_count: number;
  rejected_pattern_count: number;
}

export interface RejectedPattern {
  pattern: string;
  reason: string;
}

export class TrackedArtifactPolicy {
  readonly coordinatorRoot: string;
  readonly trackedPatterns: ReadonlyArray<string>;
  readonly ignoredPatterns: ReadonlyArray<string>;
  readonly userAddedPatterns: ReadonlyArray<string>;
  readonly strictModePaths: ReadonlyArray<string>;
  readonly rejectedPatterns: ReadonlyArray<RejectedPattern>;

  private constructor(args: {
    coordinatorRoot: string;
    trackedPatterns: ReadonlyArray<string>;
    ignoredPatterns: ReadonlyArray<string>;
    userAddedPatterns: ReadonlyArray<string>;
    strictModePaths: ReadonlyArray<string>;
    rejectedPatterns: ReadonlyArray<RejectedPattern>;
  }) {
    this.coordinatorRoot = args.coordinatorRoot;
    this.trackedPatterns = args.trackedPatterns;
    this.ignoredPatterns = args.ignoredPatterns;
    this.userAddedPatterns = args.userAddedPatterns;
    this.strictModePaths = args.strictModePaths;
    this.rejectedPatterns = args.rejectedPatterns;
  }

  /**
   * Load policy: defaults + .coherence/tracked.yaml opt-in +
   * .coherence/ignored.yaml opt-out + .coherence/strict_mode.yaml
   * strict opt-in (zero-Python Unit 6; mirrors Python policy.py).
   */
  static load(coordinatorRoot: string): TrackedArtifactPolicy {
    const rejected: RejectedPattern[] = [];
    const added = loadYamlPatterns(join(coordinatorRoot, ".coherence", "tracked.yaml"), rejected);
    const ignored = loadYamlPatterns(join(coordinatorRoot, ".coherence", "ignored.yaml"), rejected);
    const strict = loadYamlPatterns(join(coordinatorRoot, ".coherence", "strict_mode.yaml"), rejected);
    return new TrackedArtifactPolicy({
      coordinatorRoot,
      trackedPatterns: DEFAULT_TRACKED_PATTERNS,
      ignoredPatterns: ignored,
      userAddedPatterns: added,
      strictModePaths: strict,
      rejectedPatterns: rejected,
    });
  }

  /**
   * v0.2 KTD-O (Node port): a path is in strict mode iff it is TRACKED and
   * matches at least one strict_mode_paths glob. Intersection semantics —
   * strict never applies to untracked paths. Empty strict_mode_paths
   * short-circuits to false (v0.1.1 warn-only behavior preserved).
   */
  isStrictMode(parentRelativePath: string): boolean {
    if (this.strictModePaths.length === 0) return false;
    if (!this.isTracked(parentRelativePath)) return false;
    const normalized = normalizeRelative(parentRelativePath);
    if (normalized === null) return false;
    return this.strictModePaths.some((p) => globMatch(normalized.replace(/\\/g, "/"), p));
  }

  /**
   * Return true if the given parent-repo-relative path is coordinated.
   * Algorithm: path is tracked if it matches any default OR user-added
   * pattern, AND does not match any ignored pattern. Ignore wins ties.
   */
  isTracked(parentRelativePath: string): boolean {
    const normalized = normalizeRelative(parentRelativePath);
    if (normalized === null) return false;

    const tracked =
      matchesAny(normalized, this.trackedPatterns) ||
      matchesAny(normalized, this.userAddedPatterns);
    if (!tracked) return false;
    if (matchesAny(normalized, this.ignoredPatterns)) return false;
    return true;
  }

  summary(): PolicySummary {
    return {
      coordinator_root: this.coordinatorRoot,
      default_pattern_count: this.trackedPatterns.length,
      user_added_pattern_count: this.userAddedPatterns.length,
      ignored_pattern_count: this.ignoredPatterns.length,
      rejected_pattern_count: this.rejectedPatterns.length,
    };
  }
}

/**
 * Mutable policy holder — the seam that makes /policy/track + /policy/untrack
 * live-reloadable (plan Unit 1, "the load-bearing decision for G3").
 *
 * `createServer` captures its deps once by reference; Python re-assigns
 * `coordinator.policy = TrackedArtifactPolicy.load(root)` after every YAML
 * append. Node handlers must therefore read the policy THROUGH this ref
 * (never bind the inner TrackedArtifactPolicy), so a `reload()` after an
 * append is immediately visible to live handlers with no restart.
 *
 * Node's single-threaded synchronous handler model means a reload cannot
 * interleave a handler mid-decision — the swap is atomic by construction.
 */
export class PolicyRef {
  private current: TrackedArtifactPolicy;

  constructor(policy: TrackedArtifactPolicy) {
    this.current = policy;
  }

  static load(coordinatorRoot: string): PolicyRef {
    return new PolicyRef(TrackedArtifactPolicy.load(coordinatorRoot));
  }

  /** The current immutable policy snapshot. Do NOT cache across requests. */
  get(): TrackedArtifactPolicy {
    return this.current;
  }

  /** Convenience passthrough — the hot-path call every hook handler makes. */
  isTracked(parentRelativePath: string): boolean {
    return this.current.isTracked(parentRelativePath);
  }

  /** Strict-mode passthrough (Unit 6) — same read-through-the-ref discipline. */
  isStrictMode(parentRelativePath: string): boolean {
    return this.current.isStrictMode(parentRelativePath);
  }

  /** Convenience passthrough for the /status default tier. */
  summary(): PolicySummary {
    return this.current.summary();
  }

  /** Re-parse the YAML files and swap the snapshot (Python's `coordinator.policy = load(...)`). */
  reload(): void {
    this.current = TrackedArtifactPolicy.load(this.current.coordinatorRoot);
  }
}

/**
 * Append valid patterns to a policy YAML (`tracked.yaml` / `ignored.yaml`).
 * Node port of Python `_append_policy_yaml` (coordinator_server.py). Returns
 * `{added, rejected}` with the exact Python semantics:
 * - per-path validation (empty → "empty"; absolute → "absolute path";
 *   `..` → "contains '..'") — defense-in-depth; routes pre-validate;
 * - dedupe against patterns already in the file — a fully-duplicate request
 *   returns `added: []`;
 * - append one double-quoted `- "<p>"` line per entry, preserving existing
 *   content (Python writes them unquoted until Cohexa-ai/agent-coherence#284);
 * - refuse, writing nothing, when the file cannot be read, does not load as a
 *   list, or would not load back as its old entries plus the new ones → route
 *   maps to 400. For the last two Python appends anyway, reporting success for
 *   an entry that never takes effect; for an unreadable file it also writes
 *   nothing but answers 500;
 * - byte cap → throws with Python's exact message
 *   (`policy YAML cap of 65536 bytes would be exceeded`) → route maps to 400.
 *
 * Locking note (deliberate divergence from Python's fcntl.flock): all Node
 * writes flow through the single coordinator process whose handlers are
 * synchronous on one event loop, and the pid-file mutex guarantees one
 * coordinator per workspace — so there is no concurrent writer to exclude.
 * The write itself is tmp-file + atomic rename so a crash cannot leave a
 * torn YAML.
 */
export function appendPolicyYaml(
  yamlPath: string,
  newPaths: ReadonlyArray<string>,
): { added: string[]; rejected: Array<{ path: string; reason: string }> } {
  mkdirSync(dirname(yamlPath), { recursive: true });

  const candidate: string[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  for (const p of newPaths) {
    const reason = validatePolicyPath(p);
    if (reason !== null) {
      rejected.push({ path: p, reason });
      continue;
    }
    candidate.push(p);
  }
  if (candidate.length === 0) {
    return { added: [], rejected };
  }

  const name = policyFileName(yamlPath);
  let existing: string;
  try {
    existing = readFileSync(yamlPath, "utf8");
  } catch (err) {
    // Only a missing file is empty. Reading any other failure as empty would
    // rename a file holding just the new entries over every pattern it had.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`${name} could not be read (${code ?? String(err)}); nothing was written.`);
    }
    existing = "";
  }
  // A file that loads as no entries still loads as none after an append, so
  // the new entry would never apply; refusing is the only true answer.
  const current = readPolicyEntries(existing);
  if (!("entries" in current)) {
    throw new Error(unloadableMessage(name, current));
  }
  const alreadyPresent = new Set(current.entries);
  const trulyNew = candidate.filter((p) => !alreadyPresent.has(p));
  if (trulyNew.length === 0) {
    return { added: [], rejected };
  }

  // Quoted, never plain: a plain `- ${p}` lets YAML read the entry as an
  // alias, tag, comment, mapping or non-string, and one such entry stops the
  // whole file parsing, which loads as no entries. js-yaml's dumper also
  // escapes NEL, which PyYAML would fold to a space when the Python backend
  // reads the same file.
  const newLines = yamlDump(trulyNew, { forceQuotes: true, quotingType: '"', lineWidth: -1 });
  const newContent = existing !== "" ? existing.replace(/\n+$/, "") + "\n" + newLines : newLines;
  // A block line after a [ ... ] list, an indented list or a "..." end marker
  // stops valid files parsing, which would erase entries that were working.
  const written = readPolicyEntries(newContent);
  const expected = [...current.entries, ...trulyNew];
  if (
    !("entries" in written) ||
    written.entries.length !== expected.length ||
    written.entries.some((entry, i) => entry !== expected[i])
  ) {
    throw new Error(
      `${name} cannot take a new line without breaking what it holds ` +
        `(such as a [ ... ] list, an indented list, a "..." end marker or a lone ~ or null); ` +
        `nothing was written. ` +
        REWRITE_HINT,
    );
  }
  if (Buffer.byteLength(newContent, "utf8") > MAX_POLICY_YAML_BYTES) {
    throw new Error(`policy YAML cap of ${MAX_POLICY_YAML_BYTES} bytes would be exceeded`);
  }

  const tmpPath = `${yamlPath}.tmp`;
  writeFileSync(tmpPath, newContent, "utf8");
  renameSync(tmpPath, yamlPath);
  return { added: trulyNew, rejected };
}

const REWRITE_HINT =
  'Rewrite it with one entry per line, each a double-quoted string such as - "*.md", then retry.';

/**
 * What the loader reads from a policy YAML body: the string entries of a list
 * (an empty or null document reads as none), or why it reads nothing. Mirrors
 * `loadYamlPatterns` without its per-pattern guard, which treats an entry the
 * same wherever it appears.
 */
function readPolicyEntries(
  text: string,
): { entries: string[] } | { parseError: YAMLException } | { notAList: string } {
  let raw: unknown;
  try {
    raw = yamlLoad(text);
  } catch (err) {
    return { parseError: err as YAMLException };
  }
  if (raw === null || raw === undefined) return { entries: [] };
  if (!Array.isArray(raw)) return { notAList: describeYamlValue(raw) };
  return { entries: raw.filter((x): x is string => typeof x === "string") };
}

function describeYamlValue(value: unknown): string {
  if (value instanceof Date) return "a date";
  if (ArrayBuffer.isView(value)) return "binary data";
  if (typeof value === "object") return "a mapping";
  if (typeof value === "string") return "a single string";
  return `a ${typeof value}`;
}

/** `.coherence/tracked.yaml`, the way the rest of the coordinator's prose names these files. */
function policyFileName(yamlPath: string): string {
  return `${basename(dirname(yamlPath))}/${basename(yamlPath)}`;
}

/**
 * Both CLIs print the refusal to a terminal, and the parser's reason quotes
 * file content: escape C0, DEL and C1, plus the invisible format characters
 * (zero-width, bidi embeddings and isolates, line/paragraph separators, BOM)
 * that can make printed text read differently from what it is.
 */
function escapeControlChars(text: string): string {
  let out = "";
  for (const c of text) {
    const code = c.charCodeAt(0);
    const hidden =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff;
    out += hidden ? `\\u${code.toString(16).padStart(4, "0")}` : c;
  }
  return out;
}

function unloadableMessage(
  name: string,
  problem: { parseError: YAMLException } | { notAList: string },
): string {
  if ("notAList" in problem) {
    return `${name} holds ${problem.notAList}, not a list, so it loads as no entries; nothing was written. ${REWRITE_HINT}`;
  }
  // js-yaml's mark can land past the bad token (an unclosed quote is reported
  // at end of file) and is absent for a multi-document file.
  const { reason, mark } = problem.parseError;
  const where = mark ? ` near line ${mark.line + 1}, column ${mark.column + 1}` : "";
  const cause = /single document/.test(reason ?? "")
    ? "The file holds more than one YAML document; remove the extra --- separators."
    : "An unclosed quote or bracket on an earlier line can cause this.";
  return (
    `${name} is not valid YAML, so it loads as no entries; nothing was written. ` +
    `The parser stopped${where}: ${escapeControlChars(reason ?? "unknown error")}. ` +
    `${cause} ${REWRITE_HINT}`
  );
}

// ----------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------

/**
 * Normalize a relative path: strip leading `./`. Returns null if the path
 * is absolute, contains `..` components, or is empty after stripping.
 *
 * Note: uses literal `./` prefix strip (NOT trim of `./`) so dotfiles like
 * `.env` and `.gitignore` are unchanged. Mirrors Python's removeprefix fix
 * documented at policy.py:136-140.
 */
export function normalizeRelative(p: string): string | null {
  if (p === "") return null;
  if (p.startsWith("/")) return null;
  const cleaned = p.startsWith("./") ? p.slice(2) : p;
  if (cleaned === "") return null;
  const parts = cleaned.replace(/\\/g, "/").split("/");
  if (parts.includes("..")) return null;
  return cleaned;
}

function matchesAny(path: string, patterns: ReadonlyArray<string>): boolean {
  const posixPath = path.replace(/\\/g, "/");
  for (const pattern of patterns) {
    if (globMatch(posixPath, pattern)) return true;
  }
  return false;
}

/**
 * Posix-style glob matcher. Supports `**` (zero-or-more path segments),
 * `*` (zero-or-more chars within a segment, no `/`), `?` (one non-slash char).
 * Mirrors Python's _glob_match for KTD-B parity.
 */
// Per-process cache of compiled glob patterns. Hot path: every hook on
// every tracked-artifact lookup compiles `**` once per session otherwise.
// ce-review safe_auto fix: pure memoization, no semantic change.
const compiledGlobs: Map<string, RegExp> = new Map();

export function globMatch(path: string, pattern: string): boolean {
  let regex = compiledGlobs.get(pattern);
  if (regex === undefined) {
    regex = new RegExp("^" + patternToRegex(pattern) + "$");
    compiledGlobs.set(pattern, regex);
  }
  return regex.test(path);
}

function patternToRegex(pattern: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (i + 1 < pattern.length && pattern[i + 1] === "*") {
        out.push(".*");
        i += 2;
        if (i < pattern.length && pattern[i] === "/") {
          i += 1;
        }
      } else {
        out.push("[^/]*");
        i += 1;
      }
    } else if (c === "?") {
      out.push("[^/]");
      i += 1;
    } else {
      // Escape regex metacharacters.
      out.push(c!.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
      i += 1;
    }
  }
  return out.join("");
}

/**
 * Read a YAML file containing a list of pattern strings. Apply path-traversal
 * guard. Returns surviving patterns; mutates rejected with (pattern, reason)
 * for each rejection.
 *
 * Missing file → []. Malformed YAML → [] + logged WARNING. Non-list top-level → [].
 */
function loadYamlPatterns(yamlPath: string, rejected: RejectedPattern[]): string[] {
  let stat;
  try {
    stat = statSync(yamlPath);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];

  let raw: unknown;
  try {
    const text = readFileSync(yamlPath, "utf8");
    raw = yamlLoad(text);
  } catch (err) {
    process.stderr.write(
      `agent-coherence: WARNING — malformed YAML at ${yamlPath}; falling back to defaults: ${String(err)}\n`,
    );
    return [];
  }

  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    process.stderr.write(
      `agent-coherence: WARNING — ${yamlPath} top-level must be a list of patterns; got ${typeof raw}. Ignoring.\n`,
    );
    return [];
  }

  const surviving: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      rejected.push({ pattern: String(item), reason: `non-string pattern (${typeof item})` });
      continue;
    }
    const reason = validatePattern(item);
    if (reason !== null) {
      rejected.push({ pattern: item, reason });
      continue;
    }
    surviving.push(item);
  }
  return surviving;
}

/** Path-traversal guard. Returns null if pattern is acceptable, else a short reason. */
function validatePattern(pattern: string): string | null {
  if (pattern === "") return "empty pattern";
  if (pattern.startsWith("/")) return "absolute path";
  const parts = pattern.replace(/\\/g, "/").split("/");
  if (parts.includes("..")) return "contains '..' (path traversal)";
  return null;
}
