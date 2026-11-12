/**
 * The hook client keys a file the way the Python hook client does: it follows
 * links to the file they name and spells the workspace root as the disk
 * does, so one file reaches the coordinator under one path whatever link or
 * root spelling the tool call used.
 *
 * The expected paths below are literal and match the Python client of the
 * library release that ships the same change, on the same layout: a dangling
 * link skips, a '..' is folded by text before links are followed, and a
 * differently cased root reaches the coordinator. Like Python's
 * `Path.resolve()`, the client keeps the case a name was typed in under a root
 * spelled as the disk spells it.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPayload,
  buildPostEdit,
  buildPreEdit,
  buildPreGrep,
  buildPreRead,
  SkipHook,
  SUBCOMMANDS,
} from '../hook_client.js';
import { writeStandInPidFile } from './coordinator_stand_in.js';

const SID = '55555555-5555-4555-8555-555555555555';
const HOOK_CLIENT_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hook_client.js');
/** What the stand-in coordinator answers, so a request that reached it shows in the hook's output. */
const REACHED = { reached: true };

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

test('a looping link skips the hook with the skip signal', () => {
  const { root, cleanup } = makeLinkedWorkspace();
  try {
    symlinkSync('loop-b.md', join(root, 'data', 'loop-a.md'));
    symlinkSync('loop-a.md', join(root, 'data', 'loop-b.md'));
    assert.throws(() => readPayload(join(root, 'data', 'loop-a.md'), root), SkipHook);
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

/**
 * Adds <root>/sub/plan.md, <root>/other/plan.md (other bytes), <root>/other/new.md
 * and sub/link -> <root>/other/dir, so sub/link/.. is sub by text and other on disk.
 */
function addLinkBeforeDotDot(root: string): void {
  mkdirSync(join(root, 'sub'));
  mkdirSync(join(root, 'other', 'dir'), { recursive: true });
  writeFileSync(join(root, 'sub', 'plan.md'), 'by text');
  writeFileSync(join(root, 'other', 'plan.md'), 'on disk');
  writeFileSync(join(root, 'other', 'new.md'), 'on disk');
  symlinkSync(join(root, 'other', 'dir'), join(root, 'sub', 'link'));
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function editPath(filePath: string, root: string): unknown {
  return buildPreEdit({ session_id: SID, tool_input: { file_path: filePath } }, root).path;
}

/*
 * Claude Code folds '..' by text before it opens an absolute tool path,
 * measured in a live session: a Read of sub/link/../plan.md (link -> other/dir)
 * returned sub/plan.md, an Edit of it changed sub/plan.md, a Write of
 * sub/link/../new.md created sub/new.md, and a Write of missing/../w2.md
 * created w2.md. Only the shell stepped out of the link's target. So the client
 * keys and hashes the file the tool opens, as the Python client keys it.
 * The paths are template strings: join() would fold the '..' before the client sees it.
 */
test("a '..' after a link is folded by text, as Claude Code opens the path", () => {
  const { root, cleanup } = makeLinkedWorkspace();
  try {
    addLinkBeforeDotDot(root);
    assert.equal(readPayload(`${root}/sub/link/../plan.md`, root).path, 'sub/plan.md');
    assert.equal(editPath(`${root}/sub/link/../plan.md`, root), 'sub/plan.md');
    // other/new.md exists on disk, yet the Write creates sub/new.md.
    assert.equal(editPath(`${root}/sub/link/../new.md`, root), 'sub/new.md');
    assert.equal(editPath(`${root}/missing/../w2.md`, root), 'w2.md');
  } finally {
    cleanup();
  }
});

test("a '..' after a link hashes the file Claude Code opens, not the disk's step", () => {
  const { root, cleanup } = makeLinkedWorkspace();
  try {
    addLinkBeforeDotDot(root);
    assert.equal(readPayload(`${root}/sub/link/../plan.md`, root).content_hash, sha256('by text'));
    writeFileSync(join(root, 'w2.md'), 'written');
    const cc = { session_id: SID, tool_input: { file_path: `${root}/missing/../w2.md` } };
    const post = buildPostEdit({ ...cc, tool_response: {} }, root);
    assert.deepEqual(post, {
      session_id: SID,
      path: 'w2.md',
      success: true,
      content_hash: sha256('written'),
    });
  } finally {
    cleanup();
  }
});

test('a name typed in another case under a correctly spelled root is sent as typed', (t) => {
  const { root, cleanup } = makeLinkedWorkspace();
  try {
    writeFileSync(join(root, 'README.md'), 'readme');
    if (!existsSync(join(root, 'README.MD'))) {
      t.skip('the temporary disk keeps two spellings apart, so README.MD is another file');
      return;
    }
    assert.equal(readPayload(join(root, 'README.MD'), root).path, 'README.MD');
    const edit = buildPreEdit(
      { session_id: SID, tool_input: { file_path: join(root, 'README.MD') } },
      root
    );
    assert.deepEqual(edit, { session_id: SID, path: 'README.MD' });
    // The link is followed; the names typed around it keep their case.
    assert.equal(readPayload(join(root, 'docs', 'GUIDE.MD'), root).path, 'documentation/GUIDE.MD');
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

// ------------------------------------------------------------ fail-open

/**
 * A coordinator stand-in for `root` that answers every request with REACHED,
 * and the count of requests it received.
 */
async function standInCoordinator(t: TestContext, root: string): Promise<() => number> {
  let requests = 0;
  const server = createHttpServer((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(REACHED));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  mkdirSync(join(root, '.coherence'), { recursive: true });
  writeStandInPidFile(
    join(root, '.coherence', 'server.pid'),
    `${process.pid}\n${port}\nbackend=node\n`
  );
  writeFileSync(join(root, '.coherence', 'hook.secret'), `${'s'.repeat(32)}\n`);
  return () => requests;
}

/**
 * The real client's stdout for a pre-read of `filePath`. An async spawn: the
 * stand-in answers on this process's event loop, which a sync spawn blocks.
 */
function hookPreRead(root: string, filePath: string): Promise<string> {
  const cc = JSON.stringify({ session_id: SID, tool_input: { file_path: filePath } });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_CLIENT_JS, 'pre-read', '--root', root], {
      cwd: tmpdir(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.on('close', () => resolve(stdout.trim()));
    child.stdin.end(cc);
  });
}

test('a path through a regular file fails open: the hook prints {} and sends nothing', async (t) => {
  const { root, cleanup } = makeLinkedWorkspace();
  t.after(cleanup);
  const requests = await standInCoordinator(t, root);

  // The stand-in answers a request the client does send.
  assert.deepEqual(JSON.parse(await hookPreRead(root, join(root, 'plan.md'))), REACHED);
  assert.throws(() => readPayload(join(root, 'plan.md', 'x'), root));
  assert.equal(await hookPreRead(root, join(root, 'plan.md', 'x')), '{}');
  assert.equal(requests(), 1);
});

test('a workspace root that cannot be resolved fails open: the hook prints {}', async (t) => {
  const { base, cleanup } = makeLinkedWorkspace();
  t.after(cleanup);
  // Spelled as the disk resolves it, so only the missing root itself can stop a request.
  const missing = join(realpathSync.native(base), 'missing');

  assert.throws(() => readPayload(join(missing, 'plan.md'), missing));
  // Nothing under such a root names a coordinator, so the hook stops before building a request.
  assert.equal(await hookPreRead(missing, join(missing, 'plan.md')), '{}');
});
