/**
 * The hook client's refusal of held strict files, driven through the built
 * client binary row by row over the library's decision table.
 *
 * With `.coherence/hook_on_held` holding `refuse`, a pre-edit of a strict
 * path asks the coordinator for the file only if no other agent holds it, and
 * turns every other answer into a deny. Each row of the library's
 * decision_table.json is set up against a scripted coordinator and run through
 * `dist/hook_client.js` as a subprocess, on each server.pid shape it applies
 * to: the Python coordinator's two lines, with the lock its coordinator holds,
 * and the Node coordinator's `backend=node`. For each run the stdout is
 * compared parsed, with the deny reason as exact text, then the requests the
 * coordinator got, the stderr and the exit code.
 *
 * What this does not prove: the coordinator is a script, not either real
 * coordinator, except where a test says it runs this repository's Node
 * coordinator; one machine and loopback only.
 */
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import decisionTable from './fixtures/hook_on_held/decision_table.json' with { type: 'json' };
import holderDenyFixture from './fixtures/hook_on_held/holder_deny.json' with { type: 'json' };
import parentDenyFixture from './fixtures/hook_on_held/parent_deny.json' with { type: 'json' };
import stderrLines from './fixtures/hook_on_held/stderr_lines.json' with { type: 'json' };
import unavailableDenyFixture from './fixtures/hook_on_held/unavailable_deny.json' with { type: 'json' };
import { sessionToAgentId } from '../agent_id.js';
import { heldStrictAnswer } from '../hook_client.js';
import { PolicyRef, TrackedArtifactPolicy } from '../policy.js';
import { ArtifactRegistry } from '../registry.js';
import { createServer } from '../server.js';
import { SessionRegistry } from '../sessions.js';
import { writeStandInPidFile } from './coordinator_stand_in.js';
import {
  HANG,
  HANG_UP,
  closedPort,
  json,
  raw,
  startScriptedPeer,
  type Reply,
  type Script,
  type ScriptedPeer,
} from './scripted_coordinator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_CLIENT_JS = join(HERE, '..', 'hook_client.js');

const STATUS = '/status?detail=metrics';
const CLAIM = '/principal/claim';
const EDIT = '/hooks/pre-edit';
const SECRET = 's'.repeat(32);
const ON = 'refuse\n';
const STRICT_FILE = 'docs/plan.md';
/** The real per-request limit and the one deadline: rows that wait it out take this long. */
const DEADLINE_MS = 5000;
/** How long a connection kept alive after an answer may sit idle: the peer's 5 s hint less a second. */
const KEPT_ALIVE_IDLE_MS = 4000;
/** What a run may take beyond the deadline: process start, imports, and this machine's load. */
const SLACK_MS = 3000;
/** Kills a client that never exits, which would otherwise hang the file. */
const RUN_KILL_MS = 30_000;

/** A coordinator that refuses held files and folds nothing. */
const REFUSES = { pre_edit_if_unheld: true, fold_profile: 'none' };
const ADMIT = { ok: true };

type Shape = 'python' | 'node';
const SHAPES: ReadonlyArray<Shape> = ['python', 'node'];

interface Caller {
  session_id: string;
  agent_id: string | null;
}

interface Row {
  name: string;
  stage: string;
  caller: Caller;
  outcome?: string;
  http?: { status: number; body: unknown };
  expected: string;
}

const ROWS = decisionTable.rows as ReadonlyArray<Row>;

interface Workspace {
  root: string;
  coherenceDir: string;
  pidFile: string;
}

interface HookRun {
  stdout: string;
  stderr: string;
  status: number | null;
  elapsedMs: number;
}

/** A workspace with `docs/plan.md` strict, the setting as given (absent for null); gone after the test. */
function strictWorkspace(t: TestContext, setting: string | null = ON): Workspace {
  // Physical: the client resolves links, and macOS's tmpdir is one.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'held-refusal-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const coherenceDir = join(root, '.coherence');
  mkdirSync(coherenceDir, { mode: 0o700 });
  writeFileSync(join(coherenceDir, 'hook.secret'), `${SECRET}\n`, { mode: 0o600 });
  writeFileSync(join(coherenceDir, 'strict_mode.yaml'), `- "${STRICT_FILE}"\n`);
  if (setting !== null) writeFileSync(join(coherenceDir, 'hook_on_held'), setting);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, STRICT_FILE), 'plan v1\n');
  writeFileSync(join(root, 'docs', 'notes.md'), 'notes v1\n');
  return { root, coherenceDir, pidFile: join(coherenceDir, 'server.pid') };
}

/** server.pid naming a coordinator on `port` that runs: the lock held, or a live pid. */
function pointAt(ws: Workspace, shape: Shape, port: number): void {
  if (shape === 'python') writeStandInPidFile(ws.pidFile, `${process.pid}\n${port}\n`);
  else writeFileSync(ws.pidFile, `${process.pid}\n${port}\nbackend=node\n`);
}

let exitedPidValue: number | undefined;
/** The pid of a process that has exited. */
function exitedPid(): number {
  exitedPidValue ??= spawnSync(process.execPath, ['-e', '']).pid;
  return exitedPidValue;
}

/** server.pid naming a coordinator on `port` that has exited: the lock free, or a dead pid. */
function pointAtExited(ws: Workspace, shape: Shape, port: number): void {
  if (shape === 'python') writeFileSync(ws.pidFile, `${process.pid}\n${port}\n`);
  else writeFileSync(ws.pidFile, `${exitedPid()}\n${port}\nbackend=node\n`);
}

/** A peer answering each route as `answers` says, else as a coordinator that refuses held files and issues no principals. */
function routes(answers: Readonly<Record<string, Reply>> = {}): Script {
  const defaults: Record<string, Reply> = {
    [STATUS]: json(REFUSES),
    [CLAIM]: json({ error: 'not found' }, 404),
    [EDIT]: json(ADMIT),
  };
  return (request) => answers[request.url] ?? defaults[request.url] ?? json({ error: 'nf' }, 404);
}

async function peerFor(t: TestContext, script: Script): Promise<ScriptedPeer> {
  const peer = await startScriptedPeer(script);
  t.after(() => peer.close());
  return peer;
}

/** The Claude Code payload of an Edit of `file` by `caller`. */
function editCc(ws: Workspace, caller: Caller, file = STRICT_FILE): Record<string, unknown> {
  const cc: Record<string, unknown> = {
    session_id: caller.session_id,
    tool_name: 'Edit',
    tool_input: { file_path: join(ws.root, file) },
  };
  if (caller.agent_id !== null) cc.agent_id = caller.agent_id;
  return cc;
}

/** Runs the built client as a hook does, on physical paths. */
function runHook(ws: Workspace, cc: unknown, sub = 'pre-edit'): Promise<HookRun> {
  return new Promise((resolveRun) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, [HOOK_CLIENT_JS, sub, '--root', ws.root], {
      cwd: ws.root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), RUN_KILL_MS);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (status) => {
      clearTimeout(killer);
      resolveRun({ stdout, stderr, status, elapsedMs: performance.now() - startedAt });
    });
    child.stdin.end(JSON.stringify(cc));
  });
}

// ------------------------------------------------------------ expected output

interface DenyOutput {
  hookSpecificOutput: {
    hookEventName: string;
    permissionDecision: string;
    permissionDecisionReason: string;
  };
}

interface DenyFixture {
  inputs: { path: string; holder_agent_id?: string };
  stdout: DenyOutput;
}

/** A fixture's deny rendered for `path` and, for the holder deny, `holder`'s short id. */
function renderDeny(fixture: DenyFixture, path: string, holder?: string): DenyOutput {
  const { stdout, inputs } = fixture;
  let reason = stdout.hookSpecificOutput.permissionDecisionReason.replaceAll(inputs.path, path);
  if (holder !== undefined && inputs.holder_agent_id !== undefined) {
    const named = `agent ${inputs.holder_agent_id.slice(0, 8)}.`;
    assert.ok(reason.includes(named), 'the holder fixture names its holder');
    reason = reason.replace(named, `agent ${holder.slice(0, 8)}.`);
  }
  return { hookSpecificOutput: { ...stdout.hookSpecificOutput, permissionDecisionReason: reason } };
}

const unavailableDeny = (path = STRICT_FILE): DenyOutput =>
  renderDeny(unavailableDenyFixture as DenyFixture, path);
const parentDeny = (path = STRICT_FILE): DenyOutput =>
  renderDeny(parentDenyFixture as DenyFixture, path);
const holderDeny = (holder: string, path = STRICT_FILE): DenyOutput =>
  renderDeny(holderDenyFixture as DenyFixture, path, holder);

/** The stdout a row's class names, for a row whose coordinator admits a hook that never opted in. */
function expectedStdout(row: Row, today: unknown): unknown {
  const body = row.http?.body as Record<string, unknown> | undefined;
  switch (row.expected) {
    case 'today':
    case 'today_and_stderr_line':
      return today;
    case 'relay_admit':
    case 'relay_deny':
      return body;
    case 'holder_deny':
      return holderDeny(String(body?.holder_agent_id));
    case 'parent_deny':
      return parentDeny();
    case 'unavailable_deny':
      return unavailableDeny();
    default:
      throw new Error(`row ${row.name}: unknown outcome class ${row.expected}`);
  }
}

/** Compares a run's stdout parsed, and a deny's reason as exact text. */
function assertStdout(run: HookRun, expected: unknown, where: string): void {
  assert.ok(
    run.stdout.endsWith('\n'),
    `${where}: one line on stdout, got ${JSON.stringify(run.stdout)}`
  );
  const printed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.deepEqual(printed, expected, where);
  const reason = (expected as Partial<DenyOutput>).hookSpecificOutput?.permissionDecisionReason;
  if (reason !== undefined) {
    const printedReason = (printed as unknown as DenyOutput).hookSpecificOutput
      .permissionDecisionReason;
    assert.equal(printedReason, reason, `${where}: the reason, as exact text`);
  }
}

const trace = (peer: ScriptedPeer | null): string[] =>
  peer === null ? [] : peer.seen.map((r) => `${r.method} ${r.url}`);
const edits = (peer: ScriptedPeer | null): Array<Record<string, unknown> | null> =>
  peer === null ? [] : peer.seen.filter((r) => r.url === EDIT).map((r) => r.body);

/** The requests a hook that never opted in sends: a claim first where the pid file is Python-shaped. */
function todaysRoutes(shape: Shape): string[] {
  return shape === 'python' ? [`POST ${CLAIM}`, `POST ${EDIT}`] : [`POST ${EDIT}`];
}

/** The pre-edit body the caller's payload builds, opted in or not. */
function editBody(caller: Caller, file: string, optedIn: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { session_id: caller.session_id, path: file };
  if (caller.agent_id !== null) body.agent_id = caller.agent_id;
  return optedIn ? { ...body, if_unheld: true } : body;
}

// ------------------------------------------------------------ rows before the POST

/** How the coordinator side of a row is set up. */
type Coordinator = 'peer' | 'exited' | 'closed_port' | 'no_pid_file';

interface Scenario {
  setting: string | null;
  file: string;
  coordinator: Coordinator;
  script: Script;
  /** Whether the capability read comes before today's requests. */
  asksStatus: boolean;
  stderr: string;
  /** How long the run waits on a silent coordinator at least; 0 when it must not wait. */
  waits: number;
}

const BASE: Scenario = {
  setting: ON,
  file: STRICT_FILE,
  coordinator: 'peer',
  script: routes(),
  asksStatus: false,
  stderr: '',
  waits: 0,
};

const BEFORE_POST: Readonly<Record<string, Partial<Scenario>>> = {
  setting_off: { setting: null },
  setting_unknown: { setting: 'Refuse\n', stderr: stderrLines.lines.setting_unknown },
  not_strict: { file: 'docs/notes.md' },
  no_port: { coordinator: 'no_pid_file' },
  died_at_resolve: { coordinator: 'exited' },
  timeout: { script: routes({ [STATUS]: HANG }), waits: DEADLINE_MS },
  // The lock is held, or the pid runs, so the endpoint resolves and the
  // capability read is what is refused.
  refused: { coordinator: 'closed_port' },
  malformed_answer: { script: routes({ [STATUS]: raw('not json') }) },
  status_non_2xx: { script: routes({ [STATUS]: json(REFUSES, 503) }) },
  status_key_absent: {
    script: routes({ [STATUS]: json({ fold_profile: 'none' }) }),
    asksStatus: true,
    stderr: stderrLines.lines.status_key_absent,
  },
  // Strict under the folding profiles (the disk spells it docs/plan.md, or a
  // folding profile reads it so), not under `none`, which the coordinator reports.
  not_strict_under_coordinator_profile: { file: 'docs/PLAN.MD', asksStatus: true },
  malformed_agent_id: {},
};

/** The scenario for a before-the-POST row; throws on an outcome this driver does not know. */
function beforePostScenario(row: Row): Scenario {
  const scenario = BEFORE_POST[row.outcome ?? ''];
  if (scenario === undefined)
    throw new Error(`row ${row.name}: unknown outcome ${String(row.outcome)}`);
  return { ...BASE, ...scenario };
}

/** Sets up the coordinator side; the peer whose requests are read, or null when none listens. */
async function startCoordinator(
  t: TestContext,
  ws: Workspace,
  setup: { scenario: Scenario; shape: Shape }
): Promise<ScriptedPeer | null> {
  const { scenario, shape } = setup;
  switch (scenario.coordinator) {
    case 'no_pid_file':
      return null;
    case 'closed_port':
      pointAt(ws, shape, await closedPort());
      return null;
    case 'exited': {
      const peer = await peerFor(t, scenario.script);
      pointAtExited(ws, shape, peer.port);
      return peer;
    }
    case 'peer': {
      const peer = await peerFor(t, scenario.script);
      pointAt(ws, shape, peer.port);
      return peer;
    }
  }
}

/** A run that waits on a silent coordinator: at least `atLeast` ms, and never past the deadline plus slack. */
function assertWaited(run: HookRun, atLeast: number, where: string): void {
  assert.ok(run.elapsedMs >= atLeast, `${where}: denied early, after ${run.elapsedMs} ms`);
  assert.ok(
    run.elapsedMs <= DEADLINE_MS + SLACK_MS,
    `${where}: denied late, after ${run.elapsedMs} ms`
  );
}

async function runBeforePostRow(t: TestContext, row: Row, shape: Shape): Promise<void> {
  const scenario = beforePostScenario(row);
  const ws = strictWorkspace(t, scenario.setting);
  const peer = await startCoordinator(t, ws, { scenario, shape });
  const run = await runHook(ws, editCc(ws, row.caller, scenario.file));

  const where = `${row.name} [${shape}]`;
  const today = peer === null || scenario.coordinator !== 'peer' ? {} : ADMIT;
  assert.equal(run.status, 0, where);
  assertStdout(run, expectedStdout(row, today), where);
  assert.equal(
    run.stderr,
    row.expected === 'unavailable_deny' ? '' : scenario.stderr,
    `${where}: stderr`
  );
  if (scenario.waits > 0) assertWaited(run, scenario.waits, where);
  if (row.expected === 'unavailable_deny') {
    const status = peer !== null && scenario.coordinator === 'peer' ? [`GET ${STATUS}`] : [];
    assert.deepEqual(trace(peer), status, `${where}: nothing is sent after the capability read`);
    return;
  }
  const expectedRoutes = peer === null ? [] : todaysRoutes(shape);
  assert.deepEqual(
    trace(peer),
    [...(scenario.asksStatus ? [`GET ${STATUS}`] : []), ...expectedRoutes],
    where
  );
  const todayEdit = editBody(row.caller, scenario.file, false);
  assert.deepEqual(
    edits(peer),
    peer === null ? [] : [todayEdit],
    `${where}: today's edit, not opted in`
  );
}

// ------------------------------------------------------------ rows after the POST

/** The opted-in POST answered with no 2xx: what the peer does instead. */
const POST_OUTCOMES: Readonly<Record<string, Reply | 'refused'>> = {
  timeout: HANG,
  // Answers the capability read, then stops listening: the claim and the
  // edit find nothing on the port.
  refused: 'refused',
  departed: HANG_UP,
  malformed_answer: raw('not json'),
};

function postScript(row: Row): Script {
  if (row.http !== undefined) return routes({ [EDIT]: json(row.http.body, row.http.status) });
  const outcome = POST_OUTCOMES[row.outcome ?? ''];
  if (outcome === undefined)
    throw new Error(`row ${row.name}: unknown outcome ${String(row.outcome)}`);
  if (outcome !== 'refused') return routes({ [EDIT]: outcome });
  const answers = routes();
  return (request, peer) => {
    if (request.url === STATUS) peer.stopListening();
    return answers(request, peer);
  };
}

/** A principal refusal neither recovery can cure; each client reports its own recovery. */
const PRINCIPAL_ABSENT_ROW = 'caller_principal_absent_400';

/** The requests an opted-in edit sends for `row`. */
function postRowRoutes(row: Row, shape: Shape): string[] {
  if (row.outcome === 'refused') return [`GET ${STATUS}`];
  const once = todaysRoutes(shape);
  // The refusal is recovered once where the client claimed, so holds a nonce
  // to re-claim with: a re-claim, then the edit again.
  const again = row.name === PRINCIPAL_ABSENT_ROW && shape === 'python' ? once : [];
  return [`GET ${STATUS}`, ...once, ...again];
}

/** Node's own recovery report for the principal refusal row: it re-claims only where it claimed. */
function postRowStderr(row: Row, shape: Shape): string {
  if (row.name !== PRINCIPAL_ABSENT_ROW) return '';
  const refused = "agent-coherence-hook-client: coordinator refused this hook's caller principal";
  return shape === 'python'
    ? `${refused} again after the re-claim (caller_principal_absent); not retrying again\n`
    : `${refused} (caller_principal_absent); no stored mint nonce for this session, so nothing was re-claimed\n`;
}

async function runPostRow(t: TestContext, row: Row, shape: Shape): Promise<void> {
  const ws = strictWorkspace(t);
  const peer = await peerFor(t, postScript(row));
  pointAt(ws, shape, peer.port);
  const run = await runHook(ws, editCc(ws, row.caller));

  const where = `${row.name} [${shape}]`;
  assert.equal(run.status, 0, where);
  assertStdout(run, expectedStdout(row, ADMIT), where);
  assert.equal(run.stderr, postRowStderr(row, shape), `${where}: stderr`);
  // The edit goes out on the connection the capability read used. A Node
  // server, this stub as the Node coordinator, keeps it alive with a 5 s hint,
  // and the client times a kept-alive connection out a second before the hint
  // runs out: here, before the deadline.
  if (row.outcome === 'timeout') assertWaited(run, KEPT_ALIVE_IDLE_MS, where);
  assert.deepEqual(trace(peer), postRowRoutes(row, shape), where);
  const sent = edits(peer);
  const optedIn = editBody(row.caller, STRICT_FILE, true);
  assert.deepEqual(
    sent,
    sent.map(() => optedIn),
    `${where}: every edit sent opts in`
  );
}

// ------------------------------------------------------------ the driver

/** The server.pid shapes a row runs on, by label; with no server.pid there is no shape to tell apart. */
function shapesFor(row: Row): ReadonlyArray<[string, Shape]> {
  if (row.outcome === 'no_port' && row.stage === 'before_post')
    return [['no server.pid', 'python']];
  return SHAPES.map((shape) => [shape, shape]);
}

/** Registers one case per row and shape it applies to. */
function rowCases(): void {
  for (const row of ROWS) {
    for (const [label, shape] of shapesFor(row)) {
      it(`${row.name} [${label}]`, async (t) => {
        if (row.stage === 'before_post') await runBeforePostRow(t, row, shape);
        else await runPostRow(t, row, shape);
      });
    }
  }
}

it('the decision table is the 32 rows this driver knows', () => {
  assert.equal(ROWS.length, 32);
  for (const row of ROWS) {
    if (row.stage === 'before_post') beforePostScenario(row);
    else if (row.stage === 'post') postScript(row);
    else throw new Error(`row ${row.name}: unknown stage ${row.stage}`);
    expectedStdout(row, ADMIT);
  }
});

describe('every decision-table row, through the built client', { concurrency: 4 }, rowCases);

it('before_post_no_port, with a server.pid that has no port line: {} as today', async (t) => {
  const ws = strictWorkspace(t);
  writeFileSync(ws.pidFile, `${process.pid}\n`);
  const run = await runHook(ws, editCc(ws, ROWS[0]!.caller));
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '{}\n');
  assert.equal(run.stderr, '');
});

// ------------------------------------------------------------ Node-only cases, through the built client

/** The fixture's caller: a session, no subagent. */
const CALLER: Caller = { session_id: ROWS[0]!.caller.session_id, agent_id: null };

/** An Edit of the strict file by `caller` against `script`, behind `shape`'s pid file. */
async function editAgainst(
  t: TestContext,
  setup: { script: Script; shape: Shape },
  cc: (ws: Workspace) => unknown = (ws) => editCc(ws, CALLER)
): Promise<{ run: HookRun; peer: ScriptedPeer }> {
  const ws = strictWorkspace(t);
  const peer = await peerFor(t, setup.script);
  pointAt(ws, setup.shape, peer.port);
  return { run: await runHook(ws, cc(ws)), peer };
}

/** The unavailable deny, exit 0, and the requests `routes` and stderr `stderr`. */
function assertDenied(
  sent: { run: HookRun; peer: ScriptedPeer },
  routes: string[],
  stderr = ''
): void {
  assert.equal(sent.run.status, 0);
  assertStdout(sent.run, unavailableDeny(), 'the unavailable deny');
  assert.deepEqual(trace(sent.peer), routes);
  assert.equal(sent.run.stderr, stderr);
}

const DRIP_MS = 300;
/** An admit padded so that, a byte per DRIP_MS, it takes far longer than the deadline plus slack. */
const DRIPPED_ADMIT = JSON.stringify(ADMIT).padEnd(48);

/** The opted-in edit answered a byte at a time: cut off at the deadline, which the idle limit alone never reaches. */
function dripCase(shape: Shape): void {
  it(`a coordinator that drips its answer to the opted-in edit is cut off at the deadline [${shape}]`, async (t) => {
    const drip: Reply = { kind: 'drip', text: DRIPPED_ADMIT, everyMs: DRIP_MS };
    const sent = await editAgainst(t, { script: routes({ [EDIT]: drip }), shape });
    assertDenied(sent, [`GET ${STATUS}`, ...todaysRoutes(shape)]);
    assertWaited(sent.run, DEADLINE_MS, shape);
  });
}

function nonSuccessCases(shape: Shape): void {
  for (const status of [503, 302]) {
    it(`an opted-in edit answered ${status}, its body an admit, is denied [${shape}]`, async (t) => {
      const headers = status === 302 ? { Location: '/elsewhere' } : {};
      const reply: Reply = { kind: 'answer', status, text: JSON.stringify(ADMIT), headers };
      const sent = await editAgainst(t, { script: routes({ [EDIT]: reply }), shape });
      assertDenied(sent, [`GET ${STATUS}`, ...todaysRoutes(shape)]);
    });
  }
}

function replacedCase(shape: Shape): void {
  it(`a coordinator replaced between the capability read and the edit: denied, nothing more sent [${shape}]`, async (t) => {
    let pidFile = '';
    const answers = routes();
    const script: Script = (request, peer) => {
      // Another coordinator now holds the port the pid file names.
      if (request.url === STATUS) writeFileSync(pidFile, `54321\n${peer.port + 1}\n`);
      return answers(request, peer);
    };
    const sent = await editAgainst(t, { script, shape }, (ws) => {
      pidFile = ws.pidFile;
      return editCc(ws, CALLER);
    });
    assertDenied(sent, [`GET ${STATUS}`]);
  });
}

describe(
  'a coordinator that cannot answer the opted-in edit, through the built client',
  { concurrency: 4 },
  () => {
    SHAPES.forEach(dripCase);
    SHAPES.forEach(nonSuccessCases);
    SHAPES.forEach(replacedCase);
  }
);

for (const [label, text] of [
  ['[]', '[]'],
  ['a string', '"ok"'],
  ['null', 'null'],
  ['a number', '7'],
]) {
  it(`a capability answer that is ${label}, not a JSON object, is denied`, async (t) => {
    const sent = await editAgainst(t, { script: routes({ [STATUS]: raw(text!) }), shape: 'node' });
    assertDenied(sent, [`GET ${STATUS}`]);
  });
}

for (const agentId of ['bad id!', 7]) {
  it(`a malformed subagent id (${JSON.stringify(agentId)}) is denied and no edit is sent`, async (t) => {
    const cc = (ws: Workspace) => ({ ...editCc(ws, CALLER), agent_id: agentId });
    assertDenied(await editAgainst(t, { script: routes(), shape: 'node' }, cc), [`GET ${STATUS}`]);
  });
}

for (const agentId of ['', null]) {
  it(`${agentId === null ? 'a null' : 'an empty'} subagent id is sent as the parent`, async (t) => {
    const cc = (ws: Workspace) => ({ ...editCc(ws, CALLER), agent_id: agentId });
    const { run, peer } = await editAgainst(t, { script: routes(), shape: 'node' }, cc);
    assert.deepEqual(JSON.parse(run.stdout), ADMIT);
    assert.deepEqual(edits(peer), [editBody(CALLER, STRICT_FILE, true)]);
  });
}

const PRINCIPAL_ABSENT = json(
  { error: 'principal refused', reason: 'caller_principal_absent' },
  400
);
const CLAIM_REFUSED = json({ ok: false, reason: 'caller_principal_claimed', detail: 'bound' });

it('a principal refusal whose re-claim is refused: denied after one edit, the recovery reported', async (t) => {
  const script = routes({ [CLAIM]: CLAIM_REFUSED, [EDIT]: PRINCIPAL_ABSENT });
  const sent = await editAgainst(t, { script, shape: 'python' });
  const report = 'agent-coherence-hook-client: ';
  assertDenied(
    sent,
    [`GET ${STATUS}`, `POST ${CLAIM}`, `POST ${EDIT}`, `POST ${CLAIM}`],
    `${report}caller principal refused: this session is already bound under a different mint nonce; ` +
      'proceeding without a principal and NOT re-minting (routes that require one will refuse this session)\n' +
      `${report}coordinator refused this hook's caller principal (caller_principal_absent); ` +
      'this session is bound under a different mint nonce, so nothing was re-minted\n'
  );
});

it('a 400 with a reason that is no principal refusal: denied after one edit, nothing re-claimed', async (t) => {
  const unknown = json({ error: 'refused', reason: 'caller_principal_bogus' }, 400);
  const sent = await editAgainst(t, { script: routes({ [EDIT]: unknown }), shape: 'python' });
  assertDenied(sent, [`GET ${STATUS}`, `POST ${CLAIM}`, `POST ${EDIT}`]);
});

// A coordinator port is known but nothing listens on it, so any request
// would be refused: what decides is whether the hook opts in at all.
const NOT_OPTED_IN: ReadonlyArray<[string, { setting: string | null; file: string; sub: string }]> =
  [
    [
      'a pre-edit of a file that is not strict',
      { setting: ON, file: 'docs/notes.md', sub: 'pre-edit' },
    ],
    ['a pre-read of a strict file', { setting: ON, file: STRICT_FILE, sub: 'pre-read' }],
    [
      'a pre-edit of a strict file with the setting off',
      { setting: null, file: STRICT_FILE, sub: 'pre-edit' },
    ],
  ];
for (const [label, { setting, file, sub }] of NOT_OPTED_IN) {
  for (const shape of SHAPES) {
    it(`${label}, against a closed port, prints {} as today [${shape}]`, async (t) => {
      const ws = strictWorkspace(t, setting);
      pointAt(ws, shape, await closedPort());
      const run = await runHook(ws, editCc(ws, CALLER, file), sub);
      assert.equal(run.status, 0);
      assert.equal(run.stdout, '{}\n');
      assert.equal(run.stderr, '');
    });
  }
}

// ------------------------------------------------------------ against this repository's Node coordinator

interface Relayed {
  url: string;
  body: Record<string, unknown> | null;
  answer: unknown;
}

function parsedOrNull(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Forwards one request to the coordinator on `port`; its answer's status and text. */
function forward(
  port: number,
  req: IncomingMessage,
  text: string
): Promise<{ status: number; text: string }> {
  return new Promise((resolveForward, rejectForward) => {
    const options = {
      host: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers: req.headers,
    };
    const upstream = httpRequest(options, (res) => {
      void readText(res).then((answer) =>
        resolveForward({ status: res.statusCode ?? 0, text: answer })
      );
    });
    upstream.on('error', rejectForward);
    upstream.end(text);
  });
}

/** A relay in front of the coordinator on `port` that records each request's body and answer. */
async function relayTo(t: TestContext, port: number): Promise<{ port: number; seen: Relayed[] }> {
  const seen: Relayed[] = [];
  const relay = createHttpServer((req, res) => {
    void readText(req).then(async (text) => {
      const upstream = await forward(port, req, text);
      seen.push({
        url: req.url ?? '',
        body: parsedOrNull(text),
        answer: parsedOrNull(upstream.text),
      });
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(upstream.text);
    });
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', () => resolve()));
  t.after(async () => {
    relay.closeAllConnections();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });
  return { port: (relay.address() as AddressInfo).port, seen };
}

/** This repository's Node coordinator for `ws`, in this process, behind a recording relay. */
async function startNodeCoordinator(t: TestContext, ws: Workspace): Promise<Relayed[]> {
  const registry = new ArtifactRegistry(join(ws.coherenceDir, 'state.db'));
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: 'test',
    registry,
    policy: PolicyRef.load(ws.root),
    sessions: new SessionRegistry(),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    registry.close();
  });
  const relay = await relayTo(t, (server.address() as AddressInfo).port);
  writeFileSync(ws.pidFile, `${process.pid}\n${relay.port}\nbackend=node\n`);
  return relay.seen;
}

const HOLDER_SID = '11111111-1111-4111-8111-111111111111';
const EDITOR_SID = '22222222-2222-4222-8222-222222222222';
const HOLDER: Caller = { session_id: HOLDER_SID, agent_id: null };
const EDITOR: Caller = { session_id: EDITOR_SID, agent_id: null };

/** A workspace whose strict file `HOLDER` has taken through the client, the setting on. */
async function heldWorkspace(t: TestContext): Promise<{ ws: Workspace; seen: Relayed[] }> {
  const ws = strictWorkspace(t);
  const seen = await startNodeCoordinator(t, ws);
  const run = await runHook(ws, editCc(ws, HOLDER));
  assert.equal((JSON.parse(run.stdout) as Record<string, unknown>).ok, true, run.stdout);
  return { ws, seen };
}

it('Node coordinator: another session holds the strict file: the holder deny naming it, the edit opted in', async (t) => {
  const { ws, seen } = await heldWorkspace(t);
  const run = await runHook(ws, editCc(ws, EDITOR));

  assert.equal(run.status, 0);
  assertStdout(run, holderDeny(sessionToAgentId(HOLDER_SID)), 'holder');
  assert.deepEqual(
    seen.map((r) => r.url),
    [STATUS, EDIT, STATUS, EDIT]
  );
  assert.deepEqual(seen[3]!.body, editBody(EDITOR, STRICT_FILE, true));
});

it('Node coordinator: a subagent whose parent session holds the strict file: the parent deny', async (t) => {
  const { ws } = await heldWorkspace(t);
  const run = await runHook(ws, editCc(ws, { session_id: HOLDER_SID, agent_id: 'sub1' }));

  assert.equal(run.status, 0);
  assertStdout(run, parentDeny(), 'parent');
});

it('Node coordinator: the setting off while another session holds the file: relayed as today, not opted in', async (t) => {
  const { ws, seen } = await heldWorkspace(t);
  unlinkSync(join(ws.coherenceDir, 'hook_on_held'));
  seen.length = 0;
  const run = await runHook(ws, editCc(ws, EDITOR));

  assert.equal(run.status, 0);
  assert.deepEqual(
    seen.map((r) => [r.url, r.body]),
    [[EDIT, editBody(EDITOR, STRICT_FILE, false)]]
  );
  assert.deepEqual(JSON.parse(run.stdout), seen[0]!.answer);
  assert.equal(run.stderr, '');
});

// ------------------------------------------------------------ in-process, with an injected deadline

/** Short enough to keep these cases quick, long enough for the requests before the stall. */
const SHORT_DEADLINE_MS = 1000;
/** What a decision may take beyond its deadline; this machine's load varies. */
const IN_PROCESS_SLACK_MS = 1500;

interface Decided {
  answer: unknown;
  peer: ScriptedPeer;
  stderr: string;
  elapsedMs: number;
}

/** Runs the decision in this process against `script`, its stderr captured, every mock restored after. */
async function decide(
  t: TestContext,
  setup: { script: Script; shape: Shape },
  deadlineMs = SHORT_DEADLINE_MS
): Promise<Decided> {
  const ws = strictWorkspace(t);
  const peer = await peerFor(t, setup.script);
  pointAt(ws, setup.shape, peer.port);
  let stderr = '';
  const realWrite = process.stderr.write;
  // Replaced by hand, not mocked, so a case's own mock of it restores onto this capture.
  process.stderr.write = ((chunk: unknown) => ((stderr += String(chunk)), true)) as never;
  const startedAt = performance.now();
  try {
    const answer = await heldStrictAnswer(editCc(ws, CALLER), ws.root, deadlineMs);
    return { answer, peer, stderr, elapsedMs: performance.now() - startedAt };
  } finally {
    t.mock.restoreAll();
    process.stderr.write = realWrite;
  }
}

/** The unavailable deny, cut off at the short deadline, after `routes`, with `stderr`. */
function assertCutOff(decided: Decided, routes: string[], stderr = ''): void {
  const { elapsedMs } = decided;
  assert.deepEqual(decided.answer, unavailableDeny());
  assert.ok(
    elapsedMs >= SHORT_DEADLINE_MS - 10,
    `denied before the deadline, after ${elapsedMs} ms`
  );
  assert.ok(
    elapsedMs <= SHORT_DEADLINE_MS + IN_PROCESS_SLACK_MS,
    `denied late, after ${elapsedMs} ms`
  );
  assert.deepEqual(trace(decided.peer), routes);
  assert.equal(decided.stderr, stderr);
}

/** Answers the claim route's first request with a 404 and every later one never. */
function reclaimHangs(others: Script): Script {
  let claims = 0;
  return (request, peer) => {
    if (request.url !== CLAIM) return others(request, peer);
    claims += 1;
    return claims === 1 ? json({ error: 'nf' }, 404) : HANG;
  };
}

it('in process: the deadline runs out during the capability read: denied', async (t) => {
  const decided = await decide(t, { script: routes({ [STATUS]: HANG }), shape: 'node' });
  assertCutOff(decided, [`GET ${STATUS}`]);
});

it('in process: the deadline runs out during the claim: denied, no edit sent, nothing on stderr', async (t) => {
  const decided = await decide(t, { script: routes({ [CLAIM]: HANG }), shape: 'python' });
  assertCutOff(decided, [`GET ${STATUS}`, `POST ${CLAIM}`]);
});

it('in process: the deadline runs out during the re-claim: denied after one edit, one line on stderr', async (t) => {
  const script = reclaimHangs(routes({ [EDIT]: PRINCIPAL_ABSENT }));
  const decided = await decide(t, { script, shape: 'python' });
  assertCutOff(
    decided,
    [`GET ${STATUS}`, `POST ${CLAIM}`, `POST ${EDIT}`, `POST ${CLAIM}`],
    "agent-coherence-hook-client: coordinator refused this hook's caller principal (caller_principal_absent); " +
      'the re-claim with the stored mint nonce was not confirmed (claim failed: request deadline passed)\n'
  );
});

/** The mocked function's next call throws; later calls run the original. */
function throwOnce(fn: { mock: { mockImplementationOnce: (impl: () => never) => void } }): void {
  fn.mock.mockImplementationOnce(() => {
    throw new Error('injected');
  });
}

// Each throw is injected while the coordinator answers, so it lands in the
// client's next step. Without it each case would admit: once the path is a
// candidate and a port is known, whatever throws is the unavailable deny.
const INJECTED: ReadonlyArray<
  [string, { url: string; shape: Shape; routes: string[] }, (t: TestContext) => void]
> = [
  [
    'reading the capability',
    { url: STATUS, shape: 'node', routes: [`GET ${STATUS}`] },
    (t) => throwOnce(t.mock.method(Object, 'hasOwn')),
  ],
  [
    'the deadline check before the edit',
    { url: STATUS, shape: 'node', routes: [`GET ${STATUS}`] },
    (t) => throwOnce(t.mock.method(Date, 'now')),
  ],
  [
    "reporting the claim's refusal",
    { url: CLAIM, shape: 'python', routes: [`GET ${STATUS}`, `POST ${CLAIM}`] },
    (t) => throwOnce(t.mock.method(process.stderr, 'write')),
  ],
  [
    'classifying the answer',
    { url: EDIT, shape: 'node', routes: [`GET ${STATUS}`, `POST ${EDIT}`] },
    (t) => throwOnce(t.mock.method(Object, 'hasOwn')),
  ],
];
for (const [label, where, inject] of INJECTED) {
  it(`in process: a throw in ${label}, after the capability read: denied`, async (t) => {
    const answers = routes({ [CLAIM]: CLAIM_REFUSED });
    const script: Script = (request, peer) => {
      if (request.url === where.url) inject(t);
      return answers(request, peer);
    };
    const decided = await decide(t, { script, shape: where.shape });
    assert.deepEqual(decided.answer, unavailableDeny());
    assert.deepEqual(trace(decided.peer), where.routes);
  });
}

it("in process: a throw before the opt-in point takes today's path, nothing sent", async (t) => {
  const asked = await decide(t, { script: routes(), shape: 'node' });
  assert.deepEqual(asked.answer, ADMIT, 'without the throw, the same edit opts in');

  t.mock.method(TrackedArtifactPolicy, 'readQuietly', () => {
    throw new Error('policy regression');
  });
  const decided = await decide(t, { script: routes(), shape: 'node' });
  assert.equal(decided.answer, null);
  assert.deepEqual(trace(decided.peer), []);
  assert.equal(decided.stderr, '');
});
