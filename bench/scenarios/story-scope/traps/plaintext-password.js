/**
 * plaintext-password.js — `story-scope` re-export of the shared
 * `plaintext-password` trap-oracle detector (Epic #66, Story #75; Epic #66
 * audit remediation H5 consolidated this with the near-identical
 * `epic-scope` copy into `bench/scenarios/plaintext-password-shared.js`).
 *
 * Discovered and executed by `bench/scenarios/trap-runner.js`'s
 * `runTrapOracles`, which imports this module and calls
 * `evaluate(deliveredTreePath)`. The class name (`plaintext-password`) is
 * derived from this file's basename — no explicit `class` field is required
 * in the returned verdict.
 *
 * @module bench/scenarios/story-scope/traps/plaintext-password
 */

export {
  evaluate,
  evaluateSources,
} from '../../plaintext-password-shared.js';
