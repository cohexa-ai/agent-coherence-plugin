/**
 * What the CLIs print from a coordinator answer, made safe for a terminal.
 *
 * A coordinator answer is not trusted text: a path, a reason or an error
 * could carry an escape sequence that drives the terminal, a bidi control
 * that reorders the line, or a newline that forges a second line. The
 * Python console scripts escape every such string (agent-coherence #245,
 * `ccs/cli/_coherence_client.py`), and these are their Node ports, kept
 * byte-identical so the two CLIs print the same line for the same answer.
 *
 * "Printable" is Python's `str.isprintable()`: every character outside the
 * Unicode categories Cc, Cf, Cs, Co, Cn, Zl, Zp and Zs, plus the ASCII space.
 * A non-printable character is written the way Python's `repr` writes it:
 * `\t`, `\n` and `\r` by name, then `\xhh`, `\uhhhh` or `\Uhhhhhhhh` by code
 * point. Node and CPython can ship different Unicode versions, so a code
 * point one of them has not assigned yet (category Cn) can print differently;
 * every assigned character prints the same.
 */

const NONPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function isPrintable(ch: string): boolean {
  return ch === " " || !NONPRINTABLE.test(ch);
}

/** One character as Python's `repr` writes it inside the quotes. */
function escapeChar(ch: string): string {
  if (ch === "\t") return "\\t";
  if (ch === "\n") return "\\n";
  if (ch === "\r") return "\\r";
  const cp = ch.codePointAt(0) ?? 0;
  if (cp <= 0xff) return `\\x${cp.toString(16).padStart(2, "0")}`;
  if (cp <= 0xffff) return `\\u${cp.toString(16).padStart(4, "0")}`;
  return `\\U${cp.toString(16).padStart(8, "0")}`;
}

/**
 * `value` as text safe to print: printable characters unchanged, the rest
 * escaped. A non-string is stringified first. Port of Python
 * `escape_nonprintable`. Iterates by code point, so a lone surrogate is one
 * character and an astral character is never split.
 */
export function escapeNonprintable(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  let result = "";
  for (const ch of text) result += isPrintable(ch) ? ch : escapeChar(ch);
  return result;
}

/**
 * `text` quoted the way Python's `repr` quotes a string: single quotes unless
 * the text holds a single quote and no double quote, with the backslash, the
 * chosen quote and every non-printable character escaped. The CLIs print a
 * path this way where the Python scripts use `!r`, so a path whose bytes look
 * like the rest of the line cannot be mistaken for it.
 */
export function pyRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let result = quote;
  for (const ch of text) {
    if (ch === quote || ch === "\\") result += `\\${ch}`;
    else result += isPrintable(ch) ? ch : escapeChar(ch);
  }
  return result + quote;
}

/**
 * The one line a CLI prints for an HTTP error answer: `HTTP <status>: <error>`
 * when the body's `error` is a string, escaped, else `HTTP <status>`. Port of
 * Python `http_error_line`. Backslash is printable, so an error a coordinator
 * already escaped prints as it arrived, never escaped twice.
 */
export function httpErrorLine(status: number, body: Record<string, unknown> | null): string {
  const error = body?.error;
  return typeof error === "string" ? `HTTP ${status}: ${escapeNonprintable(error)}` : `HTTP ${status}`;
}
