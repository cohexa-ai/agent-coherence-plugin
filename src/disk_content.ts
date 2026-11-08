/**
 * The coordinator's own read of a file's bytes on disk, for pre-edit's
 * out-of-band change check (#205). Node port of the library's
 * `disk_content.hash_regular_file`.
 *
 * Its open is also the one reader for files under .coherence (#251), where a
 * repository can commit a symlink or a FIFO.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

/** Python `disk_content.DEFAULT_MAX_HASH_BYTES`: a larger file is not hashed (inclusive bound). */
const DEFAULT_MAX_HASH_BYTES = 64 * 1024 * 1024;

const CHUNK_BYTES = 1024 * 1024;

const NO_FOLLOW_READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * sha256 hex of a regular file's raw bytes, or null when the path is not one
 * the coordinator should vouch for: missing or unreadable, a symlink at the
 * leaf (O_NOFOLLOW), anything but a regular file, or larger than `maxBytes`.
 * O_NONBLOCK keeps a FIFO from blocking the open; the fstat then rejects it.
 * The read stops one byte past the cap, so a file that grew after the fstat
 * is refused rather than hashed in part.
 */
export function hashRegularFile(path: string, maxBytes: number = DEFAULT_MAX_HASH_BYTES): string | null {
  let opened: { fd: number; size: number };
  try {
    opened = openRegularFile(path);
  } catch {
    return null;
  }
  const { fd, size } = opened;
  try {
    if (size > maxBytes) return null;
    const hash = createHash("sha256");
    return drainWithin(fd, size, maxBytes, (chunk) => hash.update(chunk)) ? hash.digest("hex") : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads `fd` to its end, handing each chunk to `sink`; false, with the rest
 * left unread, once more than `maxBytes` came.
 */
function drainWithin(fd: number, size: number, maxBytes: number, sink: (chunk: Buffer) => void): boolean {
  // Sized to the file (one spare byte detects growth), not the cap: tracked files are small.
  const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size + 1));
  let total = 0;
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, null);
    if (n === 0) return true;
    total += n;
    if (total > maxBytes) return false;
    sink(buf.subarray(0, n));
  }
}

/** `code` of the error for a path that names a FIFO, a socket or a device: not a regular file, not a directory. */
export const NOT_REGULAR = "ENOTREG";

function fileError(path: string, code: string, what: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${path} ${what}`), { code, path });
}

/** False when the lstat fails, as it does for a missing path. */
export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * An fd on the regular file at `path`, and its size; the caller closes it.
 * Never follows a symlink at the leaf (O_NOFOLLOW) and never blocks on a FIFO
 * (O_NONBLOCK). A failed open is put down to a link (code ELOOP) only when
 * lstat shows one: the errno O_NOFOLLOW gives differs by platform and by what
 * the link names. A directory throws EISDIR, as a plain read does, and
 * anything else that is not a regular file throws NOT_REGULAR. Any other
 * failure is the open's own error.
 */
export function openRegularFile(path: string): { fd: number; size: number } {
  let fd: number;
  try {
    fd = openSync(path, NO_FOLLOW_READ);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && isSymlink(path)) {
      throw fileError(path, "ELOOP", "is a symlink");
    }
    throw err;
  }
  try {
    const info = fstatSync(fd);
    if (info.isDirectory()) throw fileError(path, "EISDIR", "is a directory");
    if (!info.isFile()) throw fileError(path, NOT_REGULAR, "is not a regular file");
    return { fd, size: info.size };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/**
 * The bytes of the regular file at `path`, opened as openRegularFile opens it.
 * EFBIG when it holds more than `maxBytes`; the read stops one byte past the
 * cap, so a file that grew after the fstat is refused rather than cut short.
 */
export function readRegularFile(path: string, maxBytes = Number.POSITIVE_INFINITY): Buffer {
  const { fd, size } = openRegularFile(path);
  const tooBig = () => fileError(path, "EFBIG", `is larger than ${maxBytes} bytes`);
  try {
    if (size > maxBytes) throw tooBig();
    let bytes = Buffer.allocUnsafe(size);
    let total = 0;
    const within = drainWithin(fd, size, maxBytes, (chunk) => {
      // Only a file that grew after the fstat outgrows it; doubling keeps that copy linear.
      if (total + chunk.length > bytes.length) {
        bytes = Buffer.concat([bytes.subarray(0, total)], 2 * (total + chunk.length));
      }
      total += chunk.copy(bytes, total);
    });
    if (!within) throw tooBig();
    return bytes.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

/** More than any secret a coordinator writes: a larger hook.secret is malformed, not read whole. */
export const MAX_SECRET_FILE_BYTES = 4096;

/**
 * The bytes of `name` directly inside `coherenceDir`, read as readRegularFile
 * reads them, once `coherenceDir` itself is known not to be a symlink (ELOOP,
 * with `path` the directory). O_NOFOLLOW guards the last component only:
 * through a linked .coherence the leaf is another directory's regular file.
 */
export function readStateFile(coherenceDir: string, name: string, maxBytes?: number): Buffer {
  if (isSymlink(coherenceDir)) throw fileError(coherenceDir, "ELOOP", "is a symlink");
  return readRegularFile(join(coherenceDir, name), maxBytes);
}
