/**
 * Unit 1 — appendPolicyYaml + PolicyRef live-reload (zero-Python plan).
 *
 * Contract mirrors Python `_append_policy_yaml`: validation reasons, dedupe
 * (duplicates excluded from `added`), append-preserving-existing, exact
 * byte-cap message. PolicyRef is the stale-by-reference guard: a reload after
 * an append must be visible through the ref with no restart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  symlinkSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPolicyYaml,
  PolicyRef,
  TrackedArtifactPolicy,
  MAX_POLICY_YAML_BYTES,
} from "../policy.js";

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "policy-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("appendPolicyYaml: fresh file — adds valid paths, rejects traversal/absolute/empty/control/backslash (Python validate_path parity)", () => {
  const { root, cleanup } = makeRoot();
  try {
    const yamlPath = join(root, ".coherence", "tracked.yaml");
    const out = appendPolicyYaml(yamlPath, [
      "notes.md",
      "/etc/passwd",
      "../up.md",
      "",
      "inject\n- /etc/shadow",
      "\\leading-backslash.md",
    ]);
    assert.deepEqual(out.added, ["notes.md"]);
    assert.deepEqual(out.rejected, [
      { path: "/etc/passwd", reason: "path must be relative (no leading /)" },
      { path: "../up.md", reason: "path contains '..' traversal" },
      { path: "", reason: "path is empty" },
      { path: "inject\n- /etc/shadow", reason: "path contains control characters" },
      { path: "\\leading-backslash.md", reason: "path must be relative (no leading \\)" },
    ]);
    // The newline-injection candidate never reaches disk — only the safe path.
    assert.equal(readFileSync(yamlPath, "utf8"), '- "notes.md"\n');
  } finally {
    cleanup();
  }
});

test("appendPolicyYaml: dedupe — a fully-duplicate request returns added: []", () => {
  const { root, cleanup } = makeRoot();
  try {
    const yamlPath = join(root, ".coherence", "tracked.yaml");
    appendPolicyYaml(yamlPath, ["notes.md"]);
    const out = appendPolicyYaml(yamlPath, ["notes.md"]);
    assert.deepEqual(out.added, []);
    assert.equal(readFileSync(yamlPath, "utf8"), '- "notes.md"\n');
  } finally {
    cleanup();
  }
});

test("appendPolicyYaml: appends to existing content without clobbering it", () => {
  const { root, cleanup } = makeRoot();
  try {
    const yamlPath = join(root, ".coherence", "tracked.yaml");
    mkdirSync(join(root, ".coherence"), { recursive: true });
    writeFileSync(yamlPath, "- existing.md\n", "utf8");
    const out = appendPolicyYaml(yamlPath, ["new.md", "existing.md"]);
    assert.deepEqual(out.added, ["new.md"]);
    // The existing line is kept byte-for-byte; only the new entry is written quoted.
    assert.equal(readFileSync(yamlPath, "utf8"), '- existing.md\n- "new.md"\n');
  } finally {
    cleanup();
  }
});

test("appendPolicyYaml: an entry that is YAML syntax round-trips, and so does every entry before it (#178)", () => {
  // As a plain scalar (`- ${p}`) each of these means something to YAML: it
  // stops the whole file parsing (the loader then keeps none of it), parses
  // to a non-string the loader drops, or parses to a different, shorter
  // pattern. All pass validatePolicyPath, so each must read back as exactly
  // the string sent, without disturbing the entry before it.
  const wholeFileLost = [
    "*.log", "!x.md", "[a].md", "{a}.md", "|x.md", "%x.md", "@x.md", "`x.md", "'x.md", '"x.md',
  ];
  const entryDropped = ["&x.md", "#x.md", "a: b.md", "null", "~", "123", "true"];
  const entryChanged = ["docs/x #1.md"];
  for (const p of [...wholeFileLost, ...entryDropped, ...entryChanged]) {
    const { root, cleanup } = makeRoot();
    try {
      const yamlPath = join(root, ".coherence", "tracked.yaml");
      appendPolicyYaml(yamlPath, ["keep.md"]);
      assert.deepEqual(appendPolicyYaml(yamlPath, [p]).added, [p]);
      assert.deepEqual(
        TrackedArtifactPolicy.load(root).userAddedPatterns,
        ["keep.md", p],
        `entry ${JSON.stringify(p)}`,
      );
    } finally {
      cleanup();
    }
  }
});

test("appendPolicyYaml: escapes NEL, which the Python coordinator's YAML reader folds to a space", () => {
  // Both backends read these files. PyYAML (YAML 1.1) treats a raw U+0085
  // inside a double-quoted scalar as a line break and folds it to a space,
  // so `a<NEL>b.md` comes back as `a b.md`; js-yaml keeps it. NEL is a C1
  // control, which validatePolicyPath does not reject, so it reaches the
  // writer and must be written as the `\N` escape.
  const { root, cleanup } = makeRoot();
  try {
    const yamlPath = join(root, ".coherence", "tracked.yaml");
    appendPolicyYaml(yamlPath, ["a\u0085b.md"]);
    assert.equal(readFileSync(yamlPath, "utf8"), '- "a\\Nb.md"\n');
    assert.deepEqual(TrackedArtifactPolicy.load(root).userAddedPatterns, ["a\u0085b.md"]);
  } finally {
    cleanup();
  }
});

/** Write `content` to a fresh tracked.yaml; return its path. */
function seedTracked(root: string, content: string): string {
  mkdirSync(join(root, ".coherence"), { recursive: true });
  const yamlPath = join(root, ".coherence", "tracked.yaml");
  writeFileSync(yamlPath, content, "utf8");
  return yamlPath;
}

test("appendPolicyYaml: refuses a file that loads as no entries, and leaves it as it was", () => {
  // Appending can never make such a file load: the loader still reads it as
  // nothing, so the new entry never applies. Answering success would be false.
  for (const [content, expected] of [
    ["- keep.md\n- *.log\n", /\.coherence\/tracked\.yaml is not valid YAML.*near line 2/s],
    ["mode: strict\n", /\.coherence\/tracked\.yaml holds a mapping, not a list/],
    ["2026-10-07\n", /holds a date, not a list/],
    ['- "a.md"\n---\n- "b.md"\n', /more than one YAML document; remove the extra --- separators/],
  ] as const) {
    const { root, cleanup } = makeRoot();
    try {
      const yamlPath = seedTracked(root, content);
      assert.throws(() => appendPolicyYaml(yamlPath, ["new.md"]), expected);
      assert.equal(readFileSync(yamlPath, "utf8"), content, `rewritten: ${JSON.stringify(content)}`);
    } finally {
      cleanup();
    }
  }
});

test("appendPolicyYaml: refuses a valid list whose layout an appended line would break", () => {
  // Each of these loads entries today. A block line after a flow list, an
  // empty `[]`, an indented list or a `...` end marker stops the file parsing,
  // so the write would erase entries that were working. Nothing is written.
  // The last one parses after an append but changes an entry: the trailing
  // newlines a keep-chomped block scalar holds are trimmed, so only the
  // entry-by-entry comparison catches it.
  for (const content of ['["a.md", "*.md"]\n', "[]\n", '  - "a.md"\n', '- "a.md"\n...\n', "~\n", "- |+\n  a\n\n"]) {
    const { root, cleanup } = makeRoot();
    try {
      const yamlPath = seedTracked(root, content);
      const before = TrackedArtifactPolicy.load(root).userAddedPatterns;
      assert.throws(
        () => appendPolicyYaml(yamlPath, ["new.md"]),
        /cannot take a new line without breaking/,
        `layout ${JSON.stringify(content)}`,
      );
      assert.equal(readFileSync(yamlPath, "utf8"), content);
      assert.deepEqual(TrackedArtifactPolicy.load(root).userAddedPatterns, before);
    } finally {
      cleanup();
    }
  }
});

test("appendPolicyYaml: an entry already in a flow-style list is still a no-op success", () => {
  const { root, cleanup } = makeRoot();
  try {
    const yamlPath = seedTracked(root, '["a.md"]\n');
    assert.deepEqual(appendPolicyYaml(yamlPath, ["a.md"]).added, []);
  } finally {
    cleanup();
  }
});

test("appendPolicyYaml: appends to an empty, comment-only or CRLF file, with any number of trailing newlines", () => {
  for (const [content, already] of [
    ["", []],
    ["# tracked by hand\n", []],
    ['- "a.md"\r\n', ["a.md"]],
    ['- "a.md"', ["a.md"]],
    ['- "a.md"\n\n\n', ["a.md"]],
    ['- "a.md"\n' + "\n".repeat(60_000) + '- "b.md"\n', ["a.md", "b.md"]],
  ] as const) {
    const { root, cleanup } = makeRoot();
    try {
      const yamlPath = seedTracked(root, content);
      assert.deepEqual(appendPolicyYaml(yamlPath, ["new.md"]).added, ["new.md"]);
      assert.deepEqual(TrackedArtifactPolicy.load(root).userAddedPatterns, [...already, "new.md"]);
    } finally {
      cleanup();
    }
  }
});

test("appendPolicyYaml: appends to a file in the layout the Python library writes", () => {
  // Bytes from PyYAML's `safe_dump(sorted(entries), default_flow_style=False)`,
  // the call CoherentVolume._merge_yaml_list uses on the same files: single
  // quotes, `\N` and `\xE9` escapes, a long plain scalar. A load-back check
  // that mishandled them would refuse every track in such a workspace.
  const { root, cleanup } = makeRoot();
  try {
    const pythonWritten =
      "- '**/*.md'\n- '*.log'\n- '123'\n- \"a\\Nb.md\"\n- \"caf\\xE9.md\"\n" +
      `- deep/${"n".repeat(90)}.md\n- 'docs/x #1.md'\n- 'null'\n- 'yes'\n`;
    const yamlPath = seedTracked(root, pythonWritten);
    const entries = ["**/*.md", "*.log", "123", "a\u0085b.md", "café.md", `deep/${"n".repeat(90)}.md`, "docs/x #1.md", "null", "yes"];
    assert.deepEqual(TrackedArtifactPolicy.load(root).userAddedPatterns, entries);
    assert.deepEqual(appendPolicyYaml(yamlPath, ["new.md"]).added, ["new.md"]);
    assert.deepEqual(TrackedArtifactPolicy.load(root).userAddedPatterns, [...entries, "new.md"]);
  } finally {
    cleanup();
  }
});

test("appendPolicyYaml: a policy file it cannot read is refused, not replaced", () => {
  // Treating a read error as an empty file would rename a one-entry file over
  // every pattern the user had.
  const { root, cleanup } = makeRoot();
  try {
    const dirPath = join(root, ".coherence", "tracked.yaml");
    mkdirSync(dirPath, { recursive: true });
    assert.throws(() => appendPolicyYaml(dirPath, ["new.md"]), /could not be read \(EISDIR\)/);

    if (process.getuid?.() !== 0) {
      const yamlPath = join(root, ".coherence", "ignored.yaml");
      writeFileSync(yamlPath, '- "keep.md"\n', "utf8");
      chmodSync(yamlPath, 0o000);
      try {
        assert.throws(() => appendPolicyYaml(yamlPath, ["new.md"]), /could not be read \(EACCES\)/);
      } finally {
        chmodSync(yamlPath, 0o600);
      }
      assert.equal(readFileSync(yamlPath, "utf8"), '- "keep.md"\n');
    }
  } finally {
    cleanup();
  }
});

test("appendPolicyYaml: the refusal escapes every class of invisible character it can quote", () => {
  // One representative per escaped class. Each reaches js-yaml's reason raw
  // (`unidentified alias "a<ch>b"`), so each must come back escaped.
  const cases: Array<[string, string]> = [
    ["\u007f", "\\u007f"], // DEL
    ["\u009b", "\\u009b"], // C1 (CSI)
    ["؜", "\\u061c"], // Arabic letter mark
    ["​", "\\u200b"], // zero-width space
    ["⁩", "\\u2069"], // pop directional isolate
    ["﻿", "\\ufeff"], // BOM / zero-width no-break space
    ["\u{E0041}", "\\u{e0041}"], // tag character, outside the BMP
  ];
  for (const [ch, escaped] of cases) {
    const { root, cleanup } = makeRoot();
    try {
      const yamlPath = seedTracked(root, `- *a${ch}b\n`);
      assert.throws(
        () => appendPolicyYaml(yamlPath, ["new.md"]),
        (err: Error) => err.message.includes(`a${escaped}b`) && !err.message.includes(ch),
        `U+${ch.codePointAt(0)!.toString(16)}`,
      );
    } finally {
      cleanup();
    }
  }
});

test("appendPolicyYaml: a planted <file>.tmp symlink cannot redirect the write", () => {
  // A fixed `<file>.tmp` written with a plain write follows a symlink at that
  // path, so a repository could commit `.coherence/tracked.yaml.tmp` pointing
  // anywhere and have the next track or untrack overwrite the target.
  const { root, cleanup } = makeRoot();
  try {
    const yamlPath = seedTracked(root, '- "keep.md"\n');
    const victim = join(root, "victim.txt");
    writeFileSync(victim, "untouched\n", "utf8");
    symlinkSync(victim, `${yamlPath}.tmp`);

    assert.deepEqual(appendPolicyYaml(yamlPath, ["new.md"]).added, ["new.md"]);
    assert.equal(readFileSync(victim, "utf8"), "untouched\n");
    assert.equal(lstatSync(yamlPath).isSymbolicLink(), false);
    assert.deepEqual(TrackedArtifactPolicy.load(root).userAddedPatterns, ["keep.md", "new.md"]);
    // No temporary file of the writer's own is left behind.
    assert.deepEqual(readdirSync(join(root, ".coherence")).sort(), ["tracked.yaml", "tracked.yaml.tmp"]);
  } finally {
    cleanup();
  }
});

test("appendPolicyYaml: the refusal never echoes control characters from the file", () => {
  // The message reaches a terminal through both CLIs, and the parser's reason
  // quotes file content.
  const { root, cleanup } = makeRoot();
  try {
    const yamlPath = seedTracked(root, "- *a\u0085\u001b[31mb\n");
    assert.throws(
      () => appendPolicyYaml(yamlPath, ["new.md"]),
      (err: Error) =>
        /not valid YAML/.test(err.message) &&
        ![...err.message].some((c) => c.charCodeAt(0) < 0x20 || (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f)),
    );
    // A right-to-left override or line separator can make the printed line
    // read differently from what it says.
    writeFileSync(yamlPath, "- *a\u202eb\u2028c\n", "utf8");
    assert.throws(
      () => appendPolicyYaml(yamlPath, ["new.md"]),
      (err: Error) => /a\\u202eb\\u2028c/.test(err.message) && !/[\u202e\u2028]/.test(err.message),
    );
  } finally {
    cleanup();
  }
});

test("appendPolicyYaml: byte cap → throws Python's exact message", () => {
  const { root, cleanup } = makeRoot();
  try {
    const yamlPath = join(root, ".coherence", "tracked.yaml");
    // Each path stays under the per-path 1024-char limit (else it's rejected
    // pre-cap now); the CAP fires on the accumulated YAML size. ~200 × ~520B
    // comfortably exceeds MAX_POLICY_YAML_BYTES (64 KiB).
    const many = Array.from({ length: 200 }, (_, i) => `d/${String(i).padStart(3, "0")}-${"a".repeat(500)}.md`);
    assert.throws(
      () => appendPolicyYaml(yamlPath, many),
      new RegExp(`policy YAML cap of ${MAX_POLICY_YAML_BYTES} bytes would be exceeded`),
    );
  } finally {
    cleanup();
  }
});

test("PolicyRef: reload after an append is visible through the ref (no stale-by-reference)", () => {
  const { root, cleanup } = makeRoot();
  try {
    const ref = PolicyRef.load(root);
    assert.equal(ref.isTracked("notes.md"), false);
    appendPolicyYaml(join(root, ".coherence", "tracked.yaml"), ["notes.md"]);
    // Before reload: the old snapshot still answers.
    assert.equal(ref.isTracked("notes.md"), false);
    ref.reload();
    assert.equal(ref.isTracked("notes.md"), true);
    // Untrack via ignored.yaml: ignore wins ties after reload.
    appendPolicyYaml(join(root, ".coherence", "ignored.yaml"), ["notes.md"]);
    ref.reload();
    assert.equal(ref.isTracked("notes.md"), false);
  } finally {
    cleanup();
  }
});
