/**
 * Reclaim wording in preemption notices: a holder whose grant an opted-in
 * pre-edit reclaimed after 30 minutes reads that, never that another session
 * silently revoked it. A notice queue with no reclaim renders exactly as
 * before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { preemptionNoticeText } from "../hook_payloads.js";
import { drainNoticeText } from "../hooks/_common.js";
import { MAX_HOLD_SEC, RECLAMATION_PREEMPTER_ID } from "../acquire_or_fail.js";

const PEER = "d7f57e87".padEnd(32, "0");
const TS = 1748088000; // 2025-05-24T12:00:00+00:00
const ISO = "2025-05-24T12:00:00+00:00";
const INTRO = /^⚠ (\d+ of your EXCLUSIVE grants|Your EXCLUSIVE grant)/;

function ordinary(path: string, ts = TS) {
  return { artifactPath: path, preempterAgentId: PEER, preempterAgentShort: "d7f57e87", preemptedAtUnixTs: ts };
}

function reclaim(path: string, ts = TS) {
  return {
    artifactPath: path,
    preempterAgentId: RECLAMATION_PREEMPTER_ID,
    preempterAgentShort: "e91bfe9c",
    preemptedAtUnixTs: ts,
  };
}

test("a queue with no reclaim renders exactly as before", () => {
  assert.equal(
    preemptionNoticeText([ordinary("plan.md")]),
    "⚠ Your EXCLUSIVE grant on this artifact was silently revoked by another session:\n" +
      `  • plan.md preempted by agent d7f57e87 at ${ISO}`,
  );
  assert.equal(
    preemptionNoticeText([ordinary("a.md"), ordinary("b.md")]),
    "⚠ 2 of your EXCLUSIVE grants were silently revoked by other sessions:\n" +
      `  • a.md preempted by agent d7f57e87 at ${ISO}\n` +
      `  • b.md preempted by agent d7f57e87 at ${ISO}`,
  );
});

test("a reclaim reads as a reclaim after the hold limit, under a neutral intro", () => {
  const text = preemptionNoticeText([reclaim("plan.md")]);
  const [intro, bullet] = text.split("\n");
  assert.match(intro!, INTRO);
  assert.doesNotMatch(text, /silently|another session|other sessions/);
  assert.ok(bullet!.startsWith("  • plan.md "), bullet);
  assert.ok(bullet!.includes(`${MAX_HOLD_SEC / 60} minutes or more`), bullet);
  assert.ok(bullet!.includes(ISO), bullet);
  assert.ok(bullet!.endsWith("; read the file again before editing it"), bullet);
  assert.doesNotMatch(bullet!, /preempted by agent|restore|retry/);
});

test("a mixed queue gets one neutral intro and one bullet of each kind", () => {
  const text = preemptionNoticeText([reclaim("a.md"), ordinary("b.md")]);
  const lines = text.split("\n");
  assert.equal(lines.filter((l) => INTRO.test(l)).length, 1);
  assert.match(lines[0]!, /^⚠ 2 of your EXCLUSIVE grants/);
  assert.doesNotMatch(lines[0]!, /silently|other sessions/);
  assert.ok(lines[1]!.startsWith("  • a.md ") && lines[1]!.includes("minutes or more"));
  assert.equal(lines[2], `  • b.md preempted by agent d7f57e87 at ${ISO}`);
});

test("a reclaim past the verbatim cap still sets the neutral intro", () => {
  const queue = [
    { artifactId: "a1", preempterAgentId: PEER, preemptedAtUnixTs: TS + 3 },
    { artifactId: "a2", preempterAgentId: PEER, preemptedAtUnixTs: TS + 2 },
    { artifactId: "a3", preempterAgentId: PEER, preemptedAtUnixTs: TS + 1 },
    { artifactId: "a4", preempterAgentId: RECLAMATION_PREEMPTER_ID, preemptedAtUnixTs: TS },
  ];
  const deps = {
    registry: {
      popPendingNoticesForAgent: () => queue,
      getArtifactById: (id: string) => ({ name: `${id}.md` }),
    },
  } as unknown as Parameters<typeof drainNoticeText>[0];

  const text = drainNoticeText(deps, "victim");
  assert.ok(text);
  const lines = text.split("\n");
  assert.match(lines[0]!, /^⚠ 4 of your EXCLUSIVE grants/);
  assert.doesNotMatch(lines[0]!, /silently|other sessions/);
  assert.equal(lines.filter((l) => l.includes("preempted by agent")).length, 3);
  assert.equal(lines.filter((l) => l.includes("minutes or more")).length, 0);
});

test("the admit drain renders a reclaim from the notice row's full preempter id", () => {
  const deps = {
    registry: {
      popPendingNoticesForAgent: () => [
        { artifactId: "a1", preempterAgentId: RECLAMATION_PREEMPTER_ID, preemptedAtUnixTs: TS },
      ],
      getArtifactById: () => ({ name: "plan.md" }),
    },
  } as unknown as Parameters<typeof drainNoticeText>[0];

  const text = drainNoticeText(deps, "victim");
  assert.ok(text);
  assert.doesNotMatch(text, /silently|preempted by agent/);
  assert.ok(text.includes(`  • plan.md `) && text.includes("minutes or more"));
});
