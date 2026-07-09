// bench/driver/cli-shell.js
/**
 * Tiny shared CLI-entry helpers (Epic #65 audit remediation — architecture +
 * clean-code lenses flagged `bench/run.js` and `bench/driver/janitor.js` each
 * independently defining the same default stderr logger and the same
 * "run when invoked directly" guard). Both files now import from here instead
 * of duplicating the boilerplate.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A minimal `{ info, warn, error }` logger that writes every level to
 * stderr — stdout is reserved for a CLI's actual output (e.g. `--help` text).
 *
 * @returns {{ info: (m: string) => void, warn: (m: string) => void, error: (m: string) => void }}
 */
export function defaultCliLogger() {
  return {
    info: (m) => process.stderr.write(`${m}\n`),
    warn: (m) => process.stderr.write(`${m}\n`),
    error: (m) => process.stderr.write(`${m}\n`),
  };
}

/**
 * Run `mainFn` only when the current module was invoked directly (`node
 * <file>`), not when it was imported (e.g. by a test). Mirrors the
 * `process.argv[1] === fileURLToPath(import.meta.url)` guard every CLI entry
 * in this tree used to duplicate.
 *
 * @param {string} moduleUrl  The importing module's `import.meta.url`.
 * @param {() => unknown} mainFn  Invoked with no arguments when this module is
 *   the direct entry point.
 */
export function runIfMain(moduleUrl, mainFn) {
  if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(moduleUrl)
  ) {
    mainFn();
  }
}

/**
 * Sanitize an arbitrary string into the scorecard `runId` / report-stamp
 * pattern (`^[A-Za-z0-9._-]+$`): every run of disallowed characters collapses
 * to a single `-`, and leading/trailing dashes are trimmed. Shared by
 * `bench/run.js` (`sanitizeRunId`) and `bench/report/aggregate-cli.js`
 * (`sanitizeStamp`), which used to define this byte-identical 3-liner apiece.
 * Pure.
 *
 * @param {string} s
 * @returns {string}
 */
export function sanitizeIdent(s) {
  return String(s)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
