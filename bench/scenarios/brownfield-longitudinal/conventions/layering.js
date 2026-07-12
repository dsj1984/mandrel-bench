/**
 * layering.js — convention grep-oracle for Ledgerline convention 3
 * (issue #124, PR-B; `sandbox/docs/CONVENTIONS.md` § 3).
 *
 * The convention: the codebase is layered routes → services →
 * repositories, and the database handle is confined to the bottom layer —
 * only `src/repositories/*.repo.js` may import `src/lib/db.js`; routes and
 * services never touch SQL or the db handle.
 *
 * Violation signals:
 *
 *   1. An import/require of `lib/db.js` from a file that is neither a
 *      repository nor on the lifecycle allowlist. The seed's
 *      `src/server.js` opens/closes the handle at process boundaries
 *      (`openDb`/`closeDb`) without running queries — the baseline is the
 *      instrument's definition of clean, so it is allowlisted alongside
 *      `src/lib/db.js` itself. Import detection runs on comment-masked
 *      source with STRINGS KEPT (specifiers are strings); a commented-out
 *      import line never fires — the epic-r2 false-positive regression
 *      case, together with a `*.repo.js` file that imports the handle
 *      merely to re-export it (compliant by the convention's letter: it IS
 *      a repository file).
 *   2. SQL statement text or a `getDb()` / `.prepare(` call in a route or
 *      service. SQL lives in strings, so this also runs on comment-masked
 *      source with strings kept; the SQL shapes are anchored
 *      (`INSERT INTO` / `DELETE FROM` / `UPDATE … SET` /
 *      `SELECT … FROM … WHERE`) so conversational prose in a user-facing
 *      message ("select an item from the list") stays clean.
 *
 * @module bench/scenarios/brownfield-longitudinal/conventions/layering
 */

import {
  collectSourceEntries,
  findingsFor,
  maskSource,
  verdict,
} from './convention-shared.js';

const CLASS = 'layering';

/** Non-repository files allowed to import the db module (lifecycle only). */
const DB_IMPORT_ALLOWLIST = new Set(['src/server.js', 'src/lib/db.js']);

const DB_IMPORT_RE =
  /(?:from\s*|require\s*\(\s*)['"][^'"]*lib\/db(?:\.js)?['"]/g;
const DB_HANDLE_RE = /\b(?:getDb\s*\(|\.prepare\s*\()/g;
const SQL_TEXT_RE =
  /\b(?:insert\s+into\s+\w|delete\s+from\s+\w|update\s+\w+\s+set\s|select\b[\s\S]{0,160}?\bfrom\s+\w+[\s\S]{0,160}?\bwhere\b)/gi;

function isRepositoryFile(relPath) {
  return /^src\/repositories\/[^/]+\.repo\.js$/.test(relPath);
}

function isRouteOrService(relPath) {
  return (
    relPath.startsWith('src/routes/') || relPath.startsWith('src/services/')
  );
}

/**
 * Pure detector over `{ path, text }` source entries.
 *
 * @param {Array<{ path: string, text: string }>} entries
 * @returns {{ class: string, clean: boolean, findings: string[] }}
 */
export function evaluateEntries(entries) {
  const findings = [];
  for (const { path: relPath, text } of entries) {
    const commentMasked = maskSource(text, { keepStrings: true });
    if (!isRepositoryFile(relPath) && !DB_IMPORT_ALLOWLIST.has(relPath)) {
      findings.push(
        ...findingsFor({
          path: relPath,
          text: commentMasked,
          pattern: DB_IMPORT_RE,
          explanation:
            'imports src/lib/db.js outside src/repositories/*.repo.js — the db handle is confined to the repository layer',
        }),
      );
    }
    if (isRouteOrService(relPath)) {
      findings.push(
        ...findingsFor({
          path: relPath,
          text: commentMasked,
          pattern: DB_HANDLE_RE,
          explanation:
            'db-handle usage (getDb()/.prepare()) in a route or service — all reads and writes go through a repository function',
        }),
        ...findingsFor({
          path: relPath,
          text: commentMasked,
          pattern: SQL_TEXT_RE,
          explanation:
            'SQL statement text in a route or service — SQL lives in src/repositories/',
        }),
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
