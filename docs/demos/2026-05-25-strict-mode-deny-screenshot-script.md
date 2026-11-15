# Strict-mode `permissionDecision: "deny"` screenshot script

**Goal**: Single static screenshot for the `agent-coherence.dev/plugin/` landing page that shows v0.2's headline feature — `permissionDecision: "deny"` on a stale read — from the model's perspective. Complements the four warn-mode screenshots already in the "What it looks like in a session" section. The site already documents v0.2 in prose but has zero visual representation of strict mode; this fills that gap.

**Verified-on**: claude CLI v2.1.131+, agent-coherence-plugin v0.2.0, library `agent-coherence>=0.9.0`.

**Capture time measured 2026-05-25**: ~5 min prep + ~30s actual model run + ~1 min screenshot crop = ~7 min end-to-end.

**Sibling doc**: `docs/demos/2026-05-17-stale-read-demo-script.md` (v0.1.1 warn-mode screencast). Use the same workspace setup pattern verbatim — only the `.coherence/strict_mode.yaml` step + the expected outcome differ.

---

## Setup (5 min, NOT in the screenshot)

```bash
# 1. Fresh disposable workspace
SCREEN=$(mktemp -d)
cd "$SCREEN"
git init -q
mkdir -p docs/plans

# 2. Seed a plan.md the screenshot will reference
cat > docs/plans/feature-x.md <<'EOF'
# Feature X plan (v4 — UPDATED 2026-05)
Steps:
  1. Add database migration
  2. Add API endpoint
  3. Add tests
  4. Wire feature flag
  5. Ship behind flag (rollout cohort: 10% → 100% over 1 week)
EOF

# 3. Spawn coordinator + track the artifact
agent-coherence-coordinator --quiet &
sleep 2
agent-coherence-track docs/plans/feature-x.md

# 4. Opt the tracked path into strict mode — THIS IS THE v0.2 DELTA
mkdir -p .coherence
cat > .coherence/strict_mode.yaml <<'EOF'
- "docs/plans/**/*.md"
EOF

# 5. Pre-seed coordinator state so the agent's first Read sees a stale
#    version + matches a strict-mode pattern (deny path fires immediately)
python3 -c "
import sqlite3, uuid, time
db = '$SCREEN/.coherence/state.db'
c = sqlite3.connect(db, isolation_level=None)
c.execute('BEGIN IMMEDIATE')
c.execute('INSERT OR REPLACE INTO artifacts (id,name,version,content_hash,size_tokens,last_writer_id,updated_at) VALUES (?,?,?,?,NULL,?,?)',
  (uuid.uuid4().hex, 'docs/plans/feature-x.md', 3, 'f'*64, uuid.uuid4().hex, time.time()))
c.execute('COMMIT')
"

# 6. Trigger the policy reload so strict_mode.yaml is live before claude runs
agent-coherence-track docs/plans/feature-x.md  # idempotent — reloads policy
```

## Capture (~30s — invoke claude, screenshot when the deny fires)

```bash
# Use --include-hook-events + stream-json so the deny envelope is visible
# in the transcript. The model will receive the deny and surface it.
claude --include-hook-events \
       --output-format stream-json \
       --print \
       --permission-mode bypassPermissions \
       --model sonnet \
       'Read docs/plans/feature-x.md and summarize the implementation steps it lists.'
```

**What to capture**: the model's response after the Read denial. The model should:

1. Issue a `Read` tool call for `docs/plans/feature-x.md`
2. Receive `permissionDecision: "deny"` with the canonical reason text
3. Surface the denial in its assistant message (per KTD-P, bounded-retry — the model exits the retry loop after the deny, no looping)

**Expected transcript shape** (text fallback if screenshot fails to load):

```
[user] Read docs/plans/feature-x.md and summarize the implementation steps it lists.

[assistant] I'll read docs/plans/feature-x.md to summarize the steps.

[tool_use: Read] {"file_path": "docs/plans/feature-x.md"}

[hook_response: PreToolUse:Read]
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Stale read denied: docs/plans/feature-x.md
       on disk does not match v3, the last version committed through the
       coordinator, and no session committed the change, so it was made
       outside the coordinator. Do not restore or overwrite
       docs/plans/feature-x.md: the change may be your user's work. Tell
       your user that docs/plans/feature-x.md changed outside the
       coordinator; the read stays denied until the change is committed
       through the coordinator. This denial is structural (v0.2 strict
       mode); retrying the same operation will produce the same denial."
  }
}

[assistant] I can't proceed — docs/plans/feature-x.md on disk doesn't match
the version the coordinator recorded, and the workspace has opted this path
into strict mode via `.coherence/strict_mode.yaml`. The PreToolUse:Read hook
returned `permissionDecision: "deny"` rather than the v0.1.1 warn-mode
advisory. Re-running the Read won't help — the denial is structural. The
change was made outside the coordinator, so I won't restore or overwrite
it; please confirm the file's current content is intended, or commit it
through the coordinator, before I summarize the plan.
```

The setup above gives the agent a session that never read the file, reading
bytes the coordinator never recorded, so the deny is the out-of-band text
([Cohexa-ai/agent-coherence#514](https://github.com/Cohexa-ai/agent-coherence/issues/514)).
A session whose own copy went stale after a peer's commit gets
`Stale read denied: <path> was updated by agent <id> at <time>. Read <path> again with the Read tool: the next Read returns the current version, and edits of <path> are denied until you have read it.`,
and its next Read of the file is allowed. Before #514 this setup showed the
peer-commit text, with a sentence saying that a retry gets the same denial.

## Crop guidance

- Capture the last assistant message + the immediately-preceding `permissionDecision: "deny"` envelope. ~6-10 visible lines is the sweet spot for the landing-page card.
- Keep the `"permissionDecision": "deny"` line visible — that's the load-bearing visual contrast vs the warn-mode screenshots' `"additionalContext": "..."` line.
- Match the existing screenshots' background + monospace font (terminal dark theme — already established style on the page).

## Landing-page placement + caption

**Placement**: insert as screenshot #4, between the existing warn-mode screenshot #3 ("PreToolUse:Read with stale warning in additionalContext") and the existing screenshot #4 ("assistant acknowledging divergence before acting"). The current order is implicitly warn-mode-only; adding the strict-mode shot mid-sequence makes the warn → strict progression explicit.

**Caption** (matches the section's existing 1-sentence narrative tone):

> With strict mode opted in via `.coherence/strict_mode.yaml`, the same stale read returns `permissionDecision: "deny"` instead of an advisory — the model surfaces the denial verbatim and stops rather than acting on stale content. Strict mode is per-artifact opt-in; warn mode (above) remains the default.

## Suggested section reorder (optional, larger edit)

If you're refreshing the section anyway, the current implicit narrative is mixed-mode. A cleaner v0.2 sequence:

| # | Screenshot | Mode | Asserts |
|---|---|---|---|
| 1 | Two sessions accessing the same plan | Setup | The collision scenario |
| 2 | Claude invocation with hook events visible | Setup | The hook surface fires |
| 3 | `additionalContext` warning in `PreToolUse:Read` | **Warn (default)** | Default behavior — context-injection only |
| 4 | Assistant acknowledging divergence + re-reading | **Warn** | Default outcome — model self-corrects |
| 5 | **NEW**: `permissionDecision: "deny"` envelope | **Strict (opt-in)** | Opt-in behavior — hard denial |
| 6 | **NEW**: Assistant surfacing the deny + stopping | **Strict** | Opt-in outcome — model halts rather than retrying |

Screenshot 6 is optional — screenshots 4 and 6 both show "assistant correctly handles the divergence." If page weight matters, screenshot 5 alone (the deny envelope) is sufficient because the page's prose already describes the assistant's response.

## Cleanup

```bash
# Stop the coordinator + remove the disposable workspace
pkill -f agent-coherence-coordinator
rm -rf "$SCREEN"
```

## Why this screenshot exists (rationale for the landing-page edit)

Audit performed 2026-05-25 against the live page found the "What it looks like in a session" section accurately depicts v0.2's default (warn) behavior but has zero visual representation of v0.2's headline feature (strict mode). Cutting the section was considered and rejected: the section is the only visual proof of the mechanism on the entire page, and removing it would push readers from "shows me what this does" to "describes what this does in prose." Adding one strict-mode screenshot preserves the credibility signal while closing the v0.2 visual gap. See PR conversation for the full audit.
