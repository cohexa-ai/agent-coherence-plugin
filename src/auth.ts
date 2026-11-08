/**
 * Bearer-token + Host-header authentication for the Node coordinator.
 *
 * Parity with the Python coordinator's auth.py (KTD-12 + KTD-A.5):
 * - Shared `hook.secret` file at `<workspace>/.coherence/hook.secret`, mode 0600.
 *   Both Python and Node coordinators read this file; switching backends does
 *   NOT rotate the secret (rotation is a v0.2 backlog item).
 * - Atomic create via `O_WRONLY | O_CREAT | O_EXCL, 0o600` (KTD-A.5 point 2);
 *   if file exists, read it (last-writer-wins-but-content-identical).
 * - Constant-time Bearer compare via `crypto.timingSafeEqual` (KTD-A.5 point 5);
 *   NOT `===`, which short-circuits on first mismatch and leaks token prefix
 *   via response timing.
 * - Host-header allowlist (`localhost`, `127.0.0.1`) defeats DNS rebinding;
 *   `bind_host = 127.0.0.1` is a locked invariant per Open Questions.
 *
 * v0.1 plan KTD-12 + v0.1.1 plan KTD-A.5 + KTD-K item ("Tighten ensure_secret
 * empty-file recovery branch") are the canonical references.
 */
import { constants as fsConstants, openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { coherenceDirRefusalMessage } from "./coherence_dir.js";
import { NOT_REGULAR, readStateFile } from "./disk_content.js";

const SECRET_BYTES = 32;
const SECRET_HEX_LEN = SECRET_BYTES * 2;
/** More than any secret a coordinator writes: a larger hook.secret is malformed, not read whole. */
export const MAX_SECRET_FILE_BYTES = 4096;
const ALLOWED_HOSTS: ReadonlyArray<string> = ["localhost", "127.0.0.1"];

const RECOVERY_MAX_ATTEMPTS = 5;

/**
 * Read existing hook.secret or atomically create a new one.
 *
 * Primary path (file does not exist): O_WRONLY|O_CREAT|O_EXCL with mode 0600.
 * Recovery path (file exists but empty, e.g. previous instance died after
 * creating the file but before writing the secret): bounded O_EXCL retry loop,
 * fail closed after N attempts per KTD-K renamed item.
 */
export function ensureSecret(coherenceDir: string): string {
  mkdirSync(coherenceDir, { recursive: true, mode: 0o700 });
  const path = join(coherenceDir, "hook.secret");

  for (let attempt = 1; attempt <= RECOVERY_MAX_ATTEMPTS; attempt++) {
    // Try atomic create.
    try {
      const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      const token = randomBytes(SECRET_BYTES).toString("hex");
      writeSync(fd, token);
      closeSync(fd);
      return token;
    } catch (err) {
      // Most likely EEXIST: file was created by another process between our
      // exists-check and our create. Try to read it.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }

    // Read existing. If valid (correct length), return it. Never through a
    // link, which made the file it names this coordinator's bearer, and never
    // blocking on a FIFO, which held the start (#251).
    let existing = "";
    try {
      existing = readStateFile(coherenceDir, "hook.secret", MAX_SECRET_FILE_BYTES).toString("utf8").trim();
    } catch (err) {
      const { code, path: refused } = err as NodeJS.ErrnoException;
      if (code === "ELOOP") {
        throw new Error(coherenceDirRefusalMessage({ kind: "link", path: refused ?? path, more: 0 }, coherenceDir));
      }
      if (code === NOT_REGULAR) {
        throw new Error(`ensureSecret: ${path} is not a regular file; remove it, then restart.`);
      }
      // Gone since the create failed, or too large to be a secret: both take
      // the bounded retry below.
      if (code !== "ENOENT" && code !== "EFBIG") throw err;
    }
    if (existing.length === SECRET_HEX_LEN) {
      return existing;
    }

    // Recovery branch: file exists but is empty or malformed. Per KTD-K, do
    // NOT O_TRUNC re-write (race window where a concurrent racer's valid
    // secret can be clobbered). Instead, bounded O_EXCL retry. Wait a short
    // jittered interval and re-try; eventually some other writer wins the
    // race cleanly, or we fail closed after N attempts.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 30));
  }

  throw new Error(
    `ensureSecret: hook.secret at ${path} exists but is malformed (length ${SECRET_HEX_LEN} expected); ` +
      `bounded O_EXCL retry exhausted after ${RECOVERY_MAX_ATTEMPTS} attempts. ` +
      `Resolution: stop all coordinator processes, remove the file, restart.`,
  );
}

/** Constant-time Bearer token comparison. Returns false on any mismatch or malformed Authorization header. */
export function verifyBearer(req: IncomingMessage, expectedSecret: string): boolean {
  const auth = req.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
    return false;
  }
  const presented = auth.slice("Bearer ".length).trim();
  if (presented.length !== expectedSecret.length) {
    // Length-mismatch short-circuit is acceptable (and necessary — timingSafeEqual
    // requires equal-length buffers). The length itself is the secret's length,
    // which is a public-knowledge constant (SECRET_HEX_LEN), not a per-secret leak.
    return false;
  }
  const presentedBuf = Buffer.from(presented, "utf8");
  const expectedBuf = Buffer.from(expectedSecret, "utf8");
  return timingSafeEqual(presentedBuf, expectedBuf);
}

/** Host-header allowlist check; defeats DNS rebinding from non-loopback origins. */
export function verifyHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (typeof host !== "string" || host.length === 0) {
    return false;
  }
  // Host header is "hostname" or "hostname:port"; split on last ":" to handle
  // both IPv4 and "localhost" cases. (No IPv6 support in v0.1.1 — bind_host is
  // a locked invariant at 127.0.0.1 per Open Questions.)
  const hostname = host.includes(":") ? host.slice(0, host.lastIndexOf(":")) : host;
  return ALLOWED_HOSTS.includes(hostname);
}
