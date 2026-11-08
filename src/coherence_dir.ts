/**
 * The start check (#251; cohexa-ai/agent-coherence#498): `.coherence` must be
 * absent or a real directory, and nothing directly inside it may be a symlink,
 * a FIFO, a socket or a device.
 *
 * A repository can commit a symlink there, and every start would then read or
 * write the file it names; a FIFO or a device can block an open. No
 * coordinator creates any of them. A directory mounted at `.coherence` is a
 * directory to lstat, so it passes, and so does a real subdirectory. The check
 * lstats and lists; it opens no file and runs no git, so nothing it finds can
 * block it.
 *
 * The outcomes and the texts are the library's start check's, kept
 * byte-identical, so both coordinators refuse the same workspace in the same
 * words.
 */
import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import { escapeNonprintable } from './cli_output.js';

/**
 * What a start refuses: `.coherence` itself (`path` is then the very string
 * the check was given), or the first offending entry in byte order, with how
 * many more entries of the same kind there are.
 */
export interface CoherenceDirRefusal {
  kind: 'link' | 'not_a_directory' | 'special';
  path: string;
  more: number;
}

/** The exit status of a refused start: the library coordinator's for a start it refuses. */
export const EXIT_REFUSED = 2;

/**
 * The refusal for `coherenceDir`, or null when it is absent (a start creates
 * it) or clean. Throws when it cannot tell: an lstat or a listing that fails
 * for another reason than ENOENT. There is no mode repair here, so a
 * directory it cannot list is never taken as clean.
 */
export function checkCoherenceDir(coherenceDir: string): CoherenceDirRefusal | null {
  let info;
  try {
    info = lstatSync(coherenceDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (info.isSymbolicLink()) return { kind: 'link', path: coherenceDir, more: 0 };
  if (!info.isDirectory()) return { kind: 'not_a_directory', path: coherenceDir, more: 0 };
  const { links, specials } = offendingEntries(coherenceDir);
  // Links first: a link is the refusal whatever else is there.
  const [first, ...rest] = links.length > 0 ? links : specials;
  if (first === undefined) return null;
  return {
    kind: links.length > 0 ? 'link' : 'special',
    path: join(coherenceDir, first.toString('utf8')),
    more: rest.length,
  };
}

function offendingEntries(coherenceDir: string): { links: Buffer[]; specials: Buffer[] } {
  const links: Buffer[] = [];
  const specials: Buffer[] = [];
  // Buffer names: on Linux a name that is not UTF-8 would decode to a string no lstat can find.
  let entries: Dirent<Buffer>[];
  try {
    entries = readdirSync(coherenceDir, { withFileTypes: true, encoding: 'buffer' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { links, specials };
    throw err;
  }
  for (const entry of entries) {
    const kind = entryKind(coherenceDir, entry);
    if (kind === 'link') links.push(entry.name);
    else if (kind === 'special') specials.push(entry.name);
  }
  return { links: links.sort(Buffer.compare), specials: specials.sort(Buffer.compare) };
}

function entryKind(coherenceDir: string, entry: Dirent<Buffer>): 'link' | 'special' | null {
  if (entry.isSymbolicLink()) return 'link';
  if (entry.isFile() || entry.isDirectory()) return null;
  // A FIFO, socket or device by its directory entry, or a file system that
  // reports no type: lstat decides, and an entry gone since the listing (a
  // policy file's temporary copy renamed away) is not counted.
  let info;
  try {
    info = lstatSync(Buffer.concat([Buffer.from(`${coherenceDir}/`), entry.name]));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (info.isSymbolicLink()) return 'link';
  return info.isFile() || info.isDirectory() ? null : 'special';
}

/** The one line a start prints for `refusal`, escaped for a terminal: path names come from the repository. */
export function coherenceDirRefusalMessage(
  refusal: CoherenceDirRefusal,
  coherenceDir: string
): string {
  return escapeNonprintable(refusalText(refusal, coherenceDir));
}

// History lives across the store and its sidecars: a copy of state.db alone loses it.
const STORE_NOTE = 'move state.db together with its -wal and -shm';

function refusalText({ kind, path, more }: CoherenceDirRefusal, coherenceDir: string): string {
  if (kind === 'not_a_directory') {
    return `refusing ${path}: it is not a directory. Move it aside; a start then creates .coherence as a real directory.`;
  }
  if (kind === 'special') {
    return (
      `refusing ${path}: it is a FIFO, socket or device, which no coordinator creates, and opening it can ` +
      `block a start. Remove it, then start again.` +
      moreText(more, 'is a FIFO, socket or device', 'are FIFOs, sockets or devices')
    );
  }
  if (path === coherenceDir) {
    return (
      `refusing ${path}: it is a symlink, and .coherence must be a real directory. Replace the link with a ` +
      `real directory and copy in the files you want to keep (${STORE_NOTE}), or mount a directory at ${path}.`
    );
  }
  const storeNote = /^(state|workspace)\.db/.test(basename(path)) ? ` (${STORE_NOTE})` : '';
  return (
    `refusing ${path}: it is a symlink, and .coherence must be a real directory with no link directly ` +
    `inside it. Replace the link with a copy of the file it names${storeNote}, or mount a directory at ` +
    `${coherenceDir}.` +
    moreText(more, 'is a link', 'are links')
  );
}

function moreText(more: number, one: string, many: string): string {
  if (more === 0) return '';
  return more === 1
    ? ` 1 more entry in .coherence ${one} too.`
    : ` ${more} more entries in .coherence ${many} too.`;
}
