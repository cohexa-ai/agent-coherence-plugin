---
description: "Show tracked artifacts × per-session MESI states for this workspace."
allowed-tools: ["Bash"]
---

Run `agent-coherence-status --detail minimal` and report its output verbatim
to the user. `--detail minimal` keeps session names and absolute paths out of
the output on either backend: without it, the Python console script the
plugin falls back to prints the operator view.

If the command exits non-zero, surface the exit code and the stderr message
without commentary — the operator can act on it. If it exits 0 with a
"no coordinator running" stderr line, this is normal (graceful state) and
should be reported as "no coordinator currently running for this workspace —
the next file Read/Edit in any session will lazy-spawn one."

Do not interpret the MESI states or version numbers beyond what the
`agent-coherence-status` table already shows; users querying this command
want raw status, not analysis.
