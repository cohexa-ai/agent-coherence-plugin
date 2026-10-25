# Security & supply chain

This document covers the threat model, network posture, auth, storage hygiene,
supply-chain controls, and disclosure channel for the **`agent-coherence` Claude
Code plugin** (this repo: `Cohexa-ai/agent-coherence-plugin`). The underlying
Python library `Cohexa-ai/agent-coherence` has its own `SECURITY.md`; the two
documents share the bearer-token + Host-header auth design but diverge on
distribution surface (Claude Code plugin marketplace vs. PyPI).

## Threat model

The plugin runs a lazy-spawned local HTTP coordinator at `127.0.0.1:<port>`
under `<repo>/.coherence/`. The trust boundary is **single-OS-user,
single-host workstation**. Within that boundary, two adversaries are
explicitly modeled (see also `src/auth.ts` top docstring, which is the
authoritative source for the auth design):

### Adversary 1 — same-user co-tenant code

A malicious npm package, compromised devtool, or other process running as
the same OS user as the developer. Such a process already has read access to
the developer's shell history, SSH agent socket, browser cookie jars, and
keychain. Any defense the plugin could mount against that adversary would be
weaker than the protections those same-user assets already (don't) have.

**Mitigation**: `<repo>/.coherence/hook.secret` is created with mode `0600`
via `openSync(path, O_WRONLY | O_CREAT | O_EXCL, 0o600)` (atomic create — no
window where the file exists with a wider mode). The same-user threat model
matches the user's shell history file. We do **not** attempt to defend
against an attacker who has already executed code as the developer.

### Adversary 2 — browser-side DNS rebinding

A page in the developer's browser issues `fetch('http://attacker.example.com/')`
where the attacker's DNS server resolves that hostname to `127.0.0.1`. Without
mitigation, the browser would send the request to our loopback coordinator
with the attacker's hostname in the `Host` header. The request would NOT
carry a valid bearer token, so it would fail auth — but a paranoid second
layer rejects on Host header alone before the auth check runs.

**Mitigation**: Host-header allowlist. `src/auth.ts:verifyHost` accepts only
`localhost` or `127.0.0.1`; any other hostname (including a rebind target
like `attacker.example.com`) returns 401 before token comparison. This is
the standard defense for local HTTP services exposed to a browser-capable
machine.

### Out of scope

- **Multiple developers sharing the same workstation.** The plugin assumes
  one developer, one OS user, one workspace. A shared workstation needs OS-
  level user isolation (separate accounts) before the plugin's per-user
  trust model holds.
- **Shared CI runners with multiple builds.** The coordinator binds to a
  process-local port; concurrent CI jobs on the same runner share the
  loopback namespace. v0.1.1 does not address this; tracked for v0.2.
- **Cross-host coordination.** The plugin coordinates state across parallel
  Claude Code sessions on the **same** workstation. Cross-machine and cross-
  vendor (e.g. Cursor + Claude Code) coordination is out of scope for this
  plugin.
- **Compromise of the underlying Claude Code binary.** The plugin layers on
  top of `claude` v2.1.131+; if the binary itself is malicious, no plugin
  layer recovers the trust boundary.

## Network

| Property | Value |
|---|---|
| Bind address | `127.0.0.1` (loopback only; locked invariant per `src/auth.ts`) |
| Outbound destinations | The coordinator, hooks and CLIs make none. The one exception is installing dependencies. On the first session, after every plugin upgrade, after you switch to a different Node major version, and whenever the installed native module fails to load (for example on the session after an interrupted install), `bin/ensure-coordinator-node` runs `npm install` from the plugin's lockfile. That fetches the locked packages from your configured npm registry (registry.npmjs.org by default) and `better-sqlite3`'s prebuilt binary from GitHub. Those requests carry what any `npm install` sends, and nothing about your workspace or files. |
| Listener exposure | Loopback only; no external listener; no port forwarding |
| IPv6 | Not supported in v0.1.1 (`bind_host` is `127.0.0.1`; tracked for v0.2) |

Apart from that install, if you observe any outbound network request
originating from the plugin or the spawned coordinator, that's a bug — please report it via the
channel below.

## Auth

| Control | Implementation | Reference |
|---|---|---|
| Bearer token | 32 random bytes hex-encoded at `<repo>/.coherence/hook.secret`, mode `0600`, atomically created via `O_WRONLY \| O_CREAT \| O_EXCL` | `src/auth.ts:ensureSecret` |
| Token comparison | Constant-time via `crypto.timingSafeEqual` (Node) and `hmac.compare_digest` (Python coordinator) — never `===` (which short-circuits and leaks token prefix via response timing) | `src/auth.ts:verifyBearer` |
| Host-header allowlist | Only `localhost` and `127.0.0.1` accepted; defeats DNS rebinding from non-loopback origins | `src/auth.ts:verifyHost` |
| Token rotation | Stop all coordinator processes, `rm <repo>/.coherence/hook.secret`, next hook re-spawn regenerates. Hot rotation deferred to v0.2. | README "Troubleshooting" |
| Empty-file recovery | If `hook.secret` exists but is empty/malformed (previous instance crashed mid-write), bounded `O_EXCL` retry rather than `O_TRUNC` re-write (avoids clobbering a concurrent racer's valid secret); fail-closed after N attempts | `src/auth.ts:ensureSecret` |

Both Python and Node coordinator backends read the same `hook.secret` file;
switching `coherence.coordinator_backend` does **not** rotate the secret.

## Storage hygiene

The coordinator's state directory is `<repo>/.coherence/`. Contents:

| File | Purpose | Mode | Contains |
|---|---|---|---|
| `state.db` | SQLite-WAL artifact state | default user umask | Per-artifact MESI state, version numbers, `content_hash` (SHA-256, hex). **Never** raw file content. |
| `hook.secret` | Bearer token for HTTP auth | `0600` | 64 hex chars (32 random bytes) |
| `server.pid` | Coordinator process discovery | default | Port + PID of the lazy-spawned coordinator |
| `tracked.yaml` | User-committed opt-in patterns | default | Glob patterns: path globs with `**`, Python `fnmatch` without (see the README) |
| `ignored.yaml` | User-committed opt-out patterns | default | Glob patterns, as `tracked.yaml` |

**Content-hash-only invariant**: `state.db` stores SHA-256 content
hashes, never file bytes. A read attacker who exfiltrates `state.db` learns
*which* tracked artifacts changed at which timestamps, but not the contents
of those artifacts. This is by design — coordination state is metadata, not
content.

**Gitignore guidance**: The README documents `state.db` and `hook.secret`
as "auto-gitignored". If your repo-level `.gitignore` does not already
exclude `.coherence/`, add it — neither file should ever be committed.
`tracked.yaml` and `ignored.yaml` are the only files under `.coherence/`
intended for source control (commit them if you want the tracked set to
apply across team checkouts).

## Supply chain

### Dependencies

- **Pinned via `package-lock.json`** (committed to the repo). `npm ci`
  installs the exact dependency tree captured at release time.
- **Runtime dependencies** (per `package.json` v0.1.1):
  - `better-sqlite3` — SQLite-WAL bindings
  - `js-yaml` — `tracked.yaml` / `ignored.yaml` parser
  - `uuid` — derives the coordinator's agent id, a one-way uuid v5 hash, from the session id Claude Code supplies (plus the subagent id for a subagent). The plugin never generates session ids.
- **Dev dependencies**: `typescript`, `@types/node`, `@types/better-sqlite3`,
  `@types/js-yaml`, `@types/uuid`.

The plugin's `package.json` declares `"private": true`, blocking accidental
`npm publish` to the public registry. The plugin is distributed through the
Claude Code marketplace catalog, not npm — `private: true` prevents the
distribution channel from accidentally drifting.

### SBOM (CycloneDX)

Each GitHub Release attaches a CycloneDX SBOM (`sbom.cyclonedx.json`)
generated by the release workflow (`.github/workflows/release.yml`). The
SBOM lists the full transitive Node dependency surface at build time. Diff
across releases to see dependency-graph changes.

### Provenance

Release tag pushes trigger `release.yml`, which builds from the tag commit
and attaches the SBOM + the built artefacts. The workflow runs in
`Cohexa-ai/agent-coherence-plugin`'s GitHub Actions environment; provenance
is implicit via the workflow run URL recorded on the release page.

GitHub-native attestation (cosign / Sigstore) is tracked for v0.2 — the
Node distribution surface (marketplace catalog) does not yet have a
standard attestation verifier equivalent to PyPI's PEP 740.

### Underlying library

The plugin requires `agent-coherence >= 0.8.0` on PyPI for the
`agent-coherence-coordinator` and `agent-coherence-hook-client` console
scripts (when running the Python coordinator backend). The Python
library's supply-chain controls are documented at
[Cohexa-ai/agent-coherence — SECURITY.md](https://github.com/Cohexa-ai/agent-coherence/blob/main/SECURITY.md):
PyPI Trusted Publishers via OIDC (no static token to steal), PEP 740
attestations, CycloneDX SBOM, hash-pinned install.

When you switch `coherence.coordinator_backend` between `python` and
`node`, you inherit the supply-chain surface of whichever backend is
active. The Node backend ships fewer dependencies and a smaller attack
surface; the Python backend has the fuller feature set.

## Reporting security issues

Report security issues via either of:

1. **Preferred — private vulnerability report**: GitHub's "Report a
   vulnerability" feature on
   [Cohexa-ai/agent-coherence-plugin/security](https://github.com/Cohexa-ai/agent-coherence-plugin/security).
   Private disclosure channel, not visible to the public.
2. **Email**: `security@agent-coherence.dev`. Forwards to the
   maintainer's inbox; the alias exists specifically so security
   reporters don't need a GitHub account. Use this if you're reporting
   on behalf of an organization that prefers email-based disclosure or
   if the GitHub channel is unavailable.

**Response-time SLA**: 72 hours to first response. P0 issues (auth
bypass, secret exposure, file-content disclosure) get a patch target
of 7 days. The rollback runbook in [docs/BROAD_BETA.md](docs/BROAD_BETA.md)
documents the procedure if a published release needs to be pulled.

Please do NOT open a public Issue for security-class reports. The bug
report template includes an explicit redirect to the security channel
for this case.

## Known limitations

Security-relevant items genuinely deferred past v0.1.1 are tracked in the
README ["v0.1.1 known limitations"](README.md#v011-known-limitations)
section. Of particular note for security review:

- **Strict mode (`permissionDecision: "deny"`) deferred to v0.2.** v0.1.1
  warns but never blocks. Hard guardrails for "agent MUST re-read before
  edit" are not available yet. Operators relying on the plugin as a hard
  policy enforcement layer should wait for v0.2 — v0.1.1 is an advisory
  coherence layer.
- **Native Windows not supported** (`fcntl` POSIX-only). Use WSL2.
- **Single-user, single-host workstation only.** Not for shared
  developer machines, multi-developer CI runners, or cross-host
  coordination.
- **`claude agents` subcommand not in coverage scope** on v2.1.131. Use
  Agent View, multi-terminal, or Task-tool subagents.

If you find a security concern that doesn't fall under "known limitations"
above, please report it via the channel in the previous section.
