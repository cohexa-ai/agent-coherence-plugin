/**
 * #251 — the start check: `.coherence` must be absent or a real directory,
 * with no symlink, FIFO, socket or device directly inside it. The outcomes
 * and the refusal texts are the library's start check's
 * (cohexa-ai/agent-coherence#498), so both coordinators refuse the same
 * workspace with the same words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXIT_REFUSED,
  checkCoherenceDir,
  coherenceDirRefusalMessage,
  type CoherenceDirRefusal,
} from '../coherence_dir.js';
import { compiledModuleUrl, makeFifo, runBounded } from './fifo_fixture.js';

function withRoot(fn: (root: string, coherenceDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'coherence-dir-test-'));
  try {
    fn(root, join(root, '.coherence'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withRootAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'coherence-dir-test-'));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const refusal = (kind: CoherenceDirRefusal['kind'], path: string, more = 0) => ({
  kind,
  path,
  more,
});

test('checkCoherenceDir passes an absent .coherence, a real one, a real subdirectory and a hard link', () => {
  withRoot((root, coherenceDir) => {
    assert.equal(checkCoherenceDir(coherenceDir), null);
    mkdirSync(coherenceDir);
    assert.equal(checkCoherenceDir(coherenceDir), null);
    writeFileSync(join(coherenceDir, 'state.db'), '');
    writeFileSync(join(coherenceDir, 'hook.secret'), 'x');
    // A mounted file system brings its own lost+found; a subdirectory is not a link.
    mkdirSync(join(coherenceDir, 'lost+found'));
    writeFileSync(join(coherenceDir, 'lost+found', 'f'), '');
    // A hard link is an ordinary directory entry: lstat cannot tell it from a file.
    writeFileSync(join(root, 'outside'), 'x');
    linkSync(join(root, 'outside'), join(coherenceDir, 'notes.txt'));
    assert.equal(checkCoherenceDir(coherenceDir), null);
  });
});

test('checkCoherenceDir refuses a .coherence that is a symlink, to a directory or dangling', () => {
  withRoot((root, coherenceDir) => {
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), coherenceDir);
    assert.deepEqual(checkCoherenceDir(coherenceDir), refusal('link', coherenceDir));
    rmSync(coherenceDir);
    symlinkSync(join(root, 'gone'), coherenceDir);
    assert.deepEqual(checkCoherenceDir(coherenceDir), refusal('link', coherenceDir));
  });
});

test('checkCoherenceDir refuses a .coherence that is a regular file', () => {
  withRoot((_root, coherenceDir) => {
    writeFileSync(coherenceDir, 'x');
    assert.deepEqual(checkCoherenceDir(coherenceDir), refusal('not_a_directory', coherenceDir));
  });
});

test('checkCoherenceDir refuses a symlink at any name directly inside .coherence, dangling or not', () => {
  // Every name, not a list of the files a coordinator opens: one it does not
  // open today (notes.txt) is refused, and so is ..x, a name the hidden-file
  // glob `.[!.]*` misses.
  const names = [
    'server.pid',
    'hook.secret',
    '.gitignore',
    'state.db-wal',
    'tracked.yaml',
    'notes.txt',
    '..x',
  ];
  for (const name of names) {
    for (const dangling of [false, true]) {
      withRoot((root, coherenceDir) => {
        mkdirSync(coherenceDir);
        writeFileSync(join(root, 'target'), 'keep');
        symlinkSync(join(root, dangling ? 'gone' : 'target'), join(coherenceDir, name));
        const where = `${name}${dangling ? ' (dangling)' : ''}`;
        assert.deepEqual(
          checkCoherenceDir(coherenceDir),
          refusal('link', join(coherenceDir, name)),
          where
        );
      });
    }
  }
  withRoot((root, coherenceDir) => {
    mkdirSync(coherenceDir);
    mkdirSync(join(root, 'dir'));
    symlinkSync(join(root, 'dir'), join(coherenceDir, 'sub'));
    assert.deepEqual(checkCoherenceDir(coherenceDir), refusal('link', join(coherenceDir, 'sub')));
  });
});

test('checkCoherenceDir passes a link nested in a subdirectory of .coherence', () => {
  withRoot((root, coherenceDir) => {
    mkdirSync(join(coherenceDir, 'sub'), { recursive: true });
    symlinkSync(join(root, 'gone'), join(coherenceDir, 'sub', 'hook.secret'));
    assert.equal(checkCoherenceDir(coherenceDir), null);
  });
});

test('checkCoherenceDir names the first link in byte order and counts the rest', () => {
  withRoot((root, coherenceDir) => {
    mkdirSync(coherenceDir);
    for (const name of ['tracked.yaml', 'hook.secret', 'state.db']) {
      symlinkSync(join(root, 'gone'), join(coherenceDir, name));
    }
    assert.deepEqual(
      checkCoherenceDir(coherenceDir),
      refusal('link', join(coherenceDir, 'hook.secret'), 2)
    );
  });
});

test(
  'checkCoherenceDir throws when it cannot list .coherence',
  { skip: process.getuid?.() === 0 ? 'root lists a mode-000 directory' : false },
  () => {
    withRoot((_root, coherenceDir) => {
      mkdirSync(coherenceDir);
      symlinkSync('/nowhere', join(coherenceDir, 'state.db'));
      chmodSync(coherenceDir, 0o000);
      try {
        // Cannot tell is not clean: no start may go on over entries it could not see.
        assert.throws(() => checkCoherenceDir(coherenceDir), { code: 'EACCES' });
      } finally {
        chmodSync(coherenceDir, 0o700);
      }
    });
  }
);

/** Generous for a loaded host: the child's own start-up counts against it, not only the check. */
const CHILD_TIMEOUT_MS = 30_000;
/** A check that only lstats and lists answers in milliseconds; this only has to tell it from a block. */
const AT_ONCE_MS = 2_000;

/** checkCoherenceDir on each [name, coherenceDir] given as JSON, one JSON line per case as it is answered. */
const CHECK_CASES_SCRIPT =
  'const [moduleUrl, cases] = process.argv.slice(1);\n' +
  'const { checkCoherenceDir } = await import(moduleUrl);\n' +
  'for (const [name, coherenceDir] of JSON.parse(cases)) {\n' +
  '  const started = performance.now();\n' +
  '  const refusal = checkCoherenceDir(coherenceDir);\n' +
  "  process.stdout.write(JSON.stringify({ name, refusal, ms: performance.now() - started }) + '\\n');\n" +
  '}\n';

test(
  'checkCoherenceDir returns at once over a FIFO: a FIFO entry, a link to one, and a FIFO at .coherence',
  { skip: process.platform === 'win32' },
  async () => {
    await withRootAsync(async (root) => {
      const coherenceAt = (name: string) => {
        mkdirSync(join(root, name));
        return join(root, name, '.coherence');
      };
      const fifos: string[] = [];
      const fifoAt = (path: string) => {
        makeFifo(path);
        fifos.push(path);
        return path;
      };
      const fifoEntry = coherenceAt('fifo-entry');
      mkdirSync(fifoEntry);
      fifoAt(join(fifoEntry, 'tracked.yaml'));
      const linkToFifo = coherenceAt('link-to-fifo');
      mkdirSync(linkToFifo);
      symlinkSync(fifoAt(join(root, 'pipe')), join(linkToFifo, 'server.pid'));
      const fifoDir = coherenceAt('fifo-dir');
      fifoAt(fifoDir);
      const linkAndFifo = coherenceAt('link-and-fifo');
      mkdirSync(linkAndFifo);
      fifoAt(join(linkAndFifo, 'a.fifo'));
      symlinkSync(join(root, 'gone'), join(linkAndFifo, 'z.link'));
      const twoFifos = coherenceAt('two-fifos');
      mkdirSync(twoFifos);
      fifoAt(join(twoFifos, 'state.db'));
      fifoAt(join(twoFifos, 'hook.secret'));

      const cases: Array<[string, string]> = [
        ['FIFO entry', fifoEntry],
        ['link to a FIFO', linkToFifo],
        ['FIFO at .coherence', fifoDir],
        ['a link and a FIFO', linkAndFifo],
        ['two FIFOs', twoFifos],
      ];
      // In a child: a check that opened what it found would block there, not here.
      const run = await runBounded(
        CHECK_CASES_SCRIPT,
        [compiledModuleUrl('coherence_dir.js'), JSON.stringify(cases)],
        { timeoutMs: CHILD_TIMEOUT_MS, fifos }
      );
      const rows = run.stdout
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { name: string; refusal: unknown; ms: number });
      assert.equal(
        run.timedOut,
        false,
        `the check blocked; answered before it: ${run.stdout} ${run.stderr}`
      );
      assert.deepEqual(Object.fromEntries(rows.map((row) => [row.name, row.refusal])), {
        'FIFO entry': refusal('special', join(fifoEntry, 'tracked.yaml')),
        'link to a FIFO': refusal('link', join(linkToFifo, 'server.pid')),
        'FIFO at .coherence': refusal('not_a_directory', fifoDir),
        // Links first, whatever their order: a link is named before any FIFO.
        'a link and a FIFO': refusal('link', join(linkAndFifo, 'z.link')),
        'two FIFOs': refusal('special', join(twoFifos, 'hook.secret'), 1),
      });
      for (const row of rows)
        assert.ok(row.ms < AT_ONCE_MS, `${row.name}: the check took ${row.ms} ms`);
    });
  }
);

test('the refusal texts are the library start check texts, byte for byte', () => {
  const dir = '/w/.coherence';
  const message = (kind: CoherenceDirRefusal['kind'], path: string, more = 0) =>
    coherenceDirRefusalMessage({ kind, path, more }, dir);
  assert.equal(
    message('link', dir),
    'refusing /w/.coherence: it is a symlink, and .coherence must be a real directory. Replace the link with a real directory and copy in the files you want to keep (move state.db together with its -wal and -shm), or mount a directory at /w/.coherence.'
  );
  assert.equal(
    message('link', `${dir}/hook.secret`),
    'refusing /w/.coherence/hook.secret: it is a symlink, and .coherence must be a real directory with no link directly inside it. Replace the link with a copy of the file it names, or mount a directory at /w/.coherence.'
  );
  assert.equal(
    message('link', `${dir}/state.db`),
    'refusing /w/.coherence/state.db: it is a symlink, and .coherence must be a real directory with no link directly inside it. Replace the link with a copy of the file it names (move state.db together with its -wal and -shm), or mount a directory at /w/.coherence.'
  );
  assert.equal(
    message('link', `${dir}/state.db-wal`, 1),
    'refusing /w/.coherence/state.db-wal: it is a symlink, and .coherence must be a real directory with no link directly inside it. Replace the link with a copy of the file it names (move state.db together with its -wal and -shm), or mount a directory at /w/.coherence. 1 more entry in .coherence is a link too.'
  );
  assert.equal(
    message('link', `${dir}/workspace.db-shm`, 2),
    'refusing /w/.coherence/workspace.db-shm: it is a symlink, and .coherence must be a real directory with no link directly inside it. Replace the link with a copy of the file it names (move state.db together with its -wal and -shm), or mount a directory at /w/.coherence. 2 more entries in .coherence are links too.'
  );
  assert.equal(
    message('not_a_directory', dir),
    'refusing /w/.coherence: it is not a directory. Move it aside; a start then creates .coherence as a real directory.'
  );
  assert.equal(
    message('special', `${dir}/tracked.yaml`),
    'refusing /w/.coherence/tracked.yaml: it is a FIFO, socket or device, which no coordinator creates, and opening it can block a start. Remove it, then start again.'
  );
  assert.equal(
    message('special', `${dir}/hook.secret`, 1),
    'refusing /w/.coherence/hook.secret: it is a FIFO, socket or device, which no coordinator creates, and opening it can block a start. Remove it, then start again. 1 more entry in .coherence is a FIFO, socket or device too.'
  );
  assert.equal(
    message('special', `${dir}/hook.secret`, 3),
    'refusing /w/.coherence/hook.secret: it is a FIFO, socket or device, which no coordinator creates, and opening it can block a start. Remove it, then start again. 3 more entries in .coherence are FIFOs, sockets or devices too.'
  );
});

test('the refusal keeps a name raw, and its text escapes what a terminal would act on', () => {
  withRoot((root, coherenceDir) => {
    mkdirSync(coherenceDir);
    const name = 'evil\x1b[2J\nname';
    symlinkSync(join(root, 'gone'), join(coherenceDir, name));
    const found = checkCoherenceDir(coherenceDir);
    assert.deepEqual(found, refusal('link', join(coherenceDir, name)));
    const text = coherenceDirRefusalMessage(found!, coherenceDir);
    assert.ok(text.includes('evil\\x1b[2J\\nname: it is a symlink'), text);
    assert.ok(!text.includes('\x1b') && !text.includes('\n'), text);
  });
});

test('a refused start exits 2, the library coordinator code for a start it refuses', () => {
  assert.equal(EXIT_REFUSED, 2);
});
