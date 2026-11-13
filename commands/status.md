---
description: "Show tracked artifacts × per-session MESI states for this workspace."
allowed-tools: ["Bash"]
---

Run `agent-coherence-status --detail minimal` and report its output verbatim
to the user. `--detail minimal` asks for the default tier on either backend.
In `agent-coherence` 0.14.1 and earlier, the Python console script the plugin
falls back to prints the operator view when run without it. On the Node
backend, and with `agent-coherence` releases after 0.14.1, the default tier
carries no session names and no absolute paths; with 0.14.1 or earlier it
still lists each session as `claude-session-<session id>` and shows the
absolute workspace root.

If the command exits non-zero, surface the exit code and the stderr message
without commentary — the operator can act on it. Three messages have a known
meaning:

- A stderr line saying no coordinator is running for this workspace means
  none is serving it. The bundled Node CLI exits 2 with it and the Python
  console script exits 0. When the line ends `start one`, the coordinator
  `.coherence/server.pid` names has exited. Report it as "no coordinator
  currently running for this workspace. Starting or resuming a Claude Code
  session in it starts one."
- An exit 2 whose message ends `; nothing was sent` means the coordinator
  the command found exited or was replaced before the request went out.
  Report it, and suggest running the command again.
- An exit 2 saying the coordinator's registry is busy means the coordinator
  answered but could not read its registry in time, so the output cannot say
  what is tracked. Report that, and suggest running the command again shortly.

Do not interpret the MESI states or version numbers beyond what the
`agent-coherence-status` table already shows; users querying this command
want raw status, not analysis.
