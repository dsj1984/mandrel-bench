/**
 * money-integer.js — convention grep-oracle for Ledgerline convention 4
 * (issue #124, PR-B; `sandbox/docs/CONVENTIONS.md` § 4).
 *
 * The convention: all monetary amounts are integer cents end to end —
 * `*Cents` fields holding integers, `_cents` INTEGER columns, integer
 * arithmetic only. Floats never enter the money path.
 *
 * Violation signals (in application source under `src/`):
 *
 *   1. Float parsing — `parseFloat(` / `Number.parseFloat(`. In a
 *      zero-float codebase there is no clean use of it; the way float
 *      money sneaks in is exactly `parseFloat(body.amount)`.
 *   2. Decimal formatting — `.toFixed(`. Rendering cents as dollar
 *      decimals server-side means a float (or a stringly-typed decimal)
 *      entered the money path.
 *   3. Cents↔dollars float arithmetic on a money identifier — a
 *      `*Cents`-named operand multiplied/divided by 100 or by a decimal
 *      literal (`totalCents / 100`, `amountCents * 0.1`).
 *
 * All three run on fully masked source (comments AND string contents
 * blanked), so a comment mentioning `parseFloat` or an error message
 * string containing it never fires — the epic-r2 idor false-positive
 * lesson, pinned as a standing regression fixture in the discrimination
 * test.
 *
 * @module bench/scenarios/brownfield-longitudinal/conventions/money-integer
 */

import {
  collectSourceEntries,
  findingsFor,
  maskSource,
  verdict,
} from './convention-shared.js';

const CLASS = 'money-integer';

const PARSE_FLOAT_RE = /\b(?:Number\s*\.\s*)?parseFloat\s*\(/g;
const TO_FIXED_RE = /\.toFixed\s*\(/g;
const CENTS_FLOAT_MATH_RE =
  /\b\w*[Cc]ents\b\s*[*/]\s*(?:100\b|\d*\.\d+)|(?:\b100|\d*\.\d+)\s*[*/]\s*\w*[Cc]ents\b/g;

/**
 * Pure detector over `{ path, text }` source entries.
 *
 * @param {Array<{ path: string, text: string }>} entries
 * @returns {{ class: string, clean: boolean, findings: string[] }}
 */
export function evaluateEntries(entries) {
  const findings = [];
  for (const { path: relPath, text } of entries) {
    const masked = maskSource(text);
    findings.push(
      ...findingsFor({
        path: relPath,
        text: masked,
        pattern: PARSE_FLOAT_RE,
        explanation:
          'parseFloat() in application source — money is integer cents; float parsing has no clean use in this codebase',
      }),
      ...findingsFor({
        path: relPath,
        text: masked,
        pattern: TO_FIXED_RE,
        explanation:
          '.toFixed() in application source — formatting money as decimal dollars means a float entered the money path',
      }),
      ...findingsFor({
        path: relPath,
        text: masked,
        pattern: CENTS_FLOAT_MATH_RE,
        explanation:
          'cents↔dollars arithmetic on a *Cents value (×/÷ 100 or a decimal literal) — derived money values stay in integer cents',
      }),
    );
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
