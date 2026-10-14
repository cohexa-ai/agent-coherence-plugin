# Privacy

**The `agent-coherence` Claude Code plugin does not transmit any of your data off your machine.** The only outbound requests it makes are the package downloads that install its Node backend, described below.

## What the plugin does NOT do

- **No phone home.** The coordinator binds only to `127.0.0.1` and never connects to any external service, and the hooks and CLIs talk only to it. The one exception is installing dependencies. On the first session, after every plugin upgrade, after you switch to a different Node major version, and whenever the installed native module fails to load (for example on the session after an interrupted install), `bin/ensure-coordinator-node` runs `npm install` from the plugin's lockfile. That fetches the locked packages from your configured npm registry (registry.npmjs.org by default) and `better-sqlite3`'s prebuilt binary from GitHub. Those requests carry what any `npm install` sends, and nothing about your workspace or files.
- **No usage analytics.** No counts of how often you invoke a hook, what files you track, which strict-mode patterns you set, which models you use, or anything else is ever transmitted off your machine.
- **No error reporting service.** Errors land in your local `.coherence/` logs and (if a crash happens) the Claude Code session's normal log surface. Nothing is sent to Sentry / Bugsnag / Rollbar / any external telemetry collector.
- **No third-party tracking.** No analytics SDKs are bundled. No CDN-loaded resources. No fingerprinting.

Apart from that install, if you ever observe an outbound network request originating from the plugin or the spawned coordinator, **that's a bug** — please report it via `security@agent-coherence.dev` or the [GitHub security tab](https://github.com/Cohexa-ai/agent-coherence-plugin/security).

## What the plugin DOES touch (all local)

| Surface | Where it lives | What's in it |
|---|---|---|
| Coordinator socket | `127.0.0.1:<random>` — loopback only | HTTP requests from the hook client to the local coordinator. Never reaches the network interface. |
| `.coherence/state.db` | `<repo>/.coherence/state.db` | Per-artifact MESI state, version numbers, SHA-256 content hashes (`content_hash`). **Never** raw file content. |
| `.coherence/hook.secret` | `<repo>/.coherence/hook.secret` | 32-byte random bearer token, file mode `0o600`. Authenticates the hook client to the coordinator. Never transmitted off your machine. |
| `.coherence/server.pid` | `<repo>/.coherence/server.pid` | Coordinator process discovery (`<pid>\n<port>\nbackend=node|python\n`). Read by the hook client to find the coordinator. |
| `.coherence/tracked.yaml` / `ignored.yaml` / `strict_mode.yaml` | `<repo>/.coherence/` | Operator-authored glob patterns. Optional. Commit if you want them to apply across team checkouts. |
| `.coherence/audit.log` *(v0.2+)* | `<repo>/.coherence/audit.log` | Append-only JSONL of strict-mode denial events. Mode `0o600`. Per-event payload: ISO timestamp, artifact path, session UUID, tool surface name, decision marker (`"strict_deny"`). **No** command bodies, **no** user content, **no** content hashes. |
| `.coherence/caller-principal-<id>.nonce` / `.principal` | `<repo>/.coherence/` | Python-backend workspaces only: a random claim nonce per session and the caller principal the coordinator issued for it. Mode `0o600`. Never transmitted off your machine. |

All of the above stays on your local disk. The `.coherence/` directory is auto-gitignored so a careless `git add .` doesn't commit it.

## `agent-coherence-status` is operator-pulled, not plugin-pushed

The only telemetry surface is the `/status` endpoint on the local coordinator, exposed via:

- `agent-coherence-status` (or `agent-coherence-status --detail metrics` for the metrics tier)
- Slash command `/agent-coherence:status` (which shells out to the same console script)

The plugin never pushes telemetry. The operator pulls it on demand. What each `/status` tier carries:

- **Metrics** (`?detail=metrics`, or `agent-coherence-status --detail metrics`): counters only, with no paths, no process id and no session identifiers, on either backend. This is the tier to paste in a bug report. The Node coordinator does not fill in counters yet, so its metrics answer is an empty counter set.
- **Default** (a bare `GET /status`, the same as `?detail=minimal`; this is what `/agent-coherence:status` shows): the workspace-relative path and version of every tracked file, and one row per session. Each row holds an opaque agent id (a one-way hash of the session id that cannot be turned back into it) and that session's state on each file. The workspace root is reported as `"."`. On the Python backend this tier also carries the coordinator's process id. The Node coordinator reports no process id at any tier. With `agent-coherence` 0.14.1 or earlier, the Python coordinator's default tier also carries the absolute workspace root (as `policy_summary.coordinator_root`) and each session's name, `claude-session-<session id>`, which contains the raw session id. Remove both before you share it. Plugin releases before v0.6.0 did the same on the Node backend.
- **Full** (`?detail=full`, or `agent-coherence-status --detail full`): requires the `Coherence-Local-Operator: true` header and is served by the Python coordinator only (the Node coordinator answers 501). It adds the absolute workspace root, session names (which contain the raw session id) and your tracked-file patterns to what the default tier carries.

With `agent-coherence` 0.14.1 or earlier, the library's `agent-coherence-status` prints the full tier when you run it with no `--detail`. Pass `--detail metrics` instead. `/agent-coherence:status` always asks for the default tier.

## What you choose to share

If you open a bug report or paste `--detail metrics` output in a Discussion, *you* are choosing to share that information with the maintainer + anyone reading the public thread. The plugin doesn't make that choice for you. Only the metrics tier is meant to be pasted as-is. The default tier lists the paths of your tracked files, which can reveal your workspace's layout, so read it before you share it. With `agent-coherence` 0.14.1 or earlier, also remove the absolute path and the session names first.

The strict-mode `.coherence/audit.log` (v0.2+) records denial events. Pasting an audit-log window in a bug report shares the **paths** of the artifacts that hit a strict-deny + the **timestamps** + the **session UUIDs** + the **tool surface** (Read / Edit / Write / Bash / Grep). It does NOT share the file contents, command bodies, or any model output. If the artifact path itself is sensitive (e.g., reveals an internal project name), redact it before sharing.

## Coordinator backends

| Backend | What's at the trust boundary |
|---|---|
| Python (`coherence.coordinator_backend = "python"`) | The Python coordinator process runs as the same OS user as your `claude` session. Loopback HTTP only. SQLite-WAL writes only to `<repo>/.coherence/state.db`. |
| Node (`coherence.coordinator_backend = "node"`) | The Node coordinator process runs as the same OS user. Same loopback-HTTP constraint. Same SQLite-WAL surface (via `better-sqlite3`). |

Both backends keep everything on your machine, and the choice between them is operational (which language runtime is on your machine). A few local surfaces differ. The Python coordinator's default `/status` tier includes its process id, and with `agent-coherence` 0.14.1 or earlier also the absolute workspace root and raw session ids. Only the Python coordinator writes `.coherence/audit.log`.

## Cross-host / cross-vendor coordination

Cross-machine and cross-vendor coordination (multiple workstations, or Cursor + Claude Code on the same workstation) is out of scope for this plugin, which is single-host single-user by design. This document covers only the plugin.

## Updates to this document

Material changes to data handling will land in the [CHANGELOG.md](CHANGELOG.md) `Security` subsection of the relevant release. The "no phone home" invariant is locked — any change that would add outbound network traffic requires a major version bump (≥1.0.0) and an explicit opt-in.
