/**
 * A deadline an endpoint carries bounds every request made on it by the wall
 * clock, not only by how long its socket sits idle.
 *
 * The socket's idle limit starts over with every byte, so a peer that keeps
 * sending one now and then holds a request for as long as it likes. Each case
 * points `requestJsonStatus`, or a caller-principal claim made through it, at a
 * loopback peer and pins when the request is refused, whether a connection was
 * opened, and that the peer saw it closed. The same peers with no deadline
 * show that such an endpoint behaves as before. The idle limit stays at the
 * hooks' own 5 s throughout, so a rejection well inside it is the deadline's.
 *
 * What none of these prove: one machine and loopback only; the peer is a stub,
 * not a coordinator of either kind; and work done before the socket opens, such
 * as the check that the coordinator is still the one resolved, is not cut short
 * by the timer. This pins the transport, not what a hook does with the
 * rejection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { claimCallerPrincipal } from '../caller_principal.js';
import {
  CoordinatorDeparted,
  requestJsonStatus,
  type CoordinatorEndpoint,
} from '../hook_client_transport.js';

const DEADLINE_MS = 500;
/** How often the slow peer sends its next byte: well inside the idle limit. */
const DRIP_MS = 300;
/** The slow peer's body: at one byte per DRIP_MS it outlasts the deadline plus slack. */
const DRIPPED_BODY = '{"a":1}';
/** What a rejection may take beyond the deadline it is due to; this machine's load varies. */
const SLACK_MS = 1000;
/** How long a connection or close that follows the rejection gets to show up. */
const SETTLE_MS = 100;
/** Timers round to whole milliseconds, so one can fire a hair before its due time. */
const TIMER_ROUNDING_MS = 10;
/** Fails a request that never settles, which would otherwise hang the file. */
const CASE = { timeout: 10_000 };

const DEADLINE_PASSED = 'request deadline passed';
const NOTHING_SENT = `${DEADLINE_PASSED}; nothing was sent`;
const BEARER = 's'.repeat(32);

interface Peer {
  port: number;
  connections: () => number;
  /** When the first connection closed, on the performance clock; null while none has. */
  closedAt: () => number | null;
  close: () => Promise<void>;
}

/** A loopback listener that runs `onRequest` on a request's first bytes and records when a connection closes. */
async function startPeer(onRequest: (socket: Socket) => void): Promise<Peer> {
  const sockets: Socket[] = [];
  let closedAt: number | null = null;
  const server = createNetServer((socket) => {
    sockets.push(socket);
    // A client reset must fail an assertion, not crash the test process.
    socket.on('error', () => {});
    socket.once('close', () => (closedAt ??= performance.now()));
    socket.once('data', () => onRequest(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => sockets.length,
    closedAt: () => closedAt,
    close: async () => {
      // `close` waits for every connection, and some are held open on purpose.
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function responseHead(body: string): string {
  return (
    'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
  );
}

/** Answers `{}` at once. */
const answerAtOnce = (socket: Socket) => socket.end(`${responseHead('{}')}{}`);

/** Accepts the request and never writes. */
const neverAnswer = () => {};

/** Sends the head at once, then the body one byte every DRIP_MS. */
function dripAnswer(socket: Socket): void {
  socket.write(responseHead(DRIPPED_BODY));
  let sent = 0;
  const drip = setInterval(() => {
    socket.write(DRIPPED_BODY[sent]!);
    sent += 1;
    if (sent === DRIPPED_BODY.length) clearInterval(drip);
  }, DRIP_MS);
  socket.once('close', () => clearInterval(drip));
}

function endpointFor(peer: Peer, deadlineAt?: number): CoordinatorEndpoint {
  return deadlineAt === undefined
    ? { port: peer.port, bearer: BEARER }
    : { port: peer.port, bearer: BEARER, deadlineAt };
}

/** One request's outcome, settled either way, and how long it took. */
async function timedRequest(
  endpoint: CoordinatorEndpoint
): Promise<{ answer?: unknown; error?: Error; startedAt: number; elapsedMs: number }> {
  const startedAt = performance.now();
  const settled = await requestJsonStatus(endpoint, 'POST', '/hooks/pre-edit', {
    session_id: 's',
  }).then(
    (answer) => ({ answer }),
    (error: Error) => ({ error })
  );
  return { ...settled, startedAt, elapsedMs: performance.now() - startedAt };
}

function assertAtTheDeadline(elapsedMs: number): void {
  assert.ok(elapsedMs >= DEADLINE_MS - TIMER_ROUNDING_MS, `rejected early, after ${elapsedMs} ms`);
  assert.ok(elapsedMs <= DEADLINE_MS + SLACK_MS, `rejected late, after ${elapsedMs} ms`);
}

/** The peer saw its one connection closed by the deadline, not later. */
async function assertPeerSawTheClose(peer: Peer, startedAt: number): Promise<void> {
  await delay(SETTLE_MS);
  const closedAt = peer.closedAt();
  assert.notEqual(closedAt, null, 'the peer never saw its connection close');
  assert.ok(
    closedAt! - startedAt <= DEADLINE_MS + SLACK_MS,
    `closed late, after ${closedAt! - startedAt} ms`
  );
  assert.equal(peer.connections(), 1);
}

const activeTimers = () =>
  process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;

// The idle limit cannot end this request: a byte arrives every DRIP_MS, well
// inside it. Only the wall-clock deadline can.
test(
  'a peer that drips its body: rejected at the deadline, and the peer sees the close',
  CASE,
  async (t) => {
    const peer = await startPeer(dripAnswer);
    t.after(() => peer.close());

    const { answer, error, startedAt, elapsedMs } = await timedRequest(
      endpointFor(peer, Date.now() + DEADLINE_MS)
    );

    assert.equal(answer, undefined, `expected a rejection, got ${JSON.stringify(answer)}`);
    assert.equal(error?.message, DEADLINE_PASSED);
    assertAtTheDeadline(elapsedMs);
    await assertPeerSawTheClose(peer, startedAt);
  }
);

test(
  'a peer that accepts and never writes: rejected at the deadline, before the idle limit',
  CASE,
  async (t) => {
    const peer = await startPeer(neverAnswer);
    t.after(() => peer.close());

    const { error, startedAt, elapsedMs } = await timedRequest(
      endpointFor(peer, Date.now() + DEADLINE_MS)
    );

    assert.equal(error?.message, DEADLINE_PASSED);
    assertAtTheDeadline(elapsedMs);
    await assertPeerSawTheClose(peer, startedAt);
  }
);

test('a spent deadline: rejected at once, and no connection is opened', CASE, async (t) => {
  const peer = await startPeer(answerAtOnce);
  t.after(() => peer.close());

  const { error, elapsedMs } = await timedRequest(endpointFor(peer, Date.now() - 1));

  assert.equal(error?.message, NOTHING_SENT);
  assert.ok(elapsedMs < SLACK_MS, `rejected late, after ${elapsedMs} ms`);
  await delay(SETTLE_MS);
  assert.equal(peer.connections(), 0);
});

// The pin below names a coordinator the pid file no longer does, which on its
// own refuses the request as departed; a spent deadline refuses it first.
test('a spent deadline is refused before the coordinator is checked', CASE, async (t) => {
  const peer = await startPeer(answerAtOnce);
  const coherenceDir = mkdtempSync(join(tmpdir(), 'deadline-pin-'));
  t.after(async () => {
    await peer.close();
    rmSync(coherenceDir, { recursive: true, force: true });
  });
  writeFileSync(join(coherenceDir, 'server.pid'), `1\n${peer.port}\n`);
  const pin = { coherenceDir, lines: { pid: 2, port: peer.port, backend: null } };

  const spent = { ...endpointFor(peer, Date.now() - 1), pin };
  await assert.rejects(requestJsonStatus(spent, 'GET', '/status'), (err: Error) => {
    assert.ok(
      !(err instanceof CoordinatorDeparted),
      `checked the coordinator first: ${err.message}`
    );
    assert.equal(err.message, NOTHING_SENT);
    return true;
  });
  await assert.rejects(
    requestJsonStatus({ ...endpointFor(peer), pin }, 'GET', '/status'),
    CoordinatorDeparted
  );
  assert.equal(peer.connections(), 0);
});

test(
  'a request answered before its deadline: resolved as without one, and no timer left running',
  CASE,
  async (t) => {
    const peer = await startPeer(answerAtOnce);
    t.after(() => peer.close());
    const timersBefore = activeTimers();

    const { answer } = await timedRequest(endpointFor(peer, Date.now() + 3 * DEADLINE_MS));

    assert.deepEqual(answer, { status: 200, body: {} });
    await delay(SETTLE_MS);
    assert.equal(activeTimers(), timersBefore);
  }
);

// Today's behaviour, which the deadline must leave alone: the idle limit does
// not bound a whole request, so the dripped body arrives in full.
test(
  'no deadline: a peer that drips its body is waited for until the body is whole',
  CASE,
  async (t) => {
    const peer = await startPeer(dripAnswer);
    t.after(() => peer.close());

    const { answer, error, elapsedMs } = await timedRequest(endpointFor(peer));

    assert.equal(error, undefined, `expected an answer, got ${error?.message}`);
    assert.deepEqual(answer, { status: 200, body: { a: 1 } });
    const dripMs = DRIPPED_BODY.length * DRIP_MS;
    assert.ok(
      elapsedMs >= dripMs - TIMER_ROUNDING_MS,
      `answered before the drip ended, after ${elapsedMs} ms`
    );
  }
);

test(
  'no deadline: a peer that answers at once is sent the request and answers',
  CASE,
  async (t) => {
    const peer = await startPeer(answerAtOnce);
    t.after(() => peer.close());

    const { answer } = await timedRequest(endpointFor(peer));

    assert.deepEqual(answer, { status: 200, body: {} });
    assert.equal(peer.connections(), 1);
  }
);

// The claim reaches the transport through the endpoint it is given, so it
// carries that endpoint's deadline; a claim the deadline cuts short is one
// whose answer never came.
test('a claim cut short by the deadline: unconfirmed, at the deadline', CASE, async (t) => {
  const peer = await startPeer(neverAnswer);
  t.after(() => peer.close());
  const startedAt = performance.now();

  const claim = await claimCallerPrincipal(
    endpointFor(peer, Date.now() + DEADLINE_MS),
    'session-a',
    'nonce-a'
  );

  assert.equal(claim.outcome, 'unconfirmed');
  assert.equal(claim.principal, null);
  assert.equal(claim.detail, `claim failed: ${DEADLINE_PASSED}`);
  assertAtTheDeadline(performance.now() - startedAt);
  await assertPeerSawTheClose(peer, startedAt);
});
