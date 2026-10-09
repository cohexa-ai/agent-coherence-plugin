# agent-coherence (Claude Code plugin)

[![CI](https://github.com/Cohexa-ai/agent-coherence-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/Cohexa-ai/agent-coherence-plugin/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Cohexa-ai/agent-coherence-plugin)](https://github.com/Cohexa-ai/agent-coherence-plugin/releases)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Library](https://img.shields.io/pypi/v/agent-coherence?label=agent-coherence)](https://pypi.org/project/agent-coherence/)

**Coherence for the prose subset of project rules that can't be expressed as policy.**

CLAUDE.md is your project's prose contract — what to track, what to escalate, what to never touch. Most of those rules can't be expressed as `permissions.deny` or `.claude/settings.json` because they're about *state*, not *tools*: "this spec is now v3, your branch is editing v1", "the planner reorganized the auth section while you weren't looking", "session B just committed a change to the file you're about to write." `agent-coherence` is the runtime layer that makes those state changes visible across parallel Claude Code sessions sharing the same workspace.

## Philosophy

**Worktrees prevent file collisions, not stale-spec collisions.** Two parallel Claude Code sessions can both read `plan.md` at v1, work independently in their per-session worktrees, and produce pull requests that reflect incompatible interpretations of v1 — even though the planner published v2 hours ago. The git surface stays clean; the model's understanding goes stale silently.

`agent-coherence` exists because that failure shape is structural — CLAUDE.md tool restrictions don't propagate to subagents, context compaction weakens rule adherence, and multi-session coordination has no platform-level synchronization primitive. Anthropic has confirmed this twice on the record: the official position is that **[hooks are the deterministic-behavior seam](#how-it-works)**, and CLAUDE.md / `.claudeignore` are guidance, not constraints. This plugin lives in that seam.

The design bias: surface stale state to the agent itself via `additionalContext`, let the agent decide. The agent reads the warning alongside the file and almost always re-reads before acting. The 2026-05-18 launch gate measured **100% re-read-or-acknowledged rate across N=80 trials**, zero ignored.

## What it does

Watches tracked artifacts (CLAUDE.md, AGENTS.md, `DECISIONS.md`, `docs/specs/`, `docs/plans/`, `docs/brainstorms/`, `plan.md` / `task.md` / `spec.md`) across:

- Agent View ✓
- Multi-terminal (multiple `claude` processes in the same workspace) ✓
- Task-tool subagents (each subagent is a first-class coherence peer via a composite `(session_id, agent_id)` identity — sibling subagents editing the same artifact collide, and a subagent's write is attributed to the subagent, not the parent; see [Subagents and composite identity](#subagents-and-composite-identity)) ✓

Verified against `claude` v2.1.131 (2026-05-17 via internal Phase E.0 probe). The `claude agents` subcommand on v2.1.131 is a management UI, not a session spawner — out of coverage scope.

When one session is about to act on an artifact another session has updated, the plugin injects a warning into the agent's own context via `additionalContext`. The warning's stale-read line looks like this:

> ⚠ Stale read [warning emitted `2026-05-23T13:42:19.114000+00:00`]: `docs/plans/feature-x.md` was updated by agent `90b1dfd3` at `2026-05-23T13:42:18.402000+00:00`. Current version is v2; you previously saw v1. … Consider re-reading `docs/plans/feature-x.md` before acting on stale assumptions.

On the Python backend with `agent-coherence` 0.14.1 or earlier, the line reads `was updated by session` instead of `was updated by agent`.

When Claude Code **compacts** a session (auto-compaction or manual `/compact`), the model's summary can silently drop what the session held and what peers changed around the boundary. The plugin re-grounds the compacted session: a second `SessionStart` hook fires on `source=compact` and the coordinator emits a bounded payload — the grants the session held at compaction (event-anchored: "At compaction you held EXCLUSIVE on `plan.md` (v7) — re-acquire before writing.") and, for every artifact the session touched, the current coordinated version with a stale flag when a peer advanced it past the session's last-observed version. The payload reaches the model at the next user message (and on `--resume`); a live autonomous tool loop additionally receives it on its next tool admit. Delivery is at-most-once per path — one benign duplicate can occur (the mid-loop delivery followed by the next user turn's render), and the payload's closing line ("a more recent read supersedes this notice") makes a second sighting harmless. Sessions with no coordination state get nothing.

For tool-class rules that *can* be expressed as policy ("use rg, not grep"; "never sudo"; "no python -c"), run `agent-coherence-migrate-rules` or the stricter `agent-coherence-migrate-deny` — they propose `permissions.deny` entries derived from prose in CLAUDE.md. `permissions.deny` is structurally stronger than runtime hook denies: the runtime enforces it before the model can choose which tool to invoke.

**Validation signal:** [anthropics/claude-code#59309](https://github.com/anthropics/claude-code/issues/59309) (filed 2026-05-13) plus three documented duplicates (#40459, #19471, #29423) confirm the failure shape across 6 months. Anthropic's position is "use hooks" — that's exactly what this plugin does.

## Quick example

A typical cycle takes about 30 seconds. Set up the plugin in a workspace, then watch the agent re-read after a peer commit:

```text
# Terminal 1 (session A)
claude
> Read docs/plans/feature-x.md and summarize the steps.

# Terminal 2 (session B, same workspace)
claude
> Edit docs/plans/feature-x.md to add a "v2: dual-write migration" step at the top.
> (B's session commits the edit; coordinator invalidates A's cached view)

# Back to Terminal 1 (session A)
> Now implement the first step you summarized earlier.

# Agent A receives a stale-read warning in its own context:
#   ⚠ Stale read [warning emitted <ts>]: docs/plans/feature-x.md was updated by <B> at <ts>. …
#   Consider re-reading docs/plans/feature-x.md before acting on stale assumptions.
# Agent A re-reads the file first, sees the new v2 step, and revises its plan.
```

To watch the warning fire live (it's invisible by default — it goes into the agent's context, not your terminal):

```bash
claude --include-hook-events --output-format stream-json "Read docs/plans/feature-x.md"
```

## Commands

The plugin itself ships **three slash commands** (in `commands/`). These are the only surfaces the plugin exposes directly — they appear the moment you `/plugin install`:

| Plugin slash command | What it does | When to use |
|---|---|---|
| `/agent-coherence:status` | Show tracked artifacts, current versions, sessions × MESI state | Daily sanity check; pre-commit verification |
| `/agent-coherence:track <path>` | Add a path to the coordinator's tracked set | When the operator wants stale-read coverage on a new file |
| `/agent-coherence:untrack <path>` | Remove a path from coordination | When the operator wants to silence warnings on intentionally-divergent files |

Everything below is a **library console script** installed by `pip install "agent-coherence>=0.8.0"` (next section) — *not* shipped by the plugin. The three slash commands above shell out to them, and you can also call them directly:

| Library console script | What it does | When to use |
|---|---|---|
| `agent-coherence-coordinator` | Spawn / inspect the lazy-spawned local HTTP coordinator | Manual recovery; `--prepare-for-migration` drains and stops a running Python coordinator (it does not convert the store to the other backend) |
| `agent-coherence-status` | CLI form of `/agent-coherence:status`. With no `--detail`, or with `--detail minimal`, which the slash command passes so that the Python console script fallback prints the same view, it prints the default tier: no session names and no absolute paths. `--detail metrics` works on both backends. `--detail full` sends the `Coherence-Local-Operator: true` opt-in header and returns the operator-tier fields, including, with `agent-coherence` releases after 0.14.1, which paths the crash-recovery sweep reclaimed from each session; it works against the Python coordinator only (the plugin's built-in Node coordinator answers 501 for it). **`--self-test` is Python-only** | Dashboard scraping (`--detail metrics`); seeing which grants the sweep reclaimed (`--detail full`, Python backend); post-install validation (`--self-test`, Python backend) |
| `agent-coherence-hook-client` | Subprocess called by the plugin's command-type hooks | Internal — not for direct invocation |
| `agent-coherence-migrate-rules` | Scan CLAUDE.md for prose tool-class rules; propose + optionally `--apply` `permissions.deny` entries | First-pass migration of `"use rg, not grep"`-style rules to enforceable policy |
| `agent-coherence-migrate-deny` *(library v0.8.2+)* | Stricter sibling: STDOUT-only, symlink-contained, never invokes an LLM, never writes settings.json | Security-sensitive workspaces; CI-driven migration where auto-apply is not acceptable |

To bridge the two, the plugin ships PATH-resolver shims at `bin/agent-coherence-{status,track,untrack,migrate-deny}`. The CLI shims prefer the plugin's Node CLI (`dist/cli_*.js` — from the package itself in a built dev checkout, otherwise from the copy provisioned into the plugin data dir at `SessionStart`; marketplace installs ship no prebuilt `dist/`) and fall back to probing for the Python binary (PATH first, then `<cwd>/.venv/bin/`, then `<git-root>/.venv/bin/`) before an actionable error — so the slash commands work whether or not the operator activated the project venv before launching `claude`, including Claude UI / remote-control sessions that inherit a system shell env without venv activation. Two more shims handle dispatch: `bin/ensure-coordinator-dispatch` is the backend-aware `SessionStart` bootstrap (selects the Node or Python coordinator), and `bin/hook-client` is the universal per-hook shim (Node client preferred, Python client fallback, `{}` fail-open floor).

## Getting started

After install (next section), the post-install validation step:

```bash
agent-coherence-status --self-test
```

Runs a four-step pre-read → pre-edit → post-edit → stale-pre-read sequence against a live coordinator. Exit 0 on pass; non-zero with an actionable diagnostic on fail.

> **`--self-test` requires the Python backend** (it ships in the `agent-coherence` library). The bundled Node CLI does not implement it and, as of v0.3.1, **rejects the flag with exit 2** rather than silently printing ordinary status — before v0.3.1 it exited 0, which looked like a passing self-test that never ran. On a default (Node) workspace, verify the install instead by opening two sessions per [Quick example](#quick-example), or by running `agent-coherence-status` and confirming the coordinator answers.

First-time experience: on your first Read of a tracked file in a workspace, you'll see no behavior change — the coordinator records the artifact in SQLite and grants your session a SHARED MESI state. The plugin only surfaces warnings when a *peer* session commits a change you haven't seen yet. Easiest way to test end-to-end: open two terminals in the same repo (sections [Quick example](#quick-example) above).

## Install

### Claude Code

```text
/plugin marketplace add Cohexa-ai/agent-coherence-plugin
/plugin install agent-coherence@agent-coherence
```

The marketplace add resolves to the latest published release. To pin a specific version: `/plugin marketplace add Cohexa-ai/agent-coherence-plugin@v0.3.1`.

**Two backends. As of v0.4.0, a fresh install needs neither step below** — a new workspace defaults to the **Node backend**, which self-provisions on first session (no `pip install`, no manual config). The paths below are for the Python backend or for an explicit choice.

**A. Python backend (richest feature set; the default for workspaces created before this change).** Install the library that provides the coordinator + hook client:

```bash
pip install "agent-coherence>=0.8.0"

# Verify the required console scripts landed on PATH
command -v agent-coherence-coordinator
command -v agent-coherence-hook-client
```

**B. Node backend (zero-Python — the default for fresh workspaces).** The plugin's Node coordinator — built from the packaged `src/` into the plugin data dir on first session (marketplace installs ship no prebuilt `dist/`) — runs all six hooks, the track/untrack/status CLIs, and strict mode with **no Python required** (needs **Node 22, 24, or 25** — the majors where `better-sqlite3` ships prebuilts). A fresh workspace selects this automatically. An existing workspace whose `.coherence/state.db` the Python coordinator created cannot move to Node: the Node coordinator fails closed on that store, and no tool converts one. To choose Node explicitly for a workspace that has no store yet:

```bash
mkdir -p .coherence && printf 'node\n' > .coherence/coordinator_backend
```

See [§ Coordinator backends](#architecture) for the selection rules and the one remaining Python-only helper (`agent-coherence-migrate-deny`). Both backends speak the same **hook** wire contract — the decision envelope every hook returns is pinned byte-for-byte against Python by the library's `protocol_corpus` fixtures (against `agent-coherence` releases after 0.14.1; see the Library compatibility note below). The diagnostic endpoints (`GET /status`, `GET /health`) and preemption-notice prose are **not** converged; see [§ Known limitations](#known-limitations).

After install, restart any running `claude` sessions in your workspace so the new `SessionStart` hook fires.

> **Library compatibility.** `agent-coherence>=0.8.0` is the first stable PyPI
> release that ships `agent-coherence-coordinator` and `agent-coherence-hook-client`
> (the earlier `0.7.x` line was the LangGraph/CrewAI/AutoGen drop-in only). v0.2
> strict mode requires `agent-coherence>=0.8.2`; warn-mode (the
> default) works against `>=0.8.0`. Compaction-aware re-grounding on the
> Python backend requires `agent-coherence>=0.14.0` — on an older library the
> `SessionStart` hook fails open and the feature is simply absent (every other
> behavior is unchanged). The bundled Node backend ships it natively. The Python
> backend's stale-read line and strict-mode deny text match the Node backend's only
> from `agent-coherence>0.14.1`; 0.14.1 and earlier word them differently, for
> example naming the writer by session rather than by agent id. Release page:
> [Cohexa-ai/agent-coherence](https://github.com/Cohexa-ai/agent-coherence/releases).

### Other targets (Cursor, Codex, Copilot, etc.)

**Not supported yet.** The plugin's hook surface is Claude-Code-specific (`PreToolUse` / `PostToolUse` / `SessionStart` / `Stop` / `SubagentStop` hook taxonomy from `hooks.json`). Multi-target support is tracked for v0.3 behind a converter-layer plan modeled on [EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin)'s `@every-env/compound-plugin` shape but adapted to the hook-coordinator architecture.

### Scope

- macOS / Linux / WSL2 — native Windows deferred (`fcntl` constraint, see [Known limitations](#known-limitations) below).
- Single workspace, single-user, single-host workstation — not for shared developer machines, CI runners with multiple developers, or cross-host coordination. Cross-machine and cross-vendor coverage is the hosted MCP roadmap (Path B), not this plugin.

## Strict mode

By default, the plugin is **warn-only** — when a peer session has invalidated a tracked artifact, the agent receives a warning via `additionalContext` and decides whether to re-read. v0.1.1's measured 100% re-read-or-acknowledged rate (N=80) means warn mode is sufficient for most workspaces.

For operators who want a hard guardrail (typically: CI / multi-developer setups where the cost of a silent stale-edit is high), v0.2 ships **strict mode**: per-artifact opt-in via `.coherence/strict_mode.yaml` that flips `permissionDecision: "deny"` on stale-read attempts.

```yaml
# .coherence/strict_mode.yaml — same shape as tracked.yaml + ignored.yaml
- CLAUDE.md
- docs/plans/feature-x.md
- "docs/specs/**/*.md"
```

What happens when a strict + tracked artifact is read stale:

- The PreToolUse hook returns `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "Stale read denied: ..."}}`.
- The model receives the deny + a static reason text. Per Phase 0 H1 falsification, the reason is byte-identical across retries (varied text actually *worsens* opus, which reads it as a prompt-injection pattern).
- The model exits its bounded retry loop (typically 2-5 attempts per Phase 0) and surfaces the deny to the operator.
- The agent's MESI state stays INVALID — retries see the same deny until the operator intervenes (re-reads via the Read tool to take a fresh SHARED grant).
- An `Edit` or `Write` of a strict file the session has not read since a peer's commit is denied the same way. That includes a session whose Bash or Grep read of the file was just denied: the deny lets the retry run, but until a retried Bash command or a `Read` reads the current version, the session cannot write the file (a retried Grep does not count, because it lists files rather than showing them).

**Strict mode is operator opt-in per artifact. Never global.** A literal `**` in `strict_mode_paths` triggers a startup warning (the coordinator counts matching tracked artifacts; default threshold is 50). The plugin will never silently lock down a workspace.

For tool-class restrictions (`grep` → `rg`, no `python -c`, no `sudo`), the structurally stronger primitive is `permissions.deny` at the configuration layer. `agent-coherence-migrate-deny` (library v0.8.2+) is the security-hardened helper: STDOUT-only (never writes settings.json), symlink-contained (canonical-path containment check refuses files outside the workspace root), never invokes an LLM. Operator reviews the output and pastes into `.claude/settings.local.json`.

```bash
agent-coherence-migrate-deny --workspace . | jq
```

**Strict mode works on both coordinator backends.** The Node coordinator now enforces strict-mode denies at byte-parity with Python (guarded by the `protocol_corpus` strict-mode fixtures; against `agent-coherence` releases after 0.14.1, see the Library compatibility note above), so a Node-backend workspace honors `.coherence/strict_mode.yaml` the same way. Select the backend per §[Coordinator backends](#architecture) below.

## Subagents and composite identity

A Claude Code subagent (spawned via the Task tool) runs under its **parent's** `session_id`, so without extra handling every subagent and the parent would collapse into one coordinator identity — sibling subagents editing the same artifact would never see each other, and a subagent's write would be mis-attributed to the parent. The coordinator folds the subagent's hook-payload `agent_id` into a **composite `(session_id, agent_id)` identity** so each subagent is a first-class coherence peer:

- **Sibling collision** — two subagents of the same parent editing the same tracked artifact now collide (previously a silent lost update).
- **Attribution** — a subagent's commit is credited to the subagent in a peer's stale-read warning. Only the Python backend's `/status` shows the subagent as `claude-session-<sid>:subagent-<aid>`, keeping the parent linkage visible: at the operator tier (`?detail=full` with the `Coherence-Local-Operator: true` header), and with `agent-coherence` 0.13.0 through 0.14.1 at the default tier too (earlier releases have no subagent identity). The Node backend's `/status` reports every session's `agent_name` as `null`.
- **Scoped release** — the `SubagentStop` hook releases *only* that subagent's uncommitted grants (never the parent's). A stop payload with an absent `agent_id` is a normal parent stop; a present-but-malformed one is refused (no-op), never a parent-scoped release.

This is **additive and fail-open**: if a hook payload carries no `agent_id`, the identity resolves to the parent exactly as before — nothing regresses for main-thread or single-session work. It is enforced identically on both coordinator backends.

**Verified against Claude Code v2.1.211** (2026-07-17 live capture): a subagent's `PreToolUse` payload carries `agent_id` (snake_case) — e.g. `"agent_id": "abd7e2b3442d77958"`, which satisfies the coordinator's `^[A-Za-z0-9_-]{1,64}$` validator — plus `agent_type`; main-thread tool calls omit `agent_id`; and `SubagentStop` fires carrying the same `agent_id`, so the scoped release targets exactly that subagent's grants.

## Configuration

The coordinator creates `.coherence/` at your repo root automatically. Inside it:

| File | Purpose | Auto-gitignored |
|---|---|---|
| `state.db` | SQLite-WAL artifact state. Per-artifact MESI state, versions, SHA-256 content hashes. **Never** raw file content. | ✓ |
| `hook.secret` | Bearer token for hook auth, mode `0600`. 32 random bytes hex-encoded. | ✓ |
| `server.pid` | Coordinator process discovery (`<pid>\n<port>\nbackend=...\n`). | ✓ |
| `tracked.yaml` | Your opt-in patterns (gitignore-style globs). Commit if you want the tracked set to apply across team checkouts. | Operator's choice |
| `ignored.yaml` | Your opt-out patterns. Same. | Operator's choice |
| `strict_mode.yaml` *(library v0.8.2+)* | Per-artifact strict-mode opt-in. Same shape. Same intersection semantics with `tracked_paths`. | Operator's choice |
| `audit.log` *(library v0.8.2+)* | Append-only JSONL of strict-mode denial events. Mode `0600`. Denials only — no command bodies, no user content. | ✓ |

**Note on `allowedHttpHookUrls`**: hooks are *command-type* (the `agent-coherence-hook-client` subprocess makes the HTTP call internally), not Claude Code's HTTP-type hooks. The `allowedHttpHookUrls` Claude Code policy does NOT apply to this plugin — no allowlist changes are required to install.

## How it works

A lazy-spawned local HTTP coordinator at the parent repo root (`<repo>/.coherence/`) wraps a SQLite-WAL state store implementing the MESI cache-coherence protocol. Plugin hooks are **command-type** (not HTTP-type — Claude Code v2.1.131's hooks.json schema validator rejects URLs containing env-var templates at load time, per internal Phase E.0 probe 2A); each hook invokes the `bin/hook-client` shim (Node client preferred, Python `agent-coherence-hook-client` fallback) which reads `.coherence/server.pid` for the port + `.coherence/hook.secret` for the bearer token, then POSTs the hook payload to the coordinator. PreToolUse fires for every `Read`, `Edit`, `Write`, `Bash`, `Grep`; PostToolUse commits writes and triggers peer invalidations; Stop releases any uncommitted EXCLUSIVE grants at end-of-turn; SubagentStop releases a stopped subagent's own grants (see [subagent identity](#subagents-and-composite-identity)). All HTTP traffic is `127.0.0.1`-bound. Coordinator idle-shuts after 15 minutes; SQLite state rehydrates on next spawn.

## Architecture

Two processes:

- **Claude Code** (the host) — invokes the plugin's command-type hooks at every tool-use boundary.
- **Coordinator** (lazy-spawned subprocess at `<repo>/.coherence/`) — HTTP server bound to `127.0.0.1:<random>`, backed by SQLite-WAL. Implements a MESI cache-coherence subset over a small JSON wire contract.

Two coordinator backends:

- **Python** — canonical, richest feature set. Ships in the `agent-coherence` library on PyPI.
- **Node** — self-sufficient (needs **no Python**): all six hooks, the track/untrack/status CLIs, and strict mode. The six hooks' decision envelopes are at wire-parity with Python (`agent-coherence` releases after 0.14.1) and pinned by the `protocol_corpus` fixtures; the `status` CLI reads `GET /status`, whose envelope is **not** converged between the backends, and is not corpus-pinned. Ships as `src/` in this plugin and is built into the plugin data dir at first-session provisioning (a built dev checkout's `dist/` is used as-is).

**Selecting the backend.** The default is **`node` for a fresh workspace** and **`python` for an established one** — resolved at `SessionStart` as: `COHERENCE_COORDINATOR_BACKEND` env → `<repo>/.coherence/coordinator_backend` file → guarded default. The default is guarded two ways, and both apply **only** when you haven't chosen explicitly:

- **Established workspaces keep `python`.** If `<repo>/.coherence/state.db` already exists, the store is likely Python-owned, and the Node coordinator deliberately fails closed on a foreign ledger — so defaulting it to Node would leave you with no coordinator. Existing workspaces are left exactly as they were, and stay on the backend that created their store: no tool converts a store between backends (`agent-coherence-coordinator --prepare-for-migration` drains and stops a running Python coordinator, nothing more).
- **No `node`/`npm` on PATH → `python`.** The Node bootstrap needs both to self-provision.

To choose explicitly (honored verbatim, guards bypassed), set the env var `COHERENCE_COORDINATOR_BACKEND=node|python`, or write the single word to `<repo>/.coherence/coordinator_backend`:

```bash
mkdir -p .coherence && printf 'node\n' > .coherence/coordinator_backend
```

On a workspace that already has a `state.db`, choose the backend that created it: the other one fails closed on that store, which leaves the workspace with no coordinator and every hook failing open.

The env var takes precedence; an unknown value falls back to `python`. (This file — not a Claude Code plugin setting — is the selection mechanism; the Node zero-Python guarantee is scoped to the platforms with a prebuilt `better-sqlite3` for the pinned Node ABI range. That range is **Node 22, 24, or 25** (`engines.node` = `^22.0.0 || ^24.0.0 || ^25.0.0`): `better-sqlite3` 12.10.0 dropped its Node 20 prebuilts — Node 20 reached end-of-life 2026-04-30 — and never ships them for odd pre-25 majors, so on any other major the bootstrap **refuses up front** rather than fall back to node-gyp, which would need Python and a C++ toolchain. On those majors the plugin runs on the Python backend — a fresh workspace falls back to it automatically, with a stderr note saying why.)

Both backends speak the same HTTP wire contract; the [`tests/protocol_corpus/`](https://github.com/Cohexa-ai/agent-coherence/tree/main/tests/protocol_corpus) suite in the library repo catches drift. Neither backend reads the other's `state.db`, so a workspace stays on the backend that created its store. The canonical design lives in the library's `docs/plans/` directory.

## Local development

```bash
git clone https://github.com/Cohexa-ai/agent-coherence-plugin
cd agent-coherence-plugin
npm ci
npm run build
npm test
```

To test your local checkout against your normal Claude Code session, add a shell alias:

```bash
alias cce='claude --plugin-dir ~/Code/agent-coherence-plugin'
```

Run `cce` instead of `claude` to load the local plugin alongside your production install. Your normal plugin install stays untouched.

For development against a pushed branch (review, cross-machine testing), point `--plugin-dir` at the worktree path:

```bash
git worktree add ~/Code/agent-coherence-plugin-pr feat/some-branch
claude --plugin-dir ~/Code/agent-coherence-plugin-pr
```

For protocol-corpus tests against both Python and Node backends:

```bash
cd ~/Code/agent-coherence       # the library checkout
npm run build --prefix ~/Code/agent-coherence-plugin
pytest -m protocol_corpus
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Agents still hit stale-spec collisions silently | `pip install agent-coherence` step missed, or `agent-coherence-hook-client` not on PATH | Confirm `which agent-coherence-coordinator agent-coherence-hook-client` both resolve. If `pip install` succeeded but binaries aren't found, check that your shell's PATH includes the install prefix's `bin/` (e.g. `~/.local/bin` for user installs). |
| Plugin load failure / silent no-op | Coordinator backend not installed | Run `claude --include-hook-events --output-format stream-json "echo test"` and look for `plugin_errors` in the init event. If `hook-load-failed` appears, the plugin's hooks.json references commands not on PATH. |
| Stale-warning shown when worktrees just have different branches checked out | Filesystem-state semantics: divergent content on first observation surfaces as `hash_differs` | Expected behavior. Add the path to `ignored.yaml` if the divergence is intentional. |
| Frequent acquire/release events in `agent-coherence-status` | Per-turn Stop-hook release of uncommitted grants. Normal end-of-turn behavior. | No action. Telemetry counter `intra_task_acquire_release_total` quantifies. |
| `state.db` corrupted | Power loss during WAL checkpoint, or SQLite version mismatch | Back up `.coherence/state.db` first — as of the durable-retention schema (issue #55) it holds retained version content, and in a mixed Python/Node workspace the sibling coordinator's live coordination state. Only if the file is genuinely unreadable, remove it to let the next spawn start fresh (this loses retained content); never remove it to "reset" a healthy store. |
| Coordinator process won't die | Stale `server.pid` after crash | `rm .coherence/server.pid` to clear the lock; next hook fires re-spawn |
| `hook.secret` compromised | Same-user attack or accidental leak | Stop all sessions, `rm .coherence/hook.secret` (the next spawn re-mints it), restart Claude Code. Remove only the secret — `rm -rf .coherence/` also destroys `state.db`'s retained content + live coordination state. v0.2.x will support hot rotation without restart. |
| *(v0.2 strict mode)* agent keeps retrying after strict deny | Expected. The model exits the retry loop after 2-5 attempts per Phase 0 finding. | No action — the deny IS the signal. The operator sees the deny in the transcript and can decide how to proceed. |
| *(v0.2 strict mode)* `agent-coherence-migrate-deny` exits with "NOT a descendant" | Symlink-containment check refused: the CLAUDE.md / AGENTS.md canonical path escapes the workspace root | Verify with `realpath CLAUDE.md`. If the symlink is intentional and points inside the workspace, the canonical-path check still rejects — the helper is intentionally strict. Use `agent-coherence-migrate-rules` for the looser flow. |
| Bash permission prompt fires every time a plugin slash command runs (e.g., `/agent-coherence:status`) | Claude Code does not currently allow plugins to ship a default `permissions.allow` for their own bundled binaries — only `agent` and `subagentStatusLine` keys are supported in plugin-root `settings.json` per the [plugins-reference](https://code.claude.com/docs/en/plugins-reference). Tracked upstream. | Add the allowlist to your workspace `.claude/settings.local.json` once per workspace — see § Allowlisting the plugin's bundled binaries below. |

### Allowlisting the plugin's bundled binaries

The plugin's slash commands and SessionStart hook invoke five console-script binaries: four shipped as `bin/` shims (`agent-coherence-status`, `agent-coherence-track`, `agent-coherence-untrack`, `agent-coherence-migrate-deny`) plus the library's `agent-coherence-coordinator`. Claude Code's per-command permission gate fires on each one unless they're in your workspace's `permissions.allow`. To suppress the prompts, append this block to your `.claude/settings.local.json` (workspace-local, per-user, gitignored by default):

```json
{
  "permissions": {
    "allow": [
      "Bash(agent-coherence-status:*)",
      "Bash(agent-coherence-track:*)",
      "Bash(agent-coherence-untrack:*)",
      "Bash(agent-coherence-coordinator:*)",
      "Bash(agent-coherence-migrate-deny:*)"
    ]
  }
}
```

If your `.claude/settings.local.json` already exists, merge the `permissions.allow` array with whatever's already there. Re-running a plugin slash command after this edit should execute without a prompt.

If your team wants the same allowlist committed for everyone, put the block in `.claude/settings.json` (workspace-shared, version-controlled) instead. Same shape, different file.

The plugin-shipped path requires a Claude Code platform change — tracked in [anthropics/claude-code#62616](https://github.com/anthropics/claude-code/issues/62616) (filed 2026-05-26 per the Phase E broad-beta monitoring window).

## Known limitations

| Issue | Impact | When it matters |
|---|---|---|
| Native Windows not supported | `fcntl` lock primitive is POSIX-only | Use WSL2 on Windows. v0.2.x ships an `os.O_EXCL` fallback. |
| `agent-coherence-migrate-deny` needs Python | The `permissions.deny` suggestion helper is not part of the zero-Python Node surface — and since fresh workspaces now default to Node, this is the one helper a default install cannot run | Install `agent-coherence` (Python) to run the migrate-deny helper, or hand-write the `permissions.deny` rules. All runtime hooks + strict mode work without Python on the Node backend. |
| Hot `hook.secret` rotation not supported | v0.2 ships stop-rotate-restart procedure | If the secret is compromised, follow the troubleshooting row above. v0.2.x will add hot rotation. |
| Bypass class: interpreters not in detector list | `ruby -e`, `node -e`, `perl -pe < file` can read tracked-strict artifacts | Operator-supplied `permissions.deny` rule per language. The `bash_path_detector` is intentionally curated; obfuscated bypass is documented as out-of-scope. |
| Bypass class: shell-redirect reads | `tee /dev/null < tracked.md` reads the file but isn't a `cat tracked.md` invocation | **NOT closed by `permissions.deny`** (no platform syntax for shell-redirect file arguments). Terminal limitation. |
| Bypass class: diff-as-reader | `diff /dev/null tracked.md` reads the file content | Adding `diff`/`cmp` to `bash_path_detector` list is on the v0.2.x backlog. |
| HTTP-type hooks not viable on v2.1.131 (internal Phase E.0 probe 2A) | hooks.json URL templating fails strict-URL schema validation at load time | v0.2 ships command-type hooks via `agent-coherence-hook-client` — works on v2.1.131. If a future Claude Code version supports URL templating, an HTTP-type variant can be added as a perf optimization. |
| `claude agents` subcommand not in coverage scope | The v2.1.131 subcommand is a management UI, not a session spawner; no PreToolUse hooks to capture | Use Agent View, multi-terminal, or Task-tool subagents (all in scope). |
| Single-user, single-host workstation only | Trust boundary is the OS user; `hook.secret` mode 0600 is the load-bearing fence | Not suitable for shared developer machines, CI runners with multiple developers, or cross-host coordination. |
| Compaction re-grounding: one residual duplicate | A mid-loop deferred delivery is later followed by the platform re-rendering the compaction attachment at the next user turn; the two sightings can differ if state moved between them | The staler rendering is the later one — the payload's closing line ("a more recent read supersedes this notice") and event-anchored wording make the duplicate benign. |
| Compaction re-grounding: first compaction after upgrade can't flag staleness | The last-observed comparand starts NULL for rows recorded before the upgrade, and never-observed rows are deliberately never flagged | Staleness detection becomes accurate as sessions read/commit after the upgrade. Not a bug — the alternative (flagging never-observed rows) would false-alarm on every untouched artifact. |
| Compaction re-grounding: fail-open loss on a cold coordinator | If the coordinator is down or still starting at the compact boundary, the SessionStart hook emits `{}` and that compaction's re-grounding is lost on both paths | Rare mid-session (the coordinator is warm); matches the plugin's universal fail-open contract — coordination never blocks the session. |
| Cross-backend parity is the hook envelope, not every surface | `protocol_corpus` runs 24 of its 31 fixtures against both backends and pins the seven POST hook surfaces — the decision envelope (`permissionDecision`, `permissionDecisionReason`, `status`) and the SessionStart re-grounding prose. Three surfaces sit outside it: `GET /status` and `GET /health` have **no** cross-backend fixture and differ by design (`/health` is Node-only), and preemption-notice prose shares no byte-identical line between the two renderers, although both send a notice to the same sessions (only those that lost an EXCLUSIVE or MODIFIED grant) | Read `/status` as backend-specific — parse it defensively and do not port a consumer between backends without re-checking. Notice prose is model-facing context, not a machine contract, so the wording divergence is cosmetic there. Background in [#138](https://github.com/Cohexa-ai/agent-coherence-plugin/issues/138). |

### Resolved in v0.2–v0.3

- **Strict mode** (`permissionDecision: "deny"`) per Phase 0 H4 routing-confirmation. Per-artifact opt-in via `.coherence/strict_mode.yaml`. Multi-tool surface (Read / Edit / Write / Bash / Grep) prevents the model from routing around denied Read via `bash cat plan.md`.
- **`TERMINAL_DENIAL_CLASSES` structural invariant** — code paths emitting `permissionDecision: "allow"` route through a single `emit_allow` helper that refuses to convert strict-mode denials. Parameterized integration test + AST-based meta-test guard against future regression.
- **`agent-coherence-migrate-deny` CLI** — STDOUT-only, symlink-contained sibling to v0.1.1's `agent-coherence-migrate-rules`.
- **Strict-mode telemetry** — `strict_mode_denials_total`, `strict_mode_routed_around_via_bash_total`, `audit_log_mode_drift_total` counters in `/status?detail=metrics`. Minimal denial-only `.coherence/audit.log` JSONL surface.
- **Cross-implementation protocol corpus** — Python ↔ Node coordinator wire-shape parity tests in the library repo, run as a dedicated CI job.

## FAQ

### Do I need to opt every file into strict mode?

No. Strict mode is per-artifact opt-in via `.coherence/strict_mode.yaml`. Most operators leave it empty — warn mode (the default for every tracked artifact) measured 100% re-read-or-acknowledged in the N=80 launch gate. Strict mode is for the small set of artifacts where the cost of a silent stale-edit is unacceptable.

### Does it phone home?

No. The plugin makes **zero outbound HTTP requests**. The coordinator binds only to `127.0.0.1` and never connects to any external service. `agent-coherence-status` is the only telemetry surface and it is operator-pulled, never plugin-pushed. See [PRIVACY.md](PRIVACY.md) for the full statement.

### Why isn't it on npm?

The plugin's `package.json` is `"private": true` by design. Distribution is via the Claude Code marketplace catalog, not npm. Marketplace install is one-click; npm publication would just be a redundant distribution channel. Revisit if v0.3 multi-target work needs npm as a distribution surface for the converter-layer.

### Can I use it with Cursor / Codex / Copilot?

Not in v0.2. The plugin's hook surface is Claude-Code-specific. Multi-target support is tracked for v0.3 behind a converter-layer plan. The closest reference shape is [EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin), which ships skills + agents (not hooks) and uses a Bun-based converter.

### How do I upgrade from v0.1.1?

Two steps:

1. **Rotate the `hook.secret`.** v0.1.1 secrets were generated under the warn-mode threat model; v0.2's strict-mode hard guardrails warrant a fresh secret. Procedure: stop any running `claude` sessions in your workspace → `rm <repo>/.coherence/hook.secret` → restart any `claude` session, which lazy-spawns the coordinator and generates a fresh secret.
2. **Bump the plugin install.** `/plugin install agent-coherence@agent-coherence` re-resolves the latest published tag from the marketplace catalog.

Strict mode is opt-in — your existing workspaces stay warn-only until you add patterns to `.coherence/strict_mode.yaml`.

### Where do I see all the operator commands?

See the [Commands](#commands) table above. Slash commands shell out to the corresponding console scripts the library installs.

### How do I report a security issue?

See [SECURITY.md](SECURITY.md). Preferred channel is GitHub's "Report a vulnerability" feature on the [security tab](https://github.com/Cohexa-ai/agent-coherence-plugin/security); fallback is `security@agent-coherence.dev`. 72h response-time SLA.

### Where is release history?

[GitHub Releases](https://github.com/Cohexa-ai/agent-coherence-plugin/releases) is the canonical surface. [CHANGELOG.md](CHANGELOG.md) at the repo root mirrors it in Keep-a-Changelog format.

## About Contributions

PRs are welcome. The posture is **maintainer-curated**, not auto-merge:

- Bug reports + reproductions: 72h triage SLA. Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md).
- Feature requests: no SLA. Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) or open a [GitHub Discussion](https://github.com/Cohexa-ai/agent-coherence-plugin/discussions) to talk it through first.
- Install-troubleshooting questions: use the [install-troubleshooting template](.github/ISSUE_TEMPLATE/install_troubleshooting.md) — it asks for the diagnostic info that lets the maintainer repro in <5 min.
- PRs: reviewed via `gh pr view` + Claude-assisted review (mirror of the workflow this repo uses on its own changes). Expect 1-3 review cycles before merge; never auto-merged. Include tests for new behavior, update tests for changed behavior.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pre-PR checklist + branching convention. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1) applies to all participants in Issues / Discussions / PRs.

## Release

Releases follow [SemVer 2.0](https://semver.org/spec/v2.0.0.html); the canonical version-tag history is in [CHANGELOG.md](CHANGELOG.md). See [GitHub Releases](https://github.com/Cohexa-ai/agent-coherence-plugin/releases) for tagged artifacts.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Links

- Underlying library: [Cohexa-ai/agent-coherence](https://github.com/Cohexa-ai/agent-coherence)
- Discovery / book a call: [agent-coherence.dev/plugin](https://agent-coherence.dev/plugin)
- Issue tracker: [github.com/Cohexa-ai/agent-coherence-plugin/issues](https://github.com/Cohexa-ai/agent-coherence-plugin/issues)
- Discussions: [github.com/Cohexa-ai/agent-coherence-plugin/discussions](https://github.com/Cohexa-ai/agent-coherence-plugin/discussions)
- Security: [SECURITY.md](SECURITY.md)
- Privacy: [PRIVACY.md](PRIVACY.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
