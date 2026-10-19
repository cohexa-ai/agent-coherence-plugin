---
description: "Append one or more workspace-relative paths to the coordinator's ignored set."
argument-hint: "<path> [<path>...]"
allowed-tools: ["Bash"]
---

Run `agent-coherence-untrack $ARGUMENTS` and report the output.

The command's stdout lists each successfully untracked path. Stderr carries
any rejections (invalid path syntax). The coordinator does NOT delete
existing artifact rows from SQLite — it just adds the path to ignored.yaml
so future Reads suppress warnings.

If the command exits 3, the coordinator refused because a path is enforced
in strict mode, and nothing was untracked. Report the refused paths and the
next step the message names (remove the entry from
`.coherence/strict_mode.yaml`, then restart the coordinator). Do not edit
those files yourself unless the user asks you to. The bundled Node
coordinator refuses this way, and so does a Python coordinator from an
`agent-coherence` release after 0.14.1.

If no paths were given, ask the user which workspace-relative path(s) they
want to untrack. Don't invoke the CLI without arguments: the bundled Node CLI exits 1 with no output, and the Python console script exits 2 with a usage error.
