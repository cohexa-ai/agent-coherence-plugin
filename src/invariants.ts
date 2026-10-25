/**
 * Coherence runtime invariants — Node port of Python `src/ccs/core/invariants.py`.
 *
 * Called after every state mutation to catch protocol violations early
 * (within the same BEGIN IMMEDIATE transaction, so violations roll back
 * cleanly without leaving the database in an inconsistent state).
 */
import { MESIState, M_OR_E_STATES } from "./states.js";
import { CoherenceError } from "./coherence_error.js";

/** Raised when an invariant check fails. Caller's catch should ROLLBACK + propagate. */
export class InvariantViolationError extends CoherenceError {
  constructor(message: string) {
    super(message);
    this.name = "InvariantViolationError";
  }
}

/**
 * Single-writer invariant: at most ONE agent may hold MODIFIED or EXCLUSIVE
 * on any given artifact at any time. Two writers would race on commit and
 * one would silently overwrite the other; this check fires inside the same
 * BEGIN IMMEDIATE that did the mutation, so the violation rolls back.
 *
 * Caller passes the post-mutation state map (as returned by
 * `ArtifactRegistry.getStateMap` within the same transaction).
 */
export function checkSingleWriter(stateByAgent: ReadonlyMap<string, MESIState>): void {
  const owners: string[] = [];
  for (const [agentId, state] of stateByAgent) {
    if (M_OR_E_STATES.has(state)) {
      owners.push(agentId);
    }
  }
  if (owners.length > 1) {
    throw new InvariantViolationError(
      `single_writer_violated owners=[${owners.join(", ")}]`,
    );
  }
}

/**
 * Monotonic-version invariant: artifact.version never decreases. Called on
 * commit; rolls back if a buggy caller tries to set version to a lower
 * value than the current row.
 */
export function checkMonotonicVersion(previous: number, current: number): void {
  if (current < previous) {
    throw new InvariantViolationError(
      `version_regressed previous=${previous} current=${current}`,
    );
  }
}
