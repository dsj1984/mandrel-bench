/**
 * regression-isolation.js — `epic-scope` touch-2 REGRESSION trap-oracle:
 * "per-user isolation preservation" (Epic #86, Story #96).
 *
 * The epic-scope second touch (share a project with another user, role-based
 * access) touches the exact resource-lookup paths whose per-user isolation the
 * touch-1 `idor` trap measures. A tersely-prompted change that makes sharing
 * "work" can quietly REGRESS that isolation — dropping the owner/shared-with
 * scoping so any id-addressed project/task lookup leaks across users — while
 * every behavioural assertion in the touch-2 frozen suite still passes. That
 * regression is a real cross-user data-exposure risk; only a source-level
 * oracle can see the missing scope. This oracle is the source-scan face of the
 * touch-2 axis for this rung.
 *
 * It reuses the vetted `idor` detector — per-user isolation preservation is
 * exactly the absence of the unscoped-id-lookup defect — so the two faces can
 * never drift on the heuristic. The class name (`regression-isolation`) is
 * derived from THIS file's basename by `bench/scenarios/trap-runner.js`, so the
 * re-exported `evaluate` reports the regression class, not the touch-1 one.
 *
 * DISCOVERY BOUNDARY (Epic #86 pre-mortem F2): this module lives under
 * `traps-touch2/`, a directory DISJOINT from the touch-1 `traps/` scan. The
 * touch-1 trap scan globs `traps/` only and never sees this file, so the
 * touch-1 cleanRate is provably unaffected by its presence.
 *
 * @module bench/scenarios/epic-scope/traps-touch2/regression-isolation
 */

export { evaluate, evaluateSources } from '../traps/idor.js';
