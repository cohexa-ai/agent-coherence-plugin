/**
 * Unit 4 — Node CLIs (track/untrack/status): path normalization contract +
 * a live end-to-end (async spawn — see hook_client.test.ts for why never
 * spawnSync against an in-process server).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer as createHttpServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import { normalizeWorkspacePath } from "../cli.js";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..");

test("normalizeWorkspacePath: relative passes; absolute-inside strips; outside/traversal reject", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-norm-"));
  try {
    assert.deepEqual(normalizeWorkspacePath("docs/plan.md", root), ["docs/plan.md", null]);
    assert.deepEqual(normalizeWorkspacePath(join(root, "docs", "plan.md"), root), [
      "docs/plan.md",
      null,
    ]);
    assert.deepEqual(normalizeWorkspacePath("/etc/passwd", root), [
      "/etc/passwd",
      "path outside workspace root",
    ]);
    assert.deepEqual(normalizeWorkspacePath("../up.md", root), ["../up.md", "contains '..'"]);
    assert.deepEqual(normalizeWorkspacePath("", root), ["", "empty"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runCli(
  entry: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(DIST, entry), ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("close", (status) => resolveRun({ stdout, stderr, status }));
  });
}

test("end-to-end: a refused write reaches the operator as HTTP <status>: <error>, exit 2", async () => {
  // The coordinator's 400 says what is wrong with the policy file and how to
  // fix it; printing only "coordinator rejected the request" threw that away.
  // Same line as the Python CLI (`coherence_track.py`).
  const root = mkdtempSync(join(tmpdir(), "cli-refusal-"));
  const secret = "s".repeat(32);
  const registry = new ArtifactRegistry(join(root, ".coherence", "state.db"));
  const server = createServer({
    secret,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy: PolicyRef.load(root),
    sessions: new SessionRegistry(),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (server.address() as AddressInfo).port;
    writeFileSync(join(root, ".coherence", "server.pid"), `${process.pid}\n${port}\n`);
    writeFileSync(join(root, ".coherence", "hook.secret"), `${secret}\n`);
    writeFileSync(join(root, ".coherence", "tracked.yaml"), "- keep.md\n- *.log\n");

    const track = await runCli("cli_track.js", ["notes.md", "--root", root], root);
    assert.equal(track.status, 2);
    assert.match(
      track.stderr,
      /^agent-coherence-track: HTTP 400: \.coherence\/tracked\.yaml is not valid YAML, so it loads as no entries/m,
    );
    assert.equal(track.stdout, "");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("end-to-end: a refusal with no string error prints its status; a non-JSON success says so (exit 2)", async () => {
  // A coordinator that answers whatever this test sets: the two fallbacks the
  // real one cannot produce on demand.
  const root = mkdtempSync(join(tmpdir(), "cli-fallback-"));
  let answer: [status: number, body: string] = [400, "{}"];
  const fake = createHttpServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(answer[0], { "Content-Type": "application/json" });
      res.end(answer[1]);
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (fake.address() as AddressInfo).port;
    mkdirSync(join(root, ".coherence"), { recursive: true });
    writeFileSync(join(root, ".coherence", "server.pid"), `${process.pid}\n${port}\n`);
    writeFileSync(join(root, ".coherence", "hook.secret"), `${"s".repeat(32)}\n`);

    const refused = await runCli("cli_untrack.js", ["notes.md", "--root", root], root);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /^agent-coherence-untrack: HTTP 400$/m);
    assert.equal(refused.stdout, "");

    answer = [200, "not json"];
    const garbled = await runCli("cli_track.js", ["notes.md", "--root", root], root);
    assert.equal(garbled.status, 2);
    assert.match(garbled.stderr, /^agent-coherence-track: coordinator returned a non-JSON response$/m);
    assert.equal(garbled.stdout, "");
  } finally {
    await new Promise<void>((r) => fake.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("end-to-end: track writes YAML + prints; untrack uses `removed`; status renders JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "cli-e2e-"));
  const secret = "s".repeat(32);
  // Closed in the finally, so a failed assertion cannot leave the server
  // listening (node --test would never exit).
  const registry = new ArtifactRegistry(join(root, ".coherence", "state.db"));
  const server = createServer({
    secret,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy: PolicyRef.load(root),
    sessions: new SessionRegistry(),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (server.address() as AddressInfo).port;
    mkdirSync(join(root, ".coherence"), { recursive: true });
    writeFileSync(join(root, ".coherence", "server.pid"), `${process.pid}\n${port}\n`); // 2-line Python format
    writeFileSync(join(root, ".coherence", "hook.secret"), `${secret}\n`);

    // track: one valid relative + one absolute-inside (normalized) + one outside (client-rejected).
    const track = await runCli(
      "cli_track.js",
      ["notes.md", join(root, "docs", "a.md"), "/etc/passwd", "--root", root],
      root,
    );
    assert.equal(track.status, 0);
    assert.match(track.stdout, /agent-coherence-track: tracked notes\.md/);
    assert.match(track.stdout, /agent-coherence-track: tracked docs\/a\.md/);
    assert.match(track.stderr, /rejected '\/etc\/passwd': path outside workspace root/);
    const yaml = readFileSync(join(root, ".coherence", "tracked.yaml"), "utf8");
    assert.equal(yaml, '- "notes.md"\n- "docs/a.md"\n');

    const untrack = await runCli("cli_untrack.js", ["notes.md", "--root", root], root);
    assert.equal(untrack.status, 0);
    assert.match(untrack.stdout, /agent-coherence-untrack: untracked notes\.md/);

    const status = await runCli("cli_status.js", ["--root", root], root);
    assert.equal(status.status, 0);
    const parsed = JSON.parse(status.stdout) as Record<string, unknown>;
    assert.equal(parsed.backend, "node");

    // Failure signaling (unlike the fail-open hook-client): no coordinator → exit 2.
    const deadRoot = mkdtempSync(join(tmpdir(), "cli-dead-"));
    try {
      const dead = await runCli("cli_status.js", ["--root", deadRoot], deadRoot);
      assert.equal(dead.status, 2);
    } finally {
      rmSync(deadRoot, { recursive: true, force: true });
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 0.3.1: unsupported flags must FAIL, not silently no-op -----------------

test("0.3.1: --self-test is rejected with exit 2, not a false-positive exit 0", async () => {
  const { runStatus } = await import("../cli.js");
  const code = await runStatus(["--self-test"]);
  // The bug: the Node CLI discarded unknown flags, printed ordinary status and
  // exited 0 — so the README's flagship post-install validation reported
  // success without ever running. Non-zero is the whole point of this test.
  assert.equal(code, 2);
});

test("0.3.1: unknown/typo flags are rejected rather than ignored", async () => {
  const { runStatus, runTrack, runUntrack } = await import("../cli.js");
  assert.equal(await runStatus(["--detial", "metrics"]), 2);
  assert.equal(await runTrack(["--self-test"]), 2);
  assert.equal(await runUntrack(["--bogus"]), 2);
});

test("0.3.1: --detail validates its value", async () => {
  const { runStatus } = await import("../cli.js");
  assert.equal(await runStatus(["--detail", "bogus"]), 2);
});

// --- --detail full: the operator tier needs the Coherence-Local-Operator header ---

const DETAIL_FULL_REFUSAL =
  "detail=full requires the Coherence-Local-Operator: true opt-in header in addition to the Bearer secret (R12).";
const RECLAIMED = { "plan.md": { trigger: "reclaim_heartbeat", reclaimed_at_unix_ts: 1791518917 } };

interface StatusStub {
  root: string;
  requests: Array<{ url: string; headers: IncomingHttpHeaders }>;
  /** A fixed [status, body] answer in place of the Python-shaped one. */
  answer: [status: number, body: string] | null;
  close(): Promise<void>;
}

/**
 * Answers /status the way the Python coordinator does: detail=full without
 * `Coherence-Local-Operator: true` is a 403, with it the operator tier (whose
 * session rows carry `reclaimed`). Records every request's headers.
 */
async function startPythonStatusStub(): Promise<StatusStub> {
  const root = mkdtempSync(join(tmpdir(), "cli-status-"));
  const requests: StatusStub["requests"] = [];
  const server = createHttpServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "";
      requests.push({ url, headers: req.headers });
      let answer: [number, string];
      if (stub.answer !== null) answer = stub.answer;
      else if (!url.includes("detail=full")) answer = [200, JSON.stringify({ backend: "python" })];
      else if (req.headers["coherence-local-operator"] !== "true") {
        answer = [403, JSON.stringify({ error: DETAIL_FULL_REFUSAL })];
      } else {
        const session = { agent_name: "claude-session-a", reclaimed: RECLAIMED };
        answer = [200, JSON.stringify({ backend: "python", sessions: [session] })];
      }
      res.writeHead(answer[0], { "Content-Type": "application/json" });
      res.end(answer[1]);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  mkdirSync(join(root, ".coherence"), { recursive: true });
  writeFileSync(join(root, ".coherence", "server.pid"), `${process.pid}\n${port}\n`);
  writeFileSync(join(root, ".coherence", "hook.secret"), `${"s".repeat(32)}\n`);
  const stub: StatusStub = {
    root,
    requests,
    answer: null,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    },
  };
  return stub;
}

test("--detail full sends Coherence-Local-Operator: true and prints the operator tier", async () => {
  // The Python coordinator refuses detail=full without the opt-in header, so
  // a CLI that never sent it could not read the operator tier at all.
  const stub = await startPythonStatusStub();
  try {
    const full = await runCli("cli_status.js", ["--detail", "full", "--root", stub.root], stub.root);
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0]!.url, "/status?detail=full");
    assert.equal(stub.requests[0]!.headers["coherence-local-operator"], "true");
    assert.equal(full.status, 0, full.stderr);
    const parsed = JSON.parse(full.stdout) as { sessions: Array<Record<string, unknown>> };
    assert.deepEqual(parsed.sessions[0]!.reclaimed, RECLAIMED);
  } finally {
    await stub.close();
  }
});

test("the default and metrics tiers do not send the operator header", async () => {
  const stub = await startPythonStatusStub();
  try {
    const plain = await runCli("cli_status.js", ["--root", stub.root], stub.root);
    const metrics = await runCli(
      "cli_status.js",
      ["--detail", "metrics", "--root", stub.root],
      stub.root,
    );
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(metrics.status, 0, metrics.stderr);
    assert.deepEqual(
      stub.requests.map((r) => r.url),
      ["/status", "/status?detail=metrics"],
    );
    for (const r of stub.requests) assert.equal(r.headers["coherence-local-operator"], undefined);
  } finally {
    await stub.close();
  }
});

test("a refused status request prints HTTP <status>: <error>, exit 2; non-JSON 2xx says so", async () => {
  const stub = await startPythonStatusStub();
  try {
    stub.answer = [403, JSON.stringify({ error: DETAIL_FULL_REFUSAL })];
    const refused = await runCli("cli_status.js", ["--detail", "full", "--root", stub.root], stub.root);
    assert.equal(refused.status, 2);
    assert.match(
      refused.stderr,
      /^agent-coherence-status: HTTP 403: detail=full requires the Coherence-Local-Operator: true opt-in header/m,
    );
    assert.equal(refused.stdout, "");

    stub.answer = [200, "not json"];
    const garbled = await runCli("cli_status.js", ["--root", stub.root], stub.root);
    assert.equal(garbled.status, 2);
    assert.match(garbled.stderr, /^agent-coherence-status: coordinator returned a non-JSON response$/m);
    assert.equal(garbled.stdout, "");
  } finally {
    await stub.close();
  }
});

test("--detail full against the Node coordinator surfaces its 501, exit 2", async () => {
  // The Node coordinator has no operator tier; its 501 must reach the operator
  // as such rather than as an unexplained rejection.
  const root = mkdtempSync(join(tmpdir(), "cli-status-node-"));
  const secret = "s".repeat(32);
  const registry = new ArtifactRegistry(join(root, ".coherence", "state.db"));
  const server = createServer({
    secret,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy: PolicyRef.load(root),
    sessions: new SessionRegistry(),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (server.address() as AddressInfo).port;
    writeFileSync(join(root, ".coherence", "server.pid"), `${process.pid}\n${port}\n`);
    writeFileSync(join(root, ".coherence", "hook.secret"), `${secret}\n`);

    const full = await runCli("cli_status.js", ["--detail", "full", "--root", root], root);
    assert.equal(full.status, 2);
    assert.match(full.stderr, /^agent-coherence-status: HTTP 501: /m);
    assert.equal(full.stdout, "");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
