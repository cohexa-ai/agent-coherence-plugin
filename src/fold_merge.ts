/**
 * The start-time merge of file rows an older build split for one file, and
 * the start step that builds the registry's fold index after it.
 *
 * An older build keyed rows by the request's spelling, so `data/x.txt` and
 * `DATA/X.TXT` (or an NFC and an NFD spelling) could each get a row for what
 * the disk keeps as one file, each with its own write grant. A group is file
 * rows whose fold keys collide under the active profile AND whose names reach
 * the same existing file under the workspace root (same st_dev and st_ino):
 * a key alone could merge two real files the profile does not model, and a
 * file that is absent right now cannot confirm anything.
 *
 * This module gathers the file facts (the only filesystem calls) and holds
 * the pure planner; the registry re-reads the rows inside its transaction,
 * plans with them and applies the plan, so it never touches the disk itself.
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { hashRegularFile } from './disk_content.js';
import type { ArtifactRegistry } from './registry.js';
import type { FoldProfileResult } from './fs_profile.js';
import { exceedsFoldLimit, foldKey, type FoldProfile } from './path_fold.js';
import { MESIState, isWriter } from './states.js';

/**
 * The preempter a merge-demoted holder's notice names, so the holder can tell
 * that no agent took its grant: `uuid5(NAMESPACE_URL,
 * "ccs-coordinator-fold-merge:merged-spellings")` as hex. A literal keeps the
 * value identical to the Python coordinator's; a test pins the derivation.
 */
export const FOLD_MERGE_PREEMPTER_ID = '707e50c79be1538fa2ac5d849131619e';

/** The reclaim trigger recorded on a holder that lost its grant to a fold rule. */
export const FOLD_MERGE_TRIGGER = 'fold_merge';

/**
 * The index key of a stored name. A name over the fold limit is never folded
 * (the door refuses such a request), so it is listed under itself.
 */
export function indexKeyOf(name: string, profile: FoldProfile): string {
  return exceedsFoldLimit(name) ? name : foldKey(name, profile);
}

/** A file row as detection and the index see it; rowid order is insertion order. */
export interface FoldRow {
  readonly rowid: number;
  readonly id: string;
  readonly name: string;
}

/** Rows of one file, found read-only at start, and what the disk holds for it. */
export interface FoldGroup {
  readonly profile: FoldProfile;
  readonly key: string;
  /** Row ids, lowest rowid first. */
  readonly ids: readonly string[];
  /** The disk's spelling of the file, relative to the canonical workspace root. */
  readonly diskSpelling: string | null;
  /** sha-256 hex of the file's bytes, the format the hook clients record; null when unreadable. */
  readonly diskHash: string | null;
}

/** Where one row's name leads on disk. */
export interface ResolvedFile {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly realPath: string;
  readonly diskSpelling: string;
}

export interface SameFileRows {
  readonly rows: readonly FoldRow[];
  readonly file: ResolvedFile;
}

/** File rows whose keys collide, by key, each list in rowid order. */
export function collidingRows(
  rows: readonly FoldRow[],
  profile: FoldProfile
): Map<string, FoldRow[]> {
  const byKey = new Map<string, FoldRow[]>();
  for (const row of rows) {
    const key = indexKeyOf(row.name, profile);
    const keyed = byKey.get(key) ?? [];
    keyed.push(row);
    byKey.set(key, keyed);
  }
  return new Map([...byKey].filter(([, keyed]) => keyed.length > 1));
}

/**
 * Split rows that share a key by the file each name reaches; only files two
 * or more rows reach form a group. `resolved[i]` belongs to `rows[i]`, null
 * when that name reaches no file.
 */
export function sameFileGroups(
  rows: readonly FoldRow[],
  resolved: ReadonlyArray<ResolvedFile | null>
): SameFileRows[] {
  const byFile = new Map<string, { rows: FoldRow[]; file: ResolvedFile }>();
  rows.forEach((row, index) => {
    const file = resolved[index];
    if (file === null || file === undefined) return;
    const identity = `${file.dev}:${file.ino}`;
    const entry = byFile.get(identity) ?? { rows: [], file };
    entry.rows.push(row);
    byFile.set(identity, entry);
  });
  return [...byFile.values()].filter((entry) => entry.rows.length > 1);
}

function isInsideRoot(spelling: string): boolean {
  return (
    spelling !== '' && spelling !== '..' && !spelling.startsWith('../') && !isAbsolute(spelling)
  );
}

/**
 * The file `name` reaches under the canonical root, through the platform's
 * own resolver, so the spelling is the one the disk stores. Null when the
 * name reaches nothing, or reaches something outside the root.
 */
export function resolveFile(canonicalRoot: string, name: string): ResolvedFile | null {
  try {
    const realPath = realpathSync.native(join(canonicalRoot, name));
    const diskSpelling = relative(canonicalRoot, realPath);
    if (!isInsideRoot(diskSpelling)) return null;
    const info = statSync(realPath, { bigint: true });
    return { dev: info.dev, ino: info.ino, realPath, diskSpelling };
  } catch (err) {
    // A name that cannot be resolved confirms nothing: it stays out of every group.
    if ((err as NodeJS.ErrnoException).code !== undefined) return null;
    throw err;
  }
}

export interface FindGroupsInput {
  readonly rows: readonly FoldRow[];
  readonly profile: FoldProfile;
  readonly root: string;
}

function canonicalRootOf(root: string): string | null {
  try {
    return realpathSync.native(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== undefined) return null;
    throw err;
  }
}

/** Read-only: the groups of file rows the disk confirms as one file. */
export function findFoldGroups(input: FindGroupsInput): FoldGroup[] {
  const canonicalRoot = canonicalRootOf(input.root);
  if (canonicalRoot === null) return [];
  const groups: FoldGroup[] = [];
  for (const [key, rows] of collidingRows(input.rows, input.profile)) {
    const resolved = rows.map((row) => resolveFile(canonicalRoot, row.name));
    for (const { rows: grouped, file } of sameFileGroups(rows, resolved)) {
      groups.push({
        profile: input.profile,
        key,
        ids: grouped.map((row) => row.id),
        diskSpelling: file.diskSpelling,
        diskHash: hashRegularFile(file.realPath),
      });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

export interface MergeArtifactRow {
  readonly rowid: number;
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly content_hash: string;
  readonly size_tokens: number | null;
  readonly last_writer_id: string | null;
  readonly updated_at: number;
}

export interface MergeStateRow {
  readonly artifact_id: string;
  readonly agent_id: string;
  readonly state: MESIState;
  readonly transient_state: string | null;
  readonly transient_tick: number | null;
  readonly granted_at_tick: number | null;
  readonly last_reclaim_trigger: string | null;
  readonly last_reclaim_tick: number | null;
  readonly deadline_tick: number | null;
  readonly last_observed_version: number | null;
}

export interface MergeNoticeRow {
  readonly agent_id: string;
  readonly artifact_id: string;
  readonly preempter_agent_id: string;
  readonly preempted_at_unix_ts: number;
}

/** A group's rows as read inside the merge's transaction; artifacts in rowid order. */
export interface MergeSnapshot {
  readonly artifacts: readonly MergeArtifactRow[];
  readonly states: readonly MergeStateRow[];
  readonly notices: readonly MergeNoticeRow[];
}

export interface MergeFacts {
  readonly diskSpelling: string | null;
  readonly diskHash: string | null;
  readonly nowTick: number;
}

export interface MergedValues {
  readonly version: number;
  readonly content_hash: string;
  readonly size_tokens: number | null;
  readonly last_writer_id: string | null;
  readonly updated_at: number;
}

/** Everything the registry writes: the survivor's values and one state row and one notice per agent. */
export interface MergePlan {
  readonly survivorId: string;
  readonly removedIds: readonly string[];
  readonly values: MergedValues;
  readonly states: readonly MergeStateRow[];
  readonly notices: readonly MergeNoticeRow[];
  readonly keeperAgentId: string | null;
  readonly demotedWriters: readonly string[];
}

/** The row stored under the disk's spelling, else the oldest row. */
function chooseSurvivor(
  artifacts: readonly MergeArtifactRow[],
  diskSpelling: string | null
): MergeArtifactRow {
  return artifacts.find((row) => row.name === diskSpelling) ?? (artifacts[0] as MergeArtifactRow);
}

/** The row whose recorded write the disk holds, when exactly one row's hash matches it. */
function soleMatchingRow(
  artifacts: readonly MergeArtifactRow[],
  diskHash: string | null
): MergeArtifactRow | null {
  const matching = artifacts.filter((row) => diskHash !== null && row.content_hash === diskHash);
  return matching.length === 1 ? (matching[0] as MergeArtifactRow) : null;
}

/** The latest write; on a tie the oldest row, so the choice never depends on read order. */
function latestWrite(artifacts: readonly MergeArtifactRow[]): MergeArtifactRow {
  return artifacts.reduce((latest, row) => (row.updated_at > latest.updated_at ? row : latest));
}

function mergedValues(
  artifacts: readonly MergeArtifactRow[],
  matching: MergeArtifactRow | null
): MergedValues {
  const source = matching ?? latestWrite(artifacts);
  return {
    // Above every grouped version, so no holder's recorded version names the merged row's bytes.
    version: Math.max(...artifacts.map((row) => row.version)) + 1,
    content_hash: source.content_hash,
    size_tokens: source.size_tokens,
    last_writer_id: source.last_writer_id,
    updated_at: source.updated_at,
  };
}

/**
 * The single write holder of the row the disk matches. Acquire times are
 * never compared: whole-second ticks tie routinely, and a later acquire says
 * nothing about which holder read the bytes on disk.
 */
function chooseKeeper(
  states: readonly MergeStateRow[],
  matching: MergeArtifactRow | null
): MergeStateRow | null {
  if (matching === null) return null;
  const writers = states.filter((row) => row.artifact_id === matching.id && isWriter(row.state));
  return writers.length === 1 ? (writers[0] as MergeStateRow) : null;
}

/** Rows grouped by agent, agents in code-unit order; each agent's rows keep their given order. */
function rowsByAgent<Row extends { agent_id: string }>(rows: readonly Row[]): Map<string, Row[]> {
  const byAgent = new Map<string, Row[]>();
  const ordered = [...rows].sort((a, b) =>
    a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0
  );
  for (const row of ordered) {
    const agentRows = byAgent.get(row.agent_id) ?? [];
    agentRows.push(row);
    byAgent.set(row.agent_id, agentRows);
  }
  return byAgent;
}

function lowestObserved(rows: readonly MergeStateRow[]): number | null {
  const observed = rows
    .map((row) => row.last_observed_version)
    .filter((version): version is number => version !== null);
  return observed.length === 0 ? null : Math.min(...observed);
}

interface DemotionContext {
  readonly survivorId: string;
  readonly nowTick: number;
  readonly rowidOf: ReadonlyMap<string, number>;
}

/**
 * INVALID on the survivor, present and never absent, so its next commit is
 * refused: a demoted writer records the merge as its reclaim, and anyone
 * else keeps the reclaim record of its oldest row that has one.
 */
function demotedState(rows: readonly MergeStateRow[], context: DemotionContext): MergeStateRow {
  const ordered = [...rows].sort(
    (a, b) => (context.rowidOf.get(a.artifact_id) ?? 0) - (context.rowidOf.get(b.artifact_id) ?? 0)
  );
  const wasWriter = ordered.some((row) => isWriter(row.state));
  const reclaimed = ordered.find((row) => row.last_reclaim_trigger !== null);
  return {
    artifact_id: context.survivorId,
    agent_id: (ordered[0] as MergeStateRow).agent_id,
    state: MESIState.INVALID,
    transient_state: null,
    transient_tick: null,
    granted_at_tick: null,
    last_reclaim_trigger: wasWriter
      ? FOLD_MERGE_TRIGGER
      : (reclaimed?.last_reclaim_trigger ?? null),
    last_reclaim_tick: wasWriter ? context.nowTick : (reclaimed?.last_reclaim_tick ?? null),
    deadline_tick: null,
    last_observed_version: lowestObserved(ordered),
  };
}

/** The latest notice per agent, the merge's own notices counted last so they win a tie. */
function mergedNotices(
  notices: readonly MergeNoticeRow[],
  demotedWriters: readonly string[],
  context: DemotionContext
): MergeNoticeRow[] {
  const fromMerge = demotedWriters.map((agentId) => ({
    agent_id: agentId,
    artifact_id: context.survivorId,
    preempter_agent_id: FOLD_MERGE_PREEMPTER_ID,
    preempted_at_unix_ts: context.nowTick,
  }));
  return [...rowsByAgent([...notices, ...fromMerge]).values()].map((rows) => ({
    ...rows.reduce((latest, row) =>
      row.preempted_at_unix_ts >= latest.preempted_at_unix_ts ? row : latest
    ),
    artifact_id: context.survivorId,
  }));
}

/** One state row per agent on the survivor: the keeper's as `kept`, every other agent's demoted. */
function mergedStates(
  states: readonly MergeStateRow[],
  kept: MergeStateRow | null,
  context: DemotionContext
): { states: MergeStateRow[]; demotedWriters: string[] } {
  const merged: MergeStateRow[] = [];
  const demotedWriters: string[] = [];
  for (const [agentId, rows] of rowsByAgent(states)) {
    if (agentId === kept?.agent_id) {
      merged.push(kept);
      continue;
    }
    if (rows.some((row) => isWriter(row.state))) demotedWriters.push(agentId);
    merged.push(demotedState(rows, context));
  }
  return { states: merged, demotedWriters };
}

/**
 * Plan one group's merge. `snapshot.artifacts` must hold at least two rows,
 * in rowid order. Pure: the registry applies the plan in one transaction.
 */
export function planFoldMerge(snapshot: MergeSnapshot, facts: MergeFacts): MergePlan {
  const survivor = chooseSurvivor(snapshot.artifacts, facts.diskSpelling);
  const matching = soleMatchingRow(snapshot.artifacts, facts.diskHash);
  const values = mergedValues(snapshot.artifacts, matching);
  const keeper = chooseKeeper(snapshot.states, matching);
  const context: DemotionContext = {
    survivorId: survivor.id,
    nowTick: facts.nowTick,
    rowidOf: new Map(snapshot.artifacts.map((row) => [row.id, row.rowid])),
  };
  // Moved to the new version, so the keeper's next commit is admitted.
  const kept = keeper && {
    ...keeper,
    artifact_id: survivor.id,
    last_observed_version: values.version,
  };
  const { states, demotedWriters } = mergedStates(snapshot.states, kept, context);
  return {
    survivorId: survivor.id,
    removedIds: snapshot.artifacts.filter((row) => row.id !== survivor.id).map((row) => row.id),
    values,
    states,
    notices: mergedNotices(snapshot.notices, demotedWriters, context),
    keeperAgentId: keeper?.agent_id ?? null,
    demotedWriters,
  };
}

// ---------------------------------------------------------------------------
// The start step
// ---------------------------------------------------------------------------

export interface StartFoldInput {
  readonly registry: ArtifactRegistry;
  readonly root: string;
  readonly foldProfile: FoldProfileResult;
  /** Whether this process holds the workspace's single-coordinator lock. */
  readonly lockHeld: boolean;
  readonly log: (line: string) => void;
}

function mergeOneGroup(input: StartFoldInput, group: FoldGroup, nowTick: number): void {
  const rows = group.ids.join(', ');
  try {
    const outcome = input.registry.mergeFoldGroup(group, nowTick);
    if (outcome.kind === 'skipped') {
      input.log(`fold merge of rows ${rows} skipped: ${outcome.reason}`);
      return;
    }
    input.log(
      `fold merge: rows ${rows} merged into ${outcome.survivorId}; ` +
        `write grant kept by ${outcome.keeperAgentId ?? 'nobody'}; ` +
        `demoted writers: ${outcome.demotedWriters.join(', ') || 'none'}`
    );
  } catch (err) {
    // The rows stay apart and the index serves them as one file; the next start retries.
    input.log(`fold merge of rows ${rows} failed and was rolled back: ${String(err)}`);
  }
}

/**
 * Once per start, after the store opened and before the server exists: merge
 * the groups the disk confirms, then build the fold index. Without the
 * single-writer lock another coordinator may hold the same store, so names
 * stay exact: nothing merges and no index is built.
 */
export function prepareFoldIndex(input: StartFoldInput): void {
  if (!input.lockHeld) {
    input.log(
      'fold index: not built; without the single-writer lock names match exactly as tidied'
    );
    return;
  }
  const profile = input.foldProfile.profile;
  const rows = input.registry.fileRowsForFold();
  const nowTick = Math.floor(Date.now() / 1000);
  for (const group of findFoldGroups({ rows, profile, root: input.root })) {
    mergeOneGroup(input, group, nowTick);
  }
  for (const bucket of input.registry.buildFoldIndex(profile)) {
    // JSON keeps a newline in a name from splitting the log line.
    input.log(
      `fold bucket ${JSON.stringify(bucket.key)}: rows ${bucket.ids.join(', ')} resolve to ${bucket.ids[0]}`
    );
  }
}
