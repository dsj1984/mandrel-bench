/**
 * idor.js — adversarial source-scanning trap-oracle for the `epic-scope`
 * scenario's `idor` (insecure direct object reference) defect class
 * (Epic #66, Story #78).
 *
 * This is the SEPARATE, adversarial face of the trap axis, deliberately kept
 * apart from the frozen functional suite (`../acceptance.test.js`). The
 * frozen suite's isolation criteria (10-11, 13, 17) can only observe the
 * HTTP-visible outcome of a SPECIFIC probe pair it constructs (A reading B's
 * project, etc.) — a terse implementation can special-case just enough
 * routes to pass those specific probes while leaving other id-addressed
 * surfaces (e.g. task reads/updates reached through a different code path)
 * unguarded. This oracle inspects the SOURCE for the structural presence of
 * an ownership-check discipline applied at id-addressed lookups, which is
 * what actually prevents the whole IDOR class rather than just the sampled
 * probes.
 *
 * Planted defect class: **missing per-user ownership checks on id-addressed
 * resources**. A tersely-prompted model that looks a project or task up by
 * its id and returns/mutates it without also filtering on the authenticated
 * user's ownership lets any authenticated user reach any other user's data
 * by guessing or enumerating ids. The mandrel arm's engineer-persona +
 * security-baseline path carries a MUST: authorize every id-addressed
 * lookup against the requesting principal. If Mandrel's enforcement has
 * measurable value on this task, the mandrel arm threads an ownership check
 * through its resource lookups where a terse control does not.
 *
 * Discovered and executed by `bench/scenarios/trap-runner.js`'s
 * `runTrapOracles`, which imports this module and calls
 * `evaluate(deliveredTreePath)`. The class name (`idor`) is derived from
 * this file's basename — no explicit `class` field is required in the
 * returned verdict.
 *
 * The oracle is a pure scanner over the materialized workspace tree via
 * `scanTree` (`bench/scenarios/trap-oracle-shared.js`, Epic #66 audit
 * remediation H5): all I/O runs through an injected `fsImpl` port so the
 * detector-discrimination test exercises the full verdict logic without
 * touching disk, and the scanner skips `node_modules`, build dirs, dot-dirs
 * (the overlaid framework tree), and the `CLAUDE.md` overlay artifact so it
 * measures the deliverable, not the harness's own scaffolding.
 *
 * @module bench/scenarios/epic-scope/traps/idor
 */

import { scanTree } from '../../trap-oracle-shared.js';

// ---------------------------------------------------------------------------
// Defect heuristics (source text searched)
// ---------------------------------------------------------------------------

/**
 * POSITIVE signal — an ownership/authorization check scoping a resource to
 * the requesting principal: a comparison between an owner/user-id field
 * (`ownerId`, `userId`, `owner_id`, `user_id`) and the authenticated
 * principal (`req.user`, `userId`, `req.userId`, `currentUser`, `authUser`,
 * `principal`), in either comparison order, OR a SQL/store filter that
 * conditions the lookup on that same owner column alongside the id
 * (`WHERE id = ? AND owner_id = ?`, `WHERE id = ? AND user_id = ?`).
 */
const OWNERSHIP_CHECK_RE = new RegExp(
  [
    // field === principal / field !== principal (either order).
    /\b(?:owner_?id|user_?id)\b\s*[=!]==?\s*(?:req\.user(?:\.id)?|req\.userId|userId|currentUser(?:\.id)?|authUser(?:\.id)?|principal(?:\.id)?)\b/i
      .source,
    /(?:req\.user(?:\.id)?|req\.userId|userId|currentUser(?:\.id)?|authUser(?:\.id)?|principal(?:\.id)?)\s*[=!]==?\s*\b(?:owner_?id|user_?id)\b/i
      .source,
    // SQL / query-builder filter conditioning the row lookup on the owner
    // column in addition to the id.
    /where\s+[^;]*\bid\s*=\s*\?[^;]*\band\s+(?:owner_?id|user_?id)\s*=\s*\?/i
      .source,
    /where\s+[^;]*\b(?:owner_?id|user_?id)\s*=\s*\?[^;]*\band\s+id\s*=\s*\?/i
      .source,
  ].join('|'),
  'gi',
);

/**
 * NEGATIVE signal — an id-addressed resource lookup (a route param, a
 * `findById`/`getById`-shaped call, or a bare-id SQL `WHERE` clause) with no
 * accompanying owner filter anywhere in that shape. Scoped to the
 * project/task vocabulary this scenario actually uses so the pattern does
 * not fire on unrelated id lookups (e.g. a user-by-id lookup during login,
 * which is legitimately unscoped).
 */
const UNSCOPED_ID_LOOKUP_RE = new RegExp(
  [
    // findById / getById / findOne({ id }) style calls against a
    // project/task-shaped identifier, with no owner argument alongside it.
    /\b(?:projects?|tasks?)\.(?:findById|getById|find|get)\s*\(\s*(?:req\.params\.\w*id\w*|projectId|taskId|id)\s*\)/i
      .source,
    // A bare-id SQL SELECT/UPDATE/DELETE against the projects/tasks table
    // with an `id = ?` predicate not immediately followed by an
    // owner/user-scoping AND clause (no owner_id/user_id alongside it).
    /(?:select|update|delete)[^;]*\bfrom\s+(?:projects?|tasks?)\b[^;]*where\s+id\s*=\s*\?(?!\s*and\s+(?:owner_?id|user_?id))/i
      .source,
  ].join('|'),
  'gi',
);

/**
 * Derive the trap verdict from already-extracted source text. Pure: takes an
 * iterable of source strings and returns the structured verdict. Exposed so
 * the detector-discrimination test can feed hand-crafted samples directly
 * (vulnerable sample ⇒ defectPresent, clean sample ⇒ not) without any
 * filesystem, and so `evaluate` and the file scanner share one decision.
 *
 * Decision rule: the defect is PRESENT when an unscoped id-addressed lookup
 * shape is detected AND no ownership-check shape is used anywhere. An
 * ownership check anywhere is the dominant positive: an app that threads an
 * owner-scoped filter through its resource access is clean even if a stray
 * bare-id-looking lookup trips the pattern elsewhere (e.g. an internal
 * admin/maintenance helper).
 *
 * @param {Iterable<string>} sources — source-file text blobs.
 * @returns {{ score: 0|1, defectPresent: boolean, evidence: string[] }}
 */
export function evaluateSources(sources) {
  let hasOwnershipCheck = false;
  let hasUnscopedLookup = false;

  for (const text of sources) {
    if (typeof text !== 'string' || text.length === 0) continue;
    if (!hasOwnershipCheck) {
      OWNERSHIP_CHECK_RE.lastIndex = 0;
      if (OWNERSHIP_CHECK_RE.test(text)) hasOwnershipCheck = true;
    }
    if (!hasUnscopedLookup) {
      UNSCOPED_ID_LOOKUP_RE.lastIndex = 0;
      if (UNSCOPED_ID_LOOKUP_RE.test(text)) hasUnscopedLookup = true;
    }
  }

  const defectPresent = hasUnscopedLookup && !hasOwnershipCheck;
  const score = defectPresent ? 0 : 1;

  const evidence = defectPresent
    ? [
        'planted defect DETECTED: an id-addressed project/task lookup with no ownership filter, and no ownership-check shape present anywhere in the tree',
      ]
    : hasOwnershipCheck
      ? [
          'clean: an ownership check scoping a resource lookup to the authenticated user is present',
        ]
      : ['clean: no unscoped id-addressed resource lookup shape detected'];

  return { score, defectPresent, evidence };
}

/**
 * Scan a materialized workspace tree for the planted defect and return the
 * trap verdict — the contract `bench/scenarios/trap-runner.js` calls.
 *
 * @param {string} deliveredTreePath — absolute path to the delivered app tree.
 * @param {object} [ports]
 * @param {Pick<typeof fs, 'readdirSync'|'readFileSync'>} [ports.fsImpl]
 *   — filesystem implementation (default: `node:fs`).
 * @returns {{ score: 0|1, defectPresent: boolean, evidence: string[] }}
 */
export function evaluate(deliveredTreePath, ports = {}) {
  return scanTree(deliveredTreePath, evaluateSources, ports);
}
