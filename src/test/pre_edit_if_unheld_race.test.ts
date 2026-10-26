/**
 * The opted-in pre-edit's check and grant are one decision across processes.
 *
 * One coordinator runs in this process; a child process holds an
 * uncommitted grant on the same state.db (a second coordinator on a
 * workspace exits, so a second registry handle is the second process). The
 * server's decision starts while that grant is uncommitted, so it waits on
 * the lock and must then refuse, naming the child's agent.
 *
 * Verdicts, each with its own failure message:
 * - regression: B admitted over the child's grant;
 * - inconclusive: B got the busy failure (the child overran the busy timeout);
 * - unforced: B answered faster than the grace, so the decision never waited;
 * - harness failure: no marker, no "entered", or the child's wrap never ran.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import { MESIState } from "../states.js";
import { sessionToAgentId } from "../agent_id.js";
import { holdUncommittedGrant } from "./race_holder_fixture.js";
import { killAndWait } from "./pid_lock_fixture.js";

const SECRET = "s".repeat(32);
const SID_A = "44444444-4444-4444-8444-444444444444";
const SID_B = "55555555-5555-4555-8555-555555555555";
const GRACE_MS = 300;
const ROUNDS = 3;

async function waitForFile(path: string, capMs: number): Promise<boolean> {
  const deadline = Date.now() + capMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

test("an opted-in pre-edit that starts while another process's grant is uncommitted is refused, naming it", async () => {
  const root = mkdtempSync(join(tmpdir(), "if-unheld-race-test-"));
  mkdirSync(join(root, ".coherence"), { recursive: true });
  writeFileSync(join(root, ".coherence", "tracked.yaml"), '- "*.md"\n');
  const dbPath = join(root, ".coherence", "state.db");
  const registry = new ArtifactRegistry(dbPath);
  const sessions = new SessionRegistry();
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy: PolicyRef.load(root),
    sessions,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;

  // The server signals "entered" as its decision starts, then decides.
  let entered = "";
  const decide = registry.acquireExclusiveIfUnheld.bind(registry);
  Object.defineProperty(registry, "acquireExclusiveIfUnheld", {
    configurable: true,
    value: (artifactId: string, agentId: string, nowTick: number) => {
      writeFileSync(entered, "");
      return decide(artifactId, agentId, nowTick);
    },
  });

  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      const path = `race-${round}.md`;
      const marker = join(root, `marker-${round}`);
      entered = join(root, `entered-${round}`);
      const holder = holdUncommittedGrant({ dbPath, path, sessionId: SID_A, marker, entered, graceMs: GRACE_MS });
      // A child killed after a failed assertion rejects its report; the failure is reported instead.
      holder.report.catch(() => undefined);
      try {
        assert.ok(await waitForFile(marker, 10_000), `harness failure (round ${round}): no marker from the child`);
        const started = Date.now();
        const res = await fetch(`http://127.0.0.1:${port}/hooks/pre-edit`, {
          method: "POST",
          headers: { Authorization: `Bearer ${SECRET}`, Host: "127.0.0.1", "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: SID_B, path, if_unheld: true }),
        });
        const elapsedMs = Date.now() - started;
        const answer = (await res.json()) as Record<string, unknown>;
        const report = await holder.report;

        assert.ok(report.fired, `harness failure (round ${round}): the child's grant wrap never ran`);
        assert.ok(report.sawEntered, `harness failure (round ${round}): the child never saw "entered"`);
        assert.notEqual(
          answer.reason,
          "internal: SqliteError",
          `inconclusive (round ${round}): the child held the lock past the busy timeout`,
        );
        assert.notEqual(answer.ok, true, `regression (round ${round}): B was admitted over an uncommitted grant`);
        assert.ok(elapsedMs >= GRACE_MS, `unforced (round ${round}): B answered in ${elapsedMs} ms`);

        assert.deepEqual(answer, { ok: false, reason: "other_holder", holder_agent_id: report.agentId });
        const id = registry.getArtifactByName(path)!.id;
        assert.equal(registry.getAgentState(id, sessionToAgentId(SID_A)), MESIState.EXCLUSIVE);
        assert.equal(registry.getAgentState(id, sessionToAgentId(SID_B)), null);
        assert.deepEqual(registry.peekPendingNoticesForAgent(sessionToAgentId(SID_A)), []);
      } finally {
        await killAndWait(holder.child);
      }
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
