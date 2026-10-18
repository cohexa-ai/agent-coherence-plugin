---
name: Bug report
about: Report a bug in the agent-coherence Claude Code plugin
title: '[bug] '
labels: 'bug'
assignees: ''
---

**Describe the bug**

A clear and concise description of what the bug is. If you saw an error message, paste it here verbatim.

**To reproduce**

Numbered steps that reproduce the bug:

1. ...
2. ...
3. ...

If the bug is intermittent, describe the conditions under which it tends to fire (under load, after N invocations, etc.).

**Expected behavior**

What you expected to happen, in 1-2 sentences.

**Actual behavior**

What actually happened — including any agent text, hook event output, or error envelope. If the agent's behavior changed (e.g., it re-read when you didn't expect a warning), describe what the agent did.

**Diagnostic output**

Please paste the output of:

```bash
agent-coherence-status --detail metrics
```

This is the `?detail=metrics` tier of `/status`. It is safe to paste: it has no paths, no process id and no session identifiers, on either backend. If you'd rather not share counters, leave this section out. `--detail minimal` is not more conservative: it is the default tier, which adds your tracked files' paths and a row per session, plus the coordinator's process id on the Python backend. With `agent-coherence` 0.14.1 or earlier it also carries the absolute workspace root and raw session ids.

If the bug involves a stale-read warning, paste the output of:

```bash
claude --include-hook-events --output-format stream-json "<your prompt>"
```

…and redact any user content. Hook events are otherwise safe to share — the plugin's `additionalContext` payloads carry only coordination metadata, such as paths, versions, grant states, timestamps and agent ids (and short session ids, on the Python backend with `agent-coherence` 0.14.1 or earlier).

**Environment**

- `claude` CLI version (output of `claude --version`):
- Node version (output of `node --version`):
- Python version (output of `python --version` or `python3 --version`):
- Plugin version (from `.claude-plugin/plugin.json`):
- Library version (output of `pip show agent-coherence | grep Version`):
- OS (macOS / Linux distro + version / WSL2):
- Coordinator backend (`coherence.coordinator_backend` setting; default is `python`):

**Workspace shape (helps with repro)**

- Single session or multi-session bug?
- If multi-session: how many concurrent `claude` invocations, and were they in the same workspace?
- Tracked artifacts involved (if any): paste the relevant `tracked.yaml` / `ignored.yaml` / `strict_mode.yaml` snippet.

**Triage SLA**

Bug reports are triaged within 72h (see [CONTRIBUTING.md](../../CONTRIBUTING.md)). P0 issues (data-corrupting, auth-bypassing) get a patch target of 7 days. If your bug is security-sensitive, please report it via the [security tab](https://github.com/Cohexa-ai/agent-coherence-plugin/security) or `security@agent-coherence.dev` instead of a public Issue.
