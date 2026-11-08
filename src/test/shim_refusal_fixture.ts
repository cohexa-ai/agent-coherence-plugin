/**
 * What a SessionStart shim answers when its `.coherence` check refuses the
 * start: exit 0, one line on stderr, and one SessionStart JSON object on
 * stdout, so both the user and the model learn that this start started no
 * coordinator.
 *
 * The texts are the shims' own, written out here so a test pins them byte for
 * byte: the JSON must be the whole of stdout, or Claude Code reads it as plain
 * text.
 */

export type ShimRefusalKind = 'link' | 'not_a_directory' | 'special';

const REASONS: Record<ShimRefusalKind, { what: string; fix: string }> = {
  link: {
    what: 'is a symlink',
    fix: 'Replace it with a copy of the file it names, or mount a directory at .coherence, then start a new session.',
  },
  not_a_directory: { what: 'is not a directory', fix: 'Move it aside, then start a new session.' },
  special: { what: 'is a FIFO, socket or device', fix: 'Remove it, then start a new session.' },
};

/**
 * A link at `.coherence` itself names a directory, not a file, and a link at
 * the store or one of its sidecars must move with the rest: a copy of
 * state.db alone loses its latest history.
 */
const LINK_FIXES: Array<[RegExp, string]> = [
  [
    /^\.coherence$/,
    'Replace the link with a real directory and copy in the files you want to keep (move state.db together with its -wal and -shm), or mount a directory at .coherence, then start a new session.',
  ],
  [
    /^\.coherence\/(state|workspace)\.db/,
    'Replace it with a copy of the file it names (move state.db together with its -wal and -shm), or mount a directory at .coherence, then start a new session.',
  ],
];

function fixFor(name: string, kind: ShimRefusalKind): string {
  const linkFix = kind === 'link' ? LINK_FIXES.find(([pattern]) => pattern.test(name)) : undefined;
  return linkFix?.[1] ?? REASONS[kind].fix;
}

export interface ShimAnswer {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The answer of a start refused for `name`: `.coherence`, or
 * `.coherence/<entry>` with every byte outside `A-Za-z0-9._/-` shown as `?`.
 */
export function shimRefusal(name: string, kind: ShimRefusalKind): ShimAnswer {
  const why = `${name} ${REASONS[kind].what}`;
  const fix = fixFor(name, kind);
  const answer = {
    systemMessage: `agent-coherence is off for this session: ${why}. ${fix}`,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      // Only what the shim knows: a coordinator already running for the
      // workspace still answers the hooks, whatever this start refused.
      additionalContext:
        `agent-coherence did not start a coordinator at this session start, because ${why}. ` +
        'Hooks may still answer from a coordinator already running for this workspace: ' +
        'treat any warning or deny they give as real, and do not assume edits are coordinated otherwise. ' +
        'Tell the user.',
    },
  };
  return {
    status: 0,
    stdout: `${JSON.stringify(answer)}\n`,
    stderr: `agent-coherence: not starting the coordinator: ${why}. ${fix}\n`,
  };
}
