/**
 * The workspace disk's fold profile, found once per coordinator process.
 *
 * Eleven vectors ask the disk itself whether two spellings reach one file.
 * Vector 1 compares `.COHERENCE` with `.coherence` and creates nothing. Vectors
 * 2 to 11 each create one spelling with O_CREAT | O_EXCL in a fresh directory
 * under `.coherence` and look up the other. A vector answers yes when both
 * spellings reach the same (st_dev, st_ino). The answers either match one of
 * the known profiles exactly, or the disk is cannot-tell and folds nothing:
 * guessing a fold could merge two real files, or split one.
 *
 * The probe runs only while this process holds the workspace's single
 * coordinator lock, so it can sweep the probe directories a crashed start
 * left without unlinking the files of a start that is probing right now.
 * Nothing about the profile is written to the store: it is kept in memory
 * and found again at every start.
 */
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  type BigIntStats,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { FoldProfile } from './path_fold.js';

export interface FoldProfileResult {
  profile: FoldProfile;
  status: 'classified' | 'cannot_tell';
  /** Why the disk could not be classified; only on cannot_tell. */
  reason?: string;
}

export interface FoldProbeInput {
  root: string;
  coherenceDir: string;
  /** Whether this process holds the workspace's single-coordinator lock. */
  lockState: 'held' | 'unlocked';
  /** Receives one line for each stale entry the sweep leaves in place. */
  log: (line: string) => void;
  /** The device a path is on; replaced in tests to put `.coherence` on another one. */
  deviceOf?: (path: string) => bigint;
}

/** Every directory the probe creates in `.coherence` starts with this. */
export const PROBE_DIR_PREFIX = 'fold-probe-';

/**
 * Vectors 2 to 11: the spelling created, then the spelling looked up. Each
 * carries a `p` before it in the file name, as when the answers were measured.
 */
const CREATED_VECTORS: readonly (readonly [created: string, probed: string])[] = [
  ['\u00e9', 'e\u0301'],
  ['\u00df', 'ss'],
  ['\u212a', 'K'],
  ['\u212a', 'k'],
  ['\uab70', '\u13a0'],
  ['\u03c2', '\u03c3'],
  ['a\u0323\u0302', 'a\u0302\u0323'],
  ['\u0131', 'i'],
  ['a\u200cb', 'ab'],
  ['\uff41', 'a'],
];

/** Measured: case-insensitive APFS, case-sensitive APFS, and a disk that folds nothing. */
const KNOWN_ANSWERS: ReadonlyMap<string, FoldProfile> = new Map([
  ['11111111000', 'caseless'],
  ['01010001000', 'nfd'],
  ['00000000000', 'none'],
]);

function cannotTell(reason: string): FoldProfileResult {
  return { profile: 'none', status: 'cannot_tell', reason };
}

/** The profile whose answers these are, or cannot-tell when they match none exactly. */
export function classifyVectorAnswers(answers: readonly boolean[]): FoldProfileResult {
  const pattern = answers.map((answer) => (answer ? '1' : '0')).join('');
  const profile = KNOWN_ANSWERS.get(pattern);
  if (profile === undefined) return cannotTell(`answers ${pattern} match no known profile`);
  return { profile, status: 'classified' };
}

/** A filesystem step of the probe failed; its message is the cannot-tell reason. */
class ProbeStepFailed extends Error {}

function attempt<T>(failure: string, step: () => T): T {
  try {
    return step();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    throw new ProbeStepFailed(`${failure}: ${code}`);
  }
}

function sameFile(first: BigIntStats, second: BigIntStats | undefined): boolean {
  return second !== undefined && first.dev === second.dev && first.ino === second.ino;
}

/** lstat, never stat: a committed `.COHERENCE` link to `.coherence` is a link, not case folding. */
function answerCaseVector(root: string): boolean {
  return attempt('vector 1 could not be read', () => {
    const lower = lstatSync(join(root, '.coherence'), { bigint: true });
    return sameFile(
      lower,
      lstatSync(join(root, '.COHERENCE'), { bigint: true, throwIfNoEntry: false })
    );
  });
}

const CREATE_FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;

function answerCreatedVector(
  probeDir: string,
  vector: readonly [string, string],
  number: number
): boolean {
  const [created, probed] = vector;
  const createdPath = join(probeDir, `p${created}`);
  attempt(`vector ${number} could not be created`, () =>
    closeSync(openSync(createdPath, CREATE_FLAGS, 0o600))
  );
  try {
    return attempt(`vector ${number} could not be read`, () =>
      sameFile(
        lstatSync(createdPath, { bigint: true }),
        lstatSync(join(probeDir, `p${probed}`), { bigint: true, throwIfNoEntry: false })
      )
    );
  } finally {
    attempt(`vector ${number} could not be removed`, () => unlinkSync(createdPath));
  }
}

function answerCreatedVectors(coherenceDir: string): boolean[] {
  const name = `${PROBE_DIR_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`;
  const probeDir = join(coherenceDir, name);
  attempt('probe directory could not be created', () => mkdirSync(probeDir, { mode: 0o700 }));
  try {
    return CREATED_VECTORS.map((vector, index) => answerCreatedVector(probeDir, vector, index + 2));
  } finally {
    attempt('probe directory could not be removed', () => rmdirSync(probeDir));
  }
}

/** Remove `path` when it is a regular file; leave anything else, a link included, and say so. */
function removeRegularFile(path: string, log: (line: string) => void): boolean {
  if (!lstatSync(path).isFile()) {
    log(`left ${path} in place: not a regular file`);
    return false;
  }
  unlinkSync(path);
  return true;
}

/**
 * Remove one stale probe directory: only the regular files directly in it,
 * then the directory once it is empty. A link is never followed or entered.
 */
function sweepEntry(path: string, log: (line: string) => void): boolean {
  try {
    if (!lstatSync(path).isDirectory()) {
      log(`left ${path} in place: not a directory`);
      return false;
    }
    const removed = readdirSync(path).map((name) => removeRegularFile(join(path, name), log));
    if (!removed.every(Boolean)) return false;
    rmdirSync(path);
    return true;
  } catch (err) {
    log(`left ${path} in place: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
    return false;
  }
}

/** Whether every stale probe directory was removed. */
function sweepStaleProbeDirs(coherenceDir: string, log: (line: string) => void): boolean {
  const names = attempt('.coherence could not be listed', () => readdirSync(coherenceDir));
  const stale = names.filter((name) => name.startsWith(PROBE_DIR_PREFIX));
  return stale.map((name) => sweepEntry(join(coherenceDir, name), log)).every(Boolean);
}

function statDevice(path: string): bigint {
  return attempt(`${path} could not be read`, () => statSync(path, { bigint: true }).dev);
}

function classifyLockedDisk(input: FoldProbeInput): FoldProfileResult {
  // A planted entry can make the start cannot-tell; it never decides a profile.
  if (!sweepStaleProbeDirs(input.coherenceDir, input.log)) {
    return cannotTell('stale probe entries left in place');
  }
  const deviceOf = input.deviceOf ?? statDevice;
  // Probe files elsewhere would classify that other disk, not the workspace's.
  if (deviceOf(input.root) !== deviceOf(input.coherenceDir)) {
    return cannotTell('coherence dir on another device');
  }
  const caseAnswer = answerCaseVector(input.root);
  return classifyVectorAnswers([caseAnswer, ...answerCreatedVectors(input.coherenceDir)]);
}

/**
 * Classify the workspace disk. Never throws for a filesystem failure: any
 * step that fails makes the disk cannot-tell, with the step as the reason.
 */
export function probeFoldProfile(input: FoldProbeInput): FoldProfileResult {
  // Without the lock another start may be probing: a sweep could unlink its files.
  if (input.lockState !== 'held') return cannotTell('unlocked');
  try {
    return classifyLockedDisk(input);
  } catch (err) {
    if (err instanceof ProbeStepFailed) return cannotTell(err.message);
    throw err;
  }
}

/** The one start-log line that names the profile, and on cannot-tell the reason. */
export function foldProfileLogLine(result: FoldProfileResult): string {
  const line = `workspace disk fold profile: ${result.profile}`;
  return result.status === 'classified' ? line : `${line} (cannot tell: ${result.reason ?? ''})`;
}
