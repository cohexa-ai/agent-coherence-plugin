/**
 * Policy on folded text: on a disk that folds names, every spelling of a file
 * meets the same globs, and every name a glob matched before still matches.
 *
 * A name matches a glob when any of three readings does: the pattern as
 * written against the name as requested (tidied, for a file), the pattern as
 * written against the spelling the disk stores, and the folded pattern against
 * the folded name. The last two apply only on a folding profile. A key, a name
 * that is not a workspace file, is matched by its exact name alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strictUntrackRefusal } from '../hooks/policy_routes.js';
import {
  foldOneCodePoint,
  policyFoldText,
  singleFoldPreimages,
  type FoldingProfile,
  type FoldProfile,
} from '../path_fold.js';
import {
  automatonStepsTaken,
  foldGlobLiterals,
  globMatch,
  PolicyRef,
  TrackedArtifactPolicy,
  type PolicyMatchContext,
} from '../policy.js';
import classFoldVectors from './fixtures/policy_class_fold_vectors.json' with { type: 'json' };

interface PolicyFiles {
  tracked?: string[];
  ignored?: string[];
  strict?: string[];
}

const PROFILES: ReadonlyArray<FoldProfile> = ['none', 'nfd', 'caseless'];

function writePolicy(root: string, files: PolicyFiles): void {
  mkdirSync(join(root, '.coherence'), { recursive: true });
  const write = (name: string, entries: string[] | undefined): void => {
    if (entries === undefined) return;
    const text = entries.map((entry) => `- ${JSON.stringify(entry)}`).join('\n') + '\n';
    writeFileSync(join(root, '.coherence', name), text, 'utf8');
  };
  write('tracked.yaml', files.tracked);
  write('ignored.yaml', files.ignored);
  write('strict_mode.yaml', files.strict);
}

function policyWith(files: PolicyFiles): TrackedArtifactPolicy {
  const root = mkdtempSync(join(tmpdir(), 'policy-fold-'));
  try {
    writePolicy(root, files);
    return TrackedArtifactPolicy.load(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function file(profile: FoldProfile, diskSpelling?: string): PolicyMatchContext {
  return diskSpelling === undefined
    ? { profile, kind: 'file' }
    : { profile, kind: 'file', diskSpelling };
}

function key(profile: FoldProfile): PolicyMatchContext {
  return { profile, kind: 'key' };
}

/** The spelling a real directory stores and lists `name` under. */
function storedSpelling(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'policy-fold-disk-'));
  try {
    writeFileSync(join(dir, name), '');
    const [stored] = readdirSync(dir);
    return stored!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What `run` writes to stderr, line by line, with its result. */
function capturingStderr<T>(run: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => (
    lines.push(String(chunk)),
    true
  )) as typeof process.stderr.write;
  try {
    return { result: run(), lines };
  } finally {
    process.stderr.write = original;
  }
}

function linkLines(lines: ReadonlyArray<string>): string[] {
  return lines.filter((line) => line.includes('through the link'));
}

// ------------------------------------------------------------- folded matches

test('a strict plan.md makes PLAN.MD strict on a caseless disk, and not on one that keeps case', () => {
  const policy = policyWith({ strict: ['plan.md'] });
  assert.equal(policy.isStrictMode('PLAN.MD', file('caseless')), true);
  assert.equal(policy.isTracked('PLAN.MD', file('caseless')), true);
  const ref = new PolicyRef(policy);
  assert.equal(ref.isStrictMode('PLAN.MD', file('caseless')), true);
  assert.equal(ref.isTracked('PLAN.MD', file('caseless')), true);
  for (const profile of ['none', 'nfd'] as const) {
    assert.equal(policy.isStrictMode('PLAN.MD', file(profile)), false, profile);
    assert.equal(policy.isTracked('PLAN.MD', file(profile)), false, profile);
  }
  assert.equal(policy.isStrictMode('PLAN.MD'), false);
});

test('data/** covers DATA/x.txt on a caseless disk', () => {
  const policy = policyWith({ tracked: ['data/**'], strict: ['data/**'] });
  assert.equal(policy.isTracked('DATA/x.txt', file('caseless')), true);
  assert.equal(policy.isStrictMode('DATA/x.txt', file('caseless')), true);
  assert.equal(policy.isTracked('DATA/x.txt', file('none')), false);
});

test('data/caf?.txt matches the composed and the decomposed request by the folded reading', () => {
  const composed = 'data/caf\u00e9.txt';
  const decomposed = 'data/cafe\u0301.txt';
  const policy = policyWith({ tracked: ['data/caf?.txt'] });
  for (const profile of ['nfd', 'caseless'] as const) {
    assert.equal(policy.isTracked(composed, file(profile)), true, profile);
    assert.equal(policy.isTracked(decomposed, file(profile)), true, profile);
  }
  // A disk that folds nothing keeps the two forms apart in policy too: '?' meets one code point.
  assert.equal(policy.isTracked(composed, file('none')), true);
  assert.equal(policy.isTracked(decomposed, file('none')), false);
});

test('a pattern is folded where its literal characters stand, never tidied', () => {
  // Tidied, the lone '.' between the stars would vanish and leave notes/**.
  const policy = policyWith({ tracked: ['notes/*.*'] });
  assert.equal(policy.isTracked('NOTES/A.B', file('caseless')), true);
  assert.equal(policy.isTracked('NOTES/AB', file('caseless')), false);
});

test('a name over the fold limit is matched as requested only', () => {
  const policy = policyWith({});
  const deep = 'D/'.repeat(520) + 'PLAN.MD';
  assert.equal(policy.isTracked('D/PLAN.MD', file('caseless')), true);
  assert.equal(policy.isTracked(deep, file('caseless')), false);
  assert.equal(policy.isTracked(deep.toLowerCase(), file('caseless')), true);
});

// -------------------------------------------------------------- disk spelling

test('with a file stra\u00dfe.md on disk, stra?e.md matches a request STRASSE.MD by the disk spelling', () => {
  const disk = storedSpelling('stra\u00dfe.md');
  const policy = policyWith({ tracked: ['stra?e.md'] });
  assert.equal(policy.isTracked('STRASSE.MD', file('caseless', disk)), true);
  // Folded, the request is strasse.md, which '?' cannot meet: only the disk spelling matches.
  assert.equal(policy.isTracked('STRASSE.MD', file('caseless')), false);
});

test('with a file A.md on disk, [A-Z]*.md matches a request a.md by the disk spelling', () => {
  const disk = storedSpelling('A.md');
  const policy = policyWith({ tracked: ['[A-Z]*.md'] });
  assert.equal(policy.isTracked('a.md', file('caseless', disk)), true);
  // The folded class holds a-z as well, so the folded reading alone matches too.
  assert.equal(policy.isTracked('a.md', file('caseless')), true);
  // A disk that folds nothing matches by the request spelling alone.
  assert.equal(policy.isTracked('a.md', file('none', disk)), false);
});

// -------------------------------------------------------------- folded classes

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = UPPER.toLowerCase();
const GRIN = String.fromCodePoint(0x1f600);

function assertFoldsTo(profile: FoldingProfile, cases: ReadonlyArray<[string, string]>): void {
  for (const [pattern, folded] of cases) {
    assert.equal(foldGlobLiterals(pattern, profile), folded, `${pattern} on ${profile}`);
  }
}

function codePointRange(first: number, last: number): string {
  return String.fromCodePoint(...Array.from({ length: last - first + 1 }, (_, k) => first + k));
}

test('a class gains the folds of its members on a caseless disk', () => {
  assertFoldsTo('caseless', [
    // The Kelvin sign and the long s fold to k and s, but they are not members, so they stay out.
    ['docs/[A-Z]*.md', `docs/[${UPPER}${LOWER}]*.md`],
    ['[P]', '[Pp]'],
    // A class that already holds the folds of its members is copied as written.
    ['[a-z]', '[a-z]'],
    ['[Pp]', '[Pp]'],
    // A member that folds to two characters (the sharp s to ss) adds nothing.
    ['[\u00df]', '[\u00df]'],
    ['[S\u00df]', '[Ss\u00df]'],
    ['[ZA]', '[AZaz]'],
  ]);
});

test('a negated class keeps only the members no spelling outside it folds to', () => {
  assertFoldsTo('caseless', [
    // Each letter is also spelled in upper case, which the class accepts.
    ['[!a-z]', '?'],
    ['docs/[!a-z]*.md', 'docs/?*.md'],
    // Nothing folds to P, so a folded name never holds it and the class stays.
    ['[!P]', '[!P]'],
    ['[!Pp]', '[!Pp]'],
    // The long s folds to s and the class accepts it, so s goes.
    ['[!Ss]', '[!S]'],
  ]);
});

test('on an nfd disk an ASCII class is unchanged, though the Kelvin sign is a spelling of K', () => {
  assertFoldsTo('nfd', [
    ['docs/[A-Z]*.md', 'docs/[A-Z]*.md'],
    ['[!a-z]', '[!a-z]'],
    ['[\u212a]', '[K\u212a]'],
    ['[!K]', '?'],
    ['[!A-Z]', '[!ABCDEFGHIJLMNOPQRSTUVWXYZ]'],
  ]);
});

test('a folded class lists each member once: ] first, - last, and no leading ! unless negated', () => {
  assertFoldsTo('caseless', [
    ['[]!P-]', '[]!Pp-]'],
    ['[P!-]', '[Pp!-]'],
    ['[P!]', '[Pp!]'],
    ['[!]a-]', '[!]-]'],
    ['[!!a]', '[!!]'],
    ['[!!Pa]', '[!!P]'],
    // By code point, not by UTF-16 unit, which would put the astral member first.
    [`[${GRIN}\uff21]`, `[\uff21\uff41${GRIN}]`],
  ]);
});

test('the code points that fold to one code point are read from the fold table', () => {
  assert.equal(foldOneCodePoint('\u212a', 'caseless'), 'k');
  assert.equal(foldOneCodePoint('\u00df', 'caseless'), undefined);
  const sorted = (target: string, profile: FoldingProfile): string[] =>
    [...singleFoldPreimages(target, profile)].sort();
  assert.deepEqual(sorted('k', 'caseless'), ['K', 'k', '\u212a']);
  assert.deepEqual(sorted('s', 'caseless'), ['S', 's', '\u017f']);
  // P folds to p, so nothing, P included, folds to P.
  assert.deepEqual(sorted('P', 'caseless'), []);
  // A table key that folds to itself is listed once.
  assert.deepEqual(sorted('\u00e9', 'caseless'), ['\u00c9', '\u00e9']);
  assert.deepEqual(sorted('K', 'nfd'), ['K', '\u212a']);
});

test('the fold of one code point is the fold of its text, for every code point of the scan', () => {
  // It is looked up in a map of the table's domain, and every other code point is taken to fold
  // to itself: checked against folding the text of each code point of the basic plane and Deseret.
  const scanned = [
    ...Array.from({ length: 0xd800 }, (_, k) => k),
    ...Array.from({ length: 0x2000 }, (_, k) => 0xe000 + k),
    ...Array.from({ length: 0x50 }, (_, k) => 0x10400 + k),
  ];
  for (const profile of ['caseless', 'nfd'] as const) {
    const mismatches = scanned.filter((codePoint) => {
      const character = String.fromCodePoint(codePoint);
      const folded = policyFoldText(character, profile);
      const expected = Array.from(folded).length === 1 ? folded : undefined;
      return foldOneCodePoint(character, profile) !== expected;
    });
    assert.deepEqual(mismatches, [], profile);
  }
});

/**
 * Over the characters `folds` maps to their one-code-point folds, a folded
 * class accepts the fold of each character the class as written accepts, and
 * accepts a folded character only when one folding to it is accepted as written.
 */
function assertFoldedClassSound(
  pattern: string,
  profile: FoldingProfile,
  folds: ReadonlyMap<string, string>
): void {
  const folded = foldGlobLiterals(pattern, profile);
  const acceptedFolds = new Set<string>();
  for (const [character, fold] of folds) if (globMatch(character, pattern)) acceptedFolds.add(fold);
  for (const fold of acceptedFolds) {
    assert.ok(globMatch(fold, folded), `${pattern} -> ${folded} on ${profile} rejects ${fold}`);
  }
  for (const [character, fold] of folds) {
    if (fold !== character || !globMatch(character, folded)) continue;
    assert.ok(acceptedFolds.has(character), `${pattern} -> ${folded} on ${profile} adds ${fold}`);
  }
}

test('a folded class accepts the folds of what the class accepts, and no other folded character', () => {
  const codePoints = [
    ...Array.from({ length: 0x230 }, (_, k) => 0x20 + k),
    ...[0x37e, 0x3a9, 0x3c9, 0x1e9e, 0x1fef, 0x2126, 0x212a, 0x212b, 0xff21, 0xff41, 0x1f600],
  ];
  const patterns = [
    ...['[A-Z]', '[a-z]', '[!a-z]', '[!A-Z]', '[P]', '[!P]', '[!Pp]', '[Ss]', '[!Ss]'],
    ...['[k]', '[!k]', '[K]', '[!K]', '[\u212a]', '[!\u212a]', '[;]', '[!;]'],
    ...['[\u00c0-\u00df]', '[!\u00e0-\u00ff]', '[\u212b]', '[!\u00c5]'],
    ...['[]!P-]', '[P!-]', '[!]a-]'],
    // fnmatch drops the reversed range z-a with both its ends, so the ! left first negates: [^X].
    '[z-a!X]',
    // 39 members as written and 65 folded, past the 64 a class as written may list.
    '[A-Z0-9_.-]',
  ];
  for (const profile of ['caseless', 'nfd'] as const) {
    const folds = new Map<string, string>();
    for (const codePoint of codePoints) {
      const character = String.fromCodePoint(codePoint);
      const fold = foldOneCodePoint(character, profile);
      if (fold !== undefined) folds.set(character, fold);
    }
    for (const pattern of patterns) assertFoldedClassSound(pattern, profile, folds);
  }
});

test('a class of over 64 members, or with a range over 64, is copied as written', () => {
  // 65 and 64 members: only the first is too wide to fold.
  assertFoldsTo('caseless', [
    ['[A-Z0-9\u00c0-\u00dc]', '[A-Z0-9\u00c0-\u00dc]'],
    [
      '[A-Z0-9\u00c0-\u00db]',
      `[0123456789${UPPER}${LOWER}${codePointRange(0xc0, 0xdb)}` +
        `${codePointRange(0xe0, 0xf6)}${codePointRange(0xf8, 0xfb)}]`,
    ],
    // A range of 65 code points and one of 64: the last member of the second folds outside it.
    ['[\u0100-\u0140]', '[\u0100-\u0140]'],
    ['[\u0100-\u013f]', `[${codePointRange(0x100, 0x140)}]`],
  ]);
});

test('in a pattern with ** a [ is a literal, folded where it stands', () => {
  assertFoldsTo('caseless', [['DOCS/**/[A-Z]*.md', 'docs/**/[a-z]*.md']]);
});

test('every pattern folds to the text the vectors shared with the Python coordinator name', () => {
  // The Python coordinator runs a byte-identical copy of this file against its own fold, so a
  // pattern folds to the same text in both, and every spelling of a file gets the same answer.
  // Both profiles present, so an emptied or one-sided file cannot pass.
  const profiles = new Set(classFoldVectors.map((vector) => vector.profile));
  assert.deepEqual([...profiles].sort(), ['caseless', 'nfd']);
  const mismatches = classFoldVectors
    .map((vector) => ({
      ...vector,
      got: foldGlobLiterals(vector.pattern, vector.profile as FoldingProfile),
    }))
    .filter((vector) => vector.got !== vector.folded);
  assert.deepEqual(mismatches, []);
});

test('with docs/plan.md on a caseless disk, a strict docs/[A-Z]*.md holds every spelling', () => {
  const policy = policyWith({ strict: ['docs/[A-Z]*.md'] });
  for (const spelling of ['docs/plan.md', 'docs/Plan.md', 'docs/PLAN.md']) {
    assert.equal(policy.isStrictMode(spelling, file('caseless', 'docs/plan.md')), true, spelling);
  }
  // Untracking the lowercase spelling would untrack the file the strict pattern holds.
  assert.deepEqual(policy.strictPatternsCovering('docs/plan.md', 'caseless'), ['docs/[A-Z]*.md']);
  // A disk that keeps case apart keeps plan.md a file of its own, which the class does not match.
  assert.equal(policy.isStrictMode('docs/plan.md', file('none')), false);
  assert.deepEqual(policy.strictPatternsCovering('docs/plan.md', 'none'), []);
});

test('with docs/todo.md on a caseless disk, a strict docs/[z-a!X]ODO.md holds every spelling', () => {
  // fnmatch reads [z-a!X] as [^X]: it drops z-a with both its ends, and the ! left first negates.
  // As written it holds docs/TODO.md, so folded it must hold docs/todo.md, the disk's spelling.
  const policy = policyWith({ tracked: ['**'], strict: ['docs/[z-a!X]ODO.md'] });
  for (const spelling of ['docs/todo.md', 'docs/Todo.md', 'docs/TODO.md']) {
    assert.equal(policy.isStrictMode(spelling, file('caseless', 'docs/todo.md')), true, spelling);
  }
});

test('untracking a name a strict class folded past 64 members does not spell is allowed', () => {
  // [A-Z0-9_.-] lists 39 members, 65 folded: past the 64 a class as written may list before the
  // search reads it as any one character. The folded search still lists it, so an entry naming
  // # or ~ there covers nothing, as on a disk that folds nothing.
  const policy = policyWith({ tracked: ['src/**'], strict: ['src/[A-Z0-9_.-]*.py'] });
  for (const entry of ['src/#foo.py', 'src/~x.py']) {
    assert.equal(policy.isStrictMode(entry, file('caseless')), false, entry);
    assert.deepEqual(policy.strictPatternsCovering(entry, 'caseless'), [], entry);
    assert.deepEqual(policy.strictPatternsCovering(entry, 'none'), [], entry);
  }
  assert.deepEqual(policy.strictPatternsCovering('src/foo.py', 'caseless'), [
    'src/[A-Z0-9_.-]*.py',
  ]);
  // So does an entry's class, folded as the strict and tracked patterns are.
  const hashNames = policyWith({ tracked: ['src/**'], strict: ['src/#*.py'] });
  assert.deepEqual(hashNames.strictPatternsCovering('src/[A-Z0-9_.-]*.py', 'caseless'), []);
  assert.deepEqual(hashNames.strictPatternsCovering('src/[#A-Z]*.py', 'caseless'), ['src/#*.py']);
});

test('the folded search lists a range of up to twice 64 characters', () => {
  // A range of 100 is too wide to fold and is copied as written, but the folded search lists it,
  // as it lists a class the fold grew: SRC/ meets src/ only folded, and # is not in the range.
  const policy = policyWith({ tracked: ['**'], strict: ['SRC/[\u0100-\u0163]*.py'] });
  assert.deepEqual(policy.strictPatternsCovering('src/#x.py', 'caseless'), []);
  assert.deepEqual(policy.strictPatternsCovering('src/\u0101x.py', 'caseless'), [
    'SRC/[\u0100-\u0163]*.py',
  ]);
});

test('with docs/plan.md on a caseless disk, a strict docs/[!a-z]*.md holds every spelling', () => {
  const policy = policyWith({ strict: ['docs/[!a-z]*.md'] });
  for (const spelling of ['docs/plan.md', 'docs/Plan.md', 'docs/PLAN.md']) {
    assert.equal(policy.isStrictMode(spelling, file('caseless', 'docs/plan.md')), true, spelling);
  }
  assert.equal(policy.isStrictMode('docs/plan.md', file('none')), false);
});

test('an ignored negated class answers every spelling of a file alike, and no more', () => {
  // px.md matches [!P]x.md as written, so on a caseless disk every spelling of it is ignored.
  const notP = policyWith({ tracked: ['*.md'], ignored: ['[!P]x.md'] });
  for (const spelling of ['px.md', 'Px.md', 'PX.MD']) {
    assert.equal(notP.isTracked(spelling, file('caseless')), false, spelling);
  }
  assert.equal(notP.isTracked('Px.md', file('none')), true);
  // [!Pp] rejects every spelling of p, so it ignores no spelling of px.md, and every one of qx.md.
  const notPp = policyWith({ tracked: ['*.md'], ignored: ['[!Pp]x.md'] });
  for (const spelling of ['px.md', 'Px.md', 'PX.MD']) {
    assert.equal(notPp.isTracked(spelling, file('caseless', 'px.md')), true, spelling);
  }
  for (const spelling of ['qx.md', 'Qx.md', 'QX.MD']) {
    assert.equal(notPp.isTracked(spelling, file('caseless', 'qx.md')), false, spelling);
  }
});

// ------------------------------------------------------------------------ keys

test('a key is matched by its exact name only', () => {
  const byGlob = policyWith({ tracked: ['reports/*.csv'] });
  assert.equal(byGlob.isTracked('Reports/q1.csv', key('caseless')), false);
  assert.equal(byGlob.isTracked('Reports/q1.csv', file('caseless')), true);

  const byPath = policyWith({ tracked: ['reports/q1.csv'] });
  assert.equal(byPath.isTracked('reports//q1.csv', key('caseless')), false);
  assert.equal(byPath.isTracked('reports//q1.csv', file('none')), true);

  const byExactName = policyWith({ tracked: ['reports//q1.csv'] });
  assert.equal(byExactName.isTracked('reports//q1.csv', key('caseless')), true);
});

// ------------------------------------------------------------- strict coverage

test('untracking PLAN.MD while a strict plan.md covers it is refused on a caseless disk', () => {
  const policy = policyWith({ strict: ['plan.md'] });
  assert.deepEqual(strictUntrackRefusal(['PLAN.MD'], policy, 'caseless'), {
    refused: [{ path: 'PLAN.MD', strict_patterns: ['plan.md'] }],
    rejected: [],
  });
  assert.equal(strictUntrackRefusal(['PLAN.MD'], policy, 'none'), null);
  assert.equal(strictUntrackRefusal(['PLAN.MD'], policy), null);
});

test('the coverage search folds both sides of a strict glob on a caseless disk', () => {
  const policy = policyWith({ tracked: ['data/**'], strict: ['data/*.json'] });
  assert.deepEqual(policy.strictPatternsCovering('DATA/**', 'caseless'), ['data/*.json']);
  assert.deepEqual(policy.strictPatternsCoveringEach(['DATA/**'], 'caseless'), [['data/*.json']]);
  assert.deepEqual(policy.strictPatternsCovering('DATA/**', 'none'), []);
  assert.deepEqual(policy.strictPatternsCovering('DATA/*.txt', 'caseless'), []);
});

test('a literal strict path only a folded tracked pattern reaches is covered on a caseless disk', () => {
  // **/plan.md reaches PLAN.MD only folded, so only a caseless disk holds it strict.
  const policy = policyWith({ strict: ['PLAN.MD'] });
  assert.deepEqual(policy.strictPatternsCovering('plan.md', 'caseless'), ['PLAN.MD']);
  assert.deepEqual(policy.strictPatternsCovering('plan.md', 'none'), []);
});

test('on a folding disk the coverage search still makes every refusal the unfolded search makes', () => {
  // Folded, the strict path is strasse.md, which '?' cannot meet; as written, it can.
  const policy = policyWith({ tracked: ['**'], strict: ['stra\u00dfe.md'] });
  for (const profile of PROFILES) {
    assert.deepEqual(
      policy.strictPatternsCovering('stra?e.md', profile),
      ['stra\u00dfe.md'],
      profile
    );
  }
});

test('on a disk that folds nothing the coverage search takes the steps it took before', () => {
  // The counts the unfolded search is pinned to, measured on the Python coordinator.
  const cases: Array<[PolicyFiles, Array<[string, boolean, number]>]> = [
    [
      { tracked: ['data/**'], strict: ['data/*.json'] },
      [
        ['data/**', true, 974],
        ['data/a.json', true, 982],
        ['**', true, 1074],
        ['*.json', true, 1146],
        ['data/a.txt', false, 0],
        ['./data/**', true, 974],
        ['data/[0-9]', false, 460],
        ['data/[!a-z].json', true, 2831],
        ['data/[a.json', true, 1195],
      ],
    ],
    [
      { strict: ['CLAUDE.md'] },
      [
        ['*.md', true, 10],
        ['C?AUDE.md', true, 10],
        ['**', true, 27],
        ['*/CLAUDE.md', false, 10],
      ],
    ],
    [
      { tracked: ['notes/**'], strict: ['notes/\u{1F600}.md'] },
      [
        ['*.md', true, 11],
        ['notes/?.md', true, 11],
      ],
    ],
  ];
  for (const [files, entries] of cases) {
    const policy = policyWith(files);
    for (const [entry, covers, steps] of entries) {
      const before = automatonStepsTaken();
      const covering = policy.strictPatternsCoveringEach([entry], 'none')[0]!;
      assert.deepEqual(
        [covering.length > 0, automatonStepsTaken() - before],
        [covers, steps],
        entry
      );
    }
  }
});

// ---------------------------------------------------------------------- safety

test('an ignored pattern never takes a strict path out of tracking, under any spelling', () => {
  const stored = 'notes/caf\u00e9.md';
  const policy = policyWith({
    tracked: ['notes/**'],
    strict: [stored],
    ignored: ['**', 'NOTES/CAF\u00c9.MD', 'notes/cafe\u0301.md'],
  });
  const spellings = [
    stored,
    'NOTES/CAF\u00c9.MD',
    'notes/cafe\u0301.md',
    'Notes/Cafe\u0301.md',
    './NOTES//caf\u00e9.md',
  ];
  for (const profile of PROFILES) {
    for (const spelling of spellings) {
      for (const context of [file(profile), file(profile, stored)]) {
        const where = `${spelling} on ${profile}, disk ${context.diskSpelling ?? 'none'}`;
        // Ignored '**' untracks every path strict does not hold.
        assert.equal(
          policy.isTracked(spelling, context),
          policy.isStrictMode(spelling, context),
          where
        );
      }
    }
  }
  // Not vacuous: on a caseless disk every spelling is strict, and so tracked.
  for (const spelling of spellings) {
    assert.equal(policy.isStrictMode(spelling, file('caseless')), true, spelling);
  }
});

test('.//data/x.txt and ././data/x.txt are tracked and strict under data/** on every profile', () => {
  const policy = policyWith({ tracked: ['data/**'], strict: ['data/**'] });
  for (const profile of PROFILES) {
    for (const spelling of ['.//data/x.txt', '././data/x.txt']) {
      assert.equal(policy.isTracked(spelling, file(profile)), true, `${spelling} on ${profile}`);
      assert.equal(policy.isStrictMode(spelling, file(profile)), true, `${spelling} on ${profile}`);
    }
  }
  assert.equal(policy.isTracked('.//data/x.txt'), true);
});

test('a glob written with // or /./ still matches a request typed the same way', () => {
  // Tidying the request must not lose a match the as-typed spelling had.
  const policy = policyWith({
    tracked: ['docs//plan.md', 'notes/./todo.md'],
    strict: ['notes/./todo.md'],
  });
  for (const profile of PROFILES) {
    assert.equal(
      policy.isTracked('docs//plan.md', file(profile)),
      true,
      `docs//plan.md on ${profile}`
    );
    assert.equal(
      policy.isStrictMode('notes/./todo.md', file(profile)),
      true,
      `notes/./todo.md on ${profile}`
    );
  }
  assert.equal(policy.isTracked('docs//plan.md'), true);
});

// ------------------------------------------------------------- linked prefixes

test('a tracked or strict glob whose literal prefix crosses a link inside the root is logged once', () => {
  const root = mkdtempSync(join(tmpdir(), 'policy-fold-link-'));
  try {
    mkdirSync(join(root, 'real'));
    mkdirSync(join(root, 'plain'));
    for (const link of ['linked', 'aliased', 'other']) symlinkSync('real', join(root, link));
    writePolicy(root, {
      tracked: ['aliased/**', 'plain/**'],
      strict: ['linked/*.md', 'plain/*.md'],
      ignored: ['other/**'],
    });

    const loaded = capturingStderr(() => TrackedArtifactPolicy.load(root));
    const atLoad = linkLines(loaded.lines);
    assert.equal(atLoad.length, 2, atLoad.join(''));
    assert.match(atLoad[0]!, /tracked pattern "aliased\/\*\*" .*through the link "aliased"/);
    assert.match(atLoad[1]!, /strict pattern "linked\/\*\.md" .*through the link "linked"/);

    const reloaded = capturingStderr(() => loaded.result.reloaded());
    assert.deepEqual(linkLines(reloaded.lines), []);

    appendFileSync(join(root, '.coherence', 'tracked.yaml'), '- "linked/deep/**"\n');
    const added = capturingStderr(() => reloaded.result.reloaded());
    const atReload = linkLines(added.lines);
    assert.equal(atReload.length, 1, atReload.join(''));
    assert.match(atReload[0]!, /tracked pattern "linked\/deep\/\*\*" .*through the link "linked"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a strict or tracked entry naming a linked file is logged once, naming the target', () => {
  const root = mkdtempSync(join(tmpdir(), 'policy-fold-link-'));
  try {
    mkdirSync(join(root, 'docs', 'v2'), { recursive: true });
    writeFileSync(join(root, 'docs', 'v2', 'spec.md'), 'spec');
    symlinkSync(join('v2', 'spec.md'), join(root, 'docs', 'current.md'));
    symlinkSync('missing.md', join(root, 'docs', 'dangle.md'));
    writePolicy(root, {
      tracked: ['docs/current.md', 'docs/v2/spec.md'],
      strict: ['docs/current.md', 'docs/v2/spec.md', 'docs/dangle.md'],
    });

    const loaded = capturingStderr(() => TrackedArtifactPolicy.load(root));
    const atLoad = linkLines(loaded.lines);
    // One line per entry, though the same entry is both tracked and strict.
    assert.equal(atLoad.length, 2, atLoad.join(''));
    assert.match(atLoad[1]!, /"docs\/dangle\.md" .*which does not resolve/);
    assert.match(atLoad[1]!, /sends nothing .* until its target exists/);
    assert.match(atLoad[0]!, /pattern "docs\/current\.md" .*through the link "docs\/current\.md"/);
    assert.match(atLoad[0]!, /the hook client follows the link/i);
    assert.match(atLoad[0]!, /its target "docs\/v2\/spec\.md", which this entry does not match/);
    assert.match(atLoad[0]!, /name the target to cover them/);

    const reloaded = capturingStderr(() => loaded.result.reloaded());
    assert.deepEqual(linkLines(reloaded.lines), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an entry through a link whose target is outside the workspace is logged as not coordinated', () => {
  const base = mkdtempSync(join(tmpdir(), 'policy-fold-link-'));
  try {
    const root = join(base, 'ws');
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(base, 'outside'));
    writeFileSync(join(base, 'outside', 'secret.md'), 'secret');
    symlinkSync(join(base, 'outside', 'secret.md'), join(root, 'data', 'out.md'));
    symlinkSync(join(base, 'outside'), join(root, 'ext'));
    writePolicy(root, { tracked: ['ext/**'], strict: ['data/out.md'] });

    const atLoad = linkLines(capturingStderr(() => TrackedArtifactPolicy.load(root)).lines);
    assert.equal(atLoad.length, 2, atLoad.join(''));
    assert.match(atLoad[0]!, /tracked pattern "ext\/\*\*" .*through the link "ext"/);
    assert.match(atLoad[1]!, /strict pattern "data\/out\.md" .*through the link "data\/out\.md"/);
    for (const line of atLoad) {
      assert.match(line, /target is outside the workspace/);
      assert.match(line, /not coordinated at all/);
      assert.doesNotMatch(line, /name the target/);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a link whose target spells the workspace in another case is read as inside it', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'policy-fold-link-'));
  try {
    const root = join(base, 'Repo');
    mkdirSync(join(root, 'docs'), { recursive: true });
    if (!existsSync(join(base, 'REPO'))) {
      t.skip('the temporary disk keeps two spellings apart, so REPO is another directory');
      return;
    }
    // The hook client meets the root under the disk's spelling, as it does here.
    symlinkSync(join(base, 'REPO', 'docs'), join(root, 'ext'));
    writePolicy(root, { strict: ['ext/*.md'] });

    const atLoad = linkLines(capturingStderr(() => TrackedArtifactPolicy.load(root)).lines);
    assert.equal(atLoad.length, 1, atLoad.join(''));
    assert.match(atLoad[0]!, /its target "docs", which this entry does not match/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a literal prefix the disk cannot look up is not logged and does not stop the load', () => {
  const root = mkdtempSync(join(tmpdir(), 'policy-fold-link-'));
  try {
    mkdirSync(join(root, 'notes'));
    // A directory name longer than any disk takes: looking it up fails with ENAMETOOLONG.
    const unreachable = `notes/${'n'.repeat(300)}/**`;
    writePolicy(root, { tracked: [unreachable] });
    const loaded = capturingStderr(() => TrackedArtifactPolicy.load(root));
    assert.deepEqual(loaded.result.userAddedPatterns, [unreachable]);
    assert.deepEqual(linkLines(loaded.lines), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
