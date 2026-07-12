/**
 * validation-call.js — convention grep-oracle for Ledgerline convention 2
 * (issue #124, PR-B; `sandbox/docs/CONVENTIONS.md` § 2).
 *
 * The convention: every write handler (POST/PATCH/PUT) validates its
 * request body by calling `validate(body, schema)` from
 * `src/lib/validate.js` before touching any service or repository, with
 * schemas colocated in `src/schemas/`.
 *
 * Detector granularity is the ROUTE FILE (documented heuristic): a file
 * under `src/routes/` that registers at least one write route
 * (`router.add('POST'|'PATCH'|'PUT', …)` in the seed's router idiom, or a
 * framework-style `.post(`/`.patch(`/`.put(` registration) must contain at
 * least one real `validate(` call. Method-string detection runs on
 * comment-masked source with strings kept (the method IS a string);
 * `validate(` and the dot-method shapes run on fully-masked source, so a
 * `validate(` inside a comment cannot satisfy the rule and a `.post(`
 * inside a comment or log string cannot trigger it — the epic-r2
 * false-positive regression cases.
 *
 * @module bench/scenarios/brownfield-longitudinal/conventions/validation-call
 */

import {
  collectSourceEntries,
  lineAt,
  maskSource,
  verdict,
} from './convention-shared.js';

const CLASS = 'validation-call';

const ADD_WRITE_ROUTE_RE = /\badd\s*\(\s*['"](?:POST|PATCH|PUT)['"]/g;
const DOT_WRITE_ROUTE_RE = /\.(?:post|patch|put)\s*\(/g;
const VALIDATE_CALL_RE = /\bvalidate\s*\(/;

/**
 * Pure detector over `{ path, text }` source entries.
 *
 * @param {Array<{ path: string, text: string }>} entries
 * @returns {{ class: string, clean: boolean, findings: string[] }}
 */
export function evaluateEntries(entries) {
  const findings = [];
  for (const { path: relPath, text } of entries) {
    if (!relPath.startsWith('src/routes/')) continue;
    const commentMasked = maskSource(text, { keepStrings: true });
    const fullyMasked = maskSource(text);

    const writeRegistrations = [];
    ADD_WRITE_ROUTE_RE.lastIndex = 0;
    for (const match of commentMasked.matchAll(ADD_WRITE_ROUTE_RE)) {
      writeRegistrations.push(match.index);
    }
    DOT_WRITE_ROUTE_RE.lastIndex = 0;
    for (const match of fullyMasked.matchAll(DOT_WRITE_ROUTE_RE)) {
      writeRegistrations.push(match.index);
    }
    if (writeRegistrations.length === 0) continue;

    if (!VALIDATE_CALL_RE.test(fullyMasked)) {
      const firstLine = lineAt(text, Math.min(...writeRegistrations));
      findings.push(
        `${relPath}:${firstLine} — registers a write route (POST/PATCH/PUT) but never calls validate(body, schema) from src/lib/validate.js`,
      );
    }
  }
  return verdict(CLASS, findings);
}

/**
 * Scan a delivered tree for the convention verdict.
 *
 * @param {string} deliveredTreePath — absolute path to the delivered tree.
 * @param {object} [ports] — `{ fsImpl }` (see convention-shared).
 * @returns {{ class: string, clean: boolean, findings: string[] }}
 */
export function evaluate(deliveredTreePath, ports = {}) {
  return evaluateEntries(collectSourceEntries(deliveredTreePath, ports));
}
