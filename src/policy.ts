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
 * Glob semantics: one grammar for every pattern (`globTokens`) — `*` matches
 * within a path segment, `**` matches zero-or-more segments (a `/` after it is
 * swallowed), `?` matches a single non-slash char, and every other character,
 * `[` included, is literal. This is Python's `**` grammar; Python matches a
 * pattern without `**` with fnmatch instead, where `*` and `?` cross `/`.
 * KTD-B.3 C5 prefix contract applies to the parity scenarios that cover
 * policy decisions.
 *
 * A strict path stays enforced for the coordinator's lifetime
 * (Cohexa-ai/agent-coherence#261): strict wins over ignore (`isTracked`), a hot
 * reload never drops a strict or user-added pattern while strict patterns are
 * live (`reloaded`), and `/policy/untrack` refuses an entry that covers a strict
 * path (`strictPatternsCovering`). The one way to stop enforcing a strict path
 * is to restart the coordinator without its strict entry.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, statSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
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

/** A track or untrack request's paths, split by `validatePolicyPath`, in request order. */
export function partitionPolicyPaths(paths: ReadonlyArray<string>): {
  valid: string[];
  rejected: Array<{ path: string; reason: string }>;
} {
  const valid: string[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  for (const path of paths) {
    const reason = validatePolicyPath(path);
    if (reason === null) valid.push(path);
    else rejected.push({ path, reason });
  }
  return { valid, rejected };
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
  strict_mode_pattern_count: number;
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
  // What the strict-coverage check reads from the strict and tracked
  // patterns, built once: an untrack request and the spawn diagnostic decide
  // every entry against the same patterns.
  private readonly coverageStrict: ReadonlyArray<Glob>;
  private readonly coverageTracked: ReadonlyArray<Glob>;

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
    // A literal strict path no tracked pattern reaches puts nothing in strict
    // mode (an intersection), so no entry can cover it.
    this.coverageStrict = this.strictModePaths
      .map(globOf)
      .filter((s) => !s.isLiteral || this.matchesTracked(s.pattern));
    this.coverageTracked = union(this.userAddedPatterns, this.trackedPatterns).map(globOf);
  }

  /**
   * Load policy: defaults + .coherence/tracked.yaml opt-in +
   * .coherence/ignored.yaml opt-out + .coherence/strict_mode.yaml
   * strict opt-in (zero-Python Unit 6; mirrors Python policy.py). Names, once
   * at spawn, any ignored pattern that strict overrides (#261).
   */
  static load(coordinatorRoot: string): TrackedArtifactPolicy {
    const policy = TrackedArtifactPolicy.read(coordinatorRoot);
    const overridden = policy.ignoredPatternsOverriddenByStrict();
    if (overridden.length > 0) {
      process.stderr.write(
        `agent-coherence: WARNING — ignored pattern(s) ${overridden.join(", ")} cover paths in ` +
          `strict mode; strict wins, so those paths stay tracked and enforced. To stop enforcing ` +
          `a strict path, remove its entry from .coherence/strict_mode.yaml and restart the ` +
          `coordinator.\n`,
      );
    }
    return policy;
  }

  /** Read the policy files, without `load`'s spawn-time diagnostic. */
  private static read(coordinatorRoot: string): TrackedArtifactPolicy {
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
   * Re-read the policy files for a hot reload (`/policy/track`,
   * `/policy/untrack`) without narrowing strict enforcement (#261). Ignored
   * patterns come from disk as they are; they cannot untrack a strict path
   * anyway. While this policy has strict patterns, every strict and user-added
   * pattern it carries is kept even if the file no longer lists it — strict
   * mode needs both — so a hand-edited strict_mode.yaml or tracked.yaml
   * followed by any track or untrack cannot end enforcement mid-run. Additions
   * on disk still apply. Without strict patterns the files are read verbatim.
   */
  reloaded(): TrackedArtifactPolicy {
    const fresh = TrackedArtifactPolicy.read(this.coordinatorRoot);
    if (this.strictModePaths.length === 0) return fresh;
    return new TrackedArtifactPolicy({
      coordinatorRoot: fresh.coordinatorRoot,
      trackedPatterns: fresh.trackedPatterns,
      ignoredPatterns: fresh.ignoredPatterns,
      userAddedPatterns: union(this.userAddedPatterns, fresh.userAddedPatterns),
      strictModePaths: union(this.strictModePaths, fresh.strictModePaths),
      rejectedPatterns: fresh.rejectedPatterns,
    });
  }

  private matchesTracked(normalized: string): boolean {
    return matchesAny(normalized, this.trackedPatterns) || matchesAny(normalized, this.userAddedPatterns);
  }

  private matchesStrict(normalized: string): boolean {
    return matchesAny(normalized, this.strictModePaths);
  }

  /**
   * v0.2 KTD-O (Node port): a path is in strict mode iff it is TRACKED (a
   * default or user-added pattern) and matches at least one strict_mode_paths
   * glob. Intersection semantics — strict never applies to a path no tracked
   * pattern matches. An ignored pattern does not take a path out of strict
   * mode (see `isTracked`). Empty strict_mode_paths short-circuits to false
   * (v0.1.1 warn-only behavior preserved).
   */
  isStrictMode(parentRelativePath: string): boolean {
    if (this.strictModePaths.length === 0) return false;
    const normalized = normalizeRelative(parentRelativePath);
    if (normalized === null) return false;
    return this.matchesTracked(normalized) && this.matchesStrict(normalized);
  }

  /**
   * Return true if the given parent-repo-relative path is coordinated.
   * Algorithm: path is tracked if it matches any default OR user-added
   * pattern, AND does not match any ignored pattern — unless it also matches a
   * strict pattern: strict wins over ignore (#261). An ignore pattern, however
   * broad (`**`) and however it arrived (a leftover ignored.yaml at spawn or
   * `/policy/untrack` at runtime), never drops a strict path onto the
   * untracked fast path, where a read reports version 0 and a CAS commit is
   * accepted at any expected version. For every path no strict pattern
   * matches, ignore wins ties as before.
   */
  isTracked(parentRelativePath: string): boolean {
    const normalized = normalizeRelative(parentRelativePath);
    if (normalized === null) return false;
    if (!this.matchesTracked(normalized)) return false;
    if (!matchesAny(normalized, this.ignoredPatterns)) return true;
    return this.matchesStrict(normalized);
  }

  /**
   * The strict patterns under which `pattern` — a path or a glob, as
   * `/policy/untrack` receives it — matches at least one path this policy
   * puts in strict mode: some path matches `pattern`, a strict pattern and a
   * tracked (default or user-added) pattern at once.
   *
   * Decided on the glob languages themselves, so an entry spelled differently
   * from the strict pattern is still caught: `data/**` and `**` both cover a
   * strict `data/*.json`. A literal strict path is decided exactly by matching
   * it. A strict glob is decided by a product search (`globsIntersect`) on its
   * own budget of `globIntersectBudgets.pattern` steps, drawn from one
   * `globIntersectBudgets.call` for the entry. Running out errs toward
   * "covers" (a refusal, never a silent untrack): a strict glob whose own
   * budget runs out counts as covered, and once the entry's budget runs out so
   * does every strict pattern not yet decided and not ruled out by literal
   * prefixes and suffixes. Empty when no strict path is covered.
   */
  strictPatternsCovering(pattern: string): string[] {
    return this.strictPatternsCoveringEach([pattern])[0]!;
  }

  /**
   * `strictPatternsCovering` for each of `patterns`, in order: one
   * `/policy/untrack` request, decided under one `globIntersectBudgets.request`
   * so its cost is bounded however many entries it carries. Each entry still
   * has its own `globIntersectBudgets.call`. Once the request's budget runs
   * out, every later entry counts as covering each strict pattern its literal
   * ends do not rule out, so a request of costly entries is refused rather
   * than held past the client's timeout.
   */
  strictPatternsCoveringEach(patterns: ReadonlyArray<string>): string[][] {
    const requestBudget = new SearchBudget(globIntersectBudgets.request);
    return patterns.map((p) =>
      this.strictPatternsCoveringWithin(p, new SearchBudget(globIntersectBudgets.call, requestBudget)),
    );
  }

  /**
   * Ignored patterns that cover a strict path, which strict therefore
   * overrides (`isTracked`). Reported once at `load` (spawn), not on hot
   * reloads. Every entry is decided under one `globIntersectBudgets.diagnostic`,
   * so a large or pathological ignored.yaml cannot hold up the spawn, and an
   * entry stops at the first strict pattern it covers. Once the budget runs
   * out, the remaining entries a strict pattern might cover are reported,
   * erring toward the warning.
   */
  ignoredPatternsOverriddenByStrict(): string[] {
    if (this.coverageStrict.length === 0) return [];
    const total = new SearchBudget(globIntersectBudgets.diagnostic);
    return this.ignoredPatterns.filter((p) => {
      const entry = entryGlob(p);
      return this.coverageStrict.some((strict) => this.entryCoversStrict(entry, strict, total));
    });
  }

  private strictPatternsCoveringWithin(pattern: string, callBudget: SearchBudget): string[] {
    if (this.coverageStrict.length === 0) return [];
    const entry = entryGlob(pattern);
    return this.coverageStrict
      .filter((strict) => this.entryCoversStrict(entry, strict, callBudget))
      .map((strict) => strict.pattern);
  }

  /** Whether `entry` covers a path `strict` puts in strict mode; out of budget counts as covers. */
  private entryCoversStrict(entry: Glob, strict: Glob, callBudget: SearchBudget): boolean {
    // A path both match carries both literal prefixes and suffixes; if they
    // do not nest, the strict pattern is exactly not covered, at no cost.
    if (!affixesNest([entry.affixes, strict.affixes])) return false;
    try {
      // A literal strict path's language is the one path (tracked: the index
      // keeps no other), so matching it decides it exactly.
      return strict.isLiteral
        ? tokensMatch(entry.tokens, strict.pattern, callBudget)
        : this.strictGlobCovered(entry, strict, callBudget);
    } catch (err) {
      if (err instanceof BudgetExhausted) return true;
      throw err;
    }
  }

  private strictGlobCovered(entry: Glob, strict: Glob, callBudget: SearchBudget): boolean {
    // Only a tracked pattern whose literal ends nest with the entry's and the
    // strict glob's can share a path with both; with none, the strict glob is
    // exactly not covered, at no search cost.
    const tracked = this.coverageTracked.filter((t) =>
      affixesNest([entry.affixes, strict.affixes, t.affixes]),
    );
    if (tracked.length === 0) return false;
    // A budget per strict glob, so one costly pattern (or many cheap ones)
    // never decides the others: a shared budget marks every pattern after the
    // point it ran out as covering.
    const budget = new SearchBudget(globIntersectBudgets.pattern, callBudget);
    return (
      globsIntersect([entry.tokens, strict.tokens], budget) &&
      tracked.some((t) => globsIntersect([entry.tokens, strict.tokens, t.tokens], budget))
    );
  }

  summary(): PolicySummary {
    return {
      coordinator_root: this.coordinatorRoot,
      default_pattern_count: this.trackedPatterns.length,
      user_added_pattern_count: this.userAddedPatterns.length,
      ignored_pattern_count: this.ignoredPatterns.length,
      strict_mode_pattern_count: this.strictModePaths.length,
      rejected_pattern_count: this.rejectedPatterns.length,
    };
  }
}

/**
 * Mutable policy holder — the seam that makes /policy/track + /policy/untrack
 * live-reloadable (plan Unit 1, "the load-bearing decision for G3").
 *
 * `createServer` captures its deps once by reference; Python re-assigns
 * `coordinator.policy = coordinator.policy.reloaded()` after every YAML
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

  /**
   * Re-parse the YAML files and swap the snapshot (Python's
   * `coordinator.policy = coordinator.policy.reloaded()`): a reload never
   * narrows strict enforcement (`TrackedArtifactPolicy.reloaded`).
   */
  reload(): void {
    this.current = this.current.reloaded();
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

  const { valid: candidate, rejected } = partitionPolicyPaths(newPaths);
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
  const newContent = existing !== "" ? trimTrailingNewlines(existing) + "\n" + newLines : newLines;
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

  // A random name, created exclusively: a fixed `<file>.tmp` written with a
  // plain write follows a symlink planted at that path, so a repository could
  // commit one and have the next track overwrite its target. Same pattern as
  // storeCallerPrincipal.
  const tmpPath = `${yamlPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmpPath, newContent, { encoding: "utf8", flag: "wx" });
    renameSync(tmpPath, yamlPath);
  } finally {
    rmSync(tmpPath, { force: true });
  }
  return { added: trulyNew, rejected };
}

const REWRITE_HINT =
  'Rewrite it with one entry per line, each a double-quoted string such as - "*.md", then retry.';

/**
 * `text` without its trailing "\n" run. A `/\n+$/` replace backtracks over every
 * run of newlines in the text, quadratic in the longest run: a few tens of
 * thousands of blank lines inside a list blocked the coordinator's only event
 * loop for seconds on every track and untrack.
 */
function trimTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x0a) end--;
  return text.slice(0, end);
}

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
 * Characters a refusal must never print raw: controls (Cc), format characters
 * (Cf: zero-width, bidi marks, embeddings and isolates, the Arabic letter mark,
 * soft hyphen, BOM, tags), and line/paragraph separators. By category rather
 * than by list, so a format character nobody listed is still caught; the tag
 * block is named because its unassigned code points are Cn, not Cf.
 */
const HIDDEN_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{E0000}-\u{E007F}]/u;

/**
 * Both CLIs print the refusal to a terminal, and the parser's reason quotes
 * file content that could make the printed line read differently from what it
 * is. Iterates by code point: a tag character is two UTF-16 units.
 */
function escapeControlChars(text: string): string {
  let out = "";
  for (const c of text) {
    out += HIDDEN_CHAR.test(c) ? escapeCodePoint(c.codePointAt(0)!) : c;
  }
  return out;
}

/** `\uXXXX`, or `\u{...}` for a code point outside the BMP. */
function escapeCodePoint(code: number): string {
  return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
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
 */
// Per-process cache of compiled glob patterns. Hot path: every hook on
// every tracked-artifact lookup compiles `**` once per session otherwise.
// ce-review safe_auto fix: pure memoization, no semantic change.
const compiledGlobs: Map<string, (path: string) => boolean> = new Map();

export function globMatch(path: string, pattern: string): boolean {
  let matcher = compiledGlobs.get(pattern);
  if (matcher === undefined) {
    matcher = compileGlob(pattern);
    compiledGlobs.set(pattern, matcher);
  }
  return matcher(path);
}

/**
 * Runs (`*` or `**`) a pattern may hold and still be matched by its regex. The
 * regex backtracks into every run, so a failing match costs up to the path's
 * length to the power of its runs: `"**".repeat(12) + "Z"` took 5.9 s on a
 * 21-character path, and two runs (`**a**Z`) took about 2 s on a
 * 50,000-character one, which a hook path may be. Every hook matches every
 * pattern on the coordinator's one thread. A pattern over the limit is
 * matched by `tokensMatch`, linear in the path; one run, anchored at both
 * ends, is linear in the regex too.
 */
const REGEX_RUN_LIMIT = 1;

function compileGlob(pattern: string): (path: string) => boolean {
  const tokens = globTokens(pattern);
  if (tokens.filter(isRun).length > REGEX_RUN_LIMIT) {
    return (path) => tokensMatch(tokens, path);
  }
  const regex = globRegex(pattern);
  return (path) => regex.test(path);
}

/** The backtracking regex a pattern compiles to (exported for the differential test). */
export function globRegex(pattern: string): RegExp {
  return new RegExp("^" + patternToRegex(pattern) + "$");
}

// ----------------------------------------------------------------------
// Glob tokens and their automaton
//
// The tokens spell exactly the language `patternToRegex` compiles a pattern
// to: `**` is any run (a following `/` swallowed), `*` a run without `/`, `?`
// one character but `/`, and every other character a literal, `[` included.
// The regex has no flags, so its `.` stops at a line terminator, its `$`
// matches only at the end, and it reads UTF-16 code units, as the automaton
// does. Both the linear matcher and the strict-coverage search read them; a
// differential test against the regex pins the mirror.
// ----------------------------------------------------------------------

type Token =
  | { readonly kind: "any_run" }
  | { readonly kind: "seg_run" }
  | { readonly kind: "seg_one" }
  | { readonly kind: "lit"; readonly ch: string };

const ANY_RUN: Token = { kind: "any_run" };
const SEG_RUN: Token = { kind: "seg_run" };
const SEG_ONE: Token = { kind: "seg_one" };

/** What a regex `.` without the `s` flag does not match. */
const LINE_TERMINATORS: ReadonlySet<string> = new Set(["\n", "\r", "\u2028", "\u2029"]);

export function globTokens(pattern: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      tokens.push(ANY_RUN);
      i += 2;
      if (pattern[i] === "/") i += 1;
    } else if (c === "*") {
      tokens.push(SEG_RUN);
      i += 1;
    } else if (c === "?") {
      tokens.push(SEG_ONE);
      i += 1;
    } else {
      tokens.push({ kind: "lit", ch: c });
      i += 1;
    }
  }
  return tokens;
}

function isRun(token: Token): boolean {
  return token.kind === "any_run" || token.kind === "seg_run";
}

/**
 * Whether `token` consumes `ch`; `null` stands for every character no pattern
 * names (not `/`, not a line terminator).
 */
function tokenAccepts(token: Token, ch: string | null): boolean {
  switch (token.kind) {
    case "any_run":
      return ch === null || !LINE_TERMINATORS.has(ch);
    case "seg_run":
    case "seg_one":
      return ch !== "/";
    case "lit":
      return ch === token.ch;
  }
}

/**
 * Append `state` and every state a run token can skip to from it, keeping
 * `out` ascending and duplicate-free. States arrive in ascending order and a
 * run only skips to the next state, so the closure of each is a contiguous
 * run of states: one already reached adds nothing new.
 *
 * The work is proportional to the states produced, never to the pattern's
 * length: the search charges each step at the states it carries, and a step
 * that scanned every token let long patterns hold the coordinator's one
 * thread for seconds within the same budget.
 */
function pushClosed(out: number[], state: number, tokens: ReadonlyArray<Token>): void {
  if (out.length > 0 && state <= out[out.length - 1]!) return;
  let i = state;
  out.push(i);
  while (i < tokens.length && isRun(tokens[i]!)) out.push(++i);
}

/** The automaton's start: state 0 and every state its leading runs skip to. */
function startStates(tokens: ReadonlyArray<Token>): number[] {
  const out: number[] = [];
  pushClosed(out, 0, tokens);
  return out;
}

/** The states after reading `ch` from the ascending `states`, ascending. */
function advance(states: ReadonlyArray<number>, tokens: ReadonlyArray<Token>, ch: string | null): number[] {
  const out: number[] = [];
  for (const i of states) {
    if (i >= tokens.length || !tokenAccepts(tokens[i]!, ch)) continue;
    pushClosed(out, isRun(tokens[i]!) ? i : i + 1, tokens);
  }
  return out;
}

/**
 * Whether `path` matches `tokens` exactly as their regex does, in time linear
 * in the path: the automaton stepped one code unit at a time, never
 * backtracking. Each step is charged to `budget`, when one is given, at the
 * size of the state it leaves.
 */
export function tokensMatch(tokens: ReadonlyArray<Token>, path: string, budget?: SearchBudget): boolean {
  let states = startStates(tokens);
  for (let i = 0; i < path.length; i++) {
    if (budget !== undefined) charge(budget, 1 + states.length);
    states = advance(states, tokens, path[i]!);
    if (states.length === 0) return false;
  }
  return states.includes(tokens.length);
}

// ----------------------------------------------------------------------
// Bounded overlap search (strict coverage, #261)
// ----------------------------------------------------------------------

/**
 * Search steps the strict-coverage decisions may take. A step is one
 * automaton state carried across one character, so the cost is bounded
 * whatever the patterns' alphabet. Mutable so tests can lower them.
 *
 * - `pattern`: one strict glob, before it counts as covered.
 * - `call`: one untrack entry, across every strict pattern.
 * - `request`: one `/policy/untrack` request, across its entries.
 * - `diagnostic`: the spawn-time override warning, across every ignored entry.
 *
 * The values are the Python coordinator's (`policy.py`).
 */
export const globIntersectBudgets = {
  pattern: 200_000,
  call: 2_000_000,
  request: 4_000_000,
  diagnostic: 2_000_000,
};

/** A bounded glob search ran out of steps; every caller counts it as "covers". */
export class BudgetExhausted extends Error {
  constructor() {
    super("glob search budget exhausted");
  }
}

/** Search steps left, drawn from `parent` too when one is given. */
export class SearchBudget {
  remaining: number;
  private readonly parent: SearchBudget | undefined;

  constructor(steps: number, parent?: SearchBudget) {
    this.remaining = steps;
    this.parent = parent;
  }

  spend(steps: number): void {
    this.remaining -= steps;
    if (this.remaining < 0) throw new BudgetExhausted();
    this.parent?.spend(steps);
  }
}

let automatonSteps = 0;

/** Steps every charged search and match has taken in this process (for tests). */
export function automatonStepsTaken(): number {
  return automatonSteps;
}

function charge(budget: SearchBudget, steps: number): void {
  automatonSteps += steps;
  budget.spend(steps);
}

/** A pattern with what the strict-coverage check reads from it. */
interface Glob {
  readonly pattern: string;
  readonly tokens: ReadonlyArray<Token>;
  readonly affixes: readonly [string, string];
  /** True when the pattern matches exactly one path, itself. */
  readonly isLiteral: boolean;
}

function globOf(pattern: string): Glob {
  const tokens = globTokens(pattern);
  return {
    pattern,
    tokens,
    affixes: literalAffixes(tokens),
    isLiteral: tokens.every((t) => t.kind === "lit"),
  };
}

/**
 * An untrack entry as a glob. Paths are matched with a leading "./" stripped
 * (`normalizeRelative`), so an entry spelled that way names the same paths.
 */
function entryGlob(pattern: string): Glob {
  return globOf(normalizeRelative(pattern) ?? pattern);
}

function literalRun(tokens: Iterable<Token>): string {
  let run = "";
  for (const token of tokens) {
    if (token.kind !== "lit") break;
    run += token.ch;
  }
  return run;
}

/** The literal prefix and suffix every path matching `tokens` carries. */
function literalAffixes(tokens: ReadonlyArray<Token>): readonly [string, string] {
  const reversedSuffix = literalRun([...tokens].reverse());
  return [literalRun(tokens), reversedSuffix.split("").reverse().join("")];
}

/**
 * False when no path can carry every literal prefix and suffix: the prefixes
 * must each start the longest one, the suffixes each end theirs. Exact as a
 * necessary condition, so it rules a search out, never in.
 */
function affixesNest(affixes: ReadonlyArray<readonly [string, string]>): boolean {
  const longest = (i: 0 | 1) => affixes.reduce((a, b) => (b[i].length > a.length ? b[i] : a), "");
  const prefix = longest(0);
  const suffix = longest(1);
  return affixes.every(([p, s]) => prefix.startsWith(p) && suffix.endsWith(s));
}

/**
 * True when some non-empty path matches every pattern `tokenLists` spells
 * (`globTokens`) under `globMatch`.
 *
 * A product of the patterns' automata searched over an alphabet of every
 * character the patterns name, `/`, and one stand-in for every other
 * character (exact: that stand-in is accepted wherever any unnamed character
 * is). Each transition is charged to `budget` at the size of the state it
 * leaves; running out throws `BudgetExhausted`, which every caller counts as
 * "intersects".
 */
export function globsIntersect(tokenLists: ReadonlyArray<ReadonlyArray<Token>>, budget: SearchBudget): boolean {
  // Most pairs an untrack check meets (`.log` against `.json`, `svc3/` against
  // `svc7/`) fail on their literal ends: settled without a search.
  if (!affixesNest(tokenLists.map(literalAffixes))) return false;
  const alphabet = searchAlphabet(tokenLists);
  const key =(state: ReadonlyArray<ReadonlyArray<number>>) => state.map((s) => s.join(",")).join("|");
  const start = tokenLists.map(startStates);
  const seen = new Set([key(start)]);
  const frontier = [start];
  while (frontier.length > 0) {
    const state = frontier.pop()!;
    const step = 1 + state.reduce((n, s) => n + s.length, 0);
    for (const ch of alphabet) {
      charge(budget, step);
      const next = state.map((s, i) => advance(s, tokenLists[i]!, ch));
      if (!next.every((s) => s.length > 0)) continue;
      if (next.every((s, i) => s.includes(tokenLists[i]!.length))) return true;
      const k = key(next);
      if (!seen.has(k)) {
        seen.add(k);
        frontier.push(next);
      }
    }
  }
  return false;
}

/**
 * Every character the patterns name, `/`, and `null` for every other
 * character. Sorted, so the bounded search explores in the same order on every
 * run and the same entry is never refused on one coordinator and accepted on
 * the next.
 */
function searchAlphabet(tokenLists: ReadonlyArray<ReadonlyArray<Token>>): Array<string | null> {
  const named = new Set<string>(["/"]);
  for (const tokens of tokenLists) {
    for (const token of tokens) {
      if (token.kind === "lit") named.add(token.ch);
    }
  }
  return [...[...named].sort(), null];
}

/** Order-preserving union: `first`, then what `second` adds. */
function union(first: ReadonlyArray<string>, second: ReadonlyArray<string>): string[] {
  return [...new Set([...first, ...second])];
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
 */
function loadYamlPatterns(yamlPath: string, rejected: RejectedPattern[]): string[] {
  const surviving: string[] = [];
  for (const item of loadYamlList(yamlPath, rejected)) {
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

/**
 * The top-level list of a policy file, or [] when the file loads as no entries.
 *
 * Missing, empty or null file → []. An unreadable file, malformed YAML or a
 * non-list top level → [] + logged WARNING + one rejected entry for the whole
 * file, under the name and reason the Python coordinator records (#192): the
 * warning reaches only the coordinator's log, and the rejected count on
 * /status is what tells an emptied file apart from no user patterns.
 */
function loadYamlList(yamlPath: string, rejected: RejectedPattern[]): unknown[] {
  let stat;
  try {
    stat = statSync(yamlPath);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];

  const name = policyFileName(yamlPath);
  let text: string;
  try {
    text = readFileSync(yamlPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `agent-coherence: WARNING — could not read ${yamlPath}; it loads as no entries: ${String(err)}\n`,
    );
    rejected.push({ pattern: name, reason: "could not be read, so the file loads as no entries" });
    return [];
  }

  let raw: unknown;
  try {
    raw = yamlLoad(text);
  } catch (err) {
    process.stderr.write(
      `agent-coherence: WARNING — malformed YAML at ${yamlPath}; falling back to defaults: ${String(err)}\n`,
    );
    rejected.push({ pattern: name, reason: "not valid YAML, so the file loads as no entries" });
    return [];
  }

  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    process.stderr.write(
      `agent-coherence: WARNING — ${yamlPath} top-level must be a list of patterns; got ${typeof raw}. Ignoring.\n`,
    );
    rejected.push({
      pattern: name,
      reason: `top level is ${pythonTypeName(raw)}, not a list, so the file loads as no entries`,
    });
    return [];
  }
  return raw;
}

/**
 * The name the Python coordinator's loader gives a top level that is not a
 * list (`type(raw).__name__`). Only the rejected count reaches /status, so
 * where js-yaml types a scalar differently from PyYAML (`4.0` and `1e3` load
 * as integers here, and a timestamp at exactly midnight UTC reads as a date)
 * the name is close rather than exact.
 */
function pythonTypeName(value: unknown): string {
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (value instanceof Date) {
    const midnight =
      value.getUTCHours() === 0 &&
      value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0 &&
      value.getUTCMilliseconds() === 0;
    return midnight ? "date" : "datetime";
  }
  if (ArrayBuffer.isView(value)) return "bytes";
  if (typeof value === "object") return "dict";
  return typeof value;
}

/** Path-traversal guard. Returns null if pattern is acceptable, else a short reason. */
function validatePattern(pattern: string): string | null {
  if (pattern === "") return "empty pattern";
  if (pattern.startsWith("/")) return "absolute path";
  const parts = pattern.replace(/\\/g, "/").split("/");
  if (parts.includes("..")) return "contains '..' (path traversal)";
  return null;
}
