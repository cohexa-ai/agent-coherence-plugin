/**
 * A loopback HTTP peer that stands in for a coordinator: each request is
 * recorded, then answered as a test's script says. The script can answer in
 * full, never answer, hang up, send its body a byte at a time, or stop
 * listening, so a hook client can be driven through every way a coordinator
 * answers or fails to.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** FROZEN duplicate of the wire name; node lowercases incoming header names. */
const PRINCIPAL_HEADER = 'coherence-caller-principal';

export interface SeenRequest {
  method: string;
  url: string;
  principal: string | undefined;
  /** The parsed JSON body; null when there was none or it was not JSON. */
  body: Record<string, unknown> | null;
}

export type Reply =
  | { kind: 'answer'; status: number; text: string; headers?: Record<string, string> }
  | { kind: 'hang' }
  | { kind: 'hang_up' }
  | { kind: 'drip'; text: string; everyMs: number };

export interface ScriptedPeer {
  port: number;
  seen: SeenRequest[];
  /** Stop taking connections: the next connect is refused. Answers already under way finish. */
  stopListening: () => void;
  close: () => Promise<void>;
}

export type Script = (request: SeenRequest, peer: ScriptedPeer) => Reply;

export const json = (body: unknown, status = 200): Reply => ({
  kind: 'answer',
  status,
  text: JSON.stringify(body),
});
export const raw = (text: string, status = 200): Reply => ({ kind: 'answer', status, text });
/** Takes the request and never answers. */
export const HANG: Reply = { kind: 'hang' };
/** Closes the connection without an answer. */
export const HANG_UP: Reply = { kind: 'hang_up' };

function parsed(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function record(req: IncomingMessage): Promise<SeenRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const header = req.headers[PRINCIPAL_HEADER];
  return {
    method: req.method ?? '',
    url: req.url ?? '',
    principal: typeof header === 'string' ? header : undefined,
    body: parsed(Buffer.concat(chunks).toString('utf8')),
  };
}

/** Sends `text` one byte per `everyMs` after a head that declares its whole length. */
function drip(
  res: ServerResponse,
  reply: { text: string; everyMs: number },
  timers: Set<NodeJS.Timeout>
): void {
  const bytes = Buffer.from(reply.text, 'utf8');
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes.length });
  res.flushHeaders();
  let sent = 0;
  const timer = setInterval(() => {
    if (res.destroyed || sent >= bytes.length) {
      clearInterval(timer);
      timers.delete(timer);
      if (!res.destroyed) res.end();
      return;
    }
    res.write(bytes.subarray(sent, sent + 1));
    sent += 1;
  }, reply.everyMs);
  timers.add(timer);
}

function answer(res: ServerResponse, reply: Reply, timers: Set<NodeJS.Timeout>): void {
  if (reply.kind === 'hang') return;
  if (reply.kind === 'hang_up') {
    res.socket?.destroy();
    return;
  }
  if (reply.kind === 'drip') {
    drip(res, reply, timers);
    return;
  }
  const headers = { 'Content-Type': 'application/json', ...(reply.headers ?? {}) };
  res.writeHead(reply.status, { ...headers, 'Content-Length': Buffer.byteLength(reply.text) });
  res.end(reply.text);
}

/** Keeps every connection `server` takes in `sockets`, so a close can end held ones. */
function trackSockets(server: Server, sockets: Set<Socket>): void {
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    // A client that gives up resets the connection; that is the case under test.
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
}

/** Records each request on `peer`, then answers it as `script` says. */
function serveScript(
  server: Server,
  peer: ScriptedPeer,
  setup: { script: Script; timers: Set<NodeJS.Timeout> }
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    void record(req).then((seen) => {
      peer.seen.push(seen);
      const reply = setup.script(seen, peer);
      // Once it stops listening, this answer is its last: the client must
      // connect again, and that connect is refused.
      if (!server.listening) res.setHeader('Connection', 'close');
      answer(res, reply, setup.timers);
    });
  });
}

/** Starts a scripted peer on a loopback port. `close` ends every connection, held ones included. */
export async function startScriptedPeer(script: Script): Promise<ScriptedPeer> {
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const server = createServer();
  const peer: ScriptedPeer = {
    port: 0,
    seen: [],
    stopListening: () => {
      if (server.listening) server.close();
    },
    close: async () => {
      timers.forEach((timer) => clearInterval(timer));
      sockets.forEach((socket) => socket.destroy());
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  trackSockets(server, sockets);
  serveScript(server, peer, { script, timers });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  peer.port = (server.address() as AddressInfo).port;
  return peer;
}

/** A port nothing listens on: bound, then closed. */
export async function closedPort(): Promise<number> {
  const peer = await startScriptedPeer(() => HANG);
  await peer.close();
  return peer.port;
}
