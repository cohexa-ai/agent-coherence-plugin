/**
 * The hook client's decisions for `.coherence/hook_on_held`, with no
 * coordinator: the setting, the fold profiles under which a path is strict,
 * what `/status` says, the subagent-id check and the outcome class of an
 * answer. They follow the library's Python module `ccs.cli._hook_on_held`
 * function by function and its fixtures under `fixtures/hook_on_held/`.
 *
 * Python reads a key by presence (`"degraded" not in body`,
 * `status.get("fold_profile", "none")`), not by truthiness, and the shared
 * fixtures carry no vector that tells the two apart, so the vectors that do
 * are pinned here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionToAgentId } from '../agent_id.js';
import { diskSpellingOf } from '../hook_client.js';
import {
  advertisesRefusal,
  answerFor,
  classifyAnswer,
  HOLDER_DENY,
  malformedSubagentId,
  NO_REFUSAL_MESSAGE,
  type OptedInRequest,
  PARENT_DENY,
  readSetting,
  RELAY_ADMIT,
  RELAY_DENY,
  strictForCoordinator,
  strictProfiles,
  UNAVAILABLE_DENY,
  unavailableDeny,
  UNKNOWN_SETTING_MESSAGE,
} from '../hook_on_held.js';
import { TrackedArtifactPolicy } from '../policy.js';
import type { FoldProfile } from '../path_fold.js';
import { compiledModuleUrl, makeFifo, runBounded } from './fifo_fixture.js';
import decisionTable from './fixtures/hook_on_held/decision_table.json' with { type: 'json' };
import holderDeny from './fixtures/hook_on_held/holder_deny.json' with { type: 'json' };
import parentDeny from './fixtures/hook_on_held/parent_deny.json' with { type: 'json' };
import settingValues from './fixtures/hook_on_held/setting_values.json' with { type: 'json' };
import stderrLines from './fixtures/hook_on_held/stderr_lines.json' with { type: 'json' };
import unavailableDenyFixture from './fixtures/hook_on_held/unavailable_deny.json' with { type: 'json' };

/** The name the hook client's `report` puts before each stderr line. */
const CLIENT_PREFIX = 'agent-coherence-hook-client: ';
const SESSION_ID = '5f0c2a8e-3b1d-4c7a-9e2f-6a1b8d4c0e71';
const PATH = holderDeny.inputs.path;

interface HttpRow {
  name: string;
  caller: { session_id: string; agent_id: string | null };
  http: { status: number; body: Record<string, unknown> };
  expected: string;
}

const HTTP_ROWS = (decisionTable.rows as ReadonlyArray<{ http?: unknown }>).filter(
  (row): row is HttpRow => row.http !== undefined
);

function withTemp(run: (base: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const base = mkdtempSync(join(tmpdir(), 'hook-on-held-decision-'));
    try {
      await run(base);
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  };
}

/** A `.coherence` under `base`, with `hook_on_held` holding `content` when it is a string. */
function coherenceDirWith(base: string, content: string | null): string {
  const dir = join(base, '.coherence');
  mkdirSync(dir, { recursive: true });
  if (content !== null) writeFileSync(join(dir, 'hook_on_held'), content, 'utf8');
  return dir;
}

function optedIn(caller: { session_id: string; agent_id?: unknown }): OptedInRequest {
  const agent = typeof caller.agent_id === 'string' ? { agent_id: caller.agent_id } : {};
  return { session_id: caller.session_id, path: PATH, ...agent, if_unheld: true };
}

function holderReason(holder: string): string {
  const fixtureShort = holderDeny.inputs.holder_agent_id.slice(0, 8);
  return holderDeny.stdout.hookSpecificOutput.permissionDecisionReason.replace(
    fixtureShort,
    holder.slice(0, 8)
  );
}

/** What the decision module's own stderr writes were while `run` ran. */
function stderrDuring(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let written = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return written;
}

// ---------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------

test(
  'every setting_values.json vector reads as its expected setting',
  withTemp((base) => {
    settingValues.rows.forEach((row, index) => {
      const dir = coherenceDirWith(join(base, String(index)), row.content);
      assert.equal(readSetting(dir), row.expected, JSON.stringify(row.content));
    });
  })
);

test(
  'a linked hook_on_held, a directory and a linked .coherence read as off, even naming refuse',
  { skip: process.platform === 'win32' },
  withTemp((base) => {
    const elsewhere = coherenceDirWith(join(base, 'elsewhere'), 'refuse\n');

    const linkedLeaf = coherenceDirWith(join(base, 'leaf'), null);
    symlinkSync(join(elsewhere, 'hook_on_held'), join(linkedLeaf, 'hook_on_held'));
    assert.equal(readSetting(linkedLeaf), 'off', 'a linked hook_on_held');

    const directory = coherenceDirWith(join(base, 'directory'), null);
    mkdirSync(join(directory, 'hook_on_held'));
    assert.equal(readSetting(directory), 'off', 'a directory');

    mkdirSync(join(base, 'linked'));
    const linkedDir = join(base, 'linked', '.coherence');
    symlinkSync(elsewhere, linkedDir);
    assert.equal(readSetting(linkedDir), 'off', 'a linked .coherence');

    assert.equal(readSetting(join(base, 'absent', '.coherence')), 'off', 'no .coherence');
  })
);

test(
  'a hook_on_held over 64 bytes reads as unknown, and 64 bytes is still read',
  withTemp((base) => {
    const over = coherenceDirWith(join(base, 'over'), 'refuse\n'.padEnd(65, ' '));
    assert.equal(readSetting(over), 'unknown');
    // At the cap the value is read and compared: 64 bytes cannot be refuse.
    const at = coherenceDirWith(join(base, 'at'), 'r'.repeat(64));
    assert.equal(readSetting(at), 'unknown');
  })
);

test(
  'a FIFO at hook_on_held reads as off without blocking',
  { skip: process.platform === 'win32' },
  withTemp(async (base) => {
    const dir = coherenceDirWith(base, null);
    const fifo = join(dir, 'hook_on_held');
    makeFifo(fifo);
    const script =
      'const [moduleUrl, dir] = process.argv.slice(1);\n' +
      'const { readSetting } = await import(moduleUrl);\n' +
      'process.stdout.write(readSetting(dir));\n';
    const run = await runBounded(script, [compiledModuleUrl('hook_on_held.js'), dir], {
      timeoutMs: 30_000,
      fifos: [fifo],
    });
    assert.deepEqual(
      { timedOut: run.timedOut, stdout: run.stdout },
      { timedOut: false, stdout: 'off' }
    );
  })
);

test('the two stderr messages are the fixture lines once the client names itself', () => {
  assert.equal(`${CLIENT_PREFIX}${UNKNOWN_SETTING_MESSAGE}\n`, stderrLines.lines.setting_unknown);
  assert.equal(`${CLIENT_PREFIX}${NO_REFUSAL_MESSAGE}\n`, stderrLines.lines.status_key_absent);
});

// ---------------------------------------------------------------------------
// What /status says
// ---------------------------------------------------------------------------

test('only a JSON true pre_edit_if_unheld advertises the refusal', () => {
  assert.equal(advertisesRefusal({ pre_edit_if_unheld: true }), true);
  for (const value of ['true', 1, null, false, {}]) {
    assert.equal(advertisesRefusal({ pre_edit_if_unheld: value }), false, JSON.stringify(value));
  }
  assert.equal(advertisesRefusal({}), false, 'absent');
});

test('fold_profile: absent and cannot_tell read as none; any value not a profile is strict', () => {
  // Strict under the folding profiles only, so "none" and "strict" answer apart.
  const folding: ReadonlySet<FoldProfile> = new Set(['caseless', 'nfd']);
  assert.equal(strictForCoordinator({}, folding), false, 'absent');
  assert.equal(
    strictForCoordinator({ fold_profile: 'cannot_tell' }, folding),
    false,
    'cannot_tell'
  );
  for (const value of [null, '', 'CASELESS', 7, ['none'], { profile: 'none' }]) {
    assert.equal(
      strictForCoordinator({ fold_profile: value }, folding),
      true,
      JSON.stringify(value)
    );
  }
  assert.equal(strictForCoordinator({ fold_profile: 'caseless' }, folding), true);
  assert.equal(strictForCoordinator({ fold_profile: 'nfd' }, folding), true);
  assert.equal(strictForCoordinator({ fold_profile: 'none' }, folding), false);
  assert.equal(strictForCoordinator({ fold_profile: 'none' }, new Set(['none'])), true);
  assert.equal(strictForCoordinator({}, new Set(['none'])), true);
});

// ---------------------------------------------------------------------------
// The subagent id on the Claude Code payload
// ---------------------------------------------------------------------------

test('a present agent_id that is not 1-64 chars of [A-Za-z0-9_-] is malformed', () => {
  for (const value of ['a3f9/c2e1', 7, 'bad id!', 'x'.repeat(65), 'abc\n', true, ['a'], {}]) {
    assert.equal(
      malformedSubagentId({ session_id: SESSION_ID, agent_id: value }),
      true,
      JSON.stringify(value)
    );
  }
});

test('an absent, null or empty agent_id is the parent, and a valid one is not malformed', () => {
  assert.equal(malformedSubagentId({ session_id: SESSION_ID }), false, 'absent');
  assert.equal(malformedSubagentId({ session_id: SESSION_ID, agent_id: null }), false, 'null');
  assert.equal(malformedSubagentId({ session_id: SESSION_ID, agent_id: '' }), false, 'empty');
  assert.equal(malformedSubagentId({ agent_id: 'a3f9c2e1b7d4' }), false, 'valid');
  assert.equal(malformedSubagentId({ agent_id: 'x'.repeat(64) }), false, '64 chars');
});

test('agentId is read only when agent_id is absent, as Python reads it', () => {
  assert.equal(malformedSubagentId({ agentId: 'bad id!' }), true, 'agentId alone');
  assert.equal(malformedSubagentId({ agentId: 'b8e2d4f1c6a9' }), false, 'valid agentId');
  assert.equal(malformedSubagentId({ agent_id: null, agentId: 'bad id!' }), false, 'null agent_id');
  assert.equal(malformedSubagentId({ agent_id: 'ok', agentId: 'bad id!' }), false);
});

// ---------------------------------------------------------------------------
// The answer to the opted-in pre-edit
// ---------------------------------------------------------------------------

test('the decision table has 16 http rows', () => {
  assert.equal(HTTP_ROWS.length, 16);
});

for (const row of HTTP_ROWS) {
  test(`decision row ${row.name}: classifies as ${row.expected} and prints its deny or the body`, () => {
    const request = optedIn(row.caller);
    const { status, body } = row.http;
    // The client denies every non-2xx answer before it classifies one; the
    // bodies of the table's non-2xx rows are not admits on their own either.
    assert.equal(classifyAnswer(body, request), row.expected);
    const printed = answerFor(body, request);
    if (row.expected === RELAY_ADMIT || row.expected === RELAY_DENY) {
      assert.ok(status >= 200 && status < 300);
      assert.equal(printed, body, 'the body itself, as received');
      return;
    }
    const expected =
      row.expected === HOLDER_DENY
        ? {
            hookSpecificOutput: {
              ...holderDeny.stdout.hookSpecificOutput,
              permissionDecisionReason: holderReason(String(body.holder_agent_id)),
            },
          }
        : row.expected === PARENT_DENY
          ? parentDeny.stdout
          : unavailableDenyFixture.stdout;
    assert.deepEqual(printed, expected);
    const reason = (printed as typeof expected).hookSpecificOutput.permissionDecisionReason;
    assert.equal(reason, expected.hookSpecificOutput.permissionDecisionReason);
  });
}

test('an admit carrying degraded or collision with any value is the unavailable deny', () => {
  const request = optedIn({ session_id: SESSION_ID });
  for (const key of ['degraded', 'collision']) {
    for (const value of [false, null, 0, '', true]) {
      const body = { ok: true, [key]: value };
      assert.equal(
        classifyAnswer(body, request),
        UNAVAILABLE_DENY,
        `${key}: ${JSON.stringify(value)}`
      );
      assert.deepEqual(answerFor(body, request), unavailableDenyFixture.stdout);
    }
  }
  assert.equal(classifyAnswer({ ok: true }, request), RELAY_ADMIT);
  assert.equal(classifyAnswer({ ok: true, version: 3 }, request), RELAY_ADMIT);
});

test('only a JSON true ok admits; a body that is not an object is the unavailable deny', () => {
  const request = optedIn({ session_id: SESSION_ID });
  for (const ok of ['true', 1, null]) {
    assert.equal(classifyAnswer({ ok }, request), UNAVAILABLE_DENY, JSON.stringify(ok));
  }
  for (const body of [null, [], ['ok'], 'ok', 7, true, undefined]) {
    assert.equal(classifyAnswer(body, request), UNAVAILABLE_DENY, JSON.stringify(body));
    assert.deepEqual(answerFor(body, request), unavailableDenyFixture.stdout);
  }
});

test('only a hookSpecificOutput object with permissionDecision "deny" is relayed as a deny', () => {
  const request = optedIn({ session_id: SESSION_ID });
  const relayed = { ok: false, hookSpecificOutput: { permissionDecision: 'deny' } };
  assert.equal(classifyAnswer(relayed, request), RELAY_DENY);
  for (const output of [
    { permissionDecision: 'Deny' },
    { permissionDecision: 'allow' },
    'deny',
    [],
    null,
  ]) {
    const body = { ok: false, hookSpecificOutput: output };
    assert.equal(classifyAnswer(body, request), UNAVAILABLE_DENY, JSON.stringify(output));
  }
});

test('a holder that is not 32 lowercase hex is the unavailable deny', () => {
  const request = optedIn({ session_id: SESSION_ID });
  const holder = 'bc3013e123b458509bb8c8875e97ff53';
  for (const value of [holder.toUpperCase(), `${holder}\n`, holder.slice(1), 7, null]) {
    const body = { ok: false, reason: 'other_holder', holder_agent_id: value };
    assert.equal(classifyAnswer(body, request), UNAVAILABLE_DENY, JSON.stringify(value));
  }
  const named = { ok: false, reason: 'other_holder', holder_agent_id: holder };
  assert.equal(classifyAnswer(named, request), HOLDER_DENY);
  const otherReason = { ok: false, reason: 'version_mismatch', holder_agent_id: holder };
  assert.equal(classifyAnswer(otherReason, request), UNAVAILABLE_DENY);
});

test('the parent deny needs a valid agent_id sent; without one the parent is another holder', () => {
  const parent = sessionToAgentId(SESSION_ID);
  const body = { ok: false, reason: 'other_holder', holder_agent_id: parent };
  assert.equal(
    classifyAnswer(body, optedIn({ session_id: SESSION_ID, agent_id: 'a3f9c2e1b7d4' })),
    PARENT_DENY
  );
  assert.equal(
    classifyAnswer(body, optedIn({ session_id: SESSION_ID })),
    HOLDER_DENY,
    'no agent_id'
  );
  const malformed = { ...optedIn({ session_id: SESSION_ID }), agent_id: 'bad id!' };
  assert.equal(classifyAnswer(body, malformed), HOLDER_DENY, 'a malformed agent_id');
  assert.deepEqual(answerFor(body, optedIn({ session_id: SESSION_ID })), {
    hookSpecificOutput: {
      ...holderDeny.stdout.hookSpecificOutput,
      permissionDecisionReason: holderReason(parent),
    },
  });
});

test('unavailableDeny renders unavailable_deny.json for the path', () => {
  assert.deepEqual(
    unavailableDeny(unavailableDenyFixture.inputs.path),
    unavailableDenyFixture.stdout
  );
});

// ---------------------------------------------------------------------------
// The strict check: a quiet policy and the candidate profiles
// ---------------------------------------------------------------------------

/** A workspace whose .coherence holds `files`, each a policy file's text. */
function workspaceWith(base: string, files: Record<string, string>): string {
  const dir = join(base, '.coherence');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, 'utf8');
  return base;
}

test(
  'readQuietly loads a linked or malformed policy file with nothing on stderr',
  { skip: process.platform === 'win32' },
  withTemp((base) => {
    const root = workspaceWith(join(base, 'ws'), {
      'tracked.yaml': 'notes/**/*.md: [unclosed\n',
      'ignored.yaml': 'just a string\n',
    });
    writeFileSync(join(base, 'strict_elsewhere.yaml'), '- "**/plan.md"\n');
    symlinkSync(join(base, 'strict_elsewhere.yaml'), join(root, '.coherence', 'strict_mode.yaml'));

    // The same files make the loud load warn, so a silent quiet read means something.
    const loud = stderrDuring(() => TrackedArtifactPolicy.load(root));
    assert.match(loud, /strict_mode\.yaml is a symlink/);
    assert.match(loud, /malformed YAML/);
    assert.match(loud, /top-level must be a list/);

    let quiet: TrackedArtifactPolicy | undefined;
    assert.equal(
      stderrDuring(() => (quiet = TrackedArtifactPolicy.readQuietly(root))),
      ''
    );
    assert.deepEqual(quiet!.strictModePaths, []);
    assert.deepEqual(quiet!.rejectedPatterns.map((r) => r.pattern).sort(), [
      '.coherence/ignored.yaml',
      '.coherence/strict_mode.yaml',
      '.coherence/tracked.yaml',
    ]);
  })
);

test(
  'readQuietly reads the strict entries load reads, without the ignored-overrides warning',
  withTemp((base) => {
    const root = workspaceWith(join(base, 'ws'), {
      'strict_mode.yaml': '- "**/plan.md"\n',
      'ignored.yaml': '- "docs/**"\n',
    });
    const loud = stderrDuring(() => TrackedArtifactPolicy.load(root));
    assert.match(loud, /strict wins/);
    let quiet: TrackedArtifactPolicy | undefined;
    assert.equal(
      stderrDuring(() => (quiet = TrackedArtifactPolicy.readQuietly(root))),
      ''
    );
    assert.deepEqual(quiet!.strictModePaths, ['**/plan.md']);
    assert.deepEqual(quiet!.ignoredPatterns, ['docs/**']);
  })
);

const ALL_PROFILES: ReadonlyArray<FoldProfile> = ['caseless', 'nfd', 'none'];

function profilesOf(root: string, rel: string): FoldProfile[] {
  const policy = TrackedArtifactPolicy.readQuietly(root);
  return [...strictProfiles(policy, rel, (name) => diskSpellingOf(root, name))].sort();
}

test(
  'candidate profiles: plan.md is strict under all three, notes.md under none',
  withTemp((base) => {
    const root = workspaceWith(join(base, 'ws'), { 'strict_mode.yaml': '- plan.md\n' });
    writeFileSync(join(root, 'plan.md'), 'x');
    writeFileSync(join(root, 'notes.md'), 'x');
    assert.deepEqual(profilesOf(root, 'plan.md'), ALL_PROFILES);
    assert.deepEqual(profilesOf(root, 'notes.md'), []);
  })
);

test(
  'candidate profiles: PLAN.MD on a disk that spells it plan.md is strict under caseless and nfd',
  withTemp((base) => {
    const root = workspaceWith(join(base, 'ws'), { 'strict_mode.yaml': '- plan.md\n' });
    writeFileSync(join(root, 'plan.md'), 'x');
    if (!existsSync(join(root, 'PLAN.MD'))) {
      // A disk that keeps case apart has no other spelling to read.
      assert.deepEqual(profilesOf(root, 'PLAN.MD'), ['caseless']);
      return;
    }
    assert.equal(diskSpellingOf(root, 'PLAN.MD'), 'plan.md');
    // nfd folds no case: only the disk's own spelling makes it strict there.
    assert.deepEqual(profilesOf(root, 'PLAN.MD'), ['caseless', 'nfd']);
  })
);

test(
  'candidate profiles: DECISIONS.md listed as strict is a candidate on Node (the Python client says no)',
  withTemp((base) => {
    // Node tracks DECISIONS.md by default and Python does not; this pins Node's answer.
    const root = workspaceWith(join(base, 'ws'), { 'strict_mode.yaml': '- DECISIONS.md\n' });
    writeFileSync(join(root, 'DECISIONS.md'), 'x');
    assert.deepEqual(profilesOf(root, 'DECISIONS.md'), ALL_PROFILES);
  })
);

test(
  'candidate profiles: a file under subject: is never strict, even under a strict **/plan.md',
  withTemp((base) => {
    const root = workspaceWith(join(base, 'ws'), { 'strict_mode.yaml': '- "**/plan.md"\n' });
    assert.deepEqual(profilesOf(root, 'subject:x/plan.md'), []);
    assert.deepEqual(profilesOf(root, 'docs/subject:x/plan.md'), ALL_PROFILES);
  })
);

test(
  'candidate profiles: with no strict entries the disk is not asked for a spelling',
  withTemp((base) => {
    const root = workspaceWith(join(base, 'ws'), {});
    writeFileSync(join(root, 'plan.md'), 'x');
    let asked = 0;
    const policy = TrackedArtifactPolicy.readQuietly(root);
    const profiles = strictProfiles(policy, 'plan.md', () => {
      asked += 1;
      return undefined;
    });
    assert.deepEqual({ profiles: [...profiles], asked }, { profiles: [], asked: 0 });
  })
);

test(
  'diskSpellingOf: a dangling link has no spelling, and a missing leaf keeps its typed name',
  { skip: process.platform === 'win32' },
  withTemp((base) => {
    const root = join(base, 'ws');
    mkdirSync(join(root, 'docs'), { recursive: true });
    symlinkSync(join(base, 'gone'), join(root, 'docs', 'dangling.md'));
    assert.equal(diskSpellingOf(root, 'docs/dangling.md'), undefined);
    assert.equal(diskSpellingOf(root, 'docs/New.md'), join('docs', 'New.md'));
  })
);
