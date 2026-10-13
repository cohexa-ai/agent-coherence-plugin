/**
 * AC-03 cross-backend /status shape parity tests.
 *
 * The Python coordinator's /status default tier emits:
 *   tracked_artifacts: [{path, version, id}]
 *   sessions: [{agent_name, agent_id, states: {path: state_name}}]
 *
 * Node previously emitted:
 *   tracked_artifacts: [{id, name, version}]      (key divergence: name vs path)
 *   sessions: [{agent_id}]                        (missing agent_name + states)
 *
 * These tests pin the corrected shape so any future regression on the
 * Node side breaks loudly (the agent-coherence-status CLI reads
 * `agent_name` and `states` directly — silent empty against the old
 * shape).
 *
 * R6 narrowed one of those fields rather than moving it: `agent_name` renders
 * `claude-session-<session id>`, so both runtimes stopped publishing it below
 * the operator tier. Python moved the name to `?detail=full`; Node serves no
 * operator tier (detail=full is 501), so on its one tier the value is always
 * null. The FIELD is still part of the pinned shape — it is typed
 * `string | null` on both sides and Python emits null on this same path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../server.js";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";

function makeOptions() {
  const tmp = mkdtempSync(join(tmpdir(), "ac03-test-"));
  const registry = new ArtifactRegistry(join(tmp, "state.db"));
  const policy = PolicyRef.load(tmp);
  const sessions = new SessionRegistry();
  const cleanup = (): void => {
    registry.close();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };
  return {
    options: {
      secret: "test-secret-not-used-in-direct-handler-tests",
      startedAtMs: Date.now() - 100,
      version: "0.1.1-test",
      registry,
      policy,
      sessions,
    },
    cleanup,
    tmp,
  };
}

async function statusBody(server: ReturnType<typeof createServer>, secret: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`unexpected server address: ${String(address)}`);
  }
  const url = `http://127.0.0.1:${address.port}/status`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${secret}`,
      Host: "127.0.0.1",
    },
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

test("AC-03: tracked_artifacts entries use 'path' (Python parity)", async () => {
  const { options, cleanup } = makeOptions();
  try {
    const sid = "11111111-2222-4111-8111-aaaaaaaaaaaa";
    const agentId = options.sessions.registerSession(sid);
    const artId = options.registry.resolveOrRegisterArtifact("plan.md", "abc");
    options.registry.grantShared(artId, agentId, 0);

    const server = createServer(options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const { status, body } = await statusBody(server, options.secret);
      assert.equal(status, 200);
      const arts = body.tracked_artifacts as ReadonlyArray<Record<string, unknown>>;
      assert.ok(Array.isArray(arts) && arts.length >= 1);
      assert.equal(typeof arts[0]!.path, "string", "tracked_artifacts entries must carry 'path'");
      assert.equal(arts[0]!.path, "plan.md");
      assert.equal(typeof arts[0]!.version, "number");
      assert.equal(typeof arts[0]!.id, "string");
      assert.equal(
        (arts[0] as Record<string, unknown>).name,
        undefined,
        "tracked_artifacts entries must NOT carry deprecated 'name' key",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    cleanup();
  }
});

test("AC-03: a durable holder with no session-map entry is still listed with its states", async () => {
  // The SessionRegistry is process-local while the holder set comes from
  // durable sqlite agent_states, so a grant that outlived the coordinator
  // process that issued it has no recoverable name — the agent id is a
  // one-way uuid5 of the session id. The content here is that such a holder
  // is LISTED AT ALL, with its per-artifact state: the registry arbitrates
  // against it, so an operator has to be able to see it.
  //
  // The null name no longer distinguishes this branch — since R6 every row
  // this tier serves reports null — so what the name assertion still pins is
  // the field's TYPE: null rather than a "<unknown>" sentinel, which would
  // put "no name" into the same type and namespace as real names and be
  // indistinguishable from a session actually called that. The branch itself
  // is distinguished by `agentIdToName` returning null, asserted below.
  const { options, cleanup } = makeOptions();
  try {
    // Acquire with an agent id the session map has never seen — exactly the
    // post-restart orphaned-holder case, without restarting anything.
    const agentId = "0123456789abcdef0123456789abcdef";
    assert.equal(options.sessions.agentIdToName(agentId), null);
    const artId = options.registry.resolveOrRegisterArtifact("plan.md", "abc");
    options.registry.acquireExclusive(artId, agentId, 0);

    const server = createServer(options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const { status, body } = await statusBody(server, options.secret);
      assert.equal(status, 200);
      const sessions = body.sessions as ReadonlyArray<Record<string, unknown>>;
      const holder = sessions.find((s) => s.agent_id === agentId);
      assert.ok(holder, "the durable holder must still be listed");
      assert.deepEqual(holder.states, { "plan.md": "EXCLUSIVE" });
      assert.equal(holder.agent_name, null, "an unnamed holder reports null");
      assert.notEqual(holder.agent_name, "<unknown>");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    cleanup();
  }
});

test("AC-03: sessions entries carry the agent_name field + states map (Python parity)", async () => {
  // R6: `agent_name` renders `claude-session-<session id>` verbatim, so a
  // session row published the raw session id beside that session's
  // per-artifact state. Python moved the name behind the operator
  // (?detail=full) tier; Node serves no operator tier at all (detail=full is
  // 501), so on the one tier it does serve the name is null. The FIELD stays —
  // it is parity-pinned and typed `string | null`, and null is the same shape
  // Python emits on this path.
  //
  // The control is asserted first: an empty sessions list, or a row without
  // its states map, would satisfy "no session id in the body" while observing
  // nothing at all.
  const { options, cleanup } = makeOptions();
  try {
    const sid = "22222222-3333-4222-8222-bbbbbbbbbbbb";
    const agentId = options.sessions.registerSession(sid);
    const artId = options.registry.resolveOrRegisterArtifact("plan.md", "abc");
    options.registry.acquireExclusive(artId, agentId, 0);
    // Control on the fixture itself: the name the handler must not publish is
    // one the SessionRegistry genuinely knows, so a null below is a redaction
    // and not an unnamed holder.
    assert.equal(options.sessions.agentIdToName(agentId), `claude-session-${sid}`);

    const server = createServer(options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const { status, body } = await statusBody(server, options.secret);
      assert.equal(status, 200);
      const sessions = body.sessions as ReadonlyArray<Record<string, unknown>>;
      assert.ok(Array.isArray(sessions) && sessions.length === 1);
      const s = sessions[0]!;
      assert.equal(s.agent_id, agentId);
      const states = s.states as Record<string, string>;
      assert.deepEqual(states, { "plan.md": "EXCLUSIVE" });

      // The requirement. The field is present and carries no name.
      assert.ok("agent_name" in s, "the agent_name field must stay on the row");
      assert.equal(s.agent_name, null, "the name embeds the raw session id");
      // Not just this field: the identifier must be unreachable anywhere in
      // the body — any key, any value, any nesting depth.
      assert.ok(
        !JSON.stringify(body).includes(sid),
        `the raw session id is still reachable in the body: ${JSON.stringify(body).slice(0, 400)}`,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    cleanup();
  }
});

test("AC-03: INVALID states excluded from per-agent states map (Python parity)", async () => {
  const { options, cleanup } = makeOptions();
  try {
    const sid = "33333333-4444-4333-8333-cccccccccccc";
    const agentId = options.sessions.registerSession(sid);
    const artId = options.registry.resolveOrRegisterArtifact("plan.md", "abc");
    // Acquire then invalidate so the agent appears in the active set
    // with an INVALID state rather than no row at all.
    options.registry.acquireExclusive(artId, agentId, 0);
    options.registry.invalidate(artId, agentId, 1);

    const server = createServer(options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const { body } = await statusBody(server, options.secret);
      const sessions = body.sessions as ReadonlyArray<Record<string, unknown>>;
      // listActiveAgents may or may not include this agent depending on
      // whether INVALID-only counts as "active". Either way: if the agent
      // appears, its states map must be empty (no INVALID entries).
      for (const s of sessions) {
        if (s.agent_id === agentId) {
          assert.deepEqual(
            s.states,
            {},
            "INVALID state must not appear in sessions[].states",
          );
        }
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    cleanup();
  }
});
