/**
 * A coherence refusal: the protocol said no, and the transaction that raised
 * it rolled back. Node twin of the Python coordinator's
 * `ccs.core.exceptions.CoherenceError`. A hook handler answers one as
 * `{ok: false, reason: <message>}`; anything else a handler raises (a busy
 * store, a bug) answers the failure envelope instead (#214).
 */
export class CoherenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoherenceError";
  }
}
