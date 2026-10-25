/**
 * Required-status-context validation tests — checks 5+6 of
 * tools/check_release_readiness.js.
 *
 * Origin: after the CI matrix dropped Node 18, branch protection on main/dev
 * kept requiring the removed "Tests (Node 18)" context. Every PR merge needed
 * an admin override, yet the readiness checker reported 0 failures because it
 * only verified that protection *existed*, never that the required contexts
 * matched the job names ci.yml actually produces. The live contexts were
 * fixed by hand on 2026-08-23 (gh api PUT commands, docs/RELEASE.md §1);
 * these tests pin the checker-side guard against a recurrence:
 *   1. collectWorkflowContexts() statically expands job display names —
 *      matrix `name:` templates over their axis values (flow and block
 *      lists, quoted or bare scalars), GitHub's "<job-id> (v1, v2)"
 *      auto-suffix for name-less matrix jobs, and the job id for plain
 *      name-less jobs.
 *   2. Shapes it cannot expand (matrix include/exclude, non-matrix
 *      expressions) degrade to a loose wildcard matcher plus a warning —
 *      never a silent verdict. A file with no jobs mapping is an error.
 *   3. The REAL .github/workflows/ci.yml expands cleanly to exactly the
 *      known job names. Renaming a CI job breaks this test on purpose: the
 *      live required contexts must be updated in the same motion.
 *   4. compareContextsToJobs() classifies stale required contexts (fail
 *      material) and unrequired ci.yml jobs (warn material).
 *   5. End-to-end against a fake `gh`: a stale required context ("Tests
 *      (Node 18)") exits 1 naming it; an unrequired job warns but exits 0
 *      (also covers the `checks`-only response shape); missing required
 *      checks (404) exit 1; a 403 downgrades to a warning; matching
 *      contexts exit 0.
 *   6. The tool is importable without executing the CLI entry point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeExecutable } from './executable_fixture.js';

// __dirname at runtime is dist/test/; plugin root is two levels up
const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(__filename), '..', '..');
const TOOL = join(PLUGIN_ROOT, 'tools', 'check_release_readiness.js');
const CI_YML = join(PLUGIN_ROOT, '.github', 'workflows', 'ci.yml');

/**
 * The display names .github/workflows/ci.yml produces today, i.e. the exact
 * strings branch protection must require. Renaming a job or changing the
 * matrix updates this list AND the live required contexts (docs/RELEASE.md §1).
 */
const CI_JOB_NAMES = [
  'Typecheck',
  'Tests (Node 22)',
  'Tests (Node 24)',
  'Tests (Node 25)',
  'Zero-Python install (Node 22)',
  'Zero-Python install (Node 24)',
  'Zero-Python install (Node 25)',
  'Marketplace-shaped provision (dist-less package)',
  'Build Package',
];

interface WorkflowContexts {
  names: string[];
  loose: { jobId: string; regex: RegExp }[];
  warnings: string[];
  error?: string;
}

interface CheckerModule {
  collectWorkflowContexts(text: string): WorkflowContexts;
  compareContextsToJobs(
    contexts: string[],
    workflow: WorkflowContexts
  ): { stale: string[]; unrequired: string[] };
}

const checker = (await import(pathToFileURL(TOOL).href)) as CheckerModule;

function sorted(values: string[]): string[] {
  return [...values].sort();
}

// -----------------------------------------------------------------------------
// collectWorkflowContexts — static expansion
// -----------------------------------------------------------------------------

test('matrix name templates expand over flow-list axis values', () => {
  const wf = checker.collectWorkflowContexts(
    [
      'jobs:',
      '  typecheck:',
      '    name: Typecheck  # display name',
      '    runs-on: ubuntu-latest',
      '  test:',
      '    name: Tests (Node ${{ matrix.node-version }})',
      '    strategy:',
      '      fail-fast: false',
      '      matrix:',
      '        node-version: ["20", "22"]',
      '  build:',
      '    name: "Build Package" # quoted, with comment',
      '    needs: [typecheck, test]',
    ].join('\n')
  );
  assert.equal(wf.error, undefined);
  assert.deepEqual(wf.warnings, []);
  assert.deepEqual(wf.loose, []);
  assert.deepEqual(
    sorted(wf.names),
    sorted(['Typecheck', 'Tests (Node 20)', 'Tests (Node 22)', 'Build Package'])
  );
});

test('two referenced axes produce the cartesian product; bare and block-list scalars work', () => {
  const wf = checker.collectWorkflowContexts(
    [
      'jobs:',
      '  legacy:',
      '    name: Py ${{ matrix.python }} on ${{ matrix.os }}',
      '    strategy:',
      '      matrix:',
      '        python:',
      '          - "3.10"',
      '          - 3.11',
      '        os: [ubuntu, macos]',
    ].join('\n')
  );
  assert.deepEqual(wf.warnings, []);
  assert.deepEqual(
    sorted(wf.names),
    sorted(['Py 3.10 on ubuntu', 'Py 3.10 on macos', 'Py 3.11 on ubuntu', 'Py 3.11 on macos'])
  );
});

test("name-less jobs use the job id; name-less matrix jobs get GitHub's auto-suffix", () => {
  const wf = checker.collectWorkflowContexts(
    [
      'jobs:',
      '  lint:',
      '    runs-on: ubuntu-latest',
      '  smoke:',
      '    strategy:',
      '      matrix:',
      '        node: [20, 22]',
      '    runs-on: ubuntu-latest',
    ].join('\n')
  );
  assert.deepEqual(wf.warnings, []);
  assert.deepEqual(sorted(wf.names), sorted(['lint', 'smoke (20)', 'smoke (22)']));
});

test('include/exclude and non-matrix expressions degrade to loose matchers with warnings', () => {
  const wf = checker.collectWorkflowContexts(
    [
      'jobs:',
      '  test:',
      '    name: Tests (Node ${{ matrix.node-version }})',
      '    strategy:',
      '      matrix:',
      '        node-version: [20, 22]',
      '        include:',
      '          - node-version: 24',
      '  deploy:',
      '    name: Deploy ${{ env.STAGE }}',
    ].join('\n')
  );
  assert.equal(wf.error, undefined);
  assert.deepEqual(wf.names, []);
  assert.equal(wf.loose.length, 2);
  assert.equal(wf.warnings.length, 2);
  assert.match(wf.warnings[0], /job 'test'/);
  assert.match(wf.warnings[1], /job 'deploy'/);
  const testLoose = wf.loose.find((l) => l.jobId === 'test');
  const deployLoose = wf.loose.find((l) => l.jobId === 'deploy');
  assert.ok(testLoose && deployLoose);
  // The wildcard still absorbs contexts of that job's shape — including legs
  // this parser cannot enumerate — so loose jobs never produce stale failures.
  assert.ok(testLoose.regex.test('Tests (Node 18)'));
  assert.ok(testLoose.regex.test('Tests (Node 24)'));
  assert.ok(!testLoose.regex.test('Zero-Python install (Node 24)'));
  assert.ok(deployLoose.regex.test('Deploy prod'));
});

test('a file without a jobs mapping is an error, not an empty pass', () => {
  const wf = checker.collectWorkflowContexts('name: ci\non: push\n');
  assert.match(wf.error ?? '', /jobs/);
});

test('regression: the real ci.yml expands cleanly to exactly the known job names', () => {
  const wf = checker.collectWorkflowContexts(readFileSync(CI_YML, 'utf8'));
  assert.equal(wf.error, undefined);
  assert.deepEqual(wf.warnings, [], `real ci.yml no longer expands statically:\n${wf.warnings}`);
  assert.deepEqual(wf.loose, []);
  assert.deepEqual(sorted(wf.names), sorted(CI_JOB_NAMES));
});

// -----------------------------------------------------------------------------
// compareContextsToJobs — stale vs unrequired classification
// -----------------------------------------------------------------------------

test('stale required contexts and unrequired jobs are classified independently', () => {
  const workflow: WorkflowContexts = {
    names: ['Typecheck', 'Build Package'],
    loose: [{ jobId: 'test', regex: /^Tests \(Node .*\)$/ }],
    warnings: [],
  };
  const { stale, unrequired } = checker.compareContextsToJobs(
    ['Typecheck', 'Tests (Node 18)', 'Ancient Job'],
    workflow
  );
  assert.deepEqual(stale, ['Ancient Job']);
  assert.deepEqual(unrequired, ['Build Package']);
});

test('exactly matching contexts yield neither stale nor unrequired entries', () => {
  const workflow: WorkflowContexts = { names: ['Typecheck'], loose: [], warnings: [] };
  const { stale, unrequired } = checker.compareContextsToJobs(['Typecheck'], workflow);
  assert.deepEqual(stale, []);
  assert.deepEqual(unrequired, []);
});

// -----------------------------------------------------------------------------
// End-to-end against a fake gh
// -----------------------------------------------------------------------------

type RscBehavior = { kind: 'json'; body: unknown } | { kind: 'http'; code: 404 | 403 };

/** `case` action for one required_status_checks endpoint. */
function ghAction(dir: string, file: string, behavior: RscBehavior): string {
  if (behavior.kind === 'json') {
    const fixture = join(dir, file);
    writeFileSync(fixture, JSON.stringify(behavior.body));
    return `cat "${fixture}"`;
  }
  const label = behavior.code === 404 ? 'Not Found' : 'Forbidden';
  return `echo "gh: ${label} (HTTP ${behavior.code})" >&2; exit 1`;
}

/**
 * Fake `gh` serving checks 1–3 as healthy and the two required_status_checks
 * endpoints per scenario. Returns the bin dir to prepend to PATH.
 */
function writeFakeGh(dir: string, rscMain: RscBehavior, rscDev: RscBehavior): string {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const protection = join(dir, 'protection.json');
  writeFileSync(protection, JSON.stringify({ required_status_checks: {} }));
  const rulesets = join(dir, 'rulesets.json');
  writeFileSync(rulesets, JSON.stringify([{ id: 1, target: 'tag', enforcement: 'active' }]));
  const rulesetDetail = join(dir, 'ruleset_1.json');
  writeFileSync(
    rulesetDetail,
    JSON.stringify({
      id: 1,
      name: 'Protect v* release tags',
      conditions: { ref_name: { include: ['refs/tags/v*'] } },
    })
  );
  const script = [
    '#!/usr/bin/env bash',
    '# Fake gh for release-readiness e2e tests: supports `gh api <path>`.',
    'path="$2"',
    'case "$path" in',
    `  repos/*/branches/main/protection/required_status_checks) ${ghAction(dir, 'rsc_main.json', rscMain)} ;;`,
    `  repos/*/branches/dev/protection/required_status_checks) ${ghAction(dir, 'rsc_dev.json', rscDev)} ;;`,
    `  repos/*/branches/*/protection) cat "${protection}" ;;`,
    `  repos/*/rulesets/1) cat "${rulesetDetail}" ;;`,
    `  repos/*/rulesets) cat "${rulesets}" ;;`,
    '  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;',
    'esac',
  ].join('\n');
  const ghPath = join(binDir, 'gh');
  writeExecutable(ghPath, `${script}\n`);
  return binDir;
}

function runTool(binDir: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TOOL], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${binDir}:${process.env['PATH'] ?? ''}` },
    timeout: 30000,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function withFakeGh(
  rscMain: RscBehavior,
  rscDev: RscBehavior,
  run: (res: { status: number; stdout: string; stderr: string }) => void
): void {
  const dir = mkdtempSync(join(tmpdir(), 'release-readiness-'));
  try {
    run(runTool(writeFakeGh(dir, rscMain, rscDev)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ALL_CONTEXTS: RscBehavior = { kind: 'json', body: { strict: true, contexts: CI_JOB_NAMES } };

test('e2e: required contexts matching ci.yml job names → exit 0', () => {
  withFakeGh(ALL_CONTEXTS, ALL_CONTEXTS, (res) => {
    assert.equal(res.status, 0, `expected pass:\n${res.stdout}\n${res.stderr}`);
    const count = CI_JOB_NAMES.length;
    assert.match(
      res.stdout,
      new RegExp(`✓ main required status contexts: ${count} required context\\(s\\)`)
    );
    assert.match(
      res.stdout,
      new RegExp(`✓ dev required status contexts: ${count} required context\\(s\\)`)
    );
    assert.match(res.stdout, /0 failure\(s\)/);
  });
});

test('e2e: a stale required context (the Node 18 incident) → exit 1 naming it', () => {
  const staleMain: RscBehavior = {
    kind: 'json',
    body: {
      strict: true,
      contexts: CI_JOB_NAMES.map((n) => (n === 'Tests (Node 22)' ? 'Tests (Node 18)' : n)),
    },
  };
  withFakeGh(staleMain, ALL_CONTEXTS, (res) => {
    assert.equal(res.status, 1, `expected failure:\n${res.stdout}`);
    assert.match(
      res.stdout,
      /✗ main required status contexts: required context\(s\) 'Tests \(Node 18\)'/
    );
    assert.match(res.stdout, /admin override/);
    assert.match(res.stdout, /✓ dev required status contexts/);
  });
});

test('e2e: a ci.yml job absent from the required set → warning, exit 0 (checks-only shape)', () => {
  const missingBuild: RscBehavior = {
    kind: 'json',
    // `checks` without the deprecated `contexts` mirror — exercises the
    // fallback extraction path.
    body: {
      strict: true,
      checks: CI_JOB_NAMES.filter((n) => n !== 'Build Package').map((n) => ({
        context: n,
        app_id: 15368,
      })),
    },
  };
  withFakeGh(ALL_CONTEXTS, missingBuild, (res) => {
    assert.equal(res.status, 0, `warnings must not fail the run:\n${res.stdout}`);
    assert.match(
      res.stdout,
      /⚠ dev required status contexts: .*'Build Package'.*not required on `dev`/
    );
    assert.match(res.stdout, /✓ main required status contexts/);
  });
});

test('e2e: no required status checks configured (404) → exit 1', () => {
  withFakeGh({ kind: 'http', code: 404 }, ALL_CONTEXTS, (res) => {
    assert.equal(res.status, 1);
    assert.match(
      res.stdout,
      /✗ main required status contexts: No required status checks are configured/
    );
  });
});

test('e2e: 403 (token lacks admin scope) → warning, exit 0', () => {
  withFakeGh({ kind: 'http', code: 403 }, { kind: 'http', code: 403 }, (res) => {
    assert.equal(res.status, 0, `403 must warn, not fail:\n${res.stdout}`);
    assert.match(res.stdout, /⚠ main required status contexts: check skipped \(HTTP 403/);
    assert.match(res.stdout, /⚠ dev required status contexts: check skipped \(HTTP 403/);
  });
});

// -----------------------------------------------------------------------------
// Import safety
// -----------------------------------------------------------------------------

test('the tool is importable without executing the CLI entry point', () => {
  // The top-level import above already proves this (main() would have called
  // process.exit and killed the runner); pin the exported surface too.
  assert.equal(typeof checker.collectWorkflowContexts, 'function');
  assert.equal(typeof checker.compareContextsToJobs, 'function');
});
