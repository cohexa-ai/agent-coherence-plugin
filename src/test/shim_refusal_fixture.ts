/**
 * What a SessionStart shim answers when its `.coherence` check refuses the
 * start: exit 0, one line on stderr, and one SessionStart JSON object on
 * stdout, so both the user and the model learn that coherence is off.
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
  const { what, fix } = REASONS[kind];
  const why = `${name} ${what}`;
  const answer = {
    systemMessage: `agent-coherence is off for this session: ${why}. ${fix}`,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `agent-coherence is OFF for this session: its coordinator was not started because ${why}. ` +
        'No hook will warn about a stale read or stop a conflicting edit. ' +
        'Tell the user, and do not assume edits are coordinated.',
    },
  };
  return {
    status: 0,
    stdout: `${JSON.stringify(answer)}\n`,
    stderr: `agent-coherence: not starting the coordinator: ${why}. ${fix}\n`,
  };
}
