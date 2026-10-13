/**
 * Caller principal through the REAL hook client binary (library
 * caller-principal plan, U5). The Python coordinator mints a principal per
 * session; once a session is bound, a request naming it without that
 * principal is refused on the require-class routes, while a session nobody
 * has claimed is admitted and counted (KTD15), and a presented principal that
 * is not the bound one is refused on every route. This Node coordinator
 * issues none (404 on the claim) and ignores the header (plan KTD12).
 *
 * A principal refusal is HTTP 400 carrying a typed `reason`
 * (`caller_principal_absent` / `caller_principal_foreign`). The client
 * classifies it by that key alone and recovers by re-claiming with the SAME
 * stored mint nonce — never a new one — then retrying the refused request
 * once.
 *
 * What the principal buys on the hook surface is convention-enforcement and a
 * detectable unbound caller: the client stores it under `.coherence/`, so any
 * process that can read that directory can present it for any session. None
 * of these tests claim caller separation between processes of one OS user.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { ArtifactRegistry } from '../registry.js';
import { PolicyRef } from '../policy.js';
import { SessionRegistry } from '../sessions.js';
import { createServer } from '../server.js';
import { sessionToAgentId } from '../agent_id.js';
import { principalRefusalReason, recoverFromPrincipalRefusal } from '../caller_principal.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_CLIENT_JS = join(HERE, '..', 'hook_client.js');
/** FROZEN duplicate of the wire name — never imported from the code under test. */
const HEADER = 'coherence-caller-principal'; // node lowercases incoming header names
const SID = '66666666-6666-4666-8666-666666666666';
const SECRET = 's'.repeat(32);
const MINTED = 'P'.repeat(43); // a principal-shaped value a fake coordinator hands out

interface Recorded {
  url: string;
  principal: string | undefined;
  body: Record<string, unknown>;
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'principal-test-'));
  mkdirSync(join(root, '.coherence'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, '.coherence', 'hook.secret'), `${SECRET}\n`);
  return root;
}

function filesFor(root: string, sessionId: string): { nonce: string; principal: string } {
  const key = sessionToAgentId(sessionId);
  return {
    nonce: join(root, '.coherence', `caller-principal-${key}.nonce`),
    principal: join(root, '.coherence', `caller-principal-${key}.principal`),
  };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/**
 * A scripted answer. `phrase` (the HTTP reason phrase), `headers` and `raw` (a
 * body sent verbatim instead of JSON) let a fake put coordinator text in every
 * free-text field an answer has.
 */
type Answer = {
  status: number;
  body: unknown;
  phrase?: string;
  headers?: Record<string, string>;
  raw?: string;
};
type Answerer = (
  url: string,
  body: Record<string, unknown>,
  principal: string | undefined
) => Answer;

/** A stand-in for a principal-issuing (Python) coordinator: scripted claim and hook answers, every request recorded. */
async function fakeCoordinator(
  root: string,
  answer: Answerer
): Promise<{ server: Server; seen: Recorded[] }> {
  const seen: Recorded[] = [];
  const server = createHttpServer((req, res) => {
    void readBody(req).then((body) => {
      const header = req.headers[HEADER];
      const principal = typeof header === 'string' ? header : undefined;
      seen.push({ url: req.url ?? '', principal, body });
      const out = answer(req.url ?? '', body, principal);
      const payload = out.raw ?? JSON.stringify(out.body);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(out.headers ?? {}),
      };
      if (out.phrase === undefined) res.writeHead(out.status, headers);
      else res.writeHead(out.status, out.phrase, headers);
      res.end(payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(join(root, '.coherence', 'server.pid'), `${process.pid}\n${port}\n`);
  return { server, seen };
}

function runClient(
  args: string[],
  stdin: string,
  cwd: string
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [HOOK_CLIENT_JS, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (status) => resolveRun({ stdout, stderr, status }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

function postEditPayload(root: string, sessionId: string = SID): string {
  writeFileSync(join(root, 'plan.md'), 'plan v2');
  return JSON.stringify({
    session_id: sessionId,
    tool_input: { file_path: join(root, 'plan.md') },
  });
}

const close = (server: Server): Promise<void> => new Promise((r) => server.close(() => r()));

// ------------------------------------------- against a principal-issuing coordinator

test('claim once, then present: the principal is persisted and every later hook sends it without claiming again', async () => {
  const root = makeWorkspace();
  const { server, seen } = await fakeCoordinator(root, (url) =>
    url === '/principal/claim'
      ? { status: 200, body: { ok: true, principal: MINTED } }
      : { status: 200, body: { ok: true } }
  );
  try {
    const first = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
    const second = await runClient(
      ['session-stop', '--root', root],
      JSON.stringify({ session_id: SID }),
      root
    );
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.deepEqual(
      seen.map((r) => [r.url, r.principal]),
      [
        ['/principal/claim', undefined],
        ['/hooks/post-edit', MINTED],
        ['/hooks/session-stop', MINTED],
      ]
    );
    const { nonce, principal } = filesFor(root, SID);
    // The nonce on the wire is the one persisted BEFORE the claim was sent.
    assert.equal(seen[0]!.body.mint_nonce, readFileSync(nonce, 'utf8').trim());
    assert.equal(seen[0]!.body.session_id, SID);
    assert.equal(readFileSync(principal, 'utf8').trim(), MINTED);
    assert.equal(statSync(principal).mode & 0o777, 0o600);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a refused claim is reported and NOT re-minted: nothing stored, the nonce left in place, no header sent', async () => {
  const root = makeWorkspace();
  const { server, seen } = await fakeCoordinator(root, (url) =>
    url === '/principal/claim'
      ? { status: 200, body: { ok: false, reason: 'caller_principal_claimed', detail: 'bound' } }
      : { status: 200, body: { ok: true } }
  );
  try {
    const run = await runClient(['pre-edit', '--root', root], postEditPayload(root), root);
    const { nonce, principal } = filesFor(root, SID);
    const nonceBefore = readFileSync(nonce, 'utf8');
    const again = await runClient(['pre-edit', '--root', root], postEditPayload(root), root);
    assert.equal(run.status, 0);
    assert.match(run.stderr, /caller principal refused: .*NOT re-minting/);
    assert.equal(again.status, 0);
    assert.ok(!existsSync(principal), 'a refused claim stores nothing');
    assert.equal(readFileSync(nonce, 'utf8'), nonceBefore, 'the nonce is never replaced');
    const claims = seen.filter((r) => r.url === '/principal/claim');
    assert.equal(
      new Set(claims.map((r) => r.body.mint_nonce)).size,
      1,
      'every retry presents the SAME nonce'
    );
    assert.ok(
      seen.filter((r) => r.url === '/hooks/pre-edit').every((r) => r.principal === undefined)
    );
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('any 2xx claim answer is the claim contract, as for the Python client: a 201 bound principal is stored and presented, a 201 caller_principal_claimed is a refusal', async () => {
  const cases: Array<[string, Answer, boolean]> = [
    ['bound', { status: 201, body: { ok: true, principal: MINTED } }, true],
    [
      'claimed',
      { status: 201, body: { ok: false, reason: 'caller_principal_claimed', detail: 'bound' } },
      false,
    ],
  ];
  for (const [label, claimAnswer, bound] of cases) {
    const root = makeWorkspace();
    const { server, seen } = await fakeCoordinator(root, (url) =>
      url === '/principal/claim' ? claimAnswer : { status: 200, body: { ok: true } }
    );
    try {
      const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
      assert.equal(run.status, 0);
      const hook = seen.find((r) => r.url === '/hooks/post-edit');
      const { principal } = filesFor(root, SID);
      if (bound) {
        assert.equal(hook?.principal, MINTED, `${label}: presented`);
        assert.equal(readFileSync(principal, 'utf8').trim(), MINTED, `${label}: stored`);
        assert.equal(run.stderr, '', `${label}: nothing to report`);
      } else {
        assert.equal(hook?.principal, undefined, `${label}: no header`);
        assert.ok(!existsSync(principal), `${label}: nothing stored`);
        assert.match(run.stderr, /caller principal refused: .*NOT re-minting/, label);
      }
    } finally {
      await close(server);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// ------------------------------- a principal refusal, and recovering from one

/** FROZEN duplicates of the typed refusal reasons — never imported from the code under test. */
const FOREIGN = 'caller_principal_foreign';
const ABSENT = 'caller_principal_absent';
const CLAIMED = 'caller_principal_claimed';
/** The refusal prose deliberately never names the header: the client must classify by `reason`. */
const REFUSED_TEXT = 'principal refused';
/** FROZEN duplicate of the Python posture table's require class for the hook routes (KTD15). */
const REQUIRE_CLASS = new Set(['/hooks/pre-edit', '/hooks/post-edit', '/hooks/session-stop']);
const NONCE = 'N'.repeat(43);
const STALE = 'S'.repeat(43);
const FRESH = 'F'.repeat(43);

const refusal = (reason: string): Answer => ({
  status: 400,
  body: { error: REFUSED_TEXT, reason },
});
const hookOk = (url: string): Answer => ({
  status: 200,
  body: url === '/hooks/pre-read' ? { status: 'fresh', version: 1 } : { ok: true },
});

interface Binding {
  nonce: string;
  principal: string;
}

/**
 * A stand-in for the Python coordinator's binding store and route posture: a
 * first claim binds, a claim presenting the binding's own nonce gets the same
 * principal back (R20), any other nonce is refused; a presented principal must
 * be the bound one on every route, and an absent one is refused only on a
 * require-class route of a bound session. Clearing `bindings` is what removing
 * state.db does: every binding gone, the client's files left in place.
 */
function pythonLikeCoordinator(): { answer: Answerer; bindings: Map<string, Binding> } {
  const bindings = new Map<string, Binding>();
  let minted = 0;
  const answer: Answerer = (url, body, principal) => {
    const sessionId = String(body.session_id);
    const bound = bindings.get(sessionId);
    if (url === '/principal/claim') {
      const nonce = String(body.mint_nonce);
      if (bound === undefined) {
        minted += 1;
        const fresh = `M${String(minted).padStart(42, '0')}`;
        bindings.set(sessionId, { nonce, principal: fresh });
        return { status: 200, body: { ok: true, principal: fresh } };
      }
      return bound.nonce === nonce
        ? { status: 200, body: { ok: true, principal: bound.principal } }
        : { status: 200, body: { ok: false, reason: CLAIMED, detail: 'bound' } };
    }
    if (principal !== undefined) {
      return bound?.principal === principal ? hookOk(url) : refusal(FOREIGN);
    }
    return bound !== undefined && REQUIRE_CLASS.has(url) ? refusal(ABSENT) : hookOk(url);
  };
  return { answer, bindings };
}

function hookPayload(root: string, hook: string, sessionId: string = SID): string {
  return hook === 'session-stop'
    ? JSON.stringify({ session_id: sessionId })
    : postEditPayload(root, sessionId);
}

function writeStored(root: string, values: { nonce?: string; principal?: string }): void {
  const files = filesFor(root, SID);
  if (values.nonce !== undefined) writeFileSync(files.nonce, `${values.nonce}\n`, { mode: 0o600 });
  if (values.principal !== undefined)
    writeFileSync(files.principal, `${values.principal}\n`, { mode: 0o600 });
}

/** What `.coherence/` holds: a replacement leaves no temporary file behind. */
function coherenceEntries(root: string): string[] {
  return readdirSync(join(root, '.coherence')).sort();
}

function expectedEntries(): string[] {
  const key = sessionToAgentId(SID);
  return [
    `caller-principal-${key}.nonce`,
    `caller-principal-${key}.principal`,
    'hook.secret',
    'server.pid',
  ].sort();
}

const trail = (seen: Recorded[]): Array<[string, string | undefined]> =>
  seen.map((r) => [r.url, r.principal]);

async function withCoordinator(
  answer: Answerer,
  body: (root: string, seen: Recorded[]) => Promise<void>
): Promise<void> {
  const root = makeWorkspace();
  const { server, seen } = await fakeCoordinator(root, answer);
  try {
    await body(root, seen);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
}

for (const hook of ['pre-read', 'post-edit'] as const) {
  test(`${hook}: a stored principal that outlived its binding (state.db removed) is re-claimed with the SAME nonce, replaced, and the hook retried once`, async () => {
    const coordinator = pythonLikeCoordinator();
    await withCoordinator(coordinator.answer, async (root, seen) => {
      await runClient(['post-edit', '--root', root], postEditPayload(root), root);
      const { nonce, principal } = filesFor(root, SID);
      const nonceBytes = readFileSync(nonce, 'utf8');
      const stale = readFileSync(principal, 'utf8').trim();
      coordinator.bindings.clear();
      seen.length = 0;

      const run = await runClient([hook, '--root', root], hookPayload(root, hook), root);

      const fresh = coordinator.bindings.get(SID)?.principal;
      assert.ok(fresh !== undefined && fresh !== stale, 'the re-claim bound a new principal');
      assert.equal(run.status, 0);
      assert.deepEqual(JSON.parse(run.stdout), hookOk(`/hooks/${hook}`).body);
      assert.deepEqual(trail(seen), [
        [`/hooks/${hook}`, stale],
        ['/principal/claim', undefined],
        [`/hooks/${hook}`, fresh],
      ]);
      assert.equal(seen[1]!.body.mint_nonce, nonceBytes.trim(), 'the SAME stored nonce');
      assert.equal(readFileSync(nonce, 'utf8'), nonceBytes, 'the nonce file is never rewritten');
      assert.equal(readFileSync(principal, 'utf8').trim(), fresh, 'the stored principal replaced');
      assert.equal(statSync(principal).mode & 0o777, 0o600);
      assert.deepEqual(coherenceEntries(root), expectedEntries());
      assert.equal(run.stderr, '', 'a recovered refusal is not an error');

      seen.length = 0;
      await runClient(['session-stop', '--root', root], hookPayload(root, 'session-stop'), root);
      assert.deepEqual(trail(seen), [['/hooks/session-stop', fresh]], 'later hooks present it');
    });
  });
}

test('a lost claim response (R20): the absent refusal is recovered by re-claiming with the stored nonce, then the hook is retried once', async () => {
  const coordinator = pythonLikeCoordinator();
  let claims = 0;
  const loseFirst: Answerer = (url, body, principal) => {
    const out = coordinator.answer(url, body, principal);
    if (url === '/principal/claim' && ++claims === 1) {
      // The bind committed; the answer is the Python claim route's degrade envelope.
      return { status: 200, body: { ok: false, degraded: true, reason: 'claim_unconfirmed' } };
    }
    return out;
  };
  await withCoordinator(loseFirst, async (root, seen) => {
    const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
    const bound = coordinator.bindings.get(SID)!;
    assert.deepEqual(JSON.parse(run.stdout), { ok: true });
    assert.deepEqual(trail(seen), [
      ['/principal/claim', undefined],
      ['/hooks/post-edit', undefined],
      ['/principal/claim', undefined],
      ['/hooks/post-edit', bound.principal],
    ]);
    assert.equal(seen[0]!.body.mint_nonce, seen[2]!.body.mint_nonce, 'one nonce, never re-minted');
    assert.equal(readFileSync(filesFor(root, SID).principal, 'utf8').trim(), bound.principal);
  });
});

test('a re-claim that hands back the principal already presented is reported and NOT retried', async () => {
  const sameAgain: Answerer = (url) =>
    url === '/principal/claim'
      ? { status: 200, body: { ok: true, principal: STALE } }
      : refusal(FOREIGN);
  await withCoordinator(sameAgain, async (root, seen) => {
    writeStored(root, { nonce: NONCE, principal: STALE });
    const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
    assert.equal(run.stdout.trim(), '{}');
    assert.deepEqual(trail(seen), [
      ['/hooks/post-edit', STALE],
      ['/principal/claim', undefined],
    ]);
    assert.match(run.stderr, new RegExp(`\\(${FOREIGN}\\).*principal already presented`));
    assert.equal(readFileSync(filesFor(root, SID).principal, 'utf8').trim(), STALE);
  });
});

test('a session bound under ANOTHER nonce: the re-claim is refused, reported, and nothing is re-minted or rewritten', async () => {
  const coordinator = pythonLikeCoordinator();
  coordinator.bindings.set(SID, { nonce: 'O'.repeat(43), principal: 'Q'.repeat(43) });
  await withCoordinator(coordinator.answer, async (root, seen) => {
    writeStored(root, { nonce: NONCE, principal: STALE });
    const { nonce, principal } = filesFor(root, SID);
    const before = [readFileSync(nonce, 'utf8'), readFileSync(principal, 'utf8')];
    const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
    assert.equal(run.stdout.trim(), '{}');
    assert.deepEqual(trail(seen), [
      ['/hooks/post-edit', STALE],
      ['/principal/claim', undefined],
    ]);
    assert.equal(seen[1]!.body.mint_nonce, NONCE, 'the stored nonce, never a new one');
    assert.match(run.stderr, /bound under a different mint nonce/);
    assert.deepEqual([readFileSync(nonce, 'utf8'), readFileSync(principal, 'utf8')], before);
    assert.deepEqual(coordinator.bindings.get(SID)?.nonce, 'O'.repeat(43));
  });
});

test('a coordinator that issues no principals now (404 on the re-claim): the hook is retried once WITHOUT the header', async () => {
  const noPrincipals: Answerer = (url, _body, principal) =>
    url === '/principal/claim'
      ? { status: 404, body: { error: 'not found' } }
      : principal !== undefined
        ? refusal(FOREIGN)
        : hookOk(url);
  await withCoordinator(noPrincipals, async (root, seen) => {
    writeStored(root, { nonce: NONCE, principal: STALE });
    const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
    assert.deepEqual(JSON.parse(run.stdout), { ok: true });
    assert.deepEqual(trail(seen), [
      ['/hooks/post-edit', STALE],
      ['/principal/claim', undefined],
      ['/hooks/post-edit', undefined],
    ]);
    assert.equal(
      readFileSync(filesFor(root, SID).principal, 'utf8').trim(),
      STALE,
      'never deleted'
    );
    assert.equal(readFileSync(filesFor(root, SID).nonce, 'utf8').trim(), NONCE, 'never deleted');
  });
});

test('no stored mint nonce: the refusal is reported by its typed reason, nothing is claimed or created, the stored principal stays', async () => {
  await withCoordinator(
    () => refusal(FOREIGN),
    async (root, seen) => {
      writeStored(root, { principal: STALE });
      const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
      assert.equal(run.status, 0);
      assert.equal(run.stdout.trim(), '{}');
      assert.match(run.stderr, new RegExp(`\\(${FOREIGN}\\).*no stored mint nonce`));
      assert.deepEqual(trail(seen), [['/hooks/post-edit', STALE]], 'no claim, no retry');
      assert.equal(readFileSync(filesFor(root, SID).principal, 'utf8').trim(), STALE);
      assert.ok(!existsSync(filesFor(root, SID).nonce), 'recovery never creates a nonce');
    }
  );
});

test('the retry happens at most ONCE: a retried hook refused again is reported, not re-claimed', async () => {
  const alwaysForeign: Answerer = (url) =>
    url === '/principal/claim'
      ? { status: 200, body: { ok: true, principal: FRESH } }
      : refusal(FOREIGN);
  await withCoordinator(alwaysForeign, async (root, seen) => {
    writeStored(root, { nonce: NONCE, principal: STALE });
    const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
    assert.equal(run.stdout.trim(), '{}');
    assert.deepEqual(trail(seen), [
      ['/hooks/post-edit', STALE],
      ['/principal/claim', undefined],
      ['/hooks/post-edit', FRESH],
    ]);
    assert.match(run.stderr, /refused this hook's caller principal again/);
  });
});

/**
 * Refused, recovered, refused again — the two refusals carrying DIFFERENT
 * reasons, so the report can name only the one it must: the retry's. The
 * coordinator refuses an absent header as `absent` and any presented principal
 * as `foreign`; each case differs only in its claim answers and what is stored.
 */
const REFUSED_TWICE: Array<{
  label: string;
  stored: { nonce?: string; principal?: string };
  claim: (n: number) => Answer;
  trail: Array<[string, string | undefined]>;
  second: string;
}> = [
  {
    label: 'absent, then foreign after a re-claim that bound a new principal',
    stored: {},
    // The first claim's answer is lost (the degrade envelope); the re-claim binds.
    claim: (n) =>
      n === 1
        ? { status: 200, body: { ok: false, degraded: true, reason: 'claim_unconfirmed' } }
        : { status: 200, body: { ok: true, principal: FRESH } },
    trail: [
      ['/principal/claim', undefined],
      ['/hooks/post-edit', undefined],
      ['/principal/claim', undefined],
      ['/hooks/post-edit', FRESH],
    ],
    second: FOREIGN,
  },
  {
    label: 'foreign, then absent after a re-claim answered 404',
    stored: { nonce: NONCE, principal: STALE },
    claim: () => ({ status: 404, body: { error: 'not found' } }),
    trail: [
      ['/hooks/post-edit', STALE],
      ['/principal/claim', undefined],
      ['/hooks/post-edit', undefined],
    ],
    second: ABSENT,
  },
];

for (const { label, stored, claim, trail: expected, second } of REFUSED_TWICE) {
  test(`refused again after the re-claim: the report names the RETRY's reason, not the first refusal's (${label})`, async () => {
    let claims = 0;
    const answer: Answerer = (url, _body, principal) =>
      url === '/principal/claim'
        ? claim(++claims)
        : refusal(principal === undefined ? ABSENT : FOREIGN);
    await withCoordinator(answer, async (root, seen) => {
      writeStored(root, stored);
      const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
      assert.equal(run.status, 0);
      assert.equal(run.stdout.trim(), '{}');
      // Both refusals happened: the first presented one way, the retry the other.
      assert.deepEqual(trail(seen), expected);
      const named = [...run.stderr.matchAll(/again after the re-claim \(([^)]*)\)/g)].map(
        (m) => m[1]
      );
      assert.deepEqual(named, [second], `one report, naming ${second}: ${run.stderr}`);
    });
  });
}

test('a refusal is classified by its typed reason alone: a 400 whose PROSE names the header and reason, but carries no reason key, is not one', async () => {
  const proseOnly: Answerer = () => ({
    status: 400,
    body: {
      error:
        'the Coherence-Caller-Principal header is not the caller principal bound to the session_id this request names (caller_principal_foreign)',
    },
  });
  await withCoordinator(proseOnly, async (root, seen) => {
    writeStored(root, { nonce: NONCE, principal: STALE });
    const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
    assert.equal(run.stdout.trim(), '{}');
    assert.deepEqual(trail(seen), [['/hooks/post-edit', STALE]], 'no claim, no retry');
    assert.equal(run.stderr, '', 'an untyped 400 degrades like any other');
  });
});

test('only the two principal refusal reasons are recovered: another caller_principal_* token is not one', async () => {
  await withCoordinator(
    () => ({ status: 400, body: { error: REFUSED_TEXT, reason: CLAIMED } }),
    async (root, seen) => {
      writeStored(root, { nonce: NONCE, principal: STALE });
      const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
      assert.equal(run.stdout.trim(), '{}');
      assert.deepEqual(trail(seen), [['/hooks/post-edit', STALE]], 'no claim, no retry');
      assert.equal(run.stderr, '');
    }
  );
});

test('a typed principal reason on an answer that is not HTTP 400 is not a refusal: nothing is claimed or retried', async () => {
  await withCoordinator(
    () => ({ status: 409, body: { error: REFUSED_TEXT, reason: FOREIGN } }),
    async (root, seen) => {
      writeStored(root, { nonce: NONCE, principal: STALE });
      const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
      assert.equal(run.stdout.trim(), '{}');
      assert.deepEqual(trail(seen), [['/hooks/post-edit', STALE]], 'no claim, no retry');
      assert.equal(run.stderr, '');
    }
  );
});

test('a session id with a trailing newline is never claimed for, and a refusal naming it is not recovered (the Python client applies the same rule)', async () => {
  const sid = `${SID}\n`;
  const alwaysAbsent: Answerer = (url) =>
    url === '/principal/claim'
      ? { status: 200, body: { ok: true, principal: FRESH } }
      : refusal(ABSENT);
  await withCoordinator(alwaysAbsent, async (root, seen) => {
    // A nonce a client that claimed for this id would have stored.
    const { nonce } = filesFor(root, sid);
    writeFileSync(nonce, `${NONCE}\n`, { mode: 0o600 });
    const run = await runClient(['post-edit', '--root', root], postEditPayload(root, sid), root);
    assert.equal(run.stdout.trim(), '{}');
    assert.deepEqual(trail(seen), [['/hooks/post-edit', undefined]], 'no claim, no retry');
    assert.match(run.stderr, /\(caller_principal_absent\); the session id is malformed/);
    assert.equal(readFileSync(nonce, 'utf8'), `${NONCE}\n`);
  });
});

for (const [label, torn] of [
  ['empty', ''],
  ['malformed', 'not-a-principal\n'],
] as const) {
  test(`a torn (${label}) stored principal is re-obtained with the stored nonce and REPAIRED, so later hooks claim nothing`, async () => {
    const coordinator = pythonLikeCoordinator();
    coordinator.bindings.set(SID, { nonce: NONCE, principal: FRESH });
    await withCoordinator(coordinator.answer, async (root, seen) => {
      writeStored(root, { nonce: NONCE });
      writeFileSync(filesFor(root, SID).principal, torn, { mode: 0o600 });
      await runClient(['post-edit', '--root', root], postEditPayload(root), root);
      await runClient(['session-stop', '--root', root], hookPayload(root, 'session-stop'), root);
      assert.deepEqual(trail(seen), [
        ['/principal/claim', undefined],
        ['/hooks/post-edit', FRESH],
        ['/hooks/session-stop', FRESH],
      ]);
      assert.equal(seen[0]!.body.mint_nonce, NONCE);
      const { principal } = filesFor(root, SID);
      assert.equal(readFileSync(principal, 'utf8').trim(), FRESH);
      assert.equal(statSync(principal).mode & 0o777, 0o600);
      assert.deepEqual(coherenceEntries(root), expectedEntries());
    });
  });
}

test('an EMPTY mint-nonce file a crashed writer left behind is never overwritten: the hook claims nothing, proceeds without a principal, and names the file to remove', async () => {
  const coordinator = pythonLikeCoordinator();
  await withCoordinator(coordinator.answer, async (root, seen) => {
    const { nonce, principal } = filesFor(root, SID);
    writeFileSync(nonce, '', { mode: 0o600 });
    const longAgo = Date.now() / 1000 - 60;
    utimesSync(nonce, longAgo, longAgo);
    const first = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
    const second = await runClient(
      ['session-stop', '--root', root],
      hookPayload(root, 'session-stop'),
      root
    );
    // Unbound, so the Python coordinator admits the absent principal (KTD15).
    assert.deepEqual(JSON.parse(first.stdout), hookOk('/hooks/post-edit').body);
    assert.deepEqual(JSON.parse(second.stdout), hookOk('/hooks/session-stop').body);
    assert.deepEqual(trail(seen), [
      ['/hooks/post-edit', undefined],
      ['/hooks/session-stop', undefined],
    ]);
    assert.equal(coordinator.bindings.size, 0, 'nothing was claimed');
    assert.equal(statSync(nonce).size, 0, 'the nonce file is never overwritten');
    assert.ok(!existsSync(principal));
    for (const run of [first, second]) {
      assert.ok(run.stderr.includes(nonce), 'the report names the file in full');
      assert.match(run.stderr, /remove .* by hand/);
    }
  });
});

test('a YOUNG empty mint-nonce file (another hook may still be writing it) is reported WITHOUT the removal step; the hook proceeds without a principal', async () => {
  const coordinator = pythonLikeCoordinator();
  await withCoordinator(coordinator.answer, async (root, seen) => {
    const { nonce, principal } = filesFor(root, SID);
    writeFileSync(nonce, '', { mode: 0o600 }); // created just now: well inside the grace
    const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
    assert.deepEqual(JSON.parse(run.stdout), hookOk('/hooks/post-edit').body);
    assert.deepEqual(trail(seen), [['/hooks/post-edit', undefined]], 'nothing claimed');
    assert.equal(statSync(nonce).size, 0, 'the nonce file is never overwritten');
    assert.ok(!existsSync(principal));
    assert.ok(run.stderr.includes(nonce), 'the report names the file in full');
    assert.match(run.stderr, /its write was still in progress/);
    assert.match(run.stderr, /a later one adopts the nonce if that write lands/);
    assert.doesNotMatch(
      run.stderr,
      /remove .* by hand/,
      'a file a live hook may still be writing is never named for removal'
    );
  });
});

// R5: nothing prints a principal or a nonce — not on a refusal, not on a
// recovery, not in a thrown message. Each coordinator below ECHOES every value
// it was sent into its error prose and reason fields, so a client that relays
// coordinator text, or builds a message from a value, is caught.
const echo = (body: Record<string, unknown>, principal: string | undefined): string =>
  `saw principal=${principal ?? '-'} nonce=${String(body.mint_nonce ?? '-')}`;

const R5_SCENARIOS: Array<[string, Answerer, boolean]> = [
  [
    're-claim unconfirmed (reason echoes the nonce)',
    (url, body, principal) =>
      url === '/principal/claim'
        ? {
            status: 200,
            body: { ok: false, reason: String(body.mint_nonce), detail: echo(body, principal) },
          }
        : { status: 400, body: { error: echo(body, principal), reason: FOREIGN } },
    true,
  ],
  [
    're-claim answered 503 with echoed prose',
    (url, body, principal) =>
      url === '/principal/claim'
        ? { status: 503, body: { error: echo(body, principal), reason: String(body.mint_nonce) } }
        : { status: 400, body: { error: echo(body, principal), reason: FOREIGN } },
    true,
  ],
  [
    're-claim refused (detail echoes the nonce)',
    (url, body, principal) =>
      url === '/principal/claim'
        ? { status: 200, body: { ok: false, reason: CLAIMED, detail: echo(body, principal) } }
        : { status: 400, body: { error: echo(body, principal), reason: FOREIGN } },
    true,
  ],
  [
    'recovered, then the retry refused again (prose echoes the new principal)',
    (url, body, principal) =>
      url === '/principal/claim'
        ? { status: 200, body: { ok: true, principal: FRESH } }
        : { status: 400, body: { error: echo(body, principal), reason: FOREIGN } },
    true,
  ],
  [
    'recovered, and the retry admitted',
    (url, body, principal) =>
      url === '/principal/claim'
        ? { status: 200, body: { ok: true, principal: FRESH } }
        : principal === FRESH
          ? hookOk(url)
          : { status: 400, body: { error: echo(body, principal), reason: FOREIGN } },
    false,
  ],
];

for (const [label, answer, reportsFailure] of R5_SCENARIOS) {
  test(`R5: no principal or nonce reaches stderr or stdout — ${label}`, async () => {
    await withCoordinator(answer, async (root, seen) => {
      writeStored(root, { nonce: NONCE, principal: STALE });
      const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
      assert.ok(
        seen.some((r) => r.url === '/principal/claim'),
        'the recovery path ran (a re-claim was sent)'
      );
      if (reportsFailure) assert.notEqual(run.stderr, '', 'the refusal was reported');
      else assert.deepEqual(JSON.parse(run.stdout), { ok: true });
      for (const value of [NONCE, STALE, FRESH]) {
        assert.ok(!run.stderr.includes(value), `stderr carries a value: ${label}`);
        assert.ok(!run.stdout.includes(value), `stdout carries a value: ${label}`);
      }
    });
  });
}

// ------------------------- only known reason tokens ever reach a report

/** FROZEN duplicate of the Python claim route's degrade-envelope reason. */
const CLAIM_UNCONFIRMED = 'claim_unconfirmed';
/** FROZEN duplicate of what a report calls any other reason: absent, unknown, or not a string. */
const UNRECOGNISED = 'unrecognised';
/** Marks every coordinator-supplied free-text field below: a report carrying it relayed coordinator text. */
const ECHO_MARK = 'COORDINATOR-TEXT';

const echoText = (body: Record<string, unknown>, principal: string | undefined): string =>
  `${ECHO_MARK} principal=${principal ?? '-'} nonce=${String(body.mint_nonce ?? '-')}`;

/** An answer whose every free-text field echoes `text`: `error`, `detail`, `message`, the reason phrase and a header. */
function echoing(status: number, fields: Record<string, unknown>, text: string): Answer {
  return {
    status,
    body: { error: text, detail: text, message: text, ...fields },
    phrase: text,
    headers: { 'X-Coordinator-Detail': text },
  };
}

/** `reason` values that are not strings, each carrying the echoed text somewhere inside where it can. */
const NON_STRING_REASONS: Array<[string, (text: string) => unknown]> = [
  ['an object', (text) => ({ reason: FOREIGN, text })],
  ['an array', (text) => [FOREIGN, text]],
  ['a number', () => 400],
  ['null', () => null],
  ['a boolean', () => true],
];

/** No value the client holds, and no coordinator text, is in `out`. */
function assertNothingRelayed(out: string, where: string): void {
  for (const value of [NONCE, STALE, FRESH, ECHO_MARK]) {
    assert.ok(
      !out.includes(value),
      `${where} carries ${value.slice(0, 16)}: ${JSON.stringify(out)}`
    );
  }
}

test('classifying a refusal never throws on a reason that is not a string, and none of them is a refusal', () => {
  for (const [label, make] of NON_STRING_REASONS) {
    assert.equal(
      principalRefusalReason({ status: 400, body: { error: 'x', reason: make('x') } }),
      null,
      `a reason that is ${label}`
    );
  }
  assert.equal(principalRefusalReason({ status: 400, body: null }), null, 'no body');
  assert.equal(principalRefusalReason({ status: 400, body: { reason: FOREIGN } }), FOREIGN);
});

for (const [label, make] of [
  ...NON_STRING_REASONS,
  ['an unknown string', (text: string) => text],
] as Array<[string, (text: string) => unknown]>) {
  test(`a hook's 400 whose reason is ${label} is not a principal refusal: nothing claimed or retried, nothing reported`, async () => {
    const answer: Answerer = (url, body, principal) =>
      url === '/principal/claim'
        ? { status: 200, body: { ok: true, principal: FRESH } }
        : echoing(400, { reason: make(echoText(body, principal)) }, echoText(body, principal));
    await withCoordinator(answer, async (root, seen) => {
      writeStored(root, { nonce: NONCE, principal: STALE });
      const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
      assert.equal(run.status, 0);
      assert.equal(run.stdout.trim(), '{}');
      assert.deepEqual(trail(seen), [['/hooks/post-edit', STALE]], 'no claim, no retry');
      assert.equal(run.stderr, '');
    });
  });
}

/** First-claim answers that confirm nothing, each echoing coordinator text in every free-text field. */
const UNCONFIRMED_FIRST_CLAIMS: Array<[string, (text: string) => Answer]> = [
  ['a reason that is an unknown string', (text) => echoing(200, { ok: false, reason: text }, text)],
  ...NON_STRING_REASONS.map(([label, make]): [string, (text: string) => Answer] => [
    `a reason that is ${label}`,
    (text) => echoing(200, { ok: false, reason: make(text) }, text),
  ]),
  ['HTTP 503', (text) => echoing(503, { reason: text }, text)],
  [
    'a principal that is not a string',
    (text) => echoing(200, { ok: true, principal: { text } }, text),
  ],
  ['a body that is not JSON', (text) => ({ status: 200, body: null, raw: text, phrase: text })],
];

for (const [label, claimAnswer] of UNCONFIRMED_FIRST_CLAIMS) {
  test(`first claim unconfirmed (${label}): the hook is still sent, without a header, and nothing of the answer is relayed`, async () => {
    const answer: Answerer = (url, body, principal) =>
      url === '/principal/claim' ? claimAnswer(echoText(body, principal)) : hookOk(url);
    await withCoordinator(answer, async (root, seen) => {
      const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
      assert.equal(run.status, 0);
      assert.deepEqual(JSON.parse(run.stdout), { ok: true }, 'the hook request was not dropped');
      assert.deepEqual(trail(seen), [
        ['/principal/claim', undefined],
        ['/hooks/post-edit', undefined],
      ]);
      const { nonce, principal } = filesFor(root, SID);
      assert.ok(!existsSync(principal), 'nothing stored from an unconfirmed claim');
      assert.equal(seen[0]!.body.mint_nonce, readFileSync(nonce, 'utf8').trim(), 'nonce kept');
      assertNothingRelayed(run.stderr, 'stderr');
      assertNothingRelayed(run.stdout, 'stdout');
    });
  });
}

/**
 * Re-claim answers that confirm nothing, and the one fragment the report
 * names for each: the HTTP status and a KNOWN reason token, or
 * `unrecognised`, never the coordinator's own text.
 */
const UNCONFIRMED_RECLAIMS: Array<[string, (text: string) => Answer, string]> = [
  [
    'the degrade envelope',
    (text) => echoing(200, { ok: false, degraded: true, reason: CLAIM_UNCONFIRMED }, text),
    `(HTTP 200, reason=${CLAIM_UNCONFIRMED})`,
  ],
  [
    'a reason that is an unknown string',
    (text) => echoing(200, { ok: false, reason: text }, text),
    `(HTTP 200, reason=${UNRECOGNISED})`,
  ],
  ...NON_STRING_REASONS.map(([label, make]): [string, (text: string) => Answer, string] => [
    `a reason that is ${label}`,
    (text) => echoing(200, { ok: false, reason: make(text) }, text),
    `(HTTP 200, reason=${UNRECOGNISED})`,
  ]),
  [
    'HTTP 503 with an unknown reason',
    (text) => echoing(503, { reason: text }, text),
    `(HTTP 503, reason=${UNRECOGNISED})`,
  ],
  [
    'HTTP 500 with no reason',
    (text) => echoing(500, {}, text),
    `(HTTP 500, reason=${UNRECOGNISED})`,
  ],
  [
    // Only a 200 carries the claim contract's refusal, as for the Python client.
    'HTTP 409 carrying caller_principal_claimed',
    (text) => echoing(409, { ok: false, reason: CLAIMED }, text),
    `(HTTP 409, reason=${CLAIMED})`,
  ],
  [
    'a body that is not JSON',
    (text) => ({ status: 200, body: null, raw: text, phrase: text }),
    `(HTTP 200, reason=${UNRECOGNISED})`,
  ],
];

for (const [label, claimAnswer, fragment] of UNCONFIRMED_RECLAIMS) {
  test(`re-claim unconfirmed (${label}): the report names ${fragment} and relays nothing`, async () => {
    const answer: Answerer = (url, body, principal) =>
      url === '/principal/claim'
        ? claimAnswer(echoText(body, principal))
        : echoing(400, { reason: FOREIGN }, echoText(body, principal));
    await withCoordinator(answer, async (root, seen) => {
      writeStored(root, { nonce: NONCE, principal: STALE });
      const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
      assert.equal(run.status, 0);
      assert.equal(run.stdout.trim(), '{}');
      assert.deepEqual(trail(seen), [
        ['/hooks/post-edit', STALE],
        ['/principal/claim', undefined],
      ]);
      assert.ok(
        run.stderr.includes(
          `(${FOREIGN}); the re-claim with the stored mint nonce was not confirmed ${fragment}`
        ),
        `the report names the refusal and ${fragment}: ${JSON.stringify(run.stderr)}`
      );
      assertNothingRelayed(run.stderr, 'stderr');
      assertNothingRelayed(run.stdout, 'stdout');
      assert.equal(readFileSync(filesFor(root, SID).principal, 'utf8').trim(), STALE, 'kept');
    });
  });
}

test('the recovery names only a known reason token: a reason it is handed that is not one is reported as unrecognised, never relayed', async () => {
  const root = makeWorkspace();
  try {
    const endpoint = { port: 1, bearer: SECRET }; // never reached: both exits below claim nothing
    const freeText = `${ECHO_MARK} ${NONCE}`;
    for (const [sessionId, exit] of [
      [SID, 'no stored mint nonce'],
      [`${SID}\n`, 'the session id is malformed'],
    ] as const) {
      for (const reason of [freeText, [FOREIGN] as unknown as string, FOREIGN]) {
        const reports: string[] = [];
        const context = { endpoint, root, sessionId, report: (m: string) => reports.push(m) };
        const retry = await recoverFromPrincipalRefusal(context, STALE, reason);
        assert.equal(retry, null, 'nothing to retry with');
        assert.equal(reports.length, 1);
        const named = reason === FOREIGN ? FOREIGN : UNRECOGNISED;
        assert.ok(
          reports[0]!.startsWith(`coordinator refused this hook's caller principal (${named}); `),
          `names ${named}: ${JSON.stringify(reports[0])}`
        );
        assert.ok(reports[0]!.includes(exit), `says why: ${exit}`);
        assertNothingRelayed(reports[0]!, 'the report');
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------ against THIS (Node) coordinator

async function nodeCoordinator(
  root: string
): Promise<{ server: Server; registry: ArtifactRegistry; seen: Recorded[] }> {
  const registry = new ArtifactRegistry(join(root, '.coherence', 'state.db'));
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: 'test',
    registry,
    policy: PolicyRef.load(root),
    sessions: new SessionRegistry(),
  });
  const seen: Recorded[] = [];
  server.on('request', (req: IncomingMessage) => {
    const principal = req.headers[HEADER];
    seen.push({
      url: req.url ?? '',
      principal: typeof principal === 'string' ? principal : undefined,
      body: {},
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(join(root, '.coherence', 'server.pid'), `${process.pid}\n${port}\nbackend=node\n`);
  return { server, registry, seen };
}

test('against the Node coordinator (backend=node pid file) the hook sends NO claim and NO header, as before', async () => {
  const root = makeWorkspace();
  const { server, registry, seen } = await nodeCoordinator(root);
  try {
    const cc = JSON.stringify({ session_id: SID });
    const run = await runClient(['session-stop', '--root', root], cc, root);
    assert.equal(run.status, 0);
    assert.deepEqual(JSON.parse(run.stdout), { ok: true, released_artifacts: [] });
    assert.equal(run.stderr, '', 'a coordinator that issues no principals is not an error');
    assert.deepEqual(
      seen.map((r) => [r.url, r.principal]),
      [['/hooks/session-stop', undefined]],
      'one request per hook: no 404 round trip on every event'
    );
    const { nonce, principal } = filesFor(root, SID);
    assert.ok(!existsSync(nonce) && !existsSync(principal), 'nothing is created or stored');
  } finally {
    await close(server);
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [label, backendLine, claims] of [
  ['the Python coordinator format (no backend line)', '', true],
  ['backend=python', 'backend=python\n', true],
  ['backend=node', 'backend=node\n', false],
] as const) {
  test(`pid file with ${label}: ${claims ? 'claims, and a 404 still means no header' : 'no claim at all'}`, async () => {
    const root = makeWorkspace();
    const { server, seen } = await fakeCoordinator(root, (url) =>
      url === '/principal/claim'
        ? { status: 404, body: { error: 'not found' } }
        : { status: 200, body: { ok: true } }
    );
    try {
      const pidFile = join(root, '.coherence', 'server.pid');
      writeFileSync(pidFile, readFileSync(pidFile, 'utf8') + backendLine);
      const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
      assert.equal(run.status, 0);
      assert.deepEqual(JSON.parse(run.stdout), { ok: true });
      const expected: Array<[string, string | undefined]> = claims
        ? [
            ['/principal/claim', undefined],
            ['/hooks/post-edit', undefined],
          ]
        : [['/hooks/post-edit', undefined]];
      assert.deepEqual(
        seen.map((r) => [r.url, r.principal]),
        expected
      );
      assert.equal(existsSync(filesFor(root, SID).nonce), claims, 'nonce file');
    } finally {
      await close(server);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('the Node coordinator does not refuse on a principal (KTD12): an unknown one is ignored, the answer unchanged', async () => {
  const root = makeWorkspace();
  const { server, registry } = await nodeCoordinator(root);
  try {
    const port = (server.address() as AddressInfo).port;
    const post = async (headers: Record<string, string>): Promise<[number, unknown]> => {
      const r = await fetch(`http://127.0.0.1:${port}/hooks/session-stop`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SECRET}`,
          Host: '127.0.0.1',
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ session_id: SID }),
      });
      return [r.status, await r.json()];
    };
    const without = await post({});
    const withForeign = await post({ 'Coherence-Caller-Principal': 'R'.repeat(43) });
    assert.deepEqual(withForeign, without);
    assert.equal(without[0], 200);
  } finally {
    await close(server);
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
