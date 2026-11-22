/**
 * Coordinator version, read from package.json at startup.
 *
 * package.json is the single source of truth — the previous hand-maintained
 * `VERSION` constant in coordinator.ts silently drifted (stuck at 0.1.1
 * through the 0.2.x/0.3.x releases). A static `import ... from
 * "../package.json"` can't replace it: tsconfig pins `rootDir: "src"`, and
 * pulling package.json into the program would violate that (or force a
 * dist/src/* layout change). Runtime read keeps the dist layout untouched.
 *
 * Layout invariant: package.json sits one directory above this compiled
 * module (dist/version.js → repo root). That holds in the repo checkout and
 * in installed plugins, where bin/ensure-coordinator-node puts package.json
 * (Stage 1) and dist/ (Stage 2) as siblings in each build under
 * ${CLAUDE_PLUGIN_DATA}/builds/ — and Stage 4 only spawns the coordinator from
 * a build it verified whole.
 * version_source.test.ts pins the resolution.
 */
import { readFileSync } from "node:fs";

export function readPackageVersion(): string {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version === "") {
    throw new Error(`no usable "version" field in ${packageJsonUrl.pathname}`);
  }
  return parsed.version;
}
