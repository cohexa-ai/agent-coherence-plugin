/**
 * The library's hook_on_held fixtures, copied into this repository, and the
 * three deny texts the Node hook client renders against them.
 *
 * The library is the only author of these files (see the README beside them),
 * so a copy that drifts from the hashes it was taken with fails here. The
 * denies are compared parsed, because Python and Node serialise JSON
 * differently, and each reason as exact text, because those are the bytes the
 * model reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emitAdmissionUnavailableDeny,
  emitHeldByParentDeny,
  emitHeldPathDeny,
} from '../hook_payloads.js';
import decisionTable from './fixtures/hook_on_held/decision_table.json' with { type: 'json' };
import holderDeny from './fixtures/hook_on_held/holder_deny.json' with { type: 'json' };
import parentDeny from './fixtures/hook_on_held/parent_deny.json' with { type: 'json' };
import settingValues from './fixtures/hook_on_held/setting_values.json' with { type: 'json' };
import stderrLines from './fixtures/hook_on_held/stderr_lines.json' with { type: 'json' };
import unavailableDeny from './fixtures/hook_on_held/unavailable_deny.json' with { type: 'json' };

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The copies under src/, not dist's: tsc re-prints an imported JSON file, so
// only the source copies carry the library's bytes.
const FIXTURE_DIR = join(PLUGIN_ROOT, 'src', 'test', 'fixtures', 'hook_on_held');

const IMPORTED_FIXTURES: Readonly<Record<string, unknown>> = {
  'decision_table.json': decisionTable,
  'holder_deny.json': holderDeny,
  'parent_deny.json': parentDeny,
  'setting_values.json': settingValues,
  'stderr_lines.json': stderrLines,
  'unavailable_deny.json': unavailableDeny,
};

// Pinned in the library's order, so a refreshed copy that adds, drops or
// renames a row fails here before any row driver meets it.
const DECISION_TABLE_ROW_NAMES: ReadonlyArray<string> = [
  'before_post_setting_off',
  'before_post_setting_unknown',
  'before_post_not_strict',
  'before_post_no_port',
  'before_post_died_at_resolve',
  'before_post_timeout',
  'before_post_refused',
  'before_post_malformed_answer',
  'before_post_status_non_2xx',
  'before_post_status_key_absent',
  'before_post_not_strict_under_coordinator_profile',
  'before_post_malformed_agent_id',
  'admit',
  'strict_stale_deny',
  'handoff_giver_deny',
  'other_holder_is_the_callers_parent',
  'other_holder_is_another_session',
  'other_holder_is_a_sibling_subagent',
  'other_holder_is_the_callers_own_subagent',
  'unavailable',
  'internal_error',
  'prose_reason',
  'degraded_admit',
  'collision',
  'other_holder_without_a_holder',
  'other_holder_holder_not_32_hex',
  'caller_principal_absent_400',
  'malformed_agent_id_400',
  'post_timeout',
  'post_refused',
  'post_departed',
  'post_malformed_answer',
];

interface DecisionRow {
  name: string;
  expected: string;
  http?: { status: number; body: Record<string, unknown> };
}

const DECISION_ROWS = decisionTable.rows as ReadonlyArray<DecisionRow>;

function readmeSums(): Map<string, string> {
  const readme = readFileSync(join(FIXTURE_DIR, 'README.md'), 'utf8');
  const sums = new Map<string, string>();
  for (const match of readme.matchAll(/^([0-9a-f]{64}) {2}(\S+\.json)$/gm)) {
    sums.set(match[2]!, match[1]!);
  }
  return sums;
}

function reasonOf(fixture: {
  stdout: { hookSpecificOutput: { permissionDecisionReason: string } };
}) {
  return fixture.stdout.hookSpecificOutput.permissionDecisionReason;
}

test('the holder deny renders holder_deny.json: parsed equal, reason byte-equal', () => {
  const built = emitHeldPathDeny({
    path: holderDeny.inputs.path,
    holderAgentId: holderDeny.inputs.holder_agent_id,
  });
  assert.equal(built.permissionDecisionReason, reasonOf(holderDeny));
  assert.deepEqual({ hookSpecificOutput: built }, holderDeny.stdout);
});

test('the parent deny renders parent_deny.json: parsed equal, reason byte-equal', () => {
  const built = emitHeldByParentDeny(parentDeny.inputs.path);
  assert.equal(built.permissionDecisionReason, reasonOf(parentDeny));
  assert.deepEqual({ hookSpecificOutput: built }, parentDeny.stdout);
});

test('the unavailable deny renders unavailable_deny.json: parsed equal, reason byte-equal', () => {
  const built = emitAdmissionUnavailableDeny(unavailableDeny.inputs.path);
  assert.equal(built.permissionDecisionReason, reasonOf(unavailableDeny));
  assert.deepEqual({ hookSpecificOutput: built }, unavailableDeny.stdout);
});

test('every holder_deny row names its holder by the first eight characters', () => {
  const fixtureShort = holderDeny.inputs.holder_agent_id.slice(0, 8);
  const holderRows = DECISION_ROWS.filter((row) => row.expected === 'holder_deny');
  assert.ok(holderRows.length > 0);
  for (const row of holderRows) {
    const holder = row.http?.body['holder_agent_id'];
    if (typeof holder !== 'string') assert.fail(`${row.name} carries no holder_agent_id`);
    const built = emitHeldPathDeny({ path: holderDeny.inputs.path, holderAgentId: holder });
    const expected = reasonOf(holderDeny).replace(fixtureShort, holder.slice(0, 8));
    assert.equal(built.permissionDecisionReason, expected, row.name);
  }
});

test('a path carrying placeholder braces renders literally in all three denies', () => {
  const bracePath = 'docs/{path}/{holder}.md';
  const withBracePath = (reason: string, path: string) => reason.split(path).join(bracePath);
  const holder = emitHeldPathDeny({
    path: bracePath,
    holderAgentId: holderDeny.inputs.holder_agent_id,
  });
  assert.equal(
    holder.permissionDecisionReason,
    withBracePath(reasonOf(holderDeny), holderDeny.inputs.path)
  );
  assert.equal(
    emitHeldByParentDeny(bracePath).permissionDecisionReason,
    withBracePath(reasonOf(parentDeny), parentDeny.inputs.path)
  );
  assert.equal(
    emitAdmissionUnavailableDeny(bracePath).permissionDecisionReason,
    withBracePath(reasonOf(unavailableDeny), unavailableDeny.inputs.path)
  );
});

test('every fixture file is ASCII, matches its README sha256, and is the module imported', () => {
  const sums = readmeSums();
  assert.deepEqual([...sums.keys()].sort(), Object.keys(IMPORTED_FIXTURES).sort());
  for (const [name, imported] of Object.entries(IMPORTED_FIXTURES)) {
    const bytes = readFileSync(join(FIXTURE_DIR, name));
    assert.ok(
      bytes.every((byte) => byte < 0x80),
      `${name} holds a non-ASCII byte`
    );
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sums.get(name), name);
    assert.deepEqual(imported, JSON.parse(bytes.toString('ascii')), name);
  }
});

test('the decision table has 32 rows, with exactly the expected names', () => {
  assert.equal(DECISION_ROWS.length, 32);
  assert.deepEqual(
    DECISION_ROWS.map((row) => row.name),
    DECISION_TABLE_ROW_NAMES
  );
});
