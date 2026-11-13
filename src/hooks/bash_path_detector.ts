/**
 * Bash-command tracked-path detector — Node port of Python
 * `adapters/claude_code/bash_path_detector.detect_tracked_paths`.
 *
 * KTD-N H4: when the model routes around a Read warning via `bash cat
 * plan.md`, this extracts the tracked paths the command would READ so
 * /hooks/pre-bash can run the stale-vs-fresh check. Deliberate
 * false-negative bias — adversarial obfuscation (command substitution,
 * variable indirection) is OUT of scope, mirroring the Python detector.
 *
 * Algorithm (parity with the Python module):
 * 1. Split the pipeline on `|`, `;`, `&`, `&&`, `||`.
 * 2. Tokenize each segment shell-style (quote-aware); skip leading
 *    `FOO=bar` env assignments; unwrap pass-through wrappers
 *    {eval, command, exec, builtin} up to 4 deep.
 * 3. If the command word is a known reader ({cat, less, more, head, tail,
 *    awk, sed, xargs, grep, rg, ugrep, wc}): each following non-flag
 *    positional arg (skipping `-x`/`--x`; stopping if the arg is itself a
 *    reader command, e.g. `xargs cat`) → `isTracked(arg)` ⇒ yield.
 * 4. Eval bodies (`python|python3 -c "…"`, `perl -e "…"`, `ruby -e "…"`)
 *    → regex-scan for `name.ext` tokens → `isTracked` filter.
 * Dedupe, first-occurrence order: two tokens one `keyOf` key names (two
 * spellings of one file) yield the first tracked one only.
 */

const READER_COMMANDS = new Set([
  "cat", "less", "more", "head", "tail", "awk", "sed", "xargs", "grep", "rg", "ugrep", "wc",
]);
const WRAPPER_COMMANDS = new Set(["eval", "command", "exec", "builtin"]);
const EVAL_INTERPRETERS = new Set(["python", "python3", "perl", "ruby"]);
/** `name.ext`-shaped tokens inside interpreter eval bodies (parity with Python's scan). */
// The leading negative-lookbehind is load-bearing, not cosmetic: it mirrors
// Python's `_PATH_TOKEN_RE` and prevents the engine from re-attempting a match
// at every offset inside a long run of path characters. Without it, a 16 KB
// dot-free command (within MAX_COMMAND_LENGTH) drives near-quadratic
// backtracking that blocks the single-threaded coordinator's event loop for
// every session in the workspace (ReDoS). See security review 2026-07-16.
// (The trailing `-` is literal in both classes — same character set as Python's
// `[A-Za-z0-9_/.\-]`; unescaped here to match the main class + satisfy no-useless-escape.)
const PATHLIKE_RE = /(?<![A-Za-z0-9_/.-])[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Quote-aware tokenizer (shlex-lite): honors '...'/"..." grouping + backslash escapes. */
function shellTokens(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote !== null) {
      if (c === quote) {
        quote = null;
      } else if (c === "\\" && quote === '"' && i + 1 < segment.length) {
        cur += segment[++i]!;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < segment.length) {
      cur += segment[++i]!;
      started = true;
      continue;
    }
    if (c === " " || c === "\t") {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) tokens.push(cur);
  return tokens;
}

/**
 * Extract tracked paths a Bash command would read. `isTracked` is the policy
 * gate (called once per distinct token; the caller never touches SQLite for a
 * fully untracked command). `keyOf` names the file a tracked token reaches:
 * the route registers a token's file and grants it only after the loop, so a
 * second spelling of a file the first just registered would read as stale.
 */
export function detectTrackedPaths(
  command: string,
  isTracked: (path: string) => boolean,
  keyOf: (path: string) => string = (path) => path,
): string[] {
  const found: string[] = [];
  const seenTokens = new Set<string>();
  const seenKeys = new Set<string>();
  const push = (p: string) => {
    if (seenTokens.has(p)) return;
    seenTokens.add(p);
    if (!isTracked(p)) return;
    // Among tracked tokens only: an untracked first spelling hides no later one.
    const key = keyOf(p);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    found.push(p);
  };

  const segments = command.split(/\|\||&&|[|;&]/g);
  for (const segment of segments) {
    let tokens: string[];
    try {
      tokens = shellTokens(segment.trim());
    } catch {
      continue;
    }
    // Skip leading env assignments.
    let i = 0;
    while (i < tokens.length && ENV_ASSIGN_RE.test(tokens[i]!)) i++;
    // Unwrap pass-through wrappers (≤4 deep).
    let depth = 0;
    while (i < tokens.length && WRAPPER_COMMANDS.has(tokens[i]!) && depth < 4) {
      i++;
      depth++;
    }
    if (i >= tokens.length) continue;
    const cmd = tokens[i]!;
    const base = cmd.includes("/") ? cmd.slice(cmd.lastIndexOf("/") + 1) : cmd;

    if (EVAL_INTERPRETERS.has(base)) {
      // python -c "…" / perl -e / ruby -e: scan the eval body for pathlike tokens.
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j] === "-c" || tokens[j] === "-e") {
          const bodyTok = tokens[j + 1];
          if (bodyTok !== undefined) {
            for (const m of bodyTok.match(PATHLIKE_RE) ?? []) push(m);
          }
          break;
        }
      }
      continue;
    }

    if (!READER_COMMANDS.has(base)) continue;

    for (let j = i + 1; j < tokens.length; j++) {
      const arg = tokens[j]!;
      if (arg.startsWith("-")) continue; // flags
      const argBase = arg.includes("/") ? arg.slice(arg.lastIndexOf("/") + 1) : arg;
      if (READER_COMMANDS.has(argBase)) break; // e.g. `xargs cat` — new command context
      push(arg);
    }
  }
  return found;
}
