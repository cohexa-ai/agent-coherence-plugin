---
description: "Append one or more workspace-relative paths to the coordinator's ignored set (a path enforced in strict mode is refused)."
argument-hint: "<path> [<path>...]"
allowed-tools: ["Bash"]
---

Run `agent-coherence-untrack $ARGUMENTS` and report the output.

The command's stdout lists each successfully untracked path. Stderr carries
any rejections (invalid path syntax). The coordinator does NOT delete
existing artifact rows from SQLite — it just adds the path to ignored.yaml
so future Reads suppress warnings. A path enforced in strict mode is never
untracked this way.

If the command exits 3, the coordinator refused because a path is enforced
in strict mode, and nothing was untracked. Report the refused paths and the
next step the message names (remove the entry from
`.coherence/strict_mode.yaml`, then restart the coordinator, which the
README's Strict mode section describes). An entry the coordinator could not
finish checking is refused the same way; a narrower path may be accepted.
Do not edit those files, stop the coordinator, or delete
`.coherence/server.pid` yourself unless the user asks you to. The bundled
Node coordinator refuses this way, and so does a Python coordinator from an
`agent-coherence` release after 0.14.1.

If no paths were given, ask the user which workspace-relative path(s) they
want to untrack. Don't invoke the CLI without arguments: the bundled Node CLI exits 1 with no output, and the Python console script exits 2 with a usage error.
