/**
 * The coordinator's own read of a file's bytes on disk, for pre-edit's
 * out-of-band change check (#205). Node port of the library's
 * `disk_content.hash_regular_file`.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** Python `disk_content.DEFAULT_MAX_HASH_BYTES`: a larger file is not hashed (inclusive bound). */
const DEFAULT_MAX_HASH_BYTES = 64 * 1024 * 1024;

const CHUNK_BYTES = 1024 * 1024;

/**
 * sha256 hex of a regular file's raw bytes, or null when the path is not one
 * the coordinator should vouch for: missing or unreadable, a symlink at the
 * leaf (O_NOFOLLOW), anything but a regular file, or larger than `maxBytes`.
 * O_NONBLOCK keeps a FIFO from blocking the open; the fstat then rejects it.
 * The read stops one byte past the cap, so a file that grew after the fstat
 * is refused rather than hashed in part.
 */
export function hashRegularFile(path: string, maxBytes: number = DEFAULT_MAX_HASH_BYTES): string | null {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return null;
    const hash = createHash("sha256");
    // Sized to the file (one spare byte detects growth), not the cap: tracked files are small.
    const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, info.size + 1));
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) return null;
      hash.update(buf.subarray(0, n));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
