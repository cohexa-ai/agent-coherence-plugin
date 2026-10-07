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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
