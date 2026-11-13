/**
 * A strict path stays enforced for the coordinator's lifetime
 * (Cohexa-ai/agent-coherence#261, Node parity in #177).
 *
 * Covers the policy evaluator (strict wins over ignore), the two glob
 * grammars and the matcher's running time on star-heavy patterns, and the
 * overlap decision `/policy/untrack` refuses an entry on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  automatonStepsTaken,
  BudgetExhausted,
  globIntersectBudgets,
  globMatch,
  globRegex,
  globsIntersect,
  globTokens,
  normalizeRelative,
  SearchBudget,
  tokensMatch,
  TrackedArtifactPolicy,
} from "../policy.js";
import { FNMATCH_VECTORS } from "./fnmatch_vectors.js";

function policyWith(files: { tracked?: string[]; ignored?: string[]; strict?: string[] }) {
  const root = mkdtempSync(join(tmpdir(), "policy-strict-"));
  mkdirSync(join(root, ".coherence"), { recursive: true });
  const write = (name: string, entries: string[] | undefined) => {
    if (entries === undefined) return;
    const text = entries.map((e) => `- ${JSON.stringify(e)}`).join("\n") + "\n";
    writeFileSync(join(root, ".coherence", name), text, "utf8");
  };
  write("tracked.yaml", files.tracked);
  write("ignored.yaml", files.ignored);
  write("strict_mode.yaml", files.strict);
  try {
    return TrackedArtifactPolicy.load(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------- strict wins over ignore

test("strict wins over ignore: a strict path named in ignored.yaml stays tracked and strict", () => {
  const policy = policyWith({
    tracked: ["src/special/secret.py"],
    ignored: ["src/special/secret.py"],
    strict: ["src/special/secret.py"],
  });
  assert.equal(policy.isTracked("src/special/secret.py"), true);
  assert.equal(policy.isStrictMode("src/special/secret.py"), true);
});

test("strict wins over ignore: a broader ignore pattern keeps untracking non-strict paths only", () => {
  const policy = policyWith({ tracked: ["data/**"], strict: ["data/**"], ignored: ["**"] });
  assert.equal(policy.isTracked("data/a.txt"), true);
  assert.equal(policy.isStrictMode("data/a.txt"), true);
  assert.equal(policy.isTracked("CLAUDE.md"), false);
  assert.equal(policy.isTracked("docs/plans/x.md"), false);
});

test("ignore still wins for a tracked path no strict pattern holds", () => {
  const policy = policyWith({ strict: ["CLAUDE.md"], ignored: ["docs/plans/**/*.md"] });
  assert.equal(policy.isTracked("docs/plans/x.md"), false);
  assert.equal(policy.isTracked("CLAUDE.md"), true);
});

// ------------------------------------------------------------ matcher running time

test("a `**`-heavy pattern is matched in time linear in the path, not by backtracking", () => {
  // Any bearer holder can track or untrack such an entry, and every hook
  // matches its path against every pattern on the coordinator's one thread:
  // the regex took seconds for this 21-character path, minutes for longer.
  // The short path first: on the backtracking matcher it alone takes seconds,
  // so the bound fails before the long paths, which never finish there.
  const pattern = "**".repeat(12) + "Z";
  let start = performance.now();
  assert.equal(globMatch("a/".repeat(10) + "b", pattern), false);
  assert.ok(performance.now() - start < 250, `${(performance.now() - start).toFixed(0)} ms`);
  start = performance.now();
  assert.equal(globMatch("a/".repeat(500) + "b", pattern), false);
  assert.equal(globMatch("a/".repeat(500) + "bZ", pattern), true);
  assert.ok(performance.now() - start < 250, `${(performance.now() - start).toFixed(0)} ms`);
});

test("a two-run pattern is matched without backtracking on a long hook path", () => {
  // Hook paths carry no length bound below the request cap, and a regex with
  // two runs backtracks quadratically: `**a**Z` held every hook for about two
  // seconds on a 50,000-character path.
  const start = performance.now();
  assert.equal(globMatch("a".repeat(50_000), "**a**Z"), false);
  assert.equal(globMatch("a".repeat(50_000) + "Z", "**a**Z"), true);
  assert.ok(performance.now() - start < 250, `${(performance.now() - start).toFixed(0)} ms`);
});

test("a single-star-heavy pattern is matched without backtracking too", () => {
  const pattern = "*a".repeat(12) + "Z";
  let start = performance.now();
  assert.equal(globMatch("a".repeat(32), pattern), false);
  assert.ok(performance.now() - start < 250, `${(performance.now() - start).toFixed(0)} ms`);
  start = performance.now();
  assert.equal(globMatch("a".repeat(400), pattern), false);
  assert.ok(performance.now() - start < 250, `${(performance.now() - start).toFixed(0)} ms`);
});

test("a pattern without ** whose stars cross '/' is matched without backtracking", () => {
  // A backtracking regex for it took 81 s on a 100-character path.
  const start = performance.now();
  assert.equal(globMatch("a".repeat(10_000), "*a*a*a*a*a*a*b"), false);
  assert.equal(globMatch("a/".repeat(5_000) + "b", "*a*a*a*a*a*a*b"), true);
  assert.ok(performance.now() - start < 250, `${(performance.now() - start).toFixed(0)} ms`);
});

// ------------------------------------------------------- the two grammars (#209)

test("a pattern without ** matches as CPython's fnmatch.fnmatchcase does", () => {
  const disagree = FNMATCH_VECTORS.filter(([pattern, name, expected]) => globMatch(name, pattern) !== expected);
  assert.deepEqual(disagree, []);
});

test("a pattern without ** follows fnmatch: '*' and '?' cross '/', '[...]' is a class; with ** they do not", () => {
  for (const [path, pattern, expected] of [
    ["docs/a/b.md", "docs/*.md", true],
    ["a/b", "a?b", true],
    ["data/5.json", "data/[0-9].json", true],
    ["src/x/y.py", "src/*.py", true],
    ["a/aa", "*a*a*a", true],
    ["data/[ab].json", "data/[ab].json", false],
    ["\u{1F600}.md", "?.md", true],
    // Any ** switches the whole pattern to the ** grammar, as in Python.
    ["x[ab]", "x[**]", true],
    ["docs/a/b.md", "docs/**/*.md", true],
    ["x/a/b.md", "**/x/*.md", false],
  ] as const) {
    assert.equal(globMatch(path, pattern), expected, `${path} ~ ${pattern}`);
  }
});

test("tracked, ignored and strict patterns without ** decide paths as fnmatch reads them", () => {
  const policy = policyWith({ tracked: ["data/**", "notes/*.md"], strict: ["data/[0-9].json"], ignored: ["docs/*.md"] });
  assert.equal(policy.isTracked("notes/a/b.md"), true);
  assert.equal(policy.isStrictMode("data/5.json"), true);
  assert.equal(policy.isStrictMode("data/x.json"), false);
  // docs/plans/x.md is a default tracked path; the ignore crosses '/' to reach it.
  assert.equal(policy.isTracked("docs/plans/x.md"), false);
});

// ------------------------------------------------- strict coverage (untrack)

const intersect = (patterns: string[], budget: SearchBudget) =>
  globsIntersect(patterns.map(globTokens), budget);

const DATA = { tracked: ["data/**"], strict: ["data/*.json"] };

const COVERAGE_CASES: Array<[string, string[]]> = [
  ["data/**", ["data/*.json"]], // the issue's glob untrack
  ["data/a.json", ["data/*.json"]], // a literal strict path
  ["**", ["data/*.json"]], // a broader pattern
  ["./data/a.json", ["data/*.json"]], // a leading ./ is the same path
  ["./data/**", ["data/*.json"]], // ... and the same glob
  ["data/[ab].json", ["data/*.json"]], // a class: data/a.json and data/b.json are strict
  ["*.json", ["data/*.json"]], // without **, '*' crosses '/'
  ["data?a.json", ["data/*.json"]], // and so does '?'
  ["data/[!a-z].json", ["data/*.json"]], // a negated class: data/0.json
  ["data[!a-z]x.json", ["data/*.json"]], // which matches '/' too
  ["data/[0-9]", []], // a class, but no .json
  ["data/[z-a].json", []], // a reversed range: a class of no characters
  ["data/[a.json", ["data/*.json"]], // an unterminated '[' is a literal
  ["data/a.txt", []], // tracked, not strict
  ["data/*.txt", []], // disjoint glob
  ["notes/**", []], // strict-free
];

for (const [entry, covering] of COVERAGE_CASES) {
  test(`strictPatternsCovering(${JSON.stringify(entry)}) decides on the glob languages`, () => {
    assert.deepEqual(policyWith(DATA).strictPatternsCovering(entry), covering);
  });
}

test("a strict glob is covered only through a tracked pattern, and any one is enough", () => {
  // Only the second tracked pattern reaches data/a.json.
  const second = policyWith({ tracked: ["data/x*.json", "data/**"], strict: ["data/*.json"] });
  assert.deepEqual(second.strictPatternsCovering("data/a.json"), ["data/*.json"]);
  // The entry and the strict glob meet (data/c.json), but no tracked path is
  // among them, so nothing they share is strict.
  const none = policyWith({ tracked: ["data/a*.json"], strict: ["data/*"] });
  assert.deepEqual(none.strictPatternsCovering("data/c*.json"), []);
  // Every literal prefix and suffix fits, so only the three-way search shows
  // it: tracked names are one character, the entry's at least two.
  const searched = policyWith({ tracked: ["data/?.json"], strict: ["data/*"] });
  assert.deepEqual(searched.strictPatternsCovering("data/cc*.json"), []);
  assert.deepEqual(searched.strictPatternsCovering("data/c*.json"), ["data/*"]);
});

test("a literal strict path no tracked pattern reaches is not covered", () => {
  const policy = policyWith({ strict: ["scratch/x.tmp"] });
  assert.equal(policy.isStrictMode("scratch/x.tmp"), false);
  assert.deepEqual(policy.strictPatternsCovering("scratch/*"), []);
  assert.deepEqual(policy.strictPatternsCovering("scratch/x.tmp"), []);
});

test("only a literal ./ is stripped from an entry, so a dotfile entry keeps its dot", () => {
  const policy = policyWith({ tracked: [".github/**"], strict: [".github/*.yml"] });
  assert.deepEqual(policy.strictPatternsCovering("./.github/ci.yml"), [".github/*.yml"]);
  assert.deepEqual(policy.strictPatternsCovering("./.github/**"), [".github/*.yml"]);
  assert.deepEqual(policy.strictPatternsCovering("./.env"), []);
});

test("a root-level path is covered by a leading **/ (the slash after ** is swallowed)", () => {
  const policy = policyWith({ strict: ["**/plan.md"] });
  assert.equal(policy.isStrictMode("plan.md"), true);
  assert.deepEqual(policy.strictPatternsCovering("plan.md"), ["**/plan.md"]);
});

test("a strict ** covers an entry only where the entry reaches a tracked path", () => {
  const policy = policyWith({ strict: ["**"] });
  // notes/*.txt reaches no default tracked pattern; notes/** reaches notes/plan.md.
  assert.deepEqual(policy.strictPatternsCovering("notes/*.txt"), []);
  assert.deepEqual(policy.strictPatternsCovering("notes/**"), ["**"]);
  assert.deepEqual(policy.strictPatternsCovering("docs/**"), ["**"]);
});

test("a pattern holding a class is searched as a glob, not matched as a literal path", () => {
  // The Python coordinator's test, made on the text: any '*', '?' or '['.
  for (const [strict, inside, outside] of [
    ["data/[ab].json", "data/a.json", "data/c.json"],
    ["data/a[b].json", "data/ab.json", "data/ac.json"],
  ] as const) {
    const policy = policyWith({ tracked: ["data/**"], strict: [strict] });
    assert.deepEqual(policy.strictPatternsCovering(inside), [strict]);
    assert.deepEqual(policy.strictPatternsCovering(outside), []);
  }
});

test("a class too wide to enumerate is searched as any one character, erring toward a refusal", () => {
  const policy = policyWith({ tracked: ["data/**"], strict: ["data/z*.json"] });
  // [a-y] is enumerated, so it is decided exactly: no 'z'.
  assert.deepEqual(policy.strictPatternsCovering("data/[a-y]*.json"), []);
  // 256 members: read as any one character, as the Python coordinator reads it.
  assert.deepEqual(policy.strictPatternsCovering("data/[Ā-ǿ]*.json"), ["data/z*.json"]);
  // The limit is 64: [0-o] is enumerated, [0-p] is not.
  assert.deepEqual(policy.strictPatternsCovering("data/[0-o]*.json"), []);
  assert.deepEqual(policy.strictPatternsCovering("data/[0-p]*.json"), ["data/z*.json"]);
});

test("a negated class reaches the characters no pattern names", () => {
  // [!/x] accepts neither character the patterns name: only x/a and its kind.
  const policy = policyWith({ tracked: ["x/**"], strict: ["x/*"] });
  assert.deepEqual(policy.strictPatternsCovering("x/[!/x]"), ["x/*"]);
});

test("the overlap search takes the Python coordinator's steps, entry for entry", () => {
  // Steps measured on the Python coordinator (agent-coherence dev) for the same policies.
  const cases: Array<[Parameters<typeof policyWith>[0], Array<[string, boolean, number]>]> = [
    [DATA, [
      ["data/**", true, 974], ["data/a.json", true, 982], ["**", true, 1074], ["*.json", true, 1146],
      ["data/a.txt", false, 0], ["notes/**", false, 0], ["data?a.json", true, 982], ["./data/**", true, 974],
      ["data/[0-9]", false, 460], ["data/[0-8]", false, 437], ["data/[!a-z].json", true, 2831],
      ["*", true, 1074], ["?", false, 60], ["data/*", true, 974],
      ["data/[z-a].json", false, 190], ["data/[a.json", true, 1195],
    ]],
    [{ strict: ["CLAUDE.md"] }, [
      ["*.md", true, 10], ["C?AUDE.md", true, 10], ["[C]LAUDE.md", true, 10], ["**", true, 27], ["*/CLAUDE.md", false, 10],
    ]],
    [{ strict: ["**"] }, [["notes/**", true, 1255], ["docs/**", true, 916], ["*.md", true, 675], ["plan.md", true, 629]]],
    // A literal strict path costs one step per code point, not per UTF-16 unit.
    [{ tracked: ["notes/**"], strict: ["notes/\u{1F600}.md"] }, [["*.md", true, 11], ["notes/?.md", true, 11]]],
    // The search reads a pattern without ** per code point.
    [{ tracked: ["data/**"], strict: ["data/\u{1F600}*"] }, [["data/?", true, 250], ["data/?*", true, 250]]],
    // An unterminated '[' makes a strict pattern a glob, searched rather than matched.
    [{ tracked: ["data/**"], strict: ["data/[x.json"] }, [["data/*", true, 1210], ["*.json", true, 1416]]],
    // The search alphabet is in code-point order: U+E000 before U+1F600.
    [{ tracked: ["**"], strict: ["**"] }, [["[\u{1F600}]*", true, 20], ["*\u{1F600}*", true, 80]]],
    [{ tracked: ["x/**"], strict: ["x/*"] }, [["x/[!/x]", true, 72]]],
  ];
  for (const [files, entries] of cases) {
    const policy = policyWith(files);
    for (const [entry, covers, steps] of entries) {
      const before = automatonStepsTaken();
      const covering = policy.strictPatternsCovering(entry);
      assert.deepEqual([covering.length > 0, automatonStepsTaken() - before], [covers, steps], entry);
    }
  }
});

test("a ** pattern keeps its single stars within a segment in the overlap search too", () => {
  assert.equal(intersect(["**/a*b", "a/b"], new SearchBudget(100_000)), false);
  const policy = policyWith({ tracked: ["src/**"], strict: ["src/a/b/x/?"] });
  assert.deepEqual(policy.strictPatternsCovering("src/*/x/**"), []);
  assert.deepEqual(policy.strictPatternsCovering("src/*/*/x/**"), ["src/a/b/x/?"]);
});

test("the spawn names an ignored pattern strict overrides, once", () => {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => (writes.push(String(chunk)), true)) as typeof process.stderr.write;
  let policy: TrackedArtifactPolicy;
  try {
    policy = policyWith({ tracked: ["data/**"], strict: ["data/*.json"], ignored: ["data/**", "logs/**"] });
  } finally {
    process.stderr.write = original;
  }
  assert.deepEqual(policy.ignoredPatternsOverriddenByStrict(), ["data/**"]);
  assert.equal(writes.filter((w) => w.includes("strict wins")).length, 1);
  assert.match(writes.join(""), /ignored pattern\(s\) data\/\*\* cover paths in strict mode/);
});

// -------------------------------------- the automaton agrees with the matcher

// Every shape both grammars have. With **: runs, a segment run, a segment
// character, the slash swallowed after **, and a run meeting a segment
// boundary. Without: runs and '?' that cross '/', classes plain, negated and
// ranged, and an unterminated '['.
const GRAMMAR = [
  "a", "a.x", "x", "*", "?", "**", "**/a", "a/**", "a/**/b", "**/*", "**/a?", "**/*.x", "a?",
  "a*b", "*.x", "a/*", "*/b", "?/?", "[a]", "a[", "**/a*b", "*x/**", "a*/**", "a?b",
  "[ab]", "[!a]", "[a-b]/x", "a[!x]b", "/x/a",
];
const RUN_HEAVY = ["**/*a*b", "**/**/**/a", "a/**/*/*b*", "**/*a*/*b*", "*/**/*x*"];
const DOUBLE_STAR = GRAMMAR.filter((p) => p.includes("**"));

function paths(alphabet: string, maxLength: number): string[] {
  const out: string[] = [];
  let layer = [""];
  for (let length = 1; length <= maxLength; length++) {
    layer = layer.flatMap((prefix) => [...alphabet].map((c) => prefix + c));
    out.push(...layer);
  }
  return out;
}

test("the linear matcher agrees with the regex on every short path, line terminators included", () => {
  // The regex of a ** pattern: its `.` stops at \n, \r, \u2028 and \u2029,
  // and its `$` matches only at the end; the automaton must do the same.
  const samples = [...paths("ab/x.[", 4), ...paths("a/\n\r\u2028x", 3)];
  const disagree: string[] = [];
  for (const pattern of [...DOUBLE_STAR, ...RUN_HEAVY]) {
    const tokens = globTokens(pattern);
    const regex = globRegex(tokens);
    for (const p of samples) {
      if (tokensMatch(tokens, p) !== regex.test(p)) disagree.push(`${pattern} ~ ${JSON.stringify(p)}`);
    }
  }
  assert.deepEqual(disagree, []);
});

test("globMatch stays exact over the run limit, where it steps the automaton", () => {
  for (const [path, pattern, expected] of [
    ["x/a/b", "**/*a*/*b*", true],
    ["a/x/b", "**/*a*/*b*", false],
    ["x/axb", "**/a*b", true],
    ["a/b", "**/a*b", false],
  ] as const) {
    assert.equal(globMatch(path, pattern), expected, `${path} ~ ${pattern}`);
  }
});

test("the overlap search never under-reports what the matcher matches", () => {
  // Wherever some short path matches every pattern of a pair or triple, the
  // search must say they intersect: an under-report accepts an untrack that
  // covers a strict path. (A class with a reversed range followed by '!' is
  // the one known exception, shared with the Python coordinator; none is here.)
  const samples = paths("ab/x.[", 4);
  const matching = new Map(GRAMMAR.map((g) => [g, new Set(samples.filter((p) => globMatch(p, g)))]));
  const missed: string[] = [];
  for (let i = 0; i < GRAMMAR.length; i++) {
    for (let j = i + 1; j < GRAMMAR.length; j++) {
      const pair = [GRAMMAR[i]!, GRAMMAR[j]!];
      const shared = [...matching.get(pair[0]!)!].filter((p) => matching.get(pair[1]!)!.has(p));
      if (shared.length > 0 && !intersect(pair, new SearchBudget(10_000_000))) missed.push(pair.join(" & "));
      for (let k = j + 1; k < GRAMMAR.length; k++) {
        const triple = [...pair, GRAMMAR[k]!];
        if (shared.some((p) => matching.get(GRAMMAR[k]!)!.has(p)) && !intersect(triple, new SearchBudget(10_000_000))) {
          missed.push(triple.join(" & "));
        }
      }
    }
  }
  assert.deepEqual(missed, []);
});

test("the overlap search never over-reports either: no intersection without a witness path", () => {
  // These patterns meet no approximation (no class over 64 members, no
  // reversed range), so a reported intersection has a witness; over this
  // corpus one of at most five characters always exists.
  const samples = paths("ab/x.[]", 5);
  const matching = new Map(GRAMMAR.map((g) => [g, samples.filter((p) => globMatch(p, g))]));
  const spurious: string[] = [];
  for (let i = 0; i < GRAMMAR.length; i++) {
    for (let j = i + 1; j < GRAMMAR.length; j++) {
      const [a, b] = [GRAMMAR[i]!, GRAMMAR[j]!];
      const witness = matching.get(a)!.some((p) => globMatch(p, b));
      if (!witness && intersect([a, b], new SearchBudget(10_000_000))) spurious.push(`${a} & ${b}`);
    }
  }
  assert.deepEqual(spurious, []);
});

test("the three-way search (entry, strict, tracked) never over-reports either", () => {
  // A spurious three-way intersection refuses an untrack that covers no
  // strict path. Every reported one must have a short witness.
  const samples = paths("ab/x.[]", 5);
  const matching = new Map(GRAMMAR.map((g) => [g, samples.filter((p) => globMatch(p, g))]));
  const spurious: string[] = [];
  for (let i = 0; i < GRAMMAR.length; i++) {
    for (let j = i + 1; j < GRAMMAR.length; j++) {
      for (let k = j + 1; k < GRAMMAR.length; k++) {
        const triple = [GRAMMAR[i]!, GRAMMAR[j]!, GRAMMAR[k]!];
        const witness = matching.get(triple[0]!)!.some((p) => globMatch(p, triple[1]!) && globMatch(p, triple[2]!));
        if (!witness && intersect(triple, new SearchBudget(10_000_000))) spurious.push(triple.join(" & "));
      }
    }
  }
  assert.deepEqual(spurious, []);
});

test("the coverage shortcuts never under-report a strict path the entry matches", () => {
  // strictPatternsCovering skips the search where literal ends rule a strict
  // pattern out, matches a literal strict path instead of searching, and keeps
  // only tracked literal paths. Over (strict, tracked) pairs of the corpus,
  // wherever a short path is strict and matches the entry, the strict pattern
  // must be reported. Paths as the hooks see them: normalized, so `./a` is `a`.
  const samples = [
    ...new Set(paths("ab/.", 4).flatMap((p) => normalizeRelative(p) ?? [])),
  ];
  const missed: string[] = [];
  for (const strict of GRAMMAR) {
    for (const tracked of GRAMMAR) {
      const policy = policyWith({ tracked: [tracked], strict: [strict] });
      const strictPaths = samples.filter((p) => policy.isStrictMode(p));
      if (strictPaths.length === 0) continue;
      for (const entry of GRAMMAR) {
        if (strictPaths.some((p) => globMatch(p, entry)) && !policy.strictPatternsCovering(entry).includes(strict)) {
          missed.push(`entry ${entry}, strict ${strict}, tracked ${tracked}`);
        }
      }
    }
  }
  assert.deepEqual(missed, []);
});

// --------------------------------------------------------------- the budgets

const STAR_HEAVY = "**/" + [..."abcdefgh"].map((c) => `*${c}*`).join("/");

function withBudgets(overrides: Partial<typeof globIntersectBudgets>, run: () => void): void {
  const saved = { ...globIntersectBudgets };
  Object.assign(globIntersectBudgets, overrides);
  try {
    run();
  } finally {
    Object.assign(globIntersectBudgets, saved);
  }
}

test("a search over its budget stops by throwing, which callers count as covers", () => {
  // Disjoint, but only a search shows it: no segment of src/<char> holds an 'a'
  // unless that char is one.
  assert.equal(intersect(["**/*a*", "src/?"], new SearchBudget(1_000_000)), true);
  assert.equal(intersect(["**/*a*", "src/b"], new SearchBudget(1_000_000)), false);
  assert.throws(() => intersect([STAR_HEAVY, "src/**/*.py"], new SearchBudget(50)), BudgetExhausted);
});

test("literal ends rule a search out at no cost", () => {
  const budget = new SearchBudget(0);
  assert.equal(intersect(["**/*.log", "svc3/state/*.json"], budget), false);
  assert.equal(intersect(["svc3/**", "svc7/**"], budget), false);
  assert.equal(budget.remaining, 0);
});

test("a star-heavy untrack entry is decided in a bounded number of steps, and a strict glob out of budget counts as covered", () => {
  const policy = policyWith({ tracked: ["src/**/*.py"], strict: ["docs/**/*.txt", "src/**/*.py"] });
  const before = automatonStepsTaken();
  const covering = policy.strictPatternsCovering(STAR_HEAVY);
  const steps = automatonStepsTaken() - before;
  assert.ok(steps > 0 && steps < globIntersectBudgets.pattern, `${steps} steps`);
  // docs/**/*.txt reaches no tracked path (the docs defaults end in .md).
  assert.deepEqual(covering, ["src/**/*.py"]);

  withBudgets({ pattern: 1 }, () => {
    const searched = automatonStepsTaken();
    assert.deepEqual(policy.strictPatternsCovering(STAR_HEAVY), ["src/**/*.py"]);
    // Out of budget at the first step: only this count tells it from a search
    // that found the shared path.
    assert.ok(automatonStepsTaken() - searched <= steps / 10, `${automatonStepsTaken() - searched} steps`);
  });
});

test("each strict glob is decided on its own budget", () => {
  const entry = STAR_HEAVY + ".log";
  const policy = policyWith({ tracked: ["**/*.log"], strict: ["**/*.log", "notes/?.log"] });
  // Measure what each needs, then give each pattern less than the first needs
  // but enough for the second: only the first may count as covered.
  const first = policyWith({ tracked: ["**/*.log"], strict: ["**/*.log"] });
  let before = automatonStepsTaken();
  first.strictPatternsCovering(entry);
  const firstSteps = automatonStepsTaken() - before;
  const second = policyWith({ tracked: ["**/*.log"], strict: ["notes/?.log"] });
  before = automatonStepsTaken();
  assert.deepEqual(second.strictPatternsCovering(entry), []);
  const secondSteps = automatonStepsTaken() - before;
  assert.ok(secondSteps < firstSteps, `${secondSteps} >= ${firstSteps}`);

  withBudgets({ pattern: secondSteps + 1 }, () => {
    assert.deepEqual(policy.strictPatternsCovering(entry), ["**/*.log"]);
  });
});

test("once an entry's budget runs out, undecided strict patterns count as covered unless literal ends rule them out", () => {
  const entry = STAR_HEAVY + ".log";
  const policy = policyWith({
    tracked: ["**/*.log", "data/**"],
    strict: ["**/*.log", "CLAUDE.md", "notes/a.log", "data/*.json", "src/**/*.log"],
  });
  // Within budget notes/a.log is decided exactly: eight segments cannot reach it.
  assert.equal(policy.strictPatternsCovering(entry).includes("notes/a.log"), false);
  withBudgets({ call: 100 }, () => {
    assert.deepEqual(policy.strictPatternsCovering(entry), ["**/*.log", "notes/a.log", "src/**/*.log"]);
  });
});

test("an untrack request is decided under one budget across its entries", () => {
  const policy = policyWith({ tracked: ["data/**"], strict: ["data/*.json"] });
  const before = automatonStepsTaken();
  assert.deepEqual(policy.strictPatternsCovering("data/?"), []);
  const one = automatonStepsTaken() - before;
  assert.ok(one > 0);
  // Room for the first entry's search, not the second's.
  withBudgets({ request: one + Math.floor(one / 2) }, () => {
    assert.deepEqual(policy.strictPatternsCoveringEach(["data/?", "data/?", "data/*.txt"]), [
      [],
      ["data/*.json"],
      [],
    ]);
  });
});

test("the spawn-time override diagnostic is bounded in total", () => {
  // Each entry ends like the strict glob but needs a letter src/<char>.py does
  // not hold at that place: disjoint, which only a search shows.
  const ignored = [..."abdefghijklmnoqtuvwxz"].map((c) => `**/*${c}*.py`);
  const files = { tracked: ["src/**/*.py"], strict: ["src/0.py"], ignored };
  const before = automatonStepsTaken();
  const policy = policyWith(files);
  const spawnSteps = automatonStepsTaken() - before;
  assert.ok(spawnSteps > 0 && spawnSteps < globIntersectBudgets.diagnostic, `${spawnSteps} steps`);
  assert.deepEqual(policy.ignoredPatternsOverriddenByStrict(), []);
  withBudgets({ diagnostic: Math.floor(spawnSteps / 4) }, () => {
    // Out of budget, the remaining entries are reported, erring toward the warning.
    assert.ok(policy.ignoredPatternsOverriddenByStrict().length > 0);
  });
});

test("a literal strict path is decided by matching it, in steps linear in the path", () => {
  // Searching it as a glob gives the same answer at far more cost; matching
  // the one path its language holds takes a few steps per character.
  const deep = "src/" + "d/".repeat(40) + "x.json";
  const policy = policyWith({ tracked: ["src/**"], strict: [deep] });
  for (const entry of ["src/**/*.json", "src/**/d/*/*.json", "**/*.json"]) {
    const before = automatonStepsTaken();
    assert.deepEqual(policy.strictPatternsCovering(entry), [deep]);
    const steps = automatonStepsTaken() - before;
    assert.ok(steps <= 8 * deep.length, `${entry}: ${steps} steps for a ${deep.length}-character path`);
  }
});

test("an untrack request that spends its whole budget on long patterns still answers well inside the hook timeout", () => {
  // A step is charged at the states it carries, so it must cost about that
  // much: scanning every token of every pattern on each step let maximal
  // entries against maximal tracked patterns hold the coordinator's one
  // thread for seconds, past the 5 s hook timeout on a loaded host.
  const tracked = Array.from({ length: 20 }, (_, i) => "**/" + String.fromCharCode(97 + i).repeat(1017) + "*.md");
  const policy = policyWith({ tracked, strict: ["**/*.md"] });
  const entries = Array.from({ length: 20 }, () => "?".repeat(1018) + "**");
  const before = automatonStepsTaken();
  const start = performance.now();
  const coverage = policy.strictPatternsCoveringEach(entries);
  const ms = performance.now() - start;
  assert.ok(automatonStepsTaken() - before >= globIntersectBudgets.request, "the request spent its whole budget");
  assert.ok(coverage.every((c) => c.length > 0), "every entry is refused");
  assert.ok(ms < 1_000, `${ms.toFixed(0)} ms`);
});

test("an ordinary untrack is decided quickly against a large strict set", () => {
  const strict = Array.from({ length: 45 }, (_, i) => `**/svc${i}/*/*.json`);
  const policy = policyWith({ tracked: ["**/*.json"], strict });
  const start = performance.now();
  assert.deepEqual(policy.strictPatternsCovering("**/old/*/*.json"), []);
  assert.ok(performance.now() - start < 2_000, `${(performance.now() - start).toFixed(0)} ms`);
});
