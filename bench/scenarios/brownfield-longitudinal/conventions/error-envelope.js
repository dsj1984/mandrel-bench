/**
 * error-envelope.js — convention grep-oracle for Ledgerline convention 1
 * (issue #124, PR-B; `sandbox/docs/CONVENTIONS.md` § 1).
 *
 * The convention: every non-2xx body is
 * `{"error":{"code":"E_SNAKE_CASE","message":…}}`, produced ONLY via
 * `sendError()` from `src/lib/errors.js` (directly or by throwing
 * `ApiError`, which the router converts). Never hand-roll an error JSON
 * body in a route, service, or repository.
 *
 * Violation signals (outside the allowlisted envelope writer):
 *
 *   1. A hand-rolled envelope literal — an object literal of the shape
 *      `error: { … code: …`. Detected on string-masked source so an
 *      error-shaped literal inside a string (a log message, a doc snippet)
 *      never fires; test files are outside the scan entirely (`src/` only)
 *      — both are the epic-r2 false-positive regression cases.
 *   2. A hard-coded non-2xx status written directly to the response
 *      (`res.writeHead(404…`, `res.statusCode = 500`) — an error response
 *      taking shape outside `sendError`.
 *
 * `src/lib/errors.js` is the ONE allowlisted writer; the router's
 * `sendJson`/`sendNoContent` write variable or 2xx statuses and stay
 * outside both patterns by construction.
 *
 * @module bench/scenarios/brownfield-longitudinal/conventions/error-envelope
 */

import {
  collectSourceEntries,
  findingsFor,
  maskSource,
  verdict,
} from './convention-shared.js';

const CLASS = 'error-envelope';

/** The one file allowed to construct the envelope and write error statuses. */
const ALLOWED_WRITERS = new Set(['src/lib/errors.js']);

const ENVELOPE_LITERAL_RE = /\berror\s*:\s*\{[^{}]{0,160}?\bcode\s*:/g;
const RAW_ERROR_STATUS_RE =
  /\b(?:writeHead\s*\(\s*[45]\d\d\b|statusCode\s*=\s*[45]\d\d\b)/g;

/**
 * Pure detector over `{ path, text }` source entries.
 *
 * @param {Array<{ path: string, text: string }>} entries
 * @returns {{ class: string, clean: boolean, findings: string[] }}
 */
export function evaluateEntries(entries) {
  const findings = [];
  for (const { path: relPath, text } of entries) {
    if (ALLOWED_WRITERS.has(relPath)) continue;
    const masked = maskSource(text);
    findings.push(
      ...findingsFor({
        path: relPath,
        text: masked,
        pattern: ENVELOPE_LITERAL_RE,
        explanation:
          'hand-rolled error envelope literal (`error: { … code: … }`) outside src/lib/errors.js — error bodies must go through sendError()',
      }),
      ...findingsFor({
        path: relPath,
        text: masked,
        pattern: RAW_ERROR_STATUS_RE,
        explanation:
          'hard-coded 4xx/5xx status written directly to the response outside src/lib/errors.js — error responses must go through sendError()',
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
