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
import type { FoldProfile } from '../path_fold.js';
import {
  automatonStepsTaken,
  PolicyRef,
  TrackedArtifactPolicy,
  type PolicyMatchContext,
} from '../policy.js';

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
  // A class stays as written in the folded pattern, so the folded reading alone does not match.
  assert.equal(policy.isTracked('a.md', file('caseless')), false);
  // A disk that folds nothing matches by the request spelling alone.
  assert.equal(policy.isTracked('a.md', file('none', disk)), false);
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
