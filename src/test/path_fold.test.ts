/**
 * The shared fold table and the fold functions built on it.
 *
 * The vectors in the table file are the ones the Python coordinator runs too,
 * so every one of them is driven here under every profile. The pairs measured
 * on macOS record what a case-insensitive APFS volume (caseless) and a
 * case-sensitive one (nfd) actually did with each spelling pair.
 *
 * The generator tests run a copy of `tools/gen_fold_table.js` inside a scratch
 * tree that mirrors the repository layout, so a refusal that regressed could
 * only ever write its table there, never over the committed one. They stay
 * offline: `--ucd-dir` hands the generator files that were never fetched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import foldData from '../fold_data/fold_table.json' with { type: 'json' };
import {
  FOLD_LENGTH_LIMIT,
  exceedsFoldLimit,
  foldKey,
  policyFold,
  tidyPath,
  type FoldProfile,
} from '../path_fold.js';

// At runtime this file is dist/test/path_fold.test.js; the plugin root is two levels up.
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GENERATOR = join(PLUGIN_ROOT, 'tools', 'gen_fold_table.js');
const PINNED_SUMS = join(PLUGIN_ROOT, 'data', 'ucd-17.0.0', 'SHA256SUMS');
const TABLE_SOURCE = join(PLUGIN_ROOT, 'src', 'fold_data', 'fold_table.json');
const UCD_FILES = ['CaseFolding.txt', 'CompositionExclusions.txt', 'UnicodeData.txt'];
const PROFILES: readonly FoldProfile[] = ['caseless', 'nfd', 'none'];

/**
 * The SHA-256 of the table section, as the Python coordinator's test pins it
 * too. Changing the table means regenerating it and updating this constant in
 * both repositories.
 */
const PINNED_TABLE_SHA256 = 'c259d5c36c7e6dc56347b24b7cc263a82acd4c460754e186a565a3da68d39fe8';

function sameKey(a: string, b: string, profile: FoldProfile): boolean {
  return foldKey(a, profile) === foldKey(b, profile);
}

test('every shared spelling pair has one key exactly when its vector says so, per profile', () => {
  const wrong: string[] = [];
  for (const pair of foldData.vectors.pairs) {
    for (const profile of PROFILES) {
      if (sameKey(pair.a, pair.b, profile) !== pair[profile]) {
        wrong.push(`${profile}: ${pair.note} (expected one key: ${pair[profile]})`);
      }
    }
  }
  assert.deepEqual(wrong, []);
});

test('the shared pairs cover every multi-character case folding in the table', () => {
  const pairs = new Set(foldData.vectors.pairs.map((pair) => pair.a));
  const multiCharacter = Object.entries(foldData.table.case_folding)
    .filter(([, fold]) => fold.includes(' '))
    .map(([codePoint]) => String.fromCodePoint(parseInt(codePoint, 16)));
  assert.ok(multiCharacter.length >= 100, `only ${multiCharacter.length} multi-character folds`);
  assert.deepEqual(
    multiCharacter.filter((character) => !pairs.has(character)),
    []
  );
});

test('nfd: NFC and NFD cafe share a key, Cafe and cafe do not, Hangul matches its jamo', () => {
  assert.ok(sameKey('caf\u00e9', 'cafe\u0301', 'nfd'));
  assert.ok(!sameKey('Caf\u00e9', 'caf\u00e9', 'nfd'));
  for (const profile of ['nfd', 'caseless'] as const) {
    assert.ok(sameKey('\ud55c', '\u1112\u1161\u11ab', profile), profile);
  }
});

test('none: only tidying applies, so case and accents stay apart', () => {
  assert.equal(foldKey('./a//b/./c', 'none'), 'a/b/c');
  assert.ok(!sameKey('Plan.md', 'plan.md', 'none'));
  assert.ok(!sameKey('caf\u00e9', 'cafe\u0301', 'none'));
});

test('tidy: every shared tidy vector, leaving .., backslashes and segment text alone', () => {
  for (const { input, output } of foldData.vectors.tidy) {
    assert.equal(tidyPath(input), output, JSON.stringify(input));
  }
});

test('caseless: sharp s, capital sharp s, SS and ss share a key, and so do the fi ligature and fi', () => {
  for (const spelling of ['\u1e9e', 'SS', 'ss']) {
    assert.ok(sameKey('\u00df', spelling, 'caseless'), spelling);
  }
  assert.ok(sameKey('\ufb01', 'fi', 'caseless'));
});

test('caseless: dotless i and I keep different keys', () => {
  assert.ok(!sameKey('\u0131', 'I', 'caseless'));
});

test('caseless: ODOS and odos with a final sigma share a key', () => {
  assert.ok(sameKey('\u039f\u0394\u039f\u03a3', '\u03bf\u03b4\u03bf\u03c2', 'caseless'));
});

test('policy fold: every shared vector, so NFD CAFE with an acute becomes NFC cafe', () => {
  assert.equal(policyFold('CAFE\u0301', 'caseless'), 'caf\u00e9');
  for (const vector of foldData.vectors.policy_fold) {
    for (const profile of ['caseless', 'nfd'] as const) {
      assert.equal(
        policyFold(vector.input, profile),
        vector[profile],
        `${profile}: ${vector.note}`
      );
    }
  }
});

test('no table output introduces a glob character or a slash', () => {
  const forbidden = new Set(
    ['*', '?', '[', ']', '!', '/'].map((character) => character.codePointAt(0))
  );
  const outputs = [
    ...Object.values(foldData.table.decomposition),
    ...Object.values(foldData.table.case_folding),
    ...Object.values(foldData.table.composition),
  ];
  const offending = outputs.filter((sequence) =>
    sequence.split(' ').some((codePoint) => forbidden.has(parseInt(codePoint, 16)))
  );
  assert.deepEqual(offending, []);
});

test('the length limit: every shared vector, counting code points, so 1025 is over', () => {
  assert.equal(FOLD_LENGTH_LIMIT, 1024);
  assert.equal(exceedsFoldLimit('a'.repeat(1025)), true);
  for (const { piece, count, over_limit } of foldData.vectors.limit) {
    assert.equal(
      exceedsFoldLimit(piece.repeat(count)),
      over_limit,
      `${count} x ${JSON.stringify(piece)}`
    );
  }
});

/**
 * Combining classes 240 down to 1. A run of marks in this order is the worst
 * case for canonical ordering: every mark has to move past every later one.
 */
const DESCENDING_MARKS = [
  '\u0345',
  '\u035d',
  '\u035c',
  '\u0315',
  '\u0301',
  '\u0323',
  '\u031b',
  '\u0327',
  '\u0334',
];

function worstOrderRun(length: number): string {
  const marks = Array.from(
    { length: length - 1 },
    (_, index) => DESCENDING_MARKS[Math.floor((index * DESCENDING_MARKS.length) / (length - 1))]
  );
  return `a${marks.join('')}`;
}

/** The fastest of a few runs, so a scheduler pause on a loaded machine is not read as cost. */
function fastestMilliseconds(fold: () => string): number {
  let fastest = Infinity;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const started = performance.now();
    fold();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

test('a worst-order run of 1024 combining code points folds in under 50 ms', () => {
  const run = worstOrderRun(FOLD_LENGTH_LIMIT);
  assert.equal([...run].length, 1024);
  assert.equal(exceedsFoldLimit(run), false);
  const folds: Record<string, () => string> = {
    caseless: () => foldKey(run, 'caseless'),
    nfd: () => foldKey(run, 'nfd'),
    'policy fold': () => policyFold(run, 'caseless'),
  };
  for (const [name, fold] of Object.entries(folds)) {
    const milliseconds = fastestMilliseconds(fold);
    assert.ok(milliseconds < 50, `${name} took ${milliseconds.toFixed(1)} ms`);
  }
});

/** Sorted keys, no whitespace, non-ASCII escaped: Python's json.dumps(sort_keys=True, separators=(",", ":")). */
function canonicalSerialization(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSerialization).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSerialization(record[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function tableDigest(table: unknown): string {
  return createHash('sha256').update(canonicalSerialization(table)).digest('hex');
}

function assertTablePinned(document: { table_sha256: string; table: unknown }): void {
  const digest = tableDigest(document.table);
  assert.equal(digest, document.table_sha256, 'table_sha256 is not the hash of the table');
  assert.equal(digest, PINNED_TABLE_SHA256, 'the fold table is not the pinned one');
}

test('the table carries the Unicode License notice, so every copy of it does', () => {
  // The release tarball ships dist/ alone, and tsc copies only the imported
  // JSON there, so the notice must travel inside the data it covers.
  const notice = readFileSync(join(PLUGIN_ROOT, 'src', 'fold_data', 'LICENSE-UNICODE'), 'utf8');
  assert.match(notice, /UNICODE LICENSE V3/);
  assert.equal((foldData as { license?: string }).license, notice);
});

test('the table hash: the embedded hash is the hash of the table, and the pinned one', () => {
  assert.equal(foldData.unicode_version, '17.0.0');
  assertTablePinned(foldData);
});

test('the table hash: a one-byte edit inside the table fails the pin', () => {
  const source = readFileSync(TABLE_SOURCE, 'utf8');
  const entry = '"00C0": "0041 0300"';
  assert.ok(source.includes(entry), `${entry} is no longer in the table`);
  const edited = source.replace(entry, '"00C0": "0041 0301"');
  assert.equal(Buffer.byteLength(edited), Buffer.byteLength(source));
  const document = JSON.parse(edited);
  assert.throws(() => assertTablePinned(document), /not the hash of the table/);
  // An edit that also rewrites the embedded hash still fails the pinned constant.
  document.table_sha256 = tableDigest(document.table);
  assert.throws(() => assertTablePinned(document), /not the pinned one/);
});

interface ScratchTree {
  root: string;
  script: string;
  sums: string;
  ucdDir: string;
  output: string;
}

function populateScratchTree(root: string): ScratchTree {
  const script = join(root, 'tools', 'gen_fold_table.js');
  const sums = join(root, 'data', 'ucd-17.0.0', 'SHA256SUMS');
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(dirname(sums), { recursive: true });
  mkdirSync(join(root, 'ucd'));
  copyFileSync(GENERATOR, script);
  copyFileSync(PINNED_SUMS, sums);
  const output = join(root, 'src', 'fold_data', 'fold_table.json');
  return { root, script, sums, ucdDir: join(root, 'ucd'), output };
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Write a stand-in for each named UCD file and pin every one of them in the
 * scratch SHA256SUMS, except `mismatched`, whose pinned sum is of other bytes.
 */
function stageUcdFiles(tree: ScratchTree, present: string[], mismatched?: string): void {
  const lines = UCD_FILES.map((name) => {
    const body = `stand-in for ${name}\n`;
    if (present.includes(name)) writeFileSync(join(tree.ucdDir, name), body);
    const pinned = name === mismatched ? sha256Hex(`other bytes for ${name}\n`) : sha256Hex(body);
    return `${pinned}  ${name}`;
  });
  writeFileSync(tree.sums, `${lines.join('\n')}\n`);
}

function runGenerator(tree: ScratchTree): { status: number | null; stderr: string } {
  const run = spawnSync(process.execPath, [tree.script, '--ucd-dir', tree.ucdDir], {
    encoding: 'utf8',
  });
  return { status: run.status, stderr: run.stderr };
}

/** Run `check` against a fresh scratch tree, removing the tree however it ends. */
function withScratchTree(check: (tree: ScratchTree) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'fold-gen-'));
  try {
    check(populateScratchTree(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const name of UCD_FILES) {
  const namePattern = name.replace('.', '\\.');

  test(`generator refuses a ${name} whose checksum does not match the pinned one`, () => {
    withScratchTree((tree) => {
      stageUcdFiles(tree, UCD_FILES, name);
      const run = runGenerator(tree);
      assert.notEqual(run.status, 0, run.stderr);
      assert.match(run.stderr, new RegExp(`${namePattern}.*SHA-256`));
      for (const other of UCD_FILES.filter((candidate) => candidate !== name)) {
        assert.doesNotMatch(run.stderr, new RegExp(other.replace('.', '\\.')));
      }
      assert.equal(existsSync(tree.output), false, 'a refused run wrote a table');
    });
  });

  test(`generator refuses when ${name} is missing`, () => {
    withScratchTree((tree) => {
      stageUcdFiles(
        tree,
        UCD_FILES.filter((candidate) => candidate !== name)
      );
      const run = runGenerator(tree);
      assert.notEqual(run.status, 0, run.stderr);
      assert.match(run.stderr, new RegExp(`${namePattern}.*missing`));
      assert.equal(existsSync(tree.output), false, 'a refused run wrote a table');
    });
  });
}
