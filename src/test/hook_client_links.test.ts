/**
 * The hook client keys a file the way the Python hook client does: it follows
 * links to the file they name and spells the workspace root as the disk
 * does, so one file reaches the coordinator under one path whatever link or
 * root spelling the tool call used.
 *
 * The expected paths below are literal and match the Python client's
 * `Path(file_path).resolve().relative_to(root)` on the same layout, except
 * where noted: a dangling link skips here (Python sends the missing target),
 * and a differently cased root reaches the coordinator here (Python's
 * `Path.resolve()` keeps the typed case, so it skips).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPayload,
  buildPreEdit,
  buildPreGrep,
  buildPreRead,
  SkipHook,
  SUBCOMMANDS,
} from '../hook_client.js';

const SID = '55555555-5555-4555-8555-555555555555';

interface LinkedWorkspace {
  base: string;
  root: string;
  cleanup: () => void;
}

/**
 * <base>/ws is the root: plan.md, documentation/guide.md, docs -> documentation,
 * data/plan-link.md -> ../plan.md, data/outside-link.md -> <base>/outside/secret.md,
 * data/dangle.md -> nope.md (missing).
 */
function makeLinkedWorkspace(): LinkedWorkspace {
  const base = mkdtempSync(join(tmpdir(), 'hookclient-links-'));
  const root = join(base, 'ws');
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'documentation'));
  mkdirSync(join(base, 'outside'));
  writeFileSync(join(root, 'plan.md'), 'plan');
  writeFileSync(join(root, 'documentation', 'guide.md'), 'guide');
  writeFileSync(join(base, 'outside', 'secret.md'), 'secret');
  symlinkSync('documentation', join(root, 'docs'));
  symlinkSync(join('..', 'plan.md'), join(root, 'data', 'plan-link.md'));
  symlinkSync(join(base, 'outside', 'secret.md'), join(root, 'data', 'outside-link.md'));
  symlinkSync('nope.md', join(root, 'data', 'dangle.md'));
  return { base, root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function readPayload(filePath: string, root: string): Record<string, unknown> {
  return buildPreRead({ session_id: SID, tool_input: { file_path: filePath } }, root);
}

test('a link to a file is sent as the file it names', () => {
  const { root, cleanup } = makeLinkedWorkspace();
  try {
    assert.equal(readPayload(join(root, 'data', 'plan-link.md'), root).path, 'plan.md');
    const edit = buildPreEdit(
      { session_id: SID, tool_input: { file_path: join(root, 'data', 'plan-link.md') } },
      root
    );
    assert.deepEqual(edit, { session_id: SID, path: 'plan.md' });
  } finally {
    cleanup();
  }
});

test("a path through a linked directory inside the root is sent under the target's path", () => {
  const { root, cleanup } = makeLinkedWorkspace();
  try {
    assert.equal(readPayload(join(root, 'docs', 'guide.md'), root).path, 'documentation/guide.md');
    const grep = buildPreGrep({ session_id: SID, tool_input: { path: join(root, 'docs') } }, root);
    assert.deepEqual(grep, { session_id: SID, search_root: 'documentation' });
  } finally {
    cleanup();
  }
});

test('a link whose target leaves the root skips the hook', () => {
  const { root, cleanup } = makeLinkedWorkspace();
  try {
    assert.throws(() => readPayload(join(root, 'data', 'outside-link.md'), root), SkipHook);
  } finally {
    cleanup();
  }
});

test('a dangling link skips the hook with the skip signal, not a filesystem error', () => {
  const { root, cleanup } = makeLinkedWorkspace();
  try {
    const dangling = join(root, 'data', 'dangle.md');
    assert.throws(() => readPayload(dangling, root), SkipHook);
    assert.throws(
      () => buildPreEdit({ session_id: SID, tool_input: { file_path: dangling } }, root),
      SkipHook
    );
  } finally {
    cleanup();
  }
});

test('a new file under an existing directory resolves the directory and keeps the leaf as typed', () => {
  const { root, cleanup } = makeLinkedWorkspace();
  try {
    const edit = buildPreEdit(
      { session_id: SID, tool_input: { file_path: join(root, 'docs', 'New-Plan.MD') } },
      root
    );
    assert.deepEqual(edit, { session_id: SID, path: 'documentation/New-Plan.MD' });
    assert.equal(readPayload(join(root, 'data', 'new', 'deep.md'), root).path, 'data/new/deep.md');
  } finally {
    cleanup();
  }
});

test('a tool path spelled with a differently cased root reaches the coordinator relative to it', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'hookclient-case-'));
  try {
    const root = join(base, 'Repo');
    mkdirSync(root);
    writeFileSync(join(root, 'plan.md'), 'plan');
    if (!existsSync(join(base, 'REPO'))) {
      t.skip('the temporary disk keeps two spellings apart, so no other spelling reaches the root');
      return;
    }
    assert.equal(readPayload(join(base, 'REPO', 'plan.md'), root).path, 'plan.md');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a root reached through a link and a path spelled through its target agree', () => {
  const { base, root, cleanup } = makeLinkedWorkspace();
  try {
    const alias = join(base, 'alias');
    symlinkSync(root, alias);
    assert.equal(readPayload(join(root, 'plan.md'), alias).path, 'plan.md');
    assert.equal(readPayload(join(alias, 'plan.md'), root).path, 'plan.md');
  } finally {
    cleanup();
  }
});

test(
  "macOS: /var and /private/var spellings of the root and the tool's path agree",
  { skip: process.platform !== 'darwin' && 'macOS reaches /var through /private/var' },
  () => {
    const { root, cleanup } = makeLinkedWorkspace();
    try {
      const privateSpelling = realpathSync.native(root);
      assert.ok(privateSpelling.startsWith('/private/'), privateSpelling);
      const linkSpelling = privateSpelling.slice('/private'.length);
      assert.equal(readPayload(join(privateSpelling, 'plan.md'), linkSpelling).path, 'plan.md');
      assert.equal(readPayload(join(linkSpelling, 'plan.md'), privateSpelling).path, 'plan.md');
    } finally {
      cleanup();
    }
  }
);

test('no payload carries a name_kind field', () => {
  const { root, cleanup } = makeLinkedWorkspace();
  try {
    const cc = {
      session_id: SID,
      agent_id: 'sub-1',
      source: 'compact',
      tool_input: {
        file_path: join(root, 'data', 'plan-link.md'),
        command: 'cat plan.md',
        path: join(root, 'docs'),
      },
    };
    for (const sub of SUBCOMMANDS) {
      assert.equal('name_kind' in buildPayload(sub, cc, root), false, sub);
    }
  } finally {
    cleanup();
  }
});
