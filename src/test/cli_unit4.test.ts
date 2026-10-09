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
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import { normalizeWorkspacePath } from "../cli.js";
import { CLI_REQUEST_TIMEOUT_MS, HOOK_REQUEST_TIMEOUT_MS } from "../hook_client_transport.js";

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

test("the --self-test refusal names the Python console script and no backend switch", async () => {
  // The refusal used to prescribe `printf 'python\n' > .coherence/coordinator_backend`.
  // On a store the Node coordinator created, the Python coordinator fails
  // closed and the dispatcher honors the file verbatim, so following that
  // advice left the workspace with no coordinator at all.
  const cwd = mkdtempSync(join(tmpdir(), "cli-self-test-"));
  try {
    for (const entry of ["cli_status.js", "cli_track.js"]) {
      const run = await runCli(entry, ["--self-test"], cwd);
      assert.equal(run.status, 2, entry);
      assert.equal(run.stdout, "", entry);
      assert.match(
        run.stderr,
        /--self-test is not supported by the bundled Node CLI \(it runs a live four-step pre-read → pre-edit → post-edit → stale-read sequence, then checks counters only the Python coordinator serves\)\. It needs the Python library's console script \(`pip install "agent-coherence>=0\.8\.0"`, run by its install path\) on a workspace the Python coordinator serves\. On a Node workspace, plain `agent-coherence-status` confirms the coordinator answers\.$/m,
        entry,
      );
      assert.doesNotMatch(run.stderr, /coordinator_backend|printf/, entry);
      assert.doesNotMatch(run.stderr, /prepare-for-migration/, entry);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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

test("the default, minimal and metrics tiers do not send the operator header", async () => {
  const stub = await startPythonStatusStub();
  try {
    const plain = await runCli("cli_status.js", ["--root", stub.root], stub.root);
    const minimal = await runCli(
      "cli_status.js",
      ["--detail", "minimal", "--root", stub.root],
      stub.root,
    );
    const metrics = await runCli(
      "cli_status.js",
      ["--detail", "metrics", "--root", stub.root],
      stub.root,
    );
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(minimal.status, 0, minimal.stderr);
    assert.equal(metrics.status, 0, metrics.stderr);
    assert.deepEqual(
      stub.requests.map((r) => r.url),
      ["/status", "/status?detail=minimal", "/status?detail=metrics"],
    );
    for (const r of stub.requests) assert.equal(r.headers["coherence-local-operator"], undefined);
  } finally {
    await stub.close();
  }
});

test("/agent-coherence:status runs the status CLI at --detail minimal", () => {
  // The shim runs the Python console script when it finds no Node CLI, and
  // that script's own default was the operator tier (session names, the
  // absolute root) printed into the transcript. Both CLIs accept `minimal`,
  // and every Python release the plugin supports does.
  const command = readFileSync(join(DIST, "..", "commands", "status.md"), "utf-8");
  const invocations = [...command.matchAll(/\bRun `([^`]*)`/g)].map((m) => m[1]);
  assert.deepEqual(invocations, ["agent-coherence-status --detail minimal"]);
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

    // A refusal whose body carries no string `error` names only its status.
    stub.answer = [403, "{}"];
    const bare = await runCli("cli_status.js", ["--detail", "full", "--root", stub.root], stub.root);
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /^agent-coherence-status: HTTP 403$/m);
    assert.equal(bare.stdout, "");

    stub.answer = [200, "not json"];
    const garbled = await runCli("cli_status.js", ["--root", stub.root], stub.root);
    assert.equal(garbled.status, 2);
    assert.match(garbled.stderr, /^agent-coherence-status: coordinator returned a non-JSON response$/m);
    assert.equal(garbled.stdout, "");
  } finally {
    await stub.close();
  }
});

test("a response cut off mid-body exits 2, not a silent 0", async () => {
  // The connection drops after the headers and part of the body. Unless the
  // transport treats that as a failure, the request never settles and the CLI
  // exits 0 with no output, which a script reads as an empty success.
  const root = mkdtempSync(join(tmpdir(), "cli-status-cut-"));
  const server = createNetServer((socket) => {
    // A client reset must fail this test, not crash the test process.
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.end(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n" +
          '{"backend":',
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (server.address() as AddressInfo).port;
    mkdirSync(join(root, ".coherence"), { recursive: true });
    writeFileSync(join(root, ".coherence", "server.pid"), `${process.pid}\n${port}\n`);
    writeFileSync(join(root, ".coherence", "hook.secret"), `${"s".repeat(32)}\n`);

    const cut = await runCli("cli_status.js", ["--root", root], root);
    assert.equal(cut.status, 2, `stdout=${JSON.stringify(cut.stdout)} stderr=${JSON.stringify(cut.stderr)}`);
    // Pinned to the cut-off itself: a broken setup ("no coordinator running")
    // also exits 2 and must not pass for it.
    assert.match(
      cut.stderr,
      /^agent-coherence-status: coordinator closed the connection before the response was complete$/m,
    );
    assert.equal(cut.stdout, "");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
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
    // The relayed text is the operator's only clue, so it must say where the
    // tier is served. It must not prescribe a backend switch: this store is
    // Node-owned, and the Python coordinator fails closed on it.
    assert.match(
      full.stderr,
      /^agent-coherence-status: HTTP 501: detail=full \(the operator tier\) is served by the Python coordinator only; this Node coordinator serves the default and metrics tiers$/m,
    );
    assert.doesNotMatch(full.stderr, /coordinator_backend/);
    assert.equal(full.stdout, "");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- how long a CLI waits for the coordinator ---------------------------------

test("the CLIs wait as long as the Python console scripts (6 s); the hooks keep 5 s", () => {
  // The Python scripts' limit is CLI_HTTP_TIMEOUT_SEC = 6.0 in _coherence_client.py.
  assert.equal(CLI_REQUEST_TIMEOUT_MS, 6000);
  assert.equal(HOOK_REQUEST_TIMEOUT_MS, 5000);
});

/** Past the hooks' 5 s limit, inside the CLIs' 6 s one. */
const SLOW_ANSWER_MS = 5500;

function runHookClient(
  sub: string,
  root: string,
  input: string,
): Promise<{ stdout: string; status: number | null }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(DIST, "hook_client.js"), sub, "--root", root], {
      cwd: root,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.on("close", (status) => resolveRun({ stdout, status }));
    child.stdin.end(input);
  });
}

test("the CLIs wait for a coordinator answer that takes 5.5 s; a hook still gives up at 5 s", async () => {
  // On a large workspace the Python coordinator can take just over 5 s to
  // answer when a busy registry frees up late, and its own console scripts
  // wait 6 s for that answer. A hook runs on every tool call and fails open,
  // so it keeps the shorter limit.
  const root = mkdtempSync(join(tmpdir(), "cli-slow-"));
  const requests: string[] = [];
  const server = createHttpServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "";
      requests.push(url);
      const body = url === "/policy/track" ? { added: ["notes.md"] } : { answered: url };
      const timer = setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      }, SLOW_ANSWER_MS);
      // A client that gave up has nothing left to answer.
      res.on("close", () => clearTimeout(timer));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (server.address() as AddressInfo).port;
    mkdirSync(join(root, ".coherence"), { recursive: true });
    // backend=node: the hook claims no caller principal, so its one request is
    // the hook route itself.
    writeFileSync(join(root, ".coherence", "server.pid"), `${process.pid}\n${port}\nbackend=node\n`);
    writeFileSync(join(root, ".coherence", "hook.secret"), `${"s".repeat(32)}\n`);

    const hookInput = JSON.stringify({
      session_id: "44444444-4444-4444-8444-444444444444",
      tool_input: { command: "ls" },
    });
    const [status, track, hook] = await Promise.all([
      runCli("cli_status.js", ["--root", root], root),
      runCli("cli_track.js", ["notes.md", "--root", root], root),
      runHookClient("pre-bash", root, hookInput),
    ]);

    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), { answered: "/status" });
    assert.equal(track.status, 0, track.stderr);
    assert.match(track.stdout, /^agent-coherence-track: tracked notes\.md$/m);
    // The hook's request reached the coordinator, so its `{}` is the fail-open
    // answer to giving up, not a skip before the request.
    assert.deepEqual([...requests].sort(), ["/hooks/pre-bash", "/policy/track", "/status"]);
    assert.equal(hook.status, 0);
    assert.equal(hook.stdout, "{}\n");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Node coordinator's default tier publishes the workspace root nowhere", async () => {
  // policy_summary carried the absolute root, so the default tier, which the
  // status command prints verbatim, put $HOME and the directory layout in the
  // transcript. It now carries the "." the Python default tier reports.
  const root = mkdtempSync(join(tmpdir(), "cli-status-root-"));
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

    for (const tier of [[], ["--detail", "minimal"]]) {
      const run = await runCli("cli_status.js", [...tier, "--root", root], root);
      assert.equal(run.status, 0, run.stderr);
      const body = JSON.parse(run.stdout) as { policy_summary: Record<string, unknown> };
      assert.equal(body.policy_summary.coordinator_root, ".");
      assert.ok(!run.stdout.includes(root), `root leaked at ${JSON.stringify(tier)}: ${run.stdout}`);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
