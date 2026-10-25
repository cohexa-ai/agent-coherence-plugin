/**
 * #205 — the coordinator's own read of a file on disk (Python
 * `disk_content.hash_regular_file`). It hashes only a regular file it can
 * vouch for, and answers null for anything else rather than raising.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashRegularFile } from "../disk_content.js";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "disk-content-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("hashRegularFile: the sha256 of a regular file's raw bytes", () => {
  withDir((dir) => {
    const bytes = Buffer.from([0x00, 0xff, 0x0a, 0xe9, 0x41]);
    writeFileSync(join(dir, "f.bin"), bytes);
    assert.equal(hashRegularFile(join(dir, "f.bin")), createHash("sha256").update(bytes).digest("hex"));
  });
});

test("hashRegularFile: null for a missing path, a directory, or a symlink at the leaf", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "target.md"), "x");
    symlinkSync(join(dir, "target.md"), join(dir, "link.md"));
    mkdirSync(join(dir, "sub"));
    assert.equal(hashRegularFile(join(dir, "missing.md")), null);
    assert.equal(hashRegularFile(join(dir, "sub")), null);
    assert.equal(hashRegularFile(join(dir, "link.md")), null);
  });
});

test("hashRegularFile: a FIFO answers null without blocking", { skip: process.platform === "win32" }, () => {
  withDir((dir) => {
    execFileSync("mkfifo", [join(dir, "pipe")]);
    assert.equal(hashRegularFile(join(dir, "pipe")), null);
  });
});

test("hashRegularFile: the size cap is inclusive", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "f.txt"), "12345");
    assert.equal(hashRegularFile(join(dir, "f.txt"), 4), null);
    assert.equal(hashRegularFile(join(dir, "f.txt"), 5), createHash("sha256").update("12345").digest("hex"));
  });
});
