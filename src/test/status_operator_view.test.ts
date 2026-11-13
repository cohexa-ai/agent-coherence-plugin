/**
 * The Node coordinator's operator view, and the refusal every tier advertises.
 *
 * `/status?detail=full` answers only a request that carries
 * `Coherence-Local-Operator: true` (any case), after the Host and bearer
 * checks every route makes. Its body is the default body with the four pattern
 * lists the live policy enforces, as written, added to `policy_summary`, and
 * nothing else: no session name, no pid, no absolute path. Every tier carries
 * `pre_edit_if_unheld: true` at the top level, so a client can tell that this
 * coordinator refuses a pre-edit sending `if_unheld: true` while another
 * session holds the file, rather than displacing the holder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { ArtifactRegistry } from '../registry.js';
import { DEFAULT_TRACKED_PATTERNS, PolicyRef } from '../policy.js';
import { SessionRegistry } from '../sessions.js';

const SECRET = 's'.repeat(32);
const SID = '44444444-5555-4444-8444-dddddddddddd';
const AUTH: HeaderMap = { Authorization: `Bearer ${SECRET}`, Host: '127.0.0.1' };
const OPERATOR: HeaderMap = { 'Coherence-Local-Operator': 'true' };
const OPERATOR_REFUSAL =
  'detail=full (the operator view) requires the Coherence-Local-Operator: true header';

/** The top-level keys of the default tier, and so of the operator view, sorted. */
const DEFAULT_KEYS = [
  'backend',
  'coordinator_uptime_seconds',
  'counts',
  'fold_profile',
  'fold_table_unicode',
  'policy_summary',
  'pre_edit_if_unheld',
  'schema_version',
  'sessions',
  'status',
  'tracked_artifacts',
  'version',
];

/** A user-added, an ignored and a strict pattern, each in its own file. */
const ONE_OF_EACH_LIST = {
  'tracked.yaml': '- "data/**"\n',
  'ignored.yaml': '- "scratch/**"\n',
  'strict_mode.yaml': '- "data/**"\n',
};

type HeaderMap = Record<string, string>;
type Body = Record<string, unknown>;

interface Answer {
  status: number;
  body: Body;
}

interface Workspace {
  root: string;
  port: number;
  registry: ArtifactRegistry;
  policy: PolicyRef;
  sessions: SessionRegistry;
  close(): Promise<void>;
}

function writePolicyFiles(root: string, files: Record<string, string>): void {
  mkdirSync(join(root, '.coherence'), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(root, '.coherence', name), text, 'utf8');
  }
}

/** A coordinator over a fresh workspace whose `.coherence/` holds `files`. */
async function openWorkspace(files: Record<string, string> = {}): Promise<Workspace> {
  const root = mkdtempSync(join(tmpdir(), 'operator-view-'));
  writePolicyFiles(root, files);
  const registry = new ArtifactRegistry(join(root, '.coherence', 'state.db'));
  const policy = PolicyRef.load(root);
  const sessions = new SessionRegistry();
  const options = { secret: SECRET, startedAtMs: Date.now(), version: 'test' };
  const server = createServer({ ...options, registry, policy, sessions });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const close = async (): Promise<void> => {
    await new Promise<void>((r) => server.close(() => r()));
    registry.close();
    rmSync(root, { recursive: true, force: true });
  };
  const port = (server.address() as AddressInfo).port;
  return { root, port, registry, policy, sessions, close };
}

/** One request with exactly `init.headers`: node:http sends the Host it is given. */
function send(
  port: number,
  path: string,
  init: { method?: string; headers: HeaderMap; body?: string }
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const options = { host: '127.0.0.1', port, path, method: init.method ?? 'GET' };
    const req = request({ ...options, headers: init.headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Body }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

function getStatus(ws: Workspace, query: string, extra: HeaderMap = {}): Promise<Answer> {
  return send(ws.port, `/status${query}`, { headers: { ...AUTH, ...extra } });
}

function track(ws: Workspace, paths: string[]): Promise<Answer> {
  const headers = { ...AUTH, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ paths });
  return send(ws.port, '/policy/track', { method: 'POST', headers, body });
}

/** A session, whose name embeds `SID`, holding `path` EXCLUSIVE. */
function holdFile(ws: Workspace, path: string): void {
  const agentId = ws.sessions.registerSession(SID);
  ws.registry.acquireExclusive(ws.registry.resolveOrRegisterArtifact(path, 'abc'), agentId, 0);
  // The name the view must not publish is one the coordinator knows.
  assert.equal(ws.sessions.agentIdToName(agentId), `claude-session-${SID}`);
}

function policySummary(answer: Answer): Body {
  return answer.body.policy_summary as Body;
}

/** The body without its policy summary and its uptime, which can tick between two requests. */
function otherFields(body: Body): Body {
  const { policy_summary: _summary, coordinator_uptime_seconds: _uptime, ...rest } = body;
  return rest;
}

test('the operator view is the default body plus the four pattern lists the policy enforces', async () => {
  const ws = await openWorkspace(ONE_OF_EACH_LIST);
  try {
    holdFile(ws, 'data/a.json');
    const plain = await getStatus(ws, '');
    const full = await getStatus(ws, '?detail=full', OPERATOR);
    assert.equal(full.status, 200);
    assert.deepEqual(Object.keys(plain.body).sort(), DEFAULT_KEYS);
    assert.deepEqual(Object.keys(full.body).sort(), DEFAULT_KEYS);
    assert.deepEqual(otherFields(full.body), otherFields(plain.body));
    assert.deepEqual(policySummary(full), {
      ...policySummary(plain),
      tracked_patterns: [...DEFAULT_TRACKED_PATTERNS],
      user_added_patterns: ['data/**'],
      ignored_patterns: ['scratch/**'],
      strict_mode_patterns: ['data/**'],
    });
    assert.equal(full.body.pre_edit_if_unheld, true);
    assert.equal(policySummary(full).coordinator_root, '.');
    const rows = full.body.sessions as Body[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.agent_name, null);
  } finally {
    await ws.close();
  }
});

test('the operator view needs the opt-in header set to true, in any case', async () => {
  const ws = await openWorkspace();
  try {
    const upper = await getStatus(ws, '?detail=full', { 'Coherence-Local-Operator': 'TRUE' });
    assert.equal(upper.status, 200);
    for (const extra of [{ 'Coherence-Local-Operator': 'false' }, {}]) {
      const refused = await getStatus(ws, '?detail=full', extra);
      // Node's own text, pinned whole, so it can gain no internal label.
      assert.deepEqual(refused, { status: 403, body: { error: OPERATOR_REFUSAL } });
    }
  } finally {
    await ws.close();
  }
});

test('the Host and bearer checks still come before the opt-in header', async () => {
  const ws = await openWorkspace();
  try {
    const headers = { Host: '127.0.0.1', ...OPERATOR };
    const noBearer = await send(ws.port, '/status?detail=full', { headers });
    assert.deepEqual(noBearer, { status: 401, body: { error: 'missing or invalid bearer token' } });
    const badHost = await getStatus(ws, '?detail=full', { ...OPERATOR, Host: 'attacker.example' });
    assert.deepEqual(badHost, { status: 403, body: { error: 'host header not allowlisted' } });
  } finally {
    await ws.close();
  }
});

test('the lists are the live policy: after a reload they keep a strict pattern the files dropped', async () => {
  const ws = await openWorkspace({
    'tracked.yaml': '- "Specs/**/*.MD"\n',
    'strict_mode.yaml': '- "Specs/**/*.MD"\n',
  });
  try {
    // A reload never ends strict enforcement mid-run, so the policy keeps the
    // pattern after the files stop listing it; the view must show that, not the files.
    writePolicyFiles(ws.root, { 'tracked.yaml': '', 'strict_mode.yaml': '' });
    assert.equal((await track(ws, ['notes.md'])).status, 200);
    assert.equal(ws.policy.isStrictMode('Specs/a/b.MD'), true);
    const summary = policySummary(await getStatus(ws, '?detail=full', OPERATOR));
    assert.deepEqual(summary.user_added_patterns, ['Specs/**/*.MD', 'notes.md']);
    assert.deepEqual(summary.strict_mode_patterns, ['Specs/**/*.MD']);
  } finally {
    await ws.close();
  }
});

test('a rejected pattern shows only in its count, never as text', async () => {
  const ws = await openWorkspace({ 'tracked.yaml': '- "../Rejected-Marker/**"\n- "data/**"\n' });
  try {
    const full = await getStatus(ws, '?detail=full', OPERATOR);
    assert.equal(full.status, 200);
    assert.equal(policySummary(full).rejected_pattern_count, 1);
    assert.deepEqual(policySummary(full).user_added_patterns, ['data/**']);
    const text = JSON.stringify(full.body);
    assert.ok(!text.includes('Rejected-Marker'), text);
  } finally {
    await ws.close();
  }
});

test('the default and metrics tiers advertise the refusal at the top level', async () => {
  const ws = await openWorkspace();
  try {
    const plain = await getStatus(ws, '');
    const metrics = await getStatus(ws, '?detail=metrics');
    assert.equal(plain.body.pre_edit_if_unheld, true);
    assert.equal(metrics.body.pre_edit_if_unheld, true);
    assert.ok(!('pre_edit_if_unheld' in (metrics.body.counters as Body)));
  } finally {
    await ws.close();
  }
});

test('detail is matched ignoring case: detail=FULL is the operator view', async () => {
  const ws = await openWorkspace();
  try {
    const full = await getStatus(ws, '?detail=FULL', OPERATOR);
    assert.equal(full.status, 200);
    assert.deepEqual(policySummary(full).tracked_patterns, [...DEFAULT_TRACKED_PATTERNS]);
    assert.equal((await getStatus(ws, '?detail=FULL')).status, 403);
  } finally {
    await ws.close();
  }
});

test('the operator view carries no session id, pid or absolute path', async () => {
  const ws = await openWorkspace({ 'tracked.yaml': '- "data/**"\n' });
  try {
    holdFile(ws, 'data/a.json');
    const full = await getStatus(ws, '?detail=full', OPERATOR);
    // Control: the view lists the session, so it had the id within reach.
    assert.equal((full.body.sessions as Body[]).length, 1);
    const text = JSON.stringify(full.body);
    assert.ok(!text.includes(SID), text);
    assert.doesNotMatch(text, /pid"/);
    assert.ok(!text.includes(ws.root) && !text.includes(realpathSync(ws.root)), text);
    assert.doesNotMatch(text, /"\//, 'no value is an absolute path');
  } finally {
    await ws.close();
  }
});
