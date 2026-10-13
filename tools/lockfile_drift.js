#!/usr/bin/env node
// Copyright (c) 2026 Arbiter contributors.
// The Coherence Protocol for AI Agents

/**
 * Pure comparison behind the lockfile-drift check: does `dev` install any
 * package version older than `main` does?
 *
 * No I/O, no `gh`, no filesystem. `tools/check_release_readiness.js` holds the
 * thin wrapper that fetches both lockfiles, and `tools/check_lockfile_drift.js`
 * is the CLI. This module exists because the comparison is a library concern
 * that the release preflight never runs, mirroring `check_versions_synced.js`.
 *
 * WHY THE CHECK EXISTS. Dependabot builds its dependency graph from the DEFAULT
 * branch only, so a security advisory raises exactly one alert and one PR, both
 * scoped to `main`, and `dev` is never examined even though every feature
 * branch is cut from it. Alert #5 (js-yaml) recorded `fixed_at` four seconds
 * after the fix merged to `main` and forty-one minutes before `dev` was
 * patched; alert #6, the same package, closed five seconds after its merge.
 *
 * HOW THE COMPARISON IS KEYED, and why it has been wrong twice before. The key
 * is `name@major`, and each side collapses to the LOWEST **and HIGHEST**
 * version in that lineage:
 *
 *   - Not by lockfile path: npm hoists a package between `node_modules/x` and
 *     `node_modules/dep/node_modules/x`, so a path key misses `dev` holding a
 *     vulnerable copy nested under a dependency.
 *   - Not by bare name: one name is routinely installed at two lineages at once
 *     (this repo has `ignore` at 5.3.2 and 7.0.5), which collapses both sides to
 *     a shared minimum and hides a bump to the higher lineage.
 *   - Not by the lowest alone. That is correct on the dev side and catches a
 *     branch carrying both a patched and a vulnerable copy, but it INVERTS on
 *     the main side: if main holds two same-major copies, its aggregate
 *     collapses to the older one and a dev sitting at exactly that version
 *     compares equal and is certified clean — the precise alert shape the check
 *     exists for, reported as healthy.
 *
 * Tracking both ends fixes that because "is dev behind" is an interval
 * question, not a point question: dev is behind when its lowest is under main's
 * lowest (it installs something older than anything main has) or its highest is
 * under main's highest (it never received a bump main has). Verified against
 * eleven shapes including every one that broke an earlier keying.
 *
 * A `main` lineage with no `dev` counterpart falls back to dev's highest LOWER
 * major, so a bump crossing a major boundary is caught: without that fallback,
 * replaying the twenty packages this check found on its first live run reports
 * seventeen, silently dropping `file-entry-cache` 8->11, `flat-cache` 4->6 and
 * `keyv` 4->5. A lineage dev carries and main does not is dev's own tree, not
 * drift, and is deliberately not flagged.
 */

/** A version this guard is willing to order. Anything else is skipped, never guessed. */
export const PLAIN_VERSION = /^\d+(?:\.\d+)*$/;

/**
 * Compare two dotted numeric versions -> -1 | 0 | 1, or null when either side
 * is not plainly comparable (prerelease, git ref, `link:`/`file:` specifier).
 *
 * Null means "do not judge". A wrong verdict here is a false red on a release
 * branch, and the drift this guard exists to catch is always a plain version
 * bump, so skipping the exotic cases costs nothing real.
 */
export function comparePlainVersions(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  if (!PLAIN_VERSION.test(a) || !PLAIN_VERSION.test(b)) return null;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Collapse a lockfile's `packages{}` to `name@major` -> the lowest and highest
 * version installed in that lineage, each with the path it came from.
 *
 * Entries whose version this guard cannot order are dropped here rather than
 * at comparison time. That filter is load-bearing and easy to mistake for
 * belt-and-braces: without it a prerelease can claim a lineage slot first and
 * never be dethroned, because `comparePlainVersions` returns null rather than
 * -1 against it, so a genuinely drifted lineage reads clean.
 *
 * An npm alias (`"node_modules/lru": { name: "lru-cache", version: ... }`)
 * resolves through its `name` field, so two branches aliasing one specifier to
 * different packages group under different names and are never compared.
 */
export function versionSpanByLineage(packages) {
  const spans = new Map();
  for (const [path, entry] of Object.entries(packages)) {
    // The root "" entry is the project's own version: main sits at the released
    // one and dev at the in-flight one, so it drifts in both directions by
    // design and says nothing about dependencies.
    if (path === '') continue;
    if (entry == null || typeof entry !== 'object') continue;
    if (typeof entry.version !== 'string' || !PLAIN_VERSION.test(entry.version)) continue;
    const name =
      typeof entry.name === 'string' && entry.name !== ''
        ? entry.name
        : path.split('node_modules/').pop();
    if (!name) continue;
    const major = Number(entry.version.split('.')[0]);
    const key = `${name}@${major}`;
    const current = spans.get(key);
    if (current === undefined) {
      spans.set(key, {
        name,
        major,
        lowest: entry.version,
        highest: entry.version,
        lowestPath: path,
        highestPath: path,
      });
      continue;
    }
    if (comparePlainVersions(entry.version, current.lowest) === -1) {
      current.lowest = entry.version;
      current.lowestPath = path;
    }
    if (comparePlainVersions(entry.version, current.highest) === 1) {
      current.highest = entry.version;
      current.highestPath = path;
    }
  }
  return spans;
}

/**
 * The dev-side lineage a main-side lineage should be compared against, or null
 * when dev carries nothing comparable.
 *
 * Same lineage on both sides is the ordinary case. When dev has no entry in
 * that lineage, fall back to dev's highest LOWER major of the same name: that
 * is a bump which crossed a major boundary and never reached dev.
 */
export function devCounterpart(devSpans, mainSpan) {
  const exact = devSpans.get(`${mainSpan.name}@${mainSpan.major}`);
  if (exact !== undefined) return exact;
  let best = null;
  for (const candidate of devSpans.values()) {
    if (candidate.name !== mainSpan.name) continue;
    if (candidate.major >= mainSpan.major) continue;
    if (best === null || candidate.major > best.major) best = candidate;
  }
  return best;
}

/**
 * A `packages{}` map is usable evidence only when it is an object carrying a
 * well-formed root entry.
 *
 * npm always writes the root `""` entry as an object with a version, so this
 * separates a real lockfile from a structurally invalid one. Both halves
 * matter: without the key check, `{"packages":{}}` compares nothing and reaches
 * the certifying PASS text; without the value check, `{"packages":{"":null}}`
 * does the same. A real project with no dependencies still has its root entry
 * and is accepted.
 */
function usablePackages(packages) {
  if (packages == null || typeof packages !== 'object' || Array.isArray(packages)) return false;
  if (!Object.hasOwn(packages, '')) return false;
  const root = packages[''];
  if (root == null || typeof root !== 'object' || Array.isArray(root)) return false;
  return typeof root.version === 'string';
}

/**
 * Pure verdict over the two branches' package-lock.json bodies.
 *
 * Returns `{ ok, reason, detail }` where `reason` is `clean`, `drift`, or
 * `unreadable`. The caller needs that discriminator because "dev is behind" and
 * "the check could not read its evidence" are both failures but mean opposite
 * things to an operator, and only one of them justifies telling them dev is
 * missing an update.
 *
 * What the drift costs: dev, and every feature branch cut from it, installs and
 * CI-tests the older version. It does NOT silently regress main at release time
 * — a three-way merge keeps main's side of a line dev never touched, verified
 * against a real merge. Do not restore the stronger claim.
 */
export function evaluateLockfileDrift(mainLock, devLock) {
  const mainPkgs = mainLock?.packages;
  const devPkgs = devLock?.packages;
  if (!usablePackages(mainPkgs) || !usablePackages(devPkgs)) {
    return {
      ok: false,
      reason: 'unreadable',
      detail:
        'could not read a well-formed `packages{}` from one or both lockfiles — ' +
        'cannot prove dev is patched',
    };
  }

  const mainSpans = versionSpanByLineage(mainPkgs);
  const devSpans = versionSpanByLineage(devPkgs);

  const behind = [];
  let anyTopLevel = false;
  for (const mainSpan of mainSpans.values()) {
    const devSpan = devCounterpart(devSpans, mainSpan);
    if (devSpan === null || devSpan === undefined) continue;

    // Two independent ways dev can be behind in one lineage. Lowest catches a
    // branch that installs something older than anything main installs; highest
    // catches a bump main received that dev never did. Report whichever fires,
    // preferring the lowest because it names the oldest thing dev actually runs.
    let devVersion = null;
    let mainVersion = null;
    let devPath = null;
    if (comparePlainVersions(devSpan.lowest, mainSpan.lowest) === -1) {
      devVersion = devSpan.lowest;
      mainVersion = mainSpan.lowest;
      devPath = devSpan.lowestPath;
    } else if (comparePlainVersions(devSpan.highest, mainSpan.highest) === -1) {
      devVersion = devSpan.highest;
      mainVersion = mainSpan.highest;
      devPath = devSpan.highestPath;
    }
    if (devVersion === null) continue;

    // Name the nesting when the older copy is not the top-level one; the bare
    // lockfile path reads like a scoped package name and is not something
    // `npm ls` or an advisory would accept.
    const isNested = devPath.includes('/node_modules/');
    if (!isNested) anyTopLevel = true;
    const nested = isNested ? ` [dev's older copy is nested at ${devPath}]` : '';
    behind.push(`${mainSpan.name} (dev ${devVersion} < main ${mainVersion})${nested}`);
  }

  if (behind.length > 0) {
    behind.sort();
    // The remedy depends on where the older copy sits. A top-level copy is the
    // missed-forward-merge case the check exists for. When EVERY older copy is
    // nested, main may not carry that package at that position at all, and
    // merging main into dev cannot change dev's own transitive tree — naming
    // the forward-merge there strands the operator at a gate it cannot clear.
    const remedy = anyTopLevel
      ? 'Dependabot security updates only ever patch the default branch, so a green security alert ' +
        'does not mean dev is patched — forward-merge main into dev. The forward-merge-main workflow ' +
        'normally does this, so check its latest run and its chore/auto-forward-merge-main PR first; ' +
        'docs/RELEASE.md §3 step 5 documents the manual mechanics for a conflict.'
      : "Every older copy above is nested under one of dev's dependencies, so check whether main " +
        'carries that package at that position at all — if it does not, this is dev’s own ' +
        'transitive tree and a forward-merge will not clear it.';
    return {
      ok: false,
      reason: 'drift',
      detail: `dev is behind main on ${behind.length} package(s): ${behind.join(', ')}. ${remedy}`,
    };
  }
  return { ok: true, reason: 'clean', detail: "no package in dev's lockfile is older than main's" };
}
