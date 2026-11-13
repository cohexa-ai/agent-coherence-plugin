/**
 * The workspace disk's fold profile, found once per coordinator process.
 *
 * The classifier is driven with synthetic answer tables, one row per vector,
 * so a profile that stopped reading any one vector would show here. The probe
 * runs on real disks: this machine's temporary directory, and on macOS a fresh
 * case-sensitive APFS disk image. AGENT_COHERENCE_EXPECT_FOLD_PROFILE names the
 * profile a CI job expects of its runner's disk, so that job fails, never
 * skips, when the probe answers otherwise.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { FoldProfile } from '../path_fold.js';
import {
  PROBE_DIR_PREFIX,
  classifyVectorAnswers,
  probeFoldProfile,
  type FoldProbeInput,
  type FoldProfileResult,
} from '../fs_profile.js';
import { killAndWait } from './pid_lock_fixture.js';
import { serving, startCoordinator } from './coordinator_process_fixture.js';

const KNOWN_ROWS: readonly (readonly [FoldProfile, string])[] = [
  ['caseless', '11111111000'],
  ['nfd', '01010001000'],
  ['none', '00000000000'],
];

// The answers measured on disks no profile models; each must fold nothing.
const MEASURED_UNMODELED_ROWS: readonly (readonly [string, string])[] = [
  ['HFS+', '11000001010'],
  ['HFSX', '01000001000'],
  ['exFAT', '11011110000'],
  ['FAT32', '11000000000'],
];

const HAS_HDIUTIL =
  process.platform === 'darwin' && spawnSync('hdiutil', ['help']).error === undefined;
const IS_ROOT = process.getuid?.() === 0;

function answersOf(pattern: string): boolean[] {
  return [...pattern].map((answer) => answer === '1');
}

function patternOf(answers: readonly boolean[]): string {
  return answers.map((answer) => (answer ? '1' : '0')).join('');
}

/** The profile this runner's temporary directory must classify as, or null when no one says. */
function expectedTmpDiskProfile(): FoldProfile | null {
  const expected = process.env['AGENT_COHERENCE_EXPECT_FOLD_PROFILE'];
  if (expected !== undefined && expected !== '') return expected as FoldProfile;
  if (process.platform === 'darwin') return 'caseless';
  if (process.platform === 'linux') return 'none';
  return null;
}

const TMP_DISK_PROFILE = expectedTmpDiskProfile();
const NO_EXPECTATION = 'no expected fold profile for this platform';

interface Workspace {
  root: string;
  coherenceDir: string;
  logged: string[];
}

function makeWorkspaceIn(base: string): Workspace {
  assert.ok(isAbsolute(base) && base !== '/', `refusing to use ${JSON.stringify(base)}`);
  const root = mkdtempSync(join(base, 'fs-profile-'));
  const coherenceDir = join(root, '.coherence');
  mkdirSync(coherenceDir, { mode: 0o700 });
  return { root, coherenceDir, logged: [] };
}

function makeWorkspace(t: TestContext): Workspace {
  const workspace = makeWorkspaceIn(tmpdir());
  t.after(() => rmSync(workspace.root, { recursive: true, force: true }));
  return workspace;
}

function probeInput(workspace: Workspace, lockState: FoldProbeInput['lockState']): FoldProbeInput {
  return {
    root: workspace.root,
    coherenceDir: workspace.coherenceDir,
    lockState,
    log: (line) => workspace.logged.push(line),
  };
}

const PAST = new Date('2001-02-03T04:05:06Z');

/** Backdate `dir` so any entry created or removed in it shows as a new mtime. */
function backdate(dir: string): void {
  utimesSync(dir, PAST, PAST);
}

function touchedSinceBackdate(dir: string): boolean {
  return lstatSync(dir).mtimeMs !== PAST.getTime();
}

/** Every path under `dir` with its kind and, for a file, its content. */
function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isFile()) return `${name} file ${readFileSync(path, 'base64')}`;
      return `${name} ${info.isDirectory() ? 'dir' : 'other'} ${info.ino}`;
    });
}

function probeEntries(coherenceDir: string): string[] {
  return readdirSync(coherenceDir).filter((name) => name.startsWith(PROBE_DIR_PREFIX));
}

function createFile(path: string): void {
  closeSync(openSync(path, 'wx', 0o600));
}

for (const [profile, pattern] of KNOWN_ROWS) {
  test(`the answers ${pattern} classify the disk as ${profile}`, () => {
    assert.deepEqual(classifyVectorAnswers(answersOf(pattern)), { profile, status: 'classified' });
  });
}

for (let vector = 1; vector <= 11; vector += 1) {
  test(`vector ${vector} answering otherwise than every known profile is cannot-tell`, () => {
    for (const [, pattern] of KNOWN_ROWS) {
      const answers = answersOf(pattern);
      answers[vector - 1] = !answers[vector - 1];
      assert.deepEqual(classifyVectorAnswers(answers), {
        profile: 'none',
        status: 'cannot_tell',
        reason: `answers ${patternOf(answers)} match no known profile`,
      });
    }
  });
}

test('the answers measured on HFS+, HFSX, exFAT and FAT32 are cannot-tell', () => {
  for (const [disk, pattern] of MEASURED_UNMODELED_ROWS) {
    assert.equal(classifyVectorAnswers(answersOf(pattern)).status, 'cannot_tell', disk);
  }
});

test(
  'the real workspace disk classifies as this platform expects',
  { skip: TMP_DISK_PROFILE === null ? NO_EXPECTATION : false },
  (t) => {
    const workspace = makeWorkspace(t);
    assert.deepEqual(probeFoldProfile(probeInput(workspace, 'held')), {
      profile: TMP_DISK_PROFILE,
      status: 'classified',
    });
    assert.deepEqual(readdirSync(workspace.coherenceDir), []);
    assert.deepEqual(workspace.logged, []);
  }
);

function hdiutil(args: readonly string[]): void {
  const run = spawnSync('hdiutil', args, { encoding: 'utf8' });
  assert.equal(run.status, 0, `hdiutil ${args.join(' ')}: ${run.stderr}`);
}

/** Run `body` on a fresh case-sensitive APFS volume mounted under a temporary directory. */
async function onCaseSensitiveApfs(body: (mountPoint: string) => Promise<void>): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'fs-profile-image-'));
  assert.ok(isAbsolute(scratch), `refusing to use ${JSON.stringify(scratch)}`);
  const mountPoint = join(scratch, 'mnt');
  try {
    mkdirSync(mountPoint);
    hdiutil([
      'create',
      '-quiet',
      '-type',
      'SPARSE',
      '-fs',
      'Case-sensitive APFS',
      '-size',
      '32m',
      join(scratch, 'cs'),
    ]);
    hdiutil([
      'attach',
      '-quiet',
      '-nobrowse',
      '-mountpoint',
      mountPoint,
      join(scratch, 'cs.sparseimage'),
    ]);
    try {
      await body(mountPoint);
    } finally {
      hdiutil(['detach', '-quiet', '-force', mountPoint]);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** On a disk that keeps the two spellings apart, a committed link must answer vector 1 as 0. */
function assertCaseLinkReadsAsLink(base: string, expected: FoldProfile): void {
  const workspace = makeWorkspaceIn(base);
  try {
    symlinkSync('.coherence', join(workspace.root, '.COHERENCE'));
    assert.deepEqual(probeFoldProfile(probeInput(workspace, 'held')), {
      profile: expected,
      status: 'classified',
    });
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
}

test(
  'a case-sensitive APFS disk image classifies as nfd, and a committed .COHERENCE link there reads as a link',
  { skip: HAS_HDIUTIL ? false : 'needs hdiutil (macOS)' },
  async () => {
    await onCaseSensitiveApfs(async (mountPoint) => {
      const workspace = makeWorkspaceIn(mountPoint);
      assert.deepEqual(probeFoldProfile(probeInput(workspace, 'held')), {
        profile: 'nfd',
        status: 'classified',
      });
      assert.deepEqual(readdirSync(workspace.coherenceDir), []);
      assertCaseLinkReadsAsLink(mountPoint, 'nfd');
    });
  }
);

test(
  'a committed .COHERENCE link to .coherence on a case-sensitive temporary disk reads as a link',
  {
    skip: process.platform === 'linux' ? false : 'the case-sensitive disk here is the image above',
  },
  () => {
    assertCaseLinkReadsAsLink(tmpdir(), 'none');
  }
);

test('a .coherence on another device than the root is cannot-tell and creates no probe file', (t) => {
  const workspace = makeWorkspace(t);
  backdate(workspace.coherenceDir);
  const input: FoldProbeInput = {
    ...probeInput(workspace, 'held'),
    deviceOf: (path) => (path === workspace.coherenceDir ? 2n : 1n),
  };
  assert.deepEqual(probeFoldProfile(input), {
    profile: 'none',
    status: 'cannot_tell',
    reason: 'coherence dir on another device',
  });
  assert.equal(touchedSinceBackdate(workspace.coherenceDir), false);
});

test('an unlocked start is cannot-tell, runs no vector and sweeps nothing', (t) => {
  const workspace = makeWorkspace(t);
  const leftover = join(workspace.coherenceDir, `${PROBE_DIR_PREFIX}1-0badc0de`);
  mkdirSync(leftover, { mode: 0o700 });
  createFile(join(leftover, 'p\u00e9'));
  const before = snapshot(workspace.coherenceDir);
  backdate(workspace.coherenceDir);
  assert.deepEqual(probeFoldProfile(probeInput(workspace, 'unlocked')), {
    profile: 'none',
    status: 'cannot_tell',
    reason: 'unlocked',
  });
  assert.equal(touchedSinceBackdate(workspace.coherenceDir), false);
  assert.deepEqual(snapshot(workspace.coherenceDir), before);
});

test(
  'a read-only .coherence, where no probe file can be created, is cannot-tell and leaves nothing behind',
  { skip: IS_ROOT ? 'root creates files in a read-only directory' : false },
  (t) => {
    const workspace = makeWorkspace(t);
    chmodSync(workspace.coherenceDir, 0o500);
    let result: FoldProfileResult;
    try {
      result = probeFoldProfile(probeInput(workspace, 'held'));
    } finally {
      chmodSync(workspace.coherenceDir, 0o700);
    }
    assert.equal(result.profile, 'none');
    assert.equal(result.status, 'cannot_tell');
    assert.match(result.reason ?? '', /could not be created: EACCES$/);
    assert.deepEqual(readdirSync(workspace.coherenceDir), []);
  }
);

test(
  'probe files a crashed start left are swept at the next start, which then classifies the disk',
  { skip: TMP_DISK_PROFILE === null ? NO_EXPECTATION : false },
  (t) => {
    const workspace = makeWorkspace(t);
    const crashed = join(workspace.coherenceDir, `${PROBE_DIR_PREFIX}4242-0badc0de`);
    mkdirSync(crashed, { mode: 0o700 });
    createFile(join(crashed, 'p\u00e9'));
    createFile(join(crashed, 'p\u00df'));
    mkdirSync(join(workspace.coherenceDir, `${PROBE_DIR_PREFIX}4243-feedf00d`), { mode: 0o700 });
    assert.deepEqual(probeFoldProfile(probeInput(workspace, 'held')), {
      profile: TMP_DISK_PROFILE,
      status: 'classified',
    });
    assert.deepEqual(readdirSync(workspace.coherenceDir), []);
    assert.deepEqual(workspace.logged, []);
  }
);

interface Planted {
  outside: string;
  plantedLink: string;
  planted: string;
}

/** A link to a directory outside, and a stale directory holding a nested directory, a link and a file. */
function plantUnderProbePrefix(workspace: Workspace): Planted {
  const outside = join(workspace.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'kept.md'), 'kept\n');
  const plantedLink = join(workspace.coherenceDir, `${PROBE_DIR_PREFIX}link`);
  symlinkSync(outside, plantedLink);
  const planted = join(workspace.coherenceDir, `${PROBE_DIR_PREFIX}4242-0badc0de`);
  mkdirSync(planted, { mode: 0o700 });
  mkdirSync(join(planted, 'nested'));
  writeFileSync(join(planted, 'nested', 'kept.md'), 'kept\n');
  symlinkSync(join(outside, 'kept.md'), join(planted, 'p-link'));
  createFile(join(planted, 'p\u00e9'));
  return { outside, plantedLink, planted };
}

test('a link or nested directory planted under the probe prefix is logged, left alone, and makes the start cannot-tell', (t) => {
  const workspace = makeWorkspace(t);
  const { outside, plantedLink, planted } = plantUnderProbePrefix(workspace);
  const outsideBefore = snapshot(outside);
  backdate(workspace.coherenceDir);

  assert.deepEqual(probeFoldProfile(probeInput(workspace, 'held')), {
    profile: 'none',
    status: 'cannot_tell',
    reason: 'stale probe entries left in place',
  });

  assert.equal(lstatSync(plantedLink).isSymbolicLink(), true);
  assert.equal(lstatSync(join(planted, 'p-link')).isSymbolicLink(), true);
  assert.equal(readFileSync(join(planted, 'nested', 'kept.md'), 'utf8'), 'kept\n');
  assert.equal(existsSync(join(planted, 'p\u00e9')), false);
  assert.deepEqual(snapshot(outside), outsideBefore);
  assert.equal(touchedSinceBackdate(workspace.coherenceDir), false);
  for (const left of [plantedLink, join(planted, 'nested'), join(planted, 'p-link')]) {
    assert.ok(
      workspace.logged.some((line) => line.includes(left)),
      `no log line names ${left}:\n${workspace.logged.join('\n')}`
    );
  }
});

test(
  'a stale probe directory the sweep cannot list is logged and left alone, and the start is cannot-tell',
  { skip: IS_ROOT ? 'root lists any directory' : false },
  (t) => {
    const workspace = makeWorkspace(t);
    const unlistable = join(workspace.coherenceDir, `${PROBE_DIR_PREFIX}4242-0badc0de`);
    mkdirSync(unlistable, { mode: 0o700 });
    chmodSync(unlistable, 0o000);
    let result: FoldProfileResult;
    try {
      result = probeFoldProfile(probeInput(workspace, 'held'));
    } finally {
      chmodSync(unlistable, 0o700);
    }
    assert.deepEqual(result, {
      profile: 'none',
      status: 'cannot_tell',
      reason: 'stale probe entries left in place',
    });
    assert.equal(existsSync(unlistable), true);
    assert.deepEqual(workspace.logged, [`left ${unlistable} in place: EACCES`]);
  }
);

test(
  'a start without the lock, run while another start is probing, sweeps nothing and the probing start still classifies the disk',
  { skip: TMP_DISK_PROFILE === null ? NO_EXPECTATION : false },
  (t) => {
    const workspace = makeWorkspace(t);
    // The probing start's directory as it stands between creating vector 2's
    // file and looking up its other spelling.
    const probing = join(workspace.coherenceDir, `${PROBE_DIR_PREFIX}4242-0badc0de`);
    mkdirSync(probing, { mode: 0o700 });
    const created = join(probing, 'p\u00e9');
    createFile(created);
    const createdIno = lstatSync(created).ino;

    assert.equal(probeFoldProfile(probeInput(workspace, 'unlocked')).reason, 'unlocked');

    assert.equal(lstatSync(created).ino, createdIno);
    const otherSpelling = lstatSync(join(probing, 'pe\u0301'), { throwIfNoEntry: false });
    assert.equal(otherSpelling?.ino === createdIno, TMP_DISK_PROFILE !== 'none');
    rmSync(probing, { recursive: true });
    assert.deepEqual(probeFoldProfile(probeInput(workspace, 'held')), {
      profile: TMP_DISK_PROFILE,
      status: 'classified',
    });
  }
);

test('the probe leaves the workspace and the store as they were', (t) => {
  const workspace = makeWorkspace(t);
  mkdirSync(join(workspace.root, 'docs'));
  writeFileSync(join(workspace.root, 'docs', 'plan.md'), 'plan\n');
  writeFileSync(join(workspace.root, 'README.md'), 'readme\n');
  writeFileSync(join(workspace.coherenceDir, 'state.db'), Buffer.from([0, 1, 2, 3, 255]));
  backdate(workspace.root);
  const before = snapshot(workspace.root);
  probeFoldProfile(probeInput(workspace, 'held'));
  assert.deepEqual(snapshot(workspace.root), before);
  assert.equal(touchedSinceBackdate(workspace.root), false);
});

test(
  'a coordinator start logs one line naming the disk fold profile, before it opens the store',
  { skip: TMP_DISK_PROFILE === null ? NO_EXPECTATION : false },
  async (t) => {
    const workspace = makeWorkspace(t);
    const coordinator = startCoordinator(workspace.root);
    try {
      await serving(workspace.root, coordinator);
      const lines = coordinator.stderr().split('\n');
      const profileLines = lines.filter((line) => line.includes('workspace disk fold profile'));
      assert.deepEqual(profileLines, [
        `agent-coherence-coordinator: workspace disk fold profile: ${TMP_DISK_PROFILE}`,
      ]);
      const registryLine = lines.findIndex((line) => line.includes('registry opened'));
      assert.ok(lines.indexOf(profileLines[0]!) < registryLine, coordinator.stderr());
      assert.deepEqual(probeEntries(workspace.coherenceDir), []);
    } finally {
      await killAndWait(coordinator.child);
    }
  }
);
