/**
 * The composed `additionalContext` byte budget on an admit path.
 *
 * WHY THIS FILE EXISTS. Python asserts its composed admit payload at
 * `<= 10240` bytes (tests/test_claude_code_coordinator_server.py:1025) — a
 * figure that is itself 240 bytes too generous, see the constant below.
 * Node had no equivalent, and that gap is what let a proposed fix ship a
 * notice-block bound (PR #150) whose COMPOSED payload still measured ~10.5 KB
 * — the bound was on one section, but the ceiling applies to the whole
 * `additionalContext`, and the co-tenants (stale-read or collision warning,
 * deferred re-grounding) are a runtime quantity a per-section constant cannot
 * know. Nothing in this repo would have failed.
 *
 * These tests measure the real thing: a real server, real preemptions over
 * HTTP, and the bytes that actually leave `/hooks/pre-read`. They do not call
 * the renderer directly, because calling the renderer directly is precisely how
 * the composed overrun was missed.
 *
 * Two tests, deliberately different in kind:
 *   1. A GUARD mirroring Python's: a realistic notice count stays under the
 *      ceiling. Passes today; catches a future change that inflates any section.
 *   2. A CHARACTERISATION of the known defect: above ~80 notices the composed
 *      payload EXCEEDS the ceiling, because the admit-path notice render is
 *      unbounded (tracked on Cohexa-ai/agent-coherence-plugin#138). It asserts
 *      the current, broken reality so that the fix cannot land silently: when
 *      the composed payload is bounded, this test FAILS and must be inverted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import { ADMIT_NOTICE_VERBATIM_CAP } from "../hooks/_common.js";
import { sessionToAgentId } from "../agent_id.js";

const SECRET = "s".repeat(32);

/**
 * The ceiling is 10,000, and it is the PLATFORM's, not this repo's.
 *
 * Every hook's `additionalContext` is passed through one function in the
 * Claude Code bundle before it reaches the model:
 *
 *   async function kee(e, r, n, {threshold: s = xJr, storageV5: a} = {}) {
 *     if (e.length <= s) return e;              // under: delivered verbatim
 *     let o = await B$(e, `hook-${r}-${n}`, w_(), a);   // over: to disk
 *     ...
 *   }
 *
 * with `xJr = 1e4`. Both `additionalContext` call sites pass no `threshold`,
 * so the default applies. Over it the prose is persisted to a file and the
 * model receives a 2,000-byte preview plus a path instead of the notice —
 * not a truncation, but not the coherence prose either. (A separate
 * aggregate budget, `oqt = uir * $_e` = 25000 * 4, governs batched dispatch
 * and is not this limit.)
 *
 * Two consequences worth stating, because both were previously guessed:
 *
 *   - The platform compares `e.length`, i.e. UTF-16 code units. These tests
 *     compare UTF-8 BYTES, which for this prose (`⚠`, `•`, `—` are all
 *     multi-byte) is the STRICTER measure. That is deliberate: erring tight
 *     is safe, erring loose is not.
 *   - 10,240 is 10 KiB where the platform means 10,000. An earlier revision
 *     of this comment rationalised the 10,240/10,000 split as a principled
 *     difference between the admit and session-start surfaces. There is no
 *     such difference — both surfaces go through `kee` with the same default.
 *     `src/test/session_start.test.ts:336`, `:583` already assert the right
 *     number; this file was the outlier, and Python's `<= 10240` still is.
 */
const COMPOSED_CONTEXT_CEILING_BYTES = 10_000;

/**
 * A rendered preemption BULLET, excluding the coalescing line that closes the
 * list. Both now start with "  • " — Python bullets its overflow line too —
 * so a prefix-only filter counts the coalescing line as a notice and reports
 * cap+1. Discriminate on content.
 */
const isNoticeBullet = (l: string): boolean =>
  l.startsWith("  • ") && !l.includes("more preemptions since your last activity");

async function makeServer() {
  const tmp = mkdtempSync(join(tmpdir(), "composed-ctx-"));
  const registry = new ArtifactRegistry(join(tmp, ".coherence", "state.db"));
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy: PolicyRef.load(tmp),
    sessions: new SessionRegistry(),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        Host: "127.0.0.1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  };
  const cleanup = () =>
    new Promise<void>((r) => {
      server.close(() => {
        registry.close();
        rmSync(tmp, { recursive: true, force: true });
        r();
      });
    });
  return { post, cleanup };
}

/**
 * Drive N real preemptions against one victim, then read the composed
 * `additionalContext` its next pre-read carries. Mirrors the shape of
 * Python's test: the victim takes a grant on each path, a distinct attacker
 * preempts each one, and the victim's next hook drains every notice at once.
 */
async function composedContextAfterPreemptions(
  n: number,
  pathLen: number,
): Promise<{
  text: string;
  bullets: string[];
  post: (path: string, body: unknown) => Promise<Record<string, unknown>>;
  cleanup: () => Promise<void>;
  victim: string;
  paths: string[];
}> {
  const { post, cleanup } = await makeServer();
  // Ownership of the server transfers to the caller ONLY on success. On a
  // throw the caller never receives a handle, so cleanup has to happen here
  // or a failed assertion leaves a listening socket and hangs the runner
  // instead of reporting the failure.
  try {
    const pad = Math.max(1, pathLen - 14);
    // `docs/plans/**/*.md` is in DEFAULT_TRACKED_PATTERNS, so no policy call.
    const paths = Array.from({ length: n }, (_, i) => `docs/plans/${String(i).padStart(pad, "x")}.md`);
    const victim = "11111111-1111-4111-8111-111111111111";
    for (const p of paths) await post("/hooks/pre-edit", { session_id: victim, path: p });
    for (let i = 0; i < n; i++) {
      const attacker = `2222${String(i).padStart(4, "0")}-2222-4222-8222-222222222222`;
      await post("/hooks/pre-edit", { session_id: attacker, path: paths[i] });
    }
    // Arm deferred re-grounding through the REAL session-start endpoint, so the
    // measured payload carries all three co-tenants rather than two. This is
    // not decoration: re-grounding was the LARGEST co-tenant in the overrun
    // that motivated this file, and a fixture without it measures the section
    // least likely to cause the problem. Mirrors `armReground` in
    // src/test/deferred_reground_unit8.test.ts.
    await post("/hooks/session-start", { session_id: victim });

    const body = await post("/hooks/pre-read", { session_id: victim, path: paths[0] });
    const hso = body["hookSpecificOutput"] as { additionalContext?: string } | undefined;
    assert.ok(hso?.additionalContext, "a preempted victim's pre-read must carry additionalContext");
    const text = hso.additionalContext;

    // Every assertion below depends on the fixture having actually preempted.
    // A silent setup failure yields a small payload, which would make the
    // guard pass vacuously and the overrun test fail for the wrong reason —
    // so prove the three sections are present before measuring anything.
    assert.match(text, /Post-compaction re-grounding/, "re-grounding co-tenant missing from the fixture");
    assert.match(text, /⚠ Stale read/, "stale-read co-tenant missing from the fixture");
    // Bullets in the ADMIT block only. The composed payload carries TWO
    // notice blocks: this drain's, and the one inside the deferred
    // re-grounding section — `claimRegroundContext` rebuilds that prose at
    // attach time, so it PEEKS whatever the drain just left behind and
    // renders up to its own cap of those. Counting every "  • " line in the
    // payload therefore counts both, and would read a correctly-capped drain
    // as double its size. Sections are separated by a blank line and the
    // drain is first.
    // EXACTLY ONE revocation intro per payload. The deferred re-grounding
    // block is rebuilt at attach time and peeks whatever this drain left, so
    // without a guard it renders a SECOND notice block whose intro reports the
    // REMAINING count as though that were the number of grants revoked —
    // handing the model two different totals for one backlog, and rendering
    // rows the first block just promised for "next time".
    const intros = text
      .split("\n")
      .filter((l) => /^⚠ (\d+ of your EXCLUSIVE grants|Your EXCLUSIVE grant)/.test(l));
    assert.equal(
      intros.length,
      1,
      `expected exactly one revocation intro in the composed payload; got ${intros.length}:\n${intros.join("\n")}`,
    );

    const admitSection = text.split("\n\n")[0] ?? "";
    assert.match(admitSection, /EXCLUSIVE grants|EXCLUSIVE grant on this artifact/, "the first section must be the admit drain's notice block");
    const bullets = admitSection.split("\n").filter(isNoticeBullet);
    // The bound is on the CONSUME, so the response renders at most the cap
    // however many are pending. Asserting the exact expected number (rather
    // than `<= cap`) is what makes a renderer that quietly drops one visible.
    assert.equal(
      bullets.length,
      Math.min(n, ADMIT_NOTICE_VERBATIM_CAP),
      `expected ${Math.min(n, ADMIT_NOTICE_VERBATIM_CAP)} notice bullets, got ${bullets.length}`,
    );
    return { text, bullets, post, cleanup, victim, paths };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

test("composed additionalContext: a realistic preemption load stays under the ceiling", async () => {
  // Python's own fixture size. The bound now makes this structural rather
  // than lucky: the notice block is three bullets plus a coalescing line
  // whatever the pile-up, so what this still guards is the OTHER sections —
  // the stale warning and re-grounding — growing enough to threaten the
  // composed ceiling.
  const h = await composedContextAfterPreemptions(20, 60);
  try {
    const bytes = Buffer.byteLength(h.text, "utf8");
    assert.ok(
      bytes <= COMPOSED_CONTEXT_CEILING_BYTES,
      `composed additionalContext should fit the ${COMPOSED_CONTEXT_CEILING_BYTES}-byte ceiling; got ${bytes}`,
    );
    // The intro must report what the operator HAS, not how many bullets fit.
    // "3 of your grants were revoked" when 20 were is a wrong number in their
    // face, and the overflow line below cannot unsay it.
    assert.match(h.text, /⚠ 20 of your EXCLUSIVE grants were silently revoked/);
    // Bulleted, like every sibling line in the block, and like Python's
    // counterpart (coordinator_server.py `_build_preemption_text`). Anchored
    // at line start: an unanchored match is satisfied by the unbulleted
    // orphan this assertion exists to forbid.
    assert.match(
      h.text,
      /^ {2}• Plus 17 more preemptions since your last activity, still queued/m,
      "the coalescing line must be a bullet in the list it closes",
    );
    // bullets + coalesced === total. Reporting the RENDERED count as the
    // OMITTED count survives every other assertion in this file.
    assert.equal(h.bullets.length + 17, 20);
  } finally {
    await h.cleanup();
  }
});

test("BOUNDED (#138): a pile-up that used to blow the ceiling now fits, with an honest count", async () => {
  // This test asserted the DEFECT until the admit-path drain was bounded: 80
  // notices rendered ~11.0 KB against a 10,000-byte ceiling. It is inverted
  // here rather than deleted, because the inversion IS the evidence that the
  // bound landed — a fix that quietly stopped short would leave the old
  // assertion failing and this one unwritten.
  const h = await composedContextAfterPreemptions(80, 60);
  try {
    const bytes = Buffer.byteLength(h.text, "utf8");
    assert.ok(
      bytes <= COMPOSED_CONTEXT_CEILING_BYTES,
      `the bounded drain must fit the ${COMPOSED_CONTEXT_CEILING_BYTES}-byte ceiling; got ${bytes}`,
    );
    assert.match(h.text, /⚠ 80 of your EXCLUSIVE grants were silently revoked/);
    assert.match(h.text, /Plus 77 more preemptions since your last activity, still queued/);
    // Whole bullets, never a mangled one: a bound that drops WHOLE notices is
    // distinguishable from a platform that truncates at a byte offset.
    // R7 moved the identity this names from the preempter's SESSION id to its
    // agent id, so the old `2222dddd` pin no longer matches anything. Keeping
    // only a shape check would have made this an "it printed something"
    // assertion, so the attacker agent ids are derived here and the bullet has
    // to name one of them -- and the raw session prefix has to be absent.
    const attackerAgentPrefixes = new Set(
      Array.from({ length: 80 }, (_, i) =>
        sessionToAgentId(`2222${String(i).padStart(4, "0")}-2222-4222-8222-222222222222`).slice(0, 8),
      ),
    );
    const lastBullet = h.bullets[h.bullets.length - 1] ?? "";
    const named =
      /^ {2}• docs\/plans\/[x0-9]+\.md preempted by agent ([0-9a-f]{8}) at \d{4}-\d{2}-\d{2}T[0-9:.+-]+$/.exec(
        lastBullet,
      );
    assert.ok(named, `expected a whole, well-formed bullet; got: ${lastBullet}`);
    assert.ok(
      attackerAgentPrefixes.has(named[1]),
      `the bullet named ${named[1]}, which is no attacker's agent id; got: ${lastBullet}`,
    );
    assert.doesNotMatch(lastBullet, /2222\d{4}/);
  } finally {
    await h.cleanup();
  }
});

test('the coalesced tail is DEFERRED, not destroyed — "still queued" is a true sentence', async () => {
  // The single property that separates this bound from the one PR #150 tried.
  // That one capped the RENDER after the pop had already deleted every row,
  // so the notices it declined to show were gone, while the prose promised
  // they would surface later. Here the consume is what is bounded, so the
  // tail is still in the table and the next admit hook really does show it.
  const h = await composedContextAfterPreemptions(10, 60);
  try {
    assert.match(h.text, /Plus 7 more preemptions/);

    const seen = new Set(h.bullets.map((b) => b.split(" preempted")[0]));
    // Drive the victim's next tracked-file admit and collect the next batch.
    for (let round = 0; round < 3; round++) {
      const body = await h.post("/hooks/pre-read", { session_id: h.victim, path: h.paths[0] });
      const hso = body["hookSpecificOutput"] as { additionalContext?: string } | undefined;
      const more = (hso?.additionalContext ?? "").split("\n").filter(isNoticeBullet);
      for (const b of more) seen.add(b.split(" preempted")[0]);
    }
    assert.equal(
      seen.size,
      10,
      `every deferred notice must eventually surface; saw ${seen.size} distinct of 10`,
    );
  } finally {
    await h.cleanup();
  }
});

test("the bound makes the payload independent of the notice COUNT", async () => {
  // The sharpest statement that the drain is bounded: a ten-fold difference
  // in pending notices must not move the composed size. Pre-bound these were
  // 2.1 KB and 11.0 KB; the second breached the ceiling.
  // Each acquisition gets its own finally. Taking both before the try leaks
  // the first when the SECOND throws — and the second throwing is exactly
  // what happens when this test is doing its job and catching a cap
  // regression, so the leak fires on the run someone is reading CI output
  // for. `node --test` waits on open handles, turning that assertion failure
  // into a hang.
  const few = await composedContextAfterPreemptions(8, 60);
  try {
    const many = await composedContextAfterPreemptions(80, 60);
    try {
      const a = Buffer.byteLength(few.text, "utf8");
      const b = Buffer.byteLength(many.text, "utf8");
      // Not equal: the intro and overflow counts are wider at 80 ("80"/"77"
      // vs "8"/"5"), which is the only legitimate difference.
      assert.ok(
        Math.abs(a - b) < 200,
        `10x the notices must not move the payload; got ${a} at n=8 and ${b} at n=80`,
      );
      assert.ok(b <= COMPOSED_CONTEXT_CEILING_BYTES);
    } finally {
      await many.cleanup();
    }
  } finally {
    await few.cleanup();
  }
});

test("the bound holds at the longest path the policy admits", async () => {
  // The second axis. A COUNT bound does not obviously bound BYTES: every
  // bullet carries a path, so the payload scales with path length even when
  // every section is pinned at three lines. What makes the count bound
  // sufficient is that path length is itself bounded — MAX_POLICY_PATH_LEN is
  // 1024 (src/policy.ts) — and at that bound the composed payload still fits.
  //
  // This test asserted the opposite until the deferred re-grounding block
  // stopped rendering its own notice section: notice bullets used to render
  // TWICE in one payload, which cost 10,216 bytes at an 800-character path.
  // With one block it is 7,429 at the same length, and 9,029 at 1000.
  // Measured post-fix at n=8: 1,509 B at 60 chars, 2,629 at 200, 4,229 at
  // 400, 7,429 at 800, 9,189 at 1020.
  const h = await composedContextAfterPreemptions(8, 1000);
  try {
    const bytes = Buffer.byteLength(h.text, "utf8");
    assert.ok(
      bytes <= COMPOSED_CONTEXT_CEILING_BYTES,
      `even at near-maximum path length the bounded payload must fit; got ${bytes}`,
    );
  } finally {
    await h.cleanup();
  }
});

test("a realistic large workspace fits with room to spare", async () => {
  // The case the bound exists for: many notices, long-but-real paths.
  const h = await composedContextAfterPreemptions(80, 200);
  try {
    const bytes = Buffer.byteLength(h.text, "utf8");
    assert.ok(
      bytes <= COMPOSED_CONTEXT_CEILING_BYTES,
      `a large workspace must fit the ceiling; got ${bytes}`,
    );
    assert.match(h.text, /⚠ 80 of your EXCLUSIVE grants were silently revoked/);
  } finally {
    await h.cleanup();
  }
});
