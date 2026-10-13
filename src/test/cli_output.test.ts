/**
 * cli_output: the CLIs' escaping must print exactly what the Python console
 * scripts print for the same coordinator answer. Every expected value below
 * was produced by CPython 3.12 (`str.isprintable` + `repr`), not written by
 * hand. Code points first assigned after Unicode 15.0 are avoided on purpose:
 * Node can ship a newer Unicode than CPython, and those print differently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeNonprintable, httpErrorLine, pyRepr } from "../cli_output.js";

/** [name, input, Python's escape_nonprintable(input)] */
const ESCAPE_GOLDEN: ReadonlyArray<[string, string, string]> = [
  ["esc", "a\u001b[31mRED", "a\\x1b[31mRED"],
  ["lf", "l1\nl2", "l1\\nl2"],
  ["tab", "\t", "\\t"],
  ["cr", "\r", "\\r"],
  ["del", "\u007f", "\\x7f"],
  ["c1", "\u009b", "\\x9b"],
  ["nbsp", "\u00a0", "\\xa0"],
  ["rlo", "\u202e", "\\u202e"],
  ["zwsp", "\u200b", "\\u200b"],
  ["lone", "\ud800", "\\ud800"],
  ["tag", "\udb40\udc01", "\\U000e0001"],
  ["pua", "\ue000", "\\ue000"],
  ["lsep", "\u2028", "\\u2028"],
  ["ideosp", "\u3000", "\\u3000"],
  ["hostile", "a\u001b[31m\r\n\u0000\u009b\u202e\u2066\ud800\u3000z", "a\\x1b[31m\\r\\n\\x00\\x9b\\u202e\\u2066\\ud800\\u3000z"],
  ["accented", "\u00e9/\u00fc.md", "\u00e9/\u00fc.md"],
  ["space", "a b", "a b"],
  ["backslash", "a\\b", "a\\b"],
  ["plain", "plain/path.md", "plain/path.md"],
  ["emoji", "\ud83d\ude00.md", "\ud83d\ude00.md"],
];

/** [input, Python's repr(input)] */
const REPR_GOLDEN: ReadonlyArray<[string, string]> = [
  ["b\u001b[0m", "'b\\x1b[0m'"],
  ["it's", "\"it's\""],
  ["q\"x", "'q\"x'"],
  ["both'\"", "'both\\'\"'"],
  ["a\\b", "'a\\\\b'"],
  ["", "''"],
  ["it's\\x.md", "\"it's\\\\x.md\""],
  ["say \"hi\" it's", "'say \"hi\" it\\'s'"],
  ["\u00e9\u00a0\ud83d\ude00\udb40\udc01\udbff\udfff", "'\u00e9\\xa0\ud83d\ude00\\U000e0001\\U0010ffff'"],
  ["pa\u001b[31m\r\n\u0000\u009b\u202e\u2066\ud800\u3000z", "'pa\\x1b[31m\\r\\n\\x00\\x9b\\u202e\\u2066\\ud800\\u3000z'"],
];

test("escapeNonprintable matches Python's escape_nonprintable", () => {
  for (const [name, input, expected] of ESCAPE_GOLDEN) {
    assert.equal(escapeNonprintable(input), expected, name);
  }
});

test("escapeNonprintable leaves printable text, the ASCII space and backslashes alone", () => {
  for (const text of ["plain/path.md", "a b", "é/ü.md", "a\\b", "😀.md", ""]) {
    assert.equal(escapeNonprintable(text), text);
  }
});

test("escapeNonprintable stringifies a non-string first", () => {
  assert.equal(escapeNonprintable(5), "5");
  assert.equal(escapeNonprintable(null), "null");
});

test("pyRepr matches Python's repr, quote choice included", () => {
  for (const [input, expected] of REPR_GOLDEN) {
    assert.equal(pyRepr(input), expected, JSON.stringify(input));
  }
});

test("no escaped output carries a raw control, bidi or separator character", () => {
  // The property the escaping exists for, checked independently of the
  // golden table: nothing a coordinator sends can reach the terminal raw.
  const raw = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]|[^\P{Zs} ]/u;
  for (const [name, input] of ESCAPE_GOLDEN) {
    assert.doesNotMatch(escapeNonprintable(input), raw, name);
    assert.doesNotMatch(pyRepr(input), raw, name);
  }
});

test("httpErrorLine: an escaped string error, else the status alone", () => {
  assert.equal(httpErrorLine(400, { error: "bad\x1b[31m\nline" }), "HTTP 400: bad\\x1b[31m\\nline");
  assert.equal(httpErrorLine(409, { error: 5 }), "HTTP 409");
  assert.equal(httpErrorLine(500, {}), "HTTP 500");
  assert.equal(httpErrorLine(502, null), "HTTP 502");
  // Text a coordinator already escaped prints as it arrived, not twice.
  assert.equal(httpErrorLine(400, { error: "tab\\x09here" }), "HTTP 400: tab\\x09here");
});
