#!/usr/bin/env node
// Copyright (c) 2026 Arbiter contributors.
// The Coherence Protocol for AI Agents

/**
 * Generate src/fold_data/fold_table.json, the fold table both coordinators
 * share, from three Unicode Character Database 17.0.0 files.
 *
 *   node tools/gen_fold_table.js                  fetch the files from unicode.org
 *   node tools/gen_fold_table.js --ucd-dir <dir>  read already-downloaded files
 *
 * Either way every file must match data/ucd-17.0.0/SHA256SUMS before anything
 * is parsed, and a missing or mismatched file refuses the run without writing.
 * Only the checksums are committed: the marketplace installs the repository
 * root, so the 2 MB of UCD input would otherwise ship in every plugin install.
 *
 * WHY A TABLE AND NOT THE RUNTIME. Each runtime's own normalization and case
 * mapping follow whatever Unicode version it was built with, and Node has no
 * case folding at all, so neither runtime alone reproduces what the disk folds
 * or what the other runtime computes. Both coordinators fold from this one
 * table instead, and the table's hash is pinned in each repository's tests.
 *
 * The output is ASCII-only and its "table_sha256" is the SHA-256 of the table
 * serialized with sorted keys and no whitespace, which is what Python's
 * json.dumps(table, sort_keys=True, separators=(",", ":")) produces, so the
 * Python side can check the same hash byte for byte. The output depends only
 * on the pinned files and this script, never on the Node version running it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNICODE_VERSION = '17.0.0';
const UCD_URL = `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/`;
const UCD_FILES = ['CaseFolding.txt', 'CompositionExclusions.txt', 'UnicodeData.txt'];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUMS_PATH = join(ROOT, 'data', `ucd-${UNICODE_VERSION}`, 'SHA256SUMS');
const OUTPUT_PATH = join(ROOT, 'src', 'fold_data', 'fold_table.json');
// Carried inside the table so the notice reaches every copy, including dist/.
const LICENSE_PATH = join(ROOT, 'src', 'fold_data', 'LICENSE-UNICODE');

/**
 * Spelling pairs: [note, a, b, one key under caseless, under nfd, under none].
 *
 * The caseless and nfd answers of the pairs measured on macOS 26 are what the
 * disk did: a case-insensitive APFS volume for caseless, a case-sensitive one
 * for nfd. Both folded the three lexical spellings too, because the kernel
 * tidies them. The none answer is tidying alone. The pairs after the measured
 * ones follow from the same definitions.
 */
const SPELLING_PAIRS = [
  ['ASCII case', 'a.txt', 'A.txt', true, false, false],
  ['NFC vs NFD e acute', 'caf\u00e9.txt', 'cafe\u0301.txt', true, true, false],
  ['NFC E acute vs NFD e acute', 'caf\u00c9.txt', 'cafe\u0301.txt', true, false, false],
  ['NFD E acute vs NFC e acute', 'cafE\u0301.txt', 'caf\u00e9.txt', true, false, false],
  ['sharp s vs ss', 'stra\u00dfe', 'strasse', true, false, false],
  ['sharp s vs SS', 'stra\u00dfe', 'STRASSE', true, false, false],
  ['ss vs SS', 'strasse', 'STRASSE', true, false, false],
  ['capital sharp s vs sharp s', 'stra\u1e9ee', 'stra\u00dfe', true, false, false],
  ['capital sharp s vs ss', 'stra\u1e9ee', 'strasse', true, false, false],
  ['capital I with dot vs i', '\u0130x', 'ix', false, false, false],
  ['capital I with dot vs I', '\u0130x', 'Ix', false, false, false],
  ['capital I with dot vs i and combining dot', '\u0130x', 'i\u0307x', true, false, false],
  ['dotless i vs i', '\u0131x', 'ix', false, false, false],
  ['dotless i vs I', '\u0131x', 'Ix', false, false, false],
  ['i vs I', 'ix', 'Ix', true, false, false],
  ['final sigma vs sigma', '\u03c2x', '\u03c3x', true, false, false],
  ['sigma vs capital sigma', '\u03c3x', '\u03a3x', true, false, false],
  ['final sigma vs capital sigma', '\u03c2x', '\u03a3x', true, false, false],
  [
    'ODOS vs odos, medial sigma',
    '\u039f\u0394\u039f\u03a3.txt',
    '\u03bf\u03b4\u03bf\u03c3.txt',
    true,
    false,
    false,
  ],
  [
    'ODOS vs odos, final sigma',
    '\u039f\u0394\u039f\u03a3.txt',
    '\u03bf\u03b4\u03bf\u03c2.txt',
    true,
    false,
    false,
  ],
  ['Kelvin sign vs k', '\u212ax', 'kx', true, false, false],
  ['Kelvin sign vs K', '\u212ax', 'Kx', true, true, false],
  ['fi ligature vs fi', '\ufb01le', 'file', true, false, false],
  ['fi ligature vs FI', '\ufb01le', 'FIle', true, false, false],
  ['fullwidth A vs A', '\uff21x', 'Ax', false, false, false],
  ['fullwidth A vs fullwidth a', '\uff21x', '\uff41x', true, false, false],
  ['Angstrom sign vs A ring', '\u212bx', '\u00c5x', true, true, false],
  ['Angstrom sign vs A and combining ring', '\u212bx', 'A\u030ax', true, true, false],
  ['Angstrom sign vs a ring', '\u212bx', '\u00e5x', true, false, false],
  ['Ohm sign vs capital omega', '\u2126x', '\u03a9x', true, true, false],
  ['Ohm sign vs omega', '\u2126x', '\u03c9x', true, false, false],
  ['composed Hangul vs conjoining jamo', '\ud55c.txt', '\u1112\u1161\u11ab.txt', true, true, false],
  ['micro sign vs mu', '\u00b5x', '\u03bcx', true, false, false],
  ['micro sign vs capital mu', '\u00b5x', '\u039cx', true, false, false],
  ['long s vs s', '\u017fx', 'sx', true, false, false],
  ['long s vs S', '\u017fx', 'Sx', true, false, false],
  ['Cherokee capital vs small', '\u13a0x', '\uab70x', true, false, false],
  ['titlecase Dz vs dz', '\u01c5x', '\u01c6x', true, false, false],
  ['titlecase Dz vs DZ', '\u01c5x', '\u01c4x', true, false, false],
  ['alpha with ypogegrammeni vs prosgegrammeni', '\u1fb3x', '\u1fbcx', true, false, false],
  ['alpha with ypogegrammeni vs alpha iota', '\u1fb3x', '\u03b1\u03b9x', true, false, false],
  ['Deseret capital vs small', '\u{10400}x', '\u{10428}x', true, false, false],
  ['Osage capital vs small', '\u{104b0}x', '\u{104d8}x', true, false, false],
  ['Adlam capital vs small', '\u{1e900}x', '\u{1e922}x', true, false, false],
  ['Georgian Mtavruli vs Mkhedruli', '\u1c90x', '\u10d0x', true, false, false],
  ['Glagolitic capital vs small', '\u2c2fx', '\u2c5fx', true, false, false],
  ['Latin U+A7C0 vs U+A7C1', '\ua7c0x', '\ua7c1x', true, false, false],
  ['Vithkuqi capital vs small', '\u{10570}x', '\u{10597}x', true, false, false],
  ['Latin U+A7CB vs U+0264, Unicode 16', '\ua7cbx', '\u0264x', true, false, false],
  ['Latin U+A7DC vs U+019B, Unicode 16', '\ua7dcx', '\u019bx', true, false, false],
  ['CJK compatibility ideograph vs unified', '\uf900x', '\u8c48x', true, true, false],
  ['en quad vs en space', 'a\u2000b', 'a\u2002b', true, true, false],
  ['acute and dot below in either order', 'a\u0301\u0323', 'a\u0323\u0301', true, true, false],
  ['zero width joiner is kept', 'a\u200db', 'ab', false, false, false],
  ['byte order mark is kept', 'a\ufeffb', 'ab', false, false, false],
  ['soft hyphen is kept', 'a\u00adb', 'ab', false, false, false],
  ['directory case', 'Dir/x.txt', 'dir/x.txt', true, false, false],
  ['directory and file case', 'Dir/x.txt', 'DIR/X.TXT', true, false, false],
  ['dot slash prefix', 'x.txt', './x.txt', true, true, true],
  ['double slash', 'sub/x.txt', 'sub//x.txt', true, true, true],
  ['slash dot slash', 'sub/x.txt', 'sub/./x.txt', true, true, true],
  ['dotless i and dot vs i and dot', '\u0131\u0307x', 'i\u0307x', false, false, false],
  ['dotless i and dot vs I and dot', '\u0131\u0307x', 'I\u0307x', false, false, false],
  ['sigma dotless i sigma', '\u03a3\u0131\u03a3', '\u03c3\u0131\u03c2', true, false, false],
  ['ff ligature vs ff', '\ufb00x', 'ffx', true, false, false],
  ['ff ligature vs FF', '\ufb00x', 'FFx', true, false, false],
  ['j with caron vs J and caron', '\u01f0x', 'J\u030cx', true, false, false],
  ['iota with dialytika and tonos vs capital', '\u0390x', '\u03aa\u0301x', true, false, false],
  ['ypogegrammeni vs iota', 'x\u0345', 'x\u03b9', true, false, false],
  ['two capital sharp s vs ssSS', '\u1e9e\u1e9e', 'ssSS', true, false, false],
  ['n preceded by apostrophe vs apostrophe N', '\u0149x', '\u02bcNx', true, false, false],
  ['zero width non-joiner is kept', 'a\u200cb', 'ab', false, false, false],
  ['dot below and circumflex in either order', 'a\u0323\u0302', 'a\u0302\u0323', true, true, false],
  [
    'ypogegrammeni sorts after acute before it folds',
    '\u03b1\u0345\u0301',
    '\u03b1\u0301\u03b9',
    true,
    false,
    false,
  ],
  [
    'ypogegrammeni does not fold before acute',
    '\u03b1\u0345\u0301',
    '\u03b1\u03b9\u0301',
    false,
    false,
    false,
  ],
  ['Hangul syllable vs jamo', '\ud55c', '\u1112\u1161\u11ab', true, true, false],
  ['Hangul syllable without a final vs jamo', '\ud558', '\u1112\u1161', true, true, false],
  ['Cafe capital vs small', 'Caf\u00e9', 'caf\u00e9', true, false, false],
  ['ODOS vs odos', '\u039f\u0394\u039f\u03a3', '\u03bf\u03b4\u03bf\u03c2', true, false, false],
  ['Todhri decomposition, Unicode 16', '\u{105c9}', '\u{105d2}\u0307', true, true, false],
  ['Latin double thorn, Unicode 17', '\ua7d2x', '\ua7d3x', true, false, false],
  [
    'segments fold one by one',
    'Docs/Caf\u00e9/Plan.md',
    'docs/cafe\u0301/plan.MD',
    true,
    false,
    false,
  ],
  ['backslash is not a separator', 'Dir\\x.txt', 'Dir/x.txt', false, false, false],
  ['dot dot is not resolved', 'a/../b', 'b', false, false, false],
];

/** Policy fold cases: [note, input, caseless output, nfd output]. */
const POLICY_FOLD_CASES = [
  ['NFD capitals compose to NFC', 'CAFE\u0301', 'caf\u00e9', 'CAF\u00c9'],
  ['sharp s', 'Stra\u00dfe.md', 'strasse.md', 'Stra\u00dfe.md'],
  ['capital sharp s', '\u1e9e', 'ss', '\u1e9e'],
  ['conjoining jamo compose to a syllable', '\u1112\u1161\u11ab', '\ud55c', '\ud55c'],
  ['syllable and final jamo compose', '\ud558\u11ab', '\ud55c', '\ud55c'],
  ['Kelvin sign', '\u212a', 'k', 'K'],
  ['Ohm sign', '\u2126', '\u03c9', '\u03a9'],
  ['singleton Angstrom sign', '\u212b', '\u00e5', '\u00c5'],
  ['marks in reverse canonical order', 'a\u0302\u0323', '\u1ead', '\u1ead'],
  ['capital I with dot', '\u0130x', 'i\u0307x', '\u0130x'],
  ['fi ligature', '\ufb01le', 'file', '\ufb01le'],
  ['composition exclusion stays decomposed', '\u0958', '\u0915\u093c', '\u0915\u093c'],
  ['non-starter decomposition', 'a\u0344', '\u00e4\u0301', '\u00e4\u0301'],
  [
    'final sigma',
    '\u039f\u0394\u039f\u03a3',
    '\u03bf\u03b4\u03bf\u03c3',
    '\u039f\u0394\u039f\u03a3',
  ],
  ['ypogegrammeni', '\u03b1\u0345\u0301', '\u03ac\u03b9', '\u1fb4'],
  ['Todhri composition, Unicode 16', '\u{105d2}\u0307', '\u{105c9}', '\u{105c9}'],
  ['Latin double thorn, Unicode 17', '\ua7d2x', '\ua7d3x', '\ua7d2x'],
  [
    'segments tidied, then folded',
    'Docs/./Caf\u00e9//Plan.MD',
    'docs/caf\u00e9/plan.md',
    'Docs/Caf\u00e9/Plan.MD',
  ],
  ['ASCII', 'README.MD', 'readme.md', 'README.MD'],
  ['trailing slash', 'Docs/', 'docs/', 'Docs/'],
  ['backslash', 'A\\B', 'a\\b', 'A\\B'],
  ['glob characters pass through', 'Docs/*?[!]/X', 'docs/*?[!]/x', 'Docs/*?[!]/X'],
  [
    'a mark of the same class blocks composition',
    'a\u0346\u0301',
    'a\u0346\u0301',
    'a\u0346\u0301',
  ],
  [
    'a mark between jamo blocks composition',
    '\u1100\u0301\u1161',
    '\u1100\u0301\u1161',
    '\u1100\u0301\u1161',
  ],
];

/** Tidy cases: [input, output]. */
const TIDY_CASES = [
  ['./a//b/./c', 'a/b/c'],
  ['a/b', 'a/b'],
  ['./plan.md', 'plan.md'],
  ['.//plan.md', 'plan.md'],
  ['././plan.md', 'plan.md'],
  ['docs//plan.md', 'docs/plan.md'],
  ['docs/./plan.md', 'docs/plan.md'],
  ['docs/plan.md/', 'docs/plan.md/'],
  ['docs//', 'docs/'],
  ['a/.', 'a'],
  ['a/./', 'a/'],
  ['docs/../plan.md', 'docs/../plan.md'],
  ['../plan.md', '../plan.md'],
  ['a\\b/./c', 'a\\b/c'],
  ['a\\.\\b', 'a\\.\\b'],
  ['.env', '.env'],
  ['..plan.md', '..plan.md'],
  ['a/.../b', 'a/.../b'],
  ['a./.b', 'a./.b'],
  ['/abs//x', '/abs/x'],
  ['//plan.md', '/plan.md'],
  ['.', ''],
  ['./', ''],
  ['', ''],
];

/** Length limit cases: [piece, times repeated, over the limit]. Length counts code points. */
const LIMIT_CASES = [
  ['a', 1024, false],
  ['a', 1025, true],
  ['\u{10400}', 1024, false],
  ['\u{10400}', 1025, true],
  ['\u0301', 1024, false],
  ['\u0301', 1025, true],
  ['e\u0301', 512, false],
];

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hex(codePoint) {
  return codePoint.toString(16).toUpperCase().padStart(4, '0');
}

function hexSequence(codePoints) {
  return codePoints.map(hex).join(' ');
}

function parseSequence(text) {
  return text
    .trim()
    .split(/\s+/)
    .map((part) => parseInt(part, 16));
}

function dataLines(text) {
  return text
    .split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter((line) => line !== '');
}

/** SHA256SUMS in sha256sum format: "<hex>  <name>" (or "<hex> *<name>"). */
function readPinnedSums(path) {
  const sums = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

async function fetchUcdFiles(directory) {
  for (const name of UCD_FILES) {
    const response = await fetch(`${UCD_URL}${name}`);
    if (!response.ok) throw new Error(`fetching ${UCD_URL}${name} failed: HTTP ${response.status}`);
    writeFileSync(join(directory, name), Buffer.from(await response.arrayBuffer()));
  }
}

/** Read each file once, so the bytes that are verified are the bytes that are parsed. */
function readUcdFiles(directory) {
  const files = new Map();
  for (const name of UCD_FILES) {
    const path = join(directory, name);
    files.set(name, existsSync(path) ? readFileSync(path) : undefined);
  }
  return files;
}

function findChecksumProblems(files, pinnedSums, directory) {
  const problems = [];
  for (const [name, bytes] of files) {
    if (bytes === undefined) {
      problems.push(`${name} is missing from ${directory}`);
      continue;
    }
    const actual = sha256Hex(bytes);
    const pinned = pinnedSums.get(name);
    if (actual !== pinned) {
      problems.push(`${name} does not match its pinned SHA-256 (pinned ${pinned}, got ${actual})`);
    }
  }
  return problems;
}

/** Canonical decompositions (one level) and non-zero combining classes. */
function parseUnicodeData(text) {
  const decompositions = new Map();
  const combiningClasses = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const fields = line.split(';');
    const codePoint = parseInt(fields[0], 16);
    const combiningClass = Number(fields[3]);
    if (combiningClass !== 0) combiningClasses.set(codePoint, combiningClass);
    // A tagged mapping such as <compat> is a compatibility decomposition, which
    // no supported disk folds: fullwidth A stays apart from A.
    if (fields[5] !== '' && !fields[5].startsWith('<')) {
      decompositions.set(codePoint, parseSequence(fields[5]));
    }
  }
  return { decompositions, combiningClasses };
}

/** Full case folding: statuses C and F only. */
function parseCaseFolding(text) {
  const folds = new Map();
  const fullOnly = [];
  for (const line of dataLines(text)) {
    const [code, status, mapping] = line.split(';').map((field) => field.trim());
    // S is the simple folding the full one replaces, and T the Turkic dotted and
    // dotless i, which the disk keeps apart: dotless i is not I.
    if (status !== 'C' && status !== 'F') continue;
    folds.set(parseInt(code, 16), parseSequence(mapping));
    if (status === 'F') fullOnly.push(parseInt(code, 16));
  }
  return { folds, fullOnly };
}

function parseCompositionExclusions(text) {
  return new Set(dataLines(text).map((line) => parseInt(line, 16)));
}

function fullDecomposition(codePoint, decompositions) {
  const mapping = decompositions.get(codePoint);
  if (mapping === undefined) return [codePoint];
  return mapping.flatMap((part) => fullDecomposition(part, decompositions));
}

/**
 * The pairs canonical composition joins: every two-part canonical
 * decomposition except the composition exclusions and the non-starter
 * decompositions (a singleton has a one-part mapping, so it never appears).
 */
function compositionPairs(ucd) {
  const pairs = new Map();
  for (const [composite, mapping] of ucd.decompositions) {
    if (mapping.length !== 2 || ucd.exclusions.has(composite)) continue;
    if (ucd.combiningClasses.has(composite) || ucd.combiningClasses.has(mapping[0])) continue;
    pairs.set(hexSequence(mapping), hex(composite));
  }
  return pairs;
}

function hexObject(map, formatValue) {
  const object = {};
  for (const [key, value] of map)
    object[typeof key === 'number' ? hex(key) : key] = formatValue(value);
  return object;
}

function buildTable(ucd) {
  const full = new Map(
    [...ucd.decompositions.keys()].map((codePoint) => [
      codePoint,
      fullDecomposition(codePoint, ucd.decompositions),
    ])
  );
  return {
    case_folding: hexObject(ucd.folds, hexSequence),
    combining_class: hexObject(ucd.combiningClasses, (value) => value),
    composition: hexObject(compositionPairs(ucd), (value) => value),
    decomposition: hexObject(full, hexSequence),
  };
}

/** Stable sort of each run of non-starters by combining class. */
function canonicalOrder(codePoints, combiningClasses) {
  const ordered = [];
  let run = [];
  const flushRun = () => {
    run.sort((x, y) => combiningClasses.get(x) - combiningClasses.get(y));
    ordered.push(...run);
    run = [];
  };
  for (const codePoint of codePoints) {
    if (combiningClasses.has(codePoint)) {
      run.push(codePoint);
      continue;
    }
    flushRun();
    ordered.push(codePoint);
  }
  flushRun();
  return ordered;
}

/**
 * Whether two code point sequences have one canonical decomposition. Used only
 * on case folding entries, which never hold a Hangul syllable, so it does not
 * decompose Hangul by algorithm.
 */
function canonicallyEqual(left, right, ucd) {
  const decompose = (codePoints) =>
    canonicalOrder(
      codePoints.flatMap((codePoint) => fullDecomposition(codePoint, ucd.decompositions)),
      ucd.combiningClasses
    ).join(' ');
  return decompose(left) === decompose(right);
}

/** One pair per multi-character fold: a disk that folds case reaches one file by both. */
function fullFoldPairs(ucd) {
  return ucd.fullOnly.map((codePoint) => {
    const fold = ucd.folds.get(codePoint);
    return {
      note: `full case folding of U+${hex(codePoint)}`,
      a: String.fromCodePoint(codePoint),
      b: String.fromCodePoint(...fold),
      caseless: true,
      nfd: canonicallyEqual([codePoint], fold, ucd),
      none: false,
    };
  });
}

function buildVectors(ucd) {
  const pairs = SPELLING_PAIRS.map(([note, a, b, caseless, nfd, none]) => ({
    note,
    a,
    b,
    caseless,
    nfd,
    none,
  }));
  return {
    pairs: [...pairs, ...fullFoldPairs(ucd)],
    policy_fold: POLICY_FOLD_CASES.map(([note, input, caseless, nfd]) => ({
      note,
      input,
      caseless,
      nfd,
    })),
    tidy: TIDY_CASES.map(([input, output]) => ({ input, output })),
    limit: LIMIT_CASES.map(([piece, count, overLimit]) => ({
      piece,
      count,
      over_limit: overLimit,
    })),
  };
}

/** Sorted keys at every level, no whitespace. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Escape every non-ASCII UTF-16 unit as \uXXXX, exactly as Python's ensure_ascii does. */
function asciiOnly(json) {
  return json.replace(
    /[\u0080-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/** Each table entry and each vector on its own line, keys sorted below the top level. */
function formatEntries(entries, indent) {
  const items = Array.isArray(entries)
    ? entries.map((item) => canonicalJson(item))
    : Object.keys(entries)
        .sort()
        .map((key) => `${JSON.stringify(key)}: ${JSON.stringify(entries[key])}`);
  const [open, close] = Array.isArray(entries) ? ['[', ']'] : ['{', '}'];
  return `${open}\n${items.map((item) => `${indent}  ${item}`).join(',\n')}\n${indent}${close}`;
}

function formatDocument(document) {
  const section = (value) =>
    `{\n${Object.keys(value)
      .sort()
      .map((key) => `    ${JSON.stringify(key)}: ${formatEntries(value[key], '    ')}`)
      .join(',\n')}\n  }`;
  const lines = [
    `  "unicode_version": ${JSON.stringify(document.unicode_version)}`,
    `  "license": ${JSON.stringify(document.license)}`,
    `  "table_sha256": ${JSON.stringify(document.table_sha256)}`,
    `  "table": ${section(document.table)}`,
    `  "vectors": ${section(document.vectors)}`,
  ];
  return asciiOnly(`{\n${lines.join(',\n')}\n}\n`);
}

function buildDocument(files) {
  const text = (name) => files.get(name).toString('utf8');
  const ucd = {
    ...parseUnicodeData(text('UnicodeData.txt')),
    ...parseCaseFolding(text('CaseFolding.txt')),
    exclusions: parseCompositionExclusions(text('CompositionExclusions.txt')),
  };
  const table = buildTable(ucd);
  const tableSha256 = sha256Hex(asciiOnly(canonicalJson(table)));
  return {
    unicode_version: UNICODE_VERSION,
    license: readFileSync(LICENSE_PATH, 'utf8'),
    table_sha256: tableSha256,
    table,
    vectors: buildVectors(ucd),
  };
}

function ucdDirectoryArgument(argv) {
  if (argv.length === 0) return undefined;
  if (argv.length === 2 && argv[0] === '--ucd-dir') return resolve(argv[1]);
  throw new Error('usage: node tools/gen_fold_table.js [--ucd-dir <dir>]');
}

async function main(argv) {
  const ucdDirectory = ucdDirectoryArgument(argv);
  const pinnedSums = readPinnedSums(SUMS_PATH);
  const directory = ucdDirectory ?? mkdtempSync(join(tmpdir(), `ucd-${UNICODE_VERSION}-`));
  try {
    if (ucdDirectory === undefined) await fetchUcdFiles(directory);
    const files = readUcdFiles(directory);
    const problems = findChecksumProblems(files, pinnedSums, directory);
    if (problems.length > 0) {
      throw new Error(`refusing to write the fold table:\n  - ${problems.join('\n  - ')}`);
    }
    const document = buildDocument(files);
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, formatDocument(document));
    console.log(`wrote ${OUTPUT_PATH} (table sha256 ${document.table_sha256})`);
  } finally {
    if (ucdDirectory === undefined) rmSync(directory, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`gen_fold_table: ${error.message}`);
  process.exit(1);
});
