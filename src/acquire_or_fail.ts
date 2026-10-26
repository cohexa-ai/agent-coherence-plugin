/**
 * Constants for the opted-in pre-edit (`"if_unheld": true`), shared by the
 * registry, the pre-edit route and the notice renderer. This module imports
 * nothing so the dependency-free renderer can use it.
 */

/**
 * How long another agent may hold a write grant before an opted-in pre-edit
 * reclaims it, in seconds. Python's sweep reclaims at the same ceiling
 * (`grant_max_hold_sec`, 1800 by default); Node has no sweep, so the opted-in
 * acquire applies it. Not configurable.
 */
export const MAX_HOLD_SEC = 1800;

/**
 * The preempter id a reclaimed holder's notice names: Python's
 * `SWEEP_RECLAMATION_PREEMPTER_ID`, which is
 * `uuid5(NAMESPACE_URL, "ccs-coordinator-sweep:stable-grant-reclamation")` as
 * hex. A literal rather than a derivation keeps this module import-free; a
 * test pins it against the derivation.
 */
export const RECLAMATION_PREEMPTER_ID = "e91bfe9cc2855071bf958d64a2bde624";

export const RECLAIM_MAX_HOLD_TRIGGER = "reclaim_max_hold";

/** The refusal reason, the same value Python sends and `post-edit-cas` already uses. */
export const OTHER_HOLDER_REASON = "other_holder";
