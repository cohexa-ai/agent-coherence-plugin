/**
 * #214 — a hook route whose registry work raises answers the Python
 * coordinator's failure envelope, HTTP 200 `{ok: false, reason: "internal:
 * <Type>"}` (`_answer_handler_error`), which library clients type by its
 * `internal: ` prefix. A coherence refusal (`commit_not_allowed`, an invalid
 * transition) keeps its raw reason, as Python's `except CoherenceError` does,
 * and `/status` keeps its HTTP 500.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { ArtifactRegistry } from "../registry.js";
import { InvariantViolationError } from "../invariants.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import { MESIState } from "../states.js";

const SECRET = "s".repeat(32);
const SID_A = "44444444-4444-4444-8444-444444444444";
const SID_B = "55555555-5555-5555-8555-555555555555";
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const BUSY = { ok: false, reason: "internal: SqliteError" };

async function makeServer() {
  const tmp = mkdtempSync(join(tmpdir(), "failure-envelope-test-"));
  mkdirSync(join(tmp, ".coherence"), { recursive: true });
  const registry = new ArtifactRegistry(join(tmp, ".coherence", "state.db"));
  const sessions = new SessionRegistry();
  const policy = PolicyRef.load(tmp);
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy,
    sessions,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const request = async (path: string, body?: unknown) => {
    const headers = { Authorization: `Bearer ${SECRET}`, Host: "127.0.0.1", "Content-Type": "application/json" };
    const res = await fetch(
      `http://127.0.0.1:${port}${path}`,
      body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const cleanup = () =>
    new Promise<void>((r) => {
      server.close(() => {
        registry.close();
        rmSync(tmp, { recursive: true, force: true });
        r();
      });
    });
  return { registry, sessions, policy, request, cleanup, root: tmp };
}

/** The issue's trigger: another connection holds the store's write lock past the busy timeout. */
async function whileStoreLocked<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const other = new Database(join(root, ".coherence", "state.db"));
  other.exec("BEGIN IMMEDIATE");
  try {
    return await fn();
  } finally {
    other.exec("ROLLBACK");
    other.close();
  }
}

/** Make one method raise, for the call sites a held lock cannot reach. */
function failOn<T extends object>(target: T, method: keyof T, err: Error): void {
  Object.defineProperty(target, method, {
    configurable: true,
    value: () => {
      throw err;
    },
  });
}

const busyError = () => new Database.SqliteError("database is locked", "SQLITE_BUSY");

function holdExclusive(registry: ArtifactRegistry, sessions: SessionRegistry, sessionId: string) {
  const artifactId = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
  const agentId = sessions.registerSession(sessionId);
  registry.acquireExclusive(artifactId, agentId, 10);
  return { artifactId, agentId };
}

// ------------------------------------------------- the store's write lock is held

test("/hooks/pre-read: a locked store answers the failure envelope, not HTTP 500 (#214)", async () => {
  const { request, cleanup, root } = await makeServer();
  try {
    const r = await whileStoreLocked(root, () =>
      request("/hooks/pre-read", { session_id: SID_A, path: "CLAUDE.md", content_hash: HASH_1 }),
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, BUSY);
  } finally {
    await cleanup();
  }
});

test("/hooks/post-edit: a locked commit answers the envelope, records nothing, and keeps the grant (#214)", async () => {
  const { registry, sessions, request, cleanup, root } = await makeServer();
  try {
    const { artifactId, agentId } = holdExclusive(registry, sessions, SID_A);
    const r = await whileStoreLocked(root, () =>
      request("/hooks/post-edit", { session_id: SID_A, path: "CLAUDE.md", success: true, content_hash: HASH_2 }),
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, BUSY);
    assert.equal(registry.getArtifactById(artifactId)!.version, 1);
    assert.equal(registry.getAgentState(artifactId, agentId), MESIState.EXCLUSIVE);
  } finally {
    await cleanup();
  }
});

test("/hooks/post-edit-cas: a locked CAS answers the envelope and records nothing (#214)", async () => {
  const { registry, request, cleanup, root } = await makeServer();
  try {
    const artifactId = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const r = await whileStoreLocked(root, () =>
      request("/hooks/post-edit-cas", {
        session_id: SID_A,
        path: "CLAUDE.md",
        content_hash: HASH_2,
        expected_version: 1,
      }),
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, BUSY);
    assert.equal(registry.getArtifactById(artifactId)!.version, 1);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------- one registry call raises

const STUBBED_ROUTES: Array<{
  name: string;
  method: keyof ArtifactRegistry;
  path: string;
  body: Record<string, unknown>;
  holdsExclusive?: boolean;
  registered?: boolean;
}> = [
  {
    name: "pre-edit on a new path",
    method: "resolveOrRegisterArtifact",
    path: "/hooks/pre-edit",
    body: { session_id: SID_A, path: "CLAUDE.md" },
  },
  {
    name: "pre-edit's acquire",
    method: "acquireExclusive",
    path: "/hooks/pre-edit",
    body: { session_id: SID_A, path: "CLAUDE.md" },
    registered: true,
  },
  {
    name: "post-edit's release on success=false",
    method: "invalidate",
    path: "/hooks/post-edit",
    body: { session_id: SID_A, path: "CLAUDE.md", success: false },
    holdsExclusive: true,
  },
  {
    name: "pre-bash on a tracked path",
    method: "resolveOrRegisterArtifact",
    path: "/hooks/pre-bash",
    body: { session_id: SID_A, command: "cat CLAUDE.md" },
  },
  {
    name: "pre-grep's prefix lookup",
    method: "artifactNamesUnderPrefix",
    path: "/hooks/pre-grep",
    body: { session_id: SID_A, search_root: "docs/" },
  },
];

for (const route of STUBBED_ROUTES) {
  test(`${route.path}: ${route.name} raising answers the failure envelope (#214)`, async () => {
    const { registry, sessions, request, cleanup } = await makeServer();
    try {
      if (route.holdsExclusive) holdExclusive(registry, sessions, SID_A);
      if (route.registered) registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
      failOn(registry, route.method, busyError());
      const r = await request(route.path, route.body);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, BUSY);
    } finally {
      await cleanup();
    }
  });
}

test("/hooks/session-stop: a release that raises answers the envelope, not a clean release (#214)", async () => {
  const { registry, sessions, request, cleanup } = await makeServer();
  try {
    const { artifactId, agentId } = holdExclusive(registry, sessions, SID_A);
    failOn(registry, "invalidate", busyError());
    const r = await request("/hooks/session-stop", { session_id: SID_A });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, BUSY);
    assert.equal(registry.getAgentState(artifactId, agentId), MESIState.EXCLUSIVE);
  } finally {
    await cleanup();
  }
});

test("/hooks/post-edit and /hooks/pre-edit: a registry row it cannot read answers the envelope, not a refusal (#214)", async () => {
  const { registry, sessions, request, cleanup, root } = await makeServer();
  try {
    holdExclusive(registry, sessions, SID_A);
    // A plain Error, as Python's KeyError is: a fault, never a refusal the client would trust.
    const other = new Database(join(root, ".coherence", "state.db"));
    other.prepare("UPDATE agent_states SET state = 'BOGUS'").run();
    other.close();
    const commit = await request("/hooks/post-edit", {
      session_id: SID_A,
      path: "CLAUDE.md",
      success: true,
      content_hash: HASH_2,
    });
    assert.deepEqual(commit.body, { ok: false, reason: "internal: Error" });
    const acquire = await request("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.deepEqual(acquire.body, { ok: false, reason: "internal: Error" });
  } finally {
    await cleanup();
  }
});

test("/hooks/pre-edit: any error that is not a coherence refusal answers the envelope, named by its type (#214)", async () => {
  const { registry, request, cleanup } = await makeServer();
  try {
    registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    failOn(registry, "acquireExclusive", new TypeError("x is not a function"));
    const r = await request("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.deepEqual(r.body, { ok: false, reason: "internal: TypeError" });
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------- refusals keep their reason

test("/hooks/post-edit: a lost grant keeps its commit_not_allowed reason (#214)", async () => {
  const { registry, sessions, request, cleanup } = await makeServer();
  try {
    const { artifactId } = holdExclusive(registry, sessions, SID_A);
    registry.acquireExclusive(artifactId, sessions.registerSession(SID_B), 11);
    const r = await request("/hooks/post-edit", {
      session_id: SID_A,
      path: "CLAUDE.md",
      success: true,
      content_hash: HASH_2,
    });
    assert.equal(r.body.ok, false);
    assert.match(String(r.body.reason), /^commit_not_allowed: agent=/);
  } finally {
    await cleanup();
  }
});

test("/hooks/post-edit-cas: an EXCLUSIVE caller keeps its commit_cas_not_allowed reason (#214)", async () => {
  const { registry, sessions, request, cleanup } = await makeServer();
  try {
    holdExclusive(registry, sessions, SID_A);
    const r = await request("/hooks/post-edit-cas", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_2,
      expected_version: 1,
    });
    assert.equal(r.body.ok, false);
    assert.match(String(r.body.reason), /^commit_cas_not_allowed agent=/);
  } finally {
    await cleanup();
  }
});

test("/hooks/pre-edit: an invariant violation keeps its raw reason (#214)", async () => {
  const { registry, request, cleanup } = await makeServer();
  try {
    registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    failOn(registry, "acquireExclusive", new InvariantViolationError("single_writer_violated owners=[a, b]"));
    const r = await request("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.deepEqual(r.body, { ok: false, reason: "single_writer_violated owners=[a, b]" });
  } finally {
    await cleanup();
  }
});

for (const route of ["/policy/track", "/policy/untrack"]) {
  test(`${route}: an error after the policy write keeps HTTP 500, as on the Python coordinator (#214)`, async () => {
    const { policy, request, cleanup } = await makeServer();
    try {
      failOn(policy, "reload", busyError());
      const r = await request(route, { paths: ["notes/a.md"] });
      assert.equal(r.status, 500);
      assert.deepEqual(r.body, { error: "internal: SqliteError" });
    } finally {
      await cleanup();
    }
  });
}

test("/status: a registry error keeps HTTP 500, as on the Python coordinator (#214)", async () => {
  const { registry, request, cleanup } = await makeServer();
  try {
    failOn(registry, "listArtifacts", busyError());
    const r = await request("/status");
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: "internal: SqliteError" });
  } finally {
    await cleanup();
  }
});
