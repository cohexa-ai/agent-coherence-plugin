/**
 * #205 — the coordinator's own read of a file on disk (Python
 * `disk_content.hash_regular_file`). It hashes only a regular file it can
 * vouch for, and answers null for anything else rather than raising.
 *
 * #251 — the same open as the shared reader for files under .coherence:
 * never through a symlink, never blocked by a FIFO, a regular file only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_REGULAR, hashRegularFile, readRegularFile, readStateFile } from "../disk_content.js";
import { compiledModuleUrl, makeFifo, runBounded } from "./fifo_fixture.js";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "disk-content-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "disk-content-test-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Generous for a loaded host: the child's own start-up counts against it, not only the read. */
const CHILD_TIMEOUT_MS = 30_000;
/** A read that does not block answers in well under a millisecond; this only has to tell it from a block. */
const AT_ONCE_MS = 2_000;

/**
 * readRegularFile on each [name, path, maxBytes] given as JSON, one JSON line
 * per case as it is answered: the bytes read, or the error's code and path.
 */
const READ_CASES_SCRIPT =
  "const [moduleUrl, cases] = process.argv.slice(1);\n" +
  "const { readRegularFile } = await import(moduleUrl);\n" +
  "for (const [name, path, maxBytes] of JSON.parse(cases)) {\n" +
  "  const started = performance.now();\n" +
  "  let row;\n" +
  "  try {\n" +
  "    row = { name, bytes: readRegularFile(path, maxBytes ?? undefined).toString('utf8') };\n" +
  "  } catch (err) {\n" +
  "    row = { name, code: err.code, path: err.path };\n" +
  "  }\n" +
  "  process.stdout.write(JSON.stringify({ ...row, ms: performance.now() - started }) + '\\n');\n" +
  "}\n";

type ReadCase = [name: string, path: string, maxBytes: number | null];
interface ReadRow {
  name: string;
  bytes?: string;
  code?: string;
  path?: string;
  ms: number;
}

/**
 * Each case read in a child process: a FIFO the reader wrongly blocks on then
 * holds the child, not this test runner, and the rows answered before it show.
 */
async function readInChild(cases: ReadCase[], fifos: string[]): Promise<Map<string, ReadRow>> {
  const run = await runBounded(READ_CASES_SCRIPT, [compiledModuleUrl("disk_content.js"), JSON.stringify(cases)], {
    timeoutMs: CHILD_TIMEOUT_MS,
    fifos,
  });
  const rows = run.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as ReadRow);
  assert.equal(run.timedOut, false, `the read blocked; answered before it: ${JSON.stringify(rows)} ${run.stderr}`);
  return new Map(rows.map((row) => [row.name, row]));
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

/** hashRegularFile on the path given, its answer printed as JSON. */
const HASH_SCRIPT =
  "const [moduleUrl, path] = process.argv.slice(1);\n" +
  "const { hashRegularFile } = await import(moduleUrl);\n" +
  "process.stdout.write(JSON.stringify(hashRegularFile(path)));\n";

test("hashRegularFile: a FIFO answers null without blocking", { skip: process.platform === "win32" }, async () => {
  await withDirAsync(async (dir) => {
    const fifo = join(dir, "pipe");
    makeFifo(fifo);
    // In a child: an open that blocks here would park this whole test runner,
    // and every state-file read shares this open's flags.
    const run = await runBounded(HASH_SCRIPT, [compiledModuleUrl("disk_content.js"), fifo], {
      timeoutMs: CHILD_TIMEOUT_MS,
      fifos: [fifo],
    });
    assert.equal(run.timedOut, false, `the hash blocked on the FIFO ${run.stderr}`);
    assert.equal(run.stdout, "null");
  });
});

test("hashRegularFile: the size cap is inclusive", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "f.txt"), "12345");
    assert.equal(hashRegularFile(join(dir, "f.txt"), 4), null);
    assert.equal(hashRegularFile(join(dir, "f.txt"), 5), createHash("sha256").update("12345").digest("hex"));
  });
});

test(
  "readRegularFile classifies absent, regular, link, dangling, link to FIFO, FIFO, /dev/null and directory",
  { skip: process.platform === "win32" },
  async () => {
    await withDirAsync(async (dir) => {
      const at = (name: string) => join(dir, name);
      writeFileSync(at("file"), "abc");
      symlinkSync(at("file"), at("link"));
      symlinkSync(at("gone"), at("dangling"));
      makeFifo(at("fifo"));
      symlinkSync(at("fifo"), at("link_to_fifo"));
      mkdirSync(at("dir"));
      symlinkSync(at("dir"), at("link_to_dir"));
      writeFileSync(at("unreadable"), "x");
      chmodSync(at("unreadable"), 0o000);
      const cases: ReadCase[] = [
        ["absent", at("absent"), null],
        ["regular", at("file"), null],
        ["at the cap", at("file"), 3],
        ["over the cap", at("file"), 2],
        ["link", at("link"), null],
        ["dangling link", at("dangling"), null],
        ["link to a directory", at("link_to_dir"), null],
        ["/dev/null", "/dev/null", null],
        ["directory", at("dir"), null],
        ["link to a FIFO", at("link_to_fifo"), null],
        ["FIFO", at("fifo"), null],
      ];
      // root opens a mode-000 file; everyone else is refused with the open's own code.
      if (process.getuid?.() !== 0) cases.push(["unreadable", at("unreadable"), null]);
      const rows = await readInChild(cases, [at("fifo")]);
      const refused = (code: string, path: string) => ({ code, path });
      const expected: Record<string, unknown> = {
        absent: refused("ENOENT", at("absent")),
        regular: { bytes: "abc" },
        "at the cap": { bytes: "abc" },
        "over the cap": refused("EFBIG", at("file")),
        // Decided by lstat, never by the errno O_NOFOLLOW gives, which differs by platform.
        link: refused("ELOOP", at("link")),
        "dangling link": refused("ELOOP", at("dangling")),
        "link to a directory": refused("ELOOP", at("link_to_dir")),
        "/dev/null": refused(NOT_REGULAR, "/dev/null"),
        // EISDIR, as a plain read reports it, so a policy file that is a directory keeps its text.
        directory: refused("EISDIR", at("dir")),
        "link to a FIFO": refused("ELOOP", at("link_to_fifo")),
        FIFO: refused(NOT_REGULAR, at("fifo")),
      };
      if (process.getuid?.() !== 0) expected.unreadable = refused("EACCES", at("unreadable"));
      const actual = Object.fromEntries(
        cases.map(([name]) => {
          const row = rows.get(name);
          return [name, row?.bytes !== undefined ? { bytes: row.bytes } : row && refused(row.code!, row.path!)];
        }),
      );
      assert.deepEqual(actual, expected);
    });
  },
);

test("readRegularFile returns at once on a FIFO", { skip: process.platform === "win32" }, async () => {
  await withDirAsync(async (dir) => {
    const fifo = join(dir, "pipe");
    makeFifo(fifo);
    // In a child: a read that blocks here would park this whole test runner.
    const row = (await readInChild([["fifo", fifo, null]], [fifo])).get("fifo");
    assert.equal(row?.code, NOT_REGULAR);
    assert.ok(row!.ms < AT_ONCE_MS, `the read took ${row!.ms} ms`);
  });
});

test("readStateFile refuses a linked .coherence, and reads a regular file inside a real one", () => {
  withDir((dir) => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "hook.secret"), "theirs");
    const linked = join(dir, "linked", ".coherence");
    mkdirSync(join(dir, "linked"));
    symlinkSync(elsewhere, linked);
    // O_NOFOLLOW guards the last component only: through a linked .coherence
    // the leaf is a regular file, so the directory itself has to be checked.
    assert.equal(readRegularFile(join(linked, "hook.secret")).toString("utf8"), "theirs");
    assert.throws(() => readStateFile(linked, "hook.secret"), { code: "ELOOP", path: linked });

    const real = join(dir, "real", ".coherence");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "hook.secret"), "ours");
    symlinkSync(join(elsewhere, "hook.secret"), join(real, "tracked.yaml"));
    assert.equal(readStateFile(real, "hook.secret").toString("utf8"), "ours");
    assert.throws(() => readStateFile(real, "hook.secret", 3), { code: "EFBIG" });
    assert.throws(() => readStateFile(real, "tracked.yaml"), { code: "ELOOP", path: join(real, "tracked.yaml") });
  });
});
