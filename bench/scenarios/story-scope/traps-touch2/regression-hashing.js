/**
 * regression-hashing.js — `story-scope` touch-2 REGRESSION trap-oracle:
 * "password-hashing preservation" (Epic #86, Story #96).
 *
 * The story-scope second touch (add a password-change endpoint + invalidate
 * old sessions) rewrites the exact code path that persists and compares
 * passwords. A tersely-prompted change that makes password change "work" can
 * quietly REGRESS the touch-1 security posture — writing the new password in
 * plaintext, or comparing it directly — while every behavioural assertion in
 * the touch-2 frozen suite still passes. That regression is invisible at the
 * HTTP boundary; only a source-level oracle can see it. This oracle is the
 * source-scan face of the touch-2 axis for this rung.
 *
 * It reuses the vetted `plaintext-password` detector — hashing preservation is
 * exactly the absence of the plaintext-password defect — so the two faces can
 * never drift on the heuristic (the same DRY re-export pattern the touch-1
 * `../traps/plaintext-password.js` uses over `plaintext-password-shared.js`).
 * The class name (`regression-hashing`) is derived from THIS file's basename by
 * `bench/scenarios/trap-runner.js`, so the re-exported `evaluate` reports the
 * regression class, not the touch-1 one.
 *
 * DISCOVERY BOUNDARY (Epic #86 pre-mortem F2): this module lives under
 * `traps-touch2/`, a directory DISJOINT from the touch-1 `traps/` scan. The
 * touch-1 trap scan globs `traps/` only and never sees this file, so the
 * touch-1 cleanRate is provably unaffected by its presence.
 *
 * @module bench/scenarios/story-scope/traps-touch2/regression-hashing
 */

export {
  evaluate,
  evaluateSources,
} from '../../plaintext-password-shared.js';
