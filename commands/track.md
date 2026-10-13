---
description: "Add one or more workspace-relative paths to the coordinator's tracked set."
argument-hint: "<path> [<path>...]"
allowed-tools: ["Bash"]
---

Run `agent-coherence-track $ARGUMENTS` and report the output.

The command's stdout lists each successfully tracked path (one per line,
prefix `agent-coherence-track: tracked <path>`). Stderr carries any
warnings (e.g., "does not exist on disk yet" — the path is still tracked;
it'll be seeded on first Read) and rejections (invalid path syntax or
server-side rejections).

If no paths were given, ask the user which workspace-relative path(s) they
want to track. Don't invoke the CLI without arguments — argparse will error.

Don't second-guess the user's path choices; the coordinator's policy
validator rejects path traversal and absolute paths.
