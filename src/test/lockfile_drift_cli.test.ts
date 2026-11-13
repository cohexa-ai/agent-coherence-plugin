/**
 * End-to-end tests for `tools/check_lockfile_drift.js`.
 *
 * The verdict function is covered exhaustively in lockfile_drift.test.ts. What
 * those tests cannot reach is everything between the CLI entry point and that
 * function: the `contents?ref=` URL for each branch, the base64/JSON decode,
 * the per-ref status branching, and the exit code. Without the cases below the
 * whole check could be deleted — or wired to read one ref twice — with the
 * suite still green, which is the same silent-control failure the check itself
 * exists to catch on the Dependabot side.
 *
 * Each case spawns the real CLI against a fake `gh` on PATH. The last case is
 * the exception and covers the one thing spawning the CLI cannot: that the
 * workflow invokes it at all. A guard that never runs and a guard that runs
 * clean look identical from here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeExecutable } from './executable_fixture.js';
import { load as loadYaml } from 'js-yaml';

// __dirname at runtime is dist/test/; plugin root is two levels up.
const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(__filename), '..', '..');
const TOOL = join(PLUGIN_ROOT, 'tools', 'check_lockfile_drift.js');
const WORKFLOW = join(PLUGIN_ROOT, '.github', 'workflows', 'lockfile-drift.yml');

/** How the fake `gh` answers the two `contents` reads. */
type LockBehavior =
  | { kind: 'perRef'; main: Record<string, string>; dev: Record<string, string> }
  | { kind: 'http'; code: 403 | 404 }
  // No `gh` on PATH at all. Not a variant of the HTTP failures: nothing was
  // asked and nothing answered, and the tool has a distinct message for it.
  | { kind: 'absent' };

/** A `contents` API envelope wrapping a minimal lockfile of name -> version. */
function envelope(versions: Record<string, string>): string {
  const packages: Record<string, unknown> = { '': { name: 'p', version: '0.5.0' } };
  for (const [name, version] of Object.entries(versions)) {
    packages[`node_modules/${name}`] = { version };
  }
  const body = JSON.stringify({ lockfileVersion: 3, packages });
  return JSON.stringify({ encoding: 'base64', content: Buffer.from(body).toString('base64') });
}

function writeFakeGh(dir: string, lock: LockBehavior): string {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  // An empty bin dir IS the fixture for 'absent': the caller prepends it to a
  // PATH stripped of everything else, so the shell finds no `gh` anywhere.
  if (lock.kind === 'absent') return binDir;
  let cases: string[];
  if (lock.kind === 'http') {
    const label = lock.code === 404 ? 'Not Found' : 'Forbidden';
    cases = [
      `  repos/*/contents/package-lock.json*) echo "gh: ${label} (HTTP ${lock.code})" >&2; exit 1 ;;`,
    ];
  } else {
    const mainLock = join(dir, 'lock_main.json');
    const devLock = join(dir, 'lock_dev.json');
    writeFileSync(mainLock, envelope(lock.main));
    writeFileSync(devLock, envelope(lock.dev));
    // Keyed on `?ref=`: serving one shared body for every ref cannot tell the
    // check running from the check never running, which is the whole point.
    cases = [
      `  repos/*/contents/package-lock.json*ref=main) cat "${mainLock}" ;;`,
      `  repos/*/contents/package-lock.json*ref=dev) cat "${devLock}" ;;`,
    ];
  }
  const script = [
    '#!/usr/bin/env bash',
    '# Fake gh for lockfile-drift CLI tests: supports `gh api <path>`.',
    'path="$2"',
    'case "$path" in',
    ...cases,
    '  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;',
    'esac',
  ].join('\n');
  const ghPath = join(binDir, 'gh');
  writeExecutable(ghPath, `${script}\n`);
  return binDir;
}

function withFakeGh(
  lock: LockBehavior,
  run: (res: { status: number; stdout: string; stderr: string }) => void
): void {
  const dir = mkdtempSync(join(tmpdir(), 'lockfile-drift-'));
  try {
    const binDir = writeFakeGh(dir, lock);
    // 'absent' must not inherit the real PATH, or the developer's own `gh`
    // answers and the case silently tests something else. process.execPath is
    // absolute, so node itself still starts.
    const path = lock.kind === 'absent' ? binDir : `${binDir}:${process.env['PATH'] ?? ''}`;
    const res = spawnSync(process.execPath, [TOOL], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: path },
      timeout: 30000,
    });
    run({ status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('cli: dev behind main on a package → exit 1 naming it', () => {
  withFakeGh({ kind: 'perRef', main: { 'js-yaml': '4.3.2' }, dev: { 'js-yaml': '4.3.1' } }, (res) => {
    assert.equal(res.status, 1, `drift must exit non-zero:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /js-yaml \(dev 4\.3\.1 < main 4\.3\.2\)/);
    assert.match(res.stdout, /forward-merge main into dev/);
  });
});

test('cli: the two refs are read distinctly and in the right order', () => {
  // dev AHEAD of main must exit 0. This separates a CLI that reads two distinct
  // refs from one that reads `main` twice (which would also pass here, but
  // fails the drift case above), and from one that swapped the comparison
  // arguments (which would report drift here).
  withFakeGh({ kind: 'perRef', main: { 'js-yaml': '4.3.1' }, dev: { 'js-yaml': '4.3.2' } }, (res) => {
    assert.equal(res.status, 0, `dev ahead is normal, not drift:\n${res.stdout}`);
    assert.match(res.stdout, /no package in dev's lockfile is older than main's/);
  });
});

test('cli: a 403 stays a WARN in the level but still exits 1', () => {
  // The level and the exit code answer different questions. 403 is about the
  // token, not the lockfiles, so it is not a FAIL — but it produced no
  // comparison, and exiting 0 would paint a green check on a run that never
  // looked at either branch. That green is indistinguishable from a real pass,
  // which is the silent-control failure this whole check exists to prevent.
  withFakeGh({ kind: 'http', code: 403 }, (res) => {
    assert.equal(res.status, 1, `a run that compared nothing must not exit 0:\n${res.stdout}`);
    assert.match(res.stdout, /check skipped \(HTTP 403/);
    // The WARN mark is how the distinction survives into the output.
    assert.match(res.stdout, /⚠ lockfile drift/);
    assert.doesNotMatch(res.stdout, /✗ lockfile drift/);
  });
});

test('cli: an unreadable lockfile exits 1 rather than certifying', () => {
  // Lost evidence is not proof of health. The check must not exit 0 having
  // compared nothing.
  withFakeGh({ kind: 'http', code: 404 }, (res) => {
    assert.equal(res.status, 1, `lost evidence must fail closed:\n${res.stdout}`);
    assert.match(res.stdout, /cannot prove dev is patched/);
  });
});

test('cli: no gh on PATH is reported as a missing binary, not as a branch problem', () => {
  // The CLI's only dependency is `gh`, and the operator who hits this needs to
  // install it — not go looking at dev. The classification is easy to get wrong:
  // execSync runs through a shell, so a missing binary arrives as the SHELL
  // exiting 127, never as the ENOENT an argv-form spawn would raise.
  //
  // This case can only ever exercise the host's own /bin/sh. The next test
  // covers what it therefore cannot.
  withFakeGh({ kind: 'absent' }, (res) => {
    assert.equal(res.status, 1, `a missing gh must fail closed:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /gh CLI not found on PATH/);
  });
});

test('every POSIX shell reports a missing command as exit 127, whatever it calls it', () => {
  // The portability fact the classification above rests on, pinned where it can
  // break. A first attempt keyed on the stderr text instead and passed on macOS
  // while failing on all six CI legs: Ubuntu's /bin/sh is dash, which writes
  // `gh: not found`, where macOS /bin/sh and bash write `gh: command not
  // found`. The exit code is the only part all of them agree on.
  //
  // Node picks the shell for execSync, so no CLI-level test can reach a shell
  // other than the host's. Asserting the invariant directly is what makes the
  // difference visible on a developer machine rather than on a runner.
  const dir = mkdtempSync(join(tmpdir(), 'lockfile-drift-shell-'));
  try {
    const shells = ['/bin/sh', '/bin/bash', '/bin/dash'].filter((s) => existsSync(s));
    assert.ok(shells.length > 0, 'no POSIX shell found to test against');
    for (const shell of shells) {
      const res = spawnSync(shell, ['-c', 'definitely-not-a-real-binary api x'], {
        encoding: 'utf-8',
        env: { ...process.env, PATH: dir },
      });
      assert.equal(res.status, 127, `${shell} must exit 127: got ${res.status} / ${res.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: only a proven drift may tell the operator dev is missing an update', () => {
  // The closing line is the part an operator acts on, and the three non-pass
  // outcomes justify different actions. Asserting the discrimination in both
  // directions is the point: a single shared line would pass any one of these
  // cases alone while sending two of the three operators to the wrong place.
  const MISSING_UPDATES = /dev is missing dependency updates/;
  const NOT_ABOUT_DEV = /NOT a statement about dev/;

  withFakeGh({ kind: 'perRef', main: { 'js-yaml': '4.3.2' }, dev: { 'js-yaml': '4.3.1' } }, (res) => {
    assert.match(res.stdout, MISSING_UPDATES);
    assert.doesNotMatch(res.stdout, NOT_ABOUT_DEV);
  });

  // 404 and 403 both compared nothing, so neither may make a claim about dev.
  for (const code of [404, 403] as const) {
    withFakeGh({ kind: 'http', code }, (res) => {
      assert.doesNotMatch(res.stdout, MISSING_UPDATES, `HTTP ${code} must not claim drift`);
      assert.match(res.stdout, NOT_ABOUT_DEV);
    });
  }

  withFakeGh({ kind: 'absent' }, (res) => {
    assert.doesNotMatch(res.stdout, MISSING_UPDATES);
    assert.match(res.stdout, NOT_ABOUT_DEV);
  });

  // And a clean run says none of it.
  withFakeGh({ kind: 'perRef', main: { 'js-yaml': '4.3.2' }, dev: { 'js-yaml': '4.3.2' } }, (res) => {
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.stdout, MISSING_UPDATES);
    assert.doesNotMatch(res.stdout, NOT_ABOUT_DEV);
  });
});

test('workflow: the guard is wired to run, and to run this tool', () => {
  // Everything above tests a CLI the suite invokes itself. None of it says the
  // workflow ever invokes it — and a guard that never runs is indistinguishable
  // from a guard that runs clean. These are the properties that decide whether
  // this file is live, each one a way it has silently gone inert.
  const wf = loadYaml(readFileSync(WORKFLOW, 'utf8')) as {
    on: {
      push: { branches: string[] };
      schedule?: { cron: string }[];
      workflow_dispatch?: unknown;
    };
    jobs: Record<string, { steps: { uses?: string; run?: string }[] }>;
  };

  // A push-triggered workflow runs the definition on the ref that was pushed.
  // `dev` is load-bearing, not symmetry: this change merges to dev, so a
  // main-only trigger would leave the guard inert until the next release.
  assert.deepEqual([...wf.on.push.branches].sort(), ['dev', 'main']);

  // The schedule is the ONLY trigger that survives the GITHUB_TOKEN rule: a push
  // made with that token creates no workflow run, and dependabot-automerge.yml
  // merges with it, so twelve of main's last thirteen pushes fired nothing at
  // all. Deleting this entry would not fail any other assertion here while
  // silently returning the guard to seeing roughly one push in thirteen.
  assert.ok(Array.isArray(wf.on.schedule), 'the daily schedule trigger must exist');
  assert.equal(wf.on.schedule?.length, 1);
  assert.match(wf.on.schedule?.[0]?.cron ?? '', /^\d+\s+\d+\s+\*\s+\*\s+\*$/, 'must run daily');

  // Dispatch is the manual escape hatch, and it works against any ref carrying
  // this file — `--ref dev` today, `--ref main` only once it lands there.
  assert.ok('workflow_dispatch' in wf.on, 'manual dispatch must stay available');

  const steps = Object.values(wf.jobs).flatMap((job) => job.steps);
  const runs = steps.map((s) => s.run ?? '').join('\n');
  assert.match(runs, /node tools\/check_lockfile_drift\.js/);

  // A mutable action tag on the step that fetches the code a security check
  // then reads is the one substitution in this file that would go unnoticed.
  for (const uses of steps.map((s) => s.uses).filter(Boolean) as string[]) {
    assert.match(uses, /@[0-9a-f]{40}$/, `${uses} must be pinned to a full SHA`);
  }
});
