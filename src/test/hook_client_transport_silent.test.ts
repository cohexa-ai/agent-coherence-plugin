/**
 * A coordinator that takes a request and does not answer it whole.
 *
 * Every hook and CLI request goes through `requestJsonStatus`. Each case points
 * it at a loopback stub and pins which rejection the caller gets, how soon it
 * comes, and that the request went out once. A case that waits out the limit
 * shrinks `timeoutMs`; a case that must not wait runs at the hooks' own 5 s, so a
 * rejection well inside it cannot be the timer's doing, and a stalled machine
 * cannot turn that rejection into a timeout.
 *
 * What none of these prove: one machine and loopback only, so a held connection
 * is a live peer that does not answer, not a half-open routed link, a dropped
 * packet or a partition. The peer is a stub, not a coordinator of either kind.
 * This pins the transport, not what a hook does next: a hook still admits on
 * every one of these rejections.
 *
 * Two quieter cases sit beside them. A workspace with no coordinator port, no
 * server.pid or one with no port line, is refused with its own type, so a
 * caller can tell it from a coordinator that is dead or cannot be read, which
 * keep the plain type. And the hook POST that hands back its status tells an
 * answer refused by status from a success whose body is not JSON.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PID_FILE_MAX_BYTES } from "../coordinator_pin.js";
import { postPresentingPrincipalAnswer } from "../hook_client.js";
import {
  CoordinatorPortUnknown,
  CoordinatorUnavailable,
  HOOK_REQUEST_TIMEOUT_MS,
  requestJsonStatus,
  resolveEndpoint,
} from "../hook_client_transport.js";
import { holdCoordinatorLock } from "./coordinator_stand_in.js";
import { makeFifo } from "./fifo_fixture.js";

/** The ceiling below stays under twice this, so a wait of two limits shows. */
const TIMEOUT_MS = 600;
/** What a rejection may take beyond the wait it is due to. */
const SLACK_MS = 500;
/** How long a resend that follows the rejection gets to show up in the counts. */
const SETTLE_MS = 50;
/** Fails a request that never settles, which would otherwise hang the file. */
const NEVER_SETTLED_MS = 10_000;
/** Timers round to whole milliseconds, so one can fire a hair before its due time. */
const TIMER_ROUNDING_MS = 10;
const CASE = { timeout: NEVER_SETTLED_MS };

const REQUEST_TIMEOUT = "request timeout";
const CUT_OFF = "coordinator closed the connection before the response was complete";
const RESPONSE_HEAD = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n";
const CLIENT_SOCKET_CHANNEL = "net.client.socket";

interface Stub {
  port: number;
  connections: () => number;
  requests: () => number;
  close: () => Promise<void>;
}

/** A loopback listener that counts connections and requests, and runs `onRequest` on a request's first bytes. */
async function startStub(onRequest: (socket: Socket) => void): Promise<Stub> {
  const sockets: Socket[] = [];
  let requests = 0;
  const server = createNetServer((socket) => {
    sockets.push(socket);
    // A client reset must fail an assertion, not crash the test process.
    socket.on("error", () => {});
    socket.once("data", () => {
      requests += 1;
      onRequest(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => sockets.length,
    requests: () => requests,
    close: async () => {
      // `close` waits for every connection, and these are held open on purpose.
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A port nothing listens on (bind, then close). */
async function findClosedPort(): Promise<number> {
  const stub = await startStub(() => {});
  await stub.close();
  return stub.port;
}

/** One request's rejection and how long it took; a request that resolves fails the test. */
async function requestRejection(
  port: number,
  timeoutMs: number,
): Promise<{ error: NodeJS.ErrnoException; elapsedMs: number }> {
  const startedAt = performance.now();
  const error = await requestJsonStatus(
    { port, bearer: "s".repeat(32) },
    "POST",
    "/hooks/pre-edit",
    { session_id: "s" },
    undefined,
    timeoutMs,
  ).then(
    (answer) => assert.fail(`expected a rejection, got ${JSON.stringify(answer)}`),
    (rejection: unknown) => rejection as NodeJS.ErrnoException,
  );
  return { error, elapsedMs: performance.now() - startedAt };
}

function assertWaitedOutTheLimit(elapsedMs: number): void {
  assert.ok(elapsedMs >= TIMEOUT_MS - TIMER_ROUNDING_MS, `rejected early, after ${elapsedMs} ms`);
  assert.ok(elapsedMs <= TIMEOUT_MS + SLACK_MS, `rejected late, after ${elapsedMs} ms`);
}

async function assertSentOnce(stub: Stub): Promise<void> {
  await delay(SETTLE_MS);
  assert.equal(stub.connections(), 1);
  assert.equal(stub.requests(), 1);
}

// Does not prove what a hook does on this rejection, or that the socket's limit
// bounds a whole request: it bounds silence, so a peer that keeps dripping bytes
// holds a request for longer.
test("a coordinator that accepts and never writes: request timeout, at the limit, sent once", CASE, async (t) => {
  const stub = await startStub(() => {});
  t.after(() => stub.close());

  const { error, elapsedMs } = await requestRejection(stub.port, TIMEOUT_MS);

  assert.equal(error.message, REQUEST_TIMEOUT);
  assertWaitedOutTheLimit(elapsedMs);
  await assertSentOnce(stub);
});

// The timeout wins here: the peer never closes, so only the idle limit can end
// the wait, and the cut-off that follows it finds the request already rejected.
// Does not prove which error a peer gets that stalls and then closes before the
// limit: the cut-off case below closes at once.
test("a coordinator that sends headers and hangs: request timeout, at the limit, sent once", CASE, async (t) => {
  const stub = await startStub((socket) => socket.write(RESPONSE_HEAD));
  t.after(() => stub.close());

  const { error, elapsedMs } = await requestRejection(stub.port, TIMEOUT_MS);

  assert.equal(error.message, REQUEST_TIMEOUT);
  assertWaitedOutTheLimit(elapsedMs);
  await assertSentOnce(stub);
});

// Does not prove this for a response that declares no length: a body cut there
// looks complete, and the request resolves with a null body. Neither coordinator
// sends one.
test("a coordinator that cuts its JSON body: the cut-off error at once, sent once", CASE, async (t) => {
  const stub = await startStub((socket) => socket.end(`${RESPONSE_HEAD}{"ok":`));
  t.after(() => stub.close());

  const { error, elapsedMs } = await requestRejection(stub.port, HOOK_REQUEST_TIMEOUT_MS);

  assert.equal(error.message, CUT_OFF);
  assert.ok(elapsedMs < SLACK_MS, `rejected late, after ${elapsedMs} ms`);
  await assertSentOnce(stub);
});

// Nothing listens, so the far end cannot count: the client side does. Does not
// prove a connect that hangs, such as a full accept queue or a dropped SYN.
test("a closed port: ECONNREFUSED at once, one attempt", CASE, async (t) => {
  const port = await findClosedPort();
  let attempts = 0;
  const countAttempt = () => {
    attempts += 1;
  };
  subscribe(CLIENT_SOCKET_CHANNEL, countAttempt);
  t.after(() => unsubscribe(CLIENT_SOCKET_CHANNEL, countAttempt));

  const { error, elapsedMs } = await requestRejection(port, HOOK_REQUEST_TIMEOUT_MS);

  assert.equal(error.code, "ECONNREFUSED");
  assert.ok(elapsedMs < SLACK_MS, `rejected late, after ${elapsedMs} ms`);
  await delay(SETTLE_MS);
  assert.equal(attempts, 1);
});

const BEARER = "s".repeat(32);

interface Workspace {
  root: string;
  coherenceDir: string;
  pidFile: string;
}

/** A workspace whose `.coherence` holds a hook.secret and no server.pid yet; gone after the test. */
function workspace(t: TestContext): Workspace {
  const root = mkdtempSync(join(tmpdir(), "transport-silent-"));
  const coherenceDir = join(root, ".coherence");
  mkdirSync(coherenceDir, { mode: 0o700 });
  writeFileSync(join(coherenceDir, "hook.secret"), `${BEARER}\n`, { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, coherenceDir, pidFile: join(coherenceDir, "server.pid") };
}

/** What resolveEndpoint refuses `root` with; a resolve that succeeds fails the test. */
function refusalAtResolve(root: string): Error {
  try {
    resolveEndpoint(root);
  } catch (err) {
    return err as Error;
  }
  assert.fail("resolveEndpoint did not refuse");
}

function assertPortUnknown(err: Error): void {
  assert.ok(err instanceof CoordinatorPortUnknown, `not CoordinatorPortUnknown: ${err.message}`);
  assert.ok(err instanceof CoordinatorUnavailable, "every existing catch must still take it");
}

function assertPlainUnavailable(err: Error): void {
  assert.ok(err instanceof CoordinatorUnavailable, `not CoordinatorUnavailable: ${err.message}`);
  assert.ok(!(err instanceof CoordinatorPortUnknown), `read as no coordinator: ${err.message}`);
}

test("no server.pid, or no .coherence at all: refused as CoordinatorPortUnknown", (t) => {
  const { root } = workspace(t);
  const bare = mkdtempSync(join(tmpdir(), "transport-silent-bare-"));
  t.after(() => rmSync(bare, { recursive: true, force: true }));

  assertPortUnknown(refusalAtResolve(root));
  assertPortUnknown(refusalAtResolve(bare));
});

for (const [name, content] of [
  ["a pid line only", "12345\n"],
  ["an empty file", ""],
  ["a port line that is no port", "12345\nnot-a-port\n"],
]) {
  test(`a server.pid read with no port line (${name}): refused as CoordinatorPortUnknown`, (t) => {
    const { root, pidFile } = workspace(t);
    writeFileSync(pidFile, content!);

    assertPortUnknown(refusalAtResolve(root));
  });
}

const UNUSABLE_PID_FILES: Record<string, (ws: Workspace) => void> = {
  "larger than a pid file": ({ pidFile }) => writeFileSync(pidFile, `1\n2\n${"x".repeat(PID_FILE_MAX_BYTES)}`),
  "a directory": ({ pidFile }) => mkdirSync(pidFile),
  "a FIFO": ({ pidFile }) => makeFifo(pidFile),
  "a link to a pid file": ({ coherenceDir, pidFile }) => {
    writeFileSync(join(coherenceDir, "elsewhere.pid"), `${process.pid}\n2\n`);
    symlinkSync(join(coherenceDir, "elsewhere.pid"), pidFile);
  },
};

for (const [name, make] of Object.entries(UNUSABLE_PID_FILES)) {
  test(`a server.pid that is ${name}: refused as plain CoordinatorUnavailable`, (t) => {
    const ws = workspace(t);
    make(ws);

    assertPlainUnavailable(refusalAtResolve(ws.root));
  });
}

test(
  "an unreadable server.pid: refused as plain CoordinatorUnavailable",
  { skip: process.getuid?.() === 0 ? "root reads a mode-000 file" : false },
  (t) => {
    const { root, pidFile } = workspace(t);
    writeFileSync(pidFile, `${process.pid}\n2\n`);
    chmodSync(pidFile, 0o000);

    assertPlainUnavailable(refusalAtResolve(root));
  },
);

// No process holds the lock a running coordinator holds on its pid file, so the
// file names a coordinator that has exited; held, the same file resolves.
test("a server.pid naming an exited coordinator: refused as plain CoordinatorUnavailable", (t) => {
  const { root, pidFile } = workspace(t);
  writeFileSync(pidFile, `${process.pid}\n2\n`);

  assertPlainUnavailable(refusalAtResolve(root));
  holdCoordinatorLock(pidFile);
  assert.equal(resolveEndpoint(root).port, 2);
});

interface HttpPeer {
  port: number;
  /** The path of each request that arrived, in order. */
  paths: string[];
  close: () => Promise<void>;
}

/** An HTTP peer that answers every request with `status` and the raw `body`. */
async function answeringPeer(status: number, body: string): Promise<HttpPeer> {
  const paths: string[] = [];
  const server = createHttpServer((req, res) => {
    paths.push(req.url ?? "");
    req.resume();
    res.writeHead(status, { "Content-Type": "application/json" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The hook POST's answer from a peer answering `status` and `body`, behind a Node-shaped pid file, so no principal is claimed. */
async function hookPostAnswer(t: TestContext, status: number, body: string) {
  const peer = await answeringPeer(status, body);
  t.after(() => peer.close());
  const { root, pidFile } = workspace(t);
  writeFileSync(pidFile, `${process.pid}\n${peer.port}\nbackend=node\n`);
  const target = { endpoint: { port: peer.port, bearer: BEARER }, root };
  const answer = await postPresentingPrincipalAnswer(target, "/hooks/pre-edit", { session_id: "s" });
  assert.deepEqual(peer.paths, ["/hooks/pre-edit"]);
  return answer;
}

test("the hook POST that hands back its status: a 503 keeps its status", async (t) => {
  assert.deepEqual(await hookPostAnswer(t, 503, '{"error":"busy"}'), {
    status: 503,
    body: { error: "busy" },
  });
});

test("the hook POST that hands back its status: a 2xx whose body is not JSON has a null body", async (t) => {
  assert.deepEqual(await hookPostAnswer(t, 200, "not json"), { status: 200, body: null });
});
