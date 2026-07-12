/**
 * convention-shared.js — shared scaffolding for the four Ledgerline
 * convention grep-oracles (issue #124, PR-B; design §4).
 *
 * Unlike the trap oracles (which are path-blind text scanners), every
 * convention in `sandbox/docs/CONVENTIONS.md` is stated in terms of WHERE
 * code lives (`src/lib/errors.js` is the only error-envelope writer, only
 * `src/repositories/` imports the db handle, schemas live in
 * `src/schemas/`, …), so these oracles need the RELATIVE PATH of each
 * source file alongside its text. The tree walk itself is reused from
 * `bench/scenarios/trap-oracle-shared.js#collectSourceFiles` (same skip
 * rules: `node_modules`/build dirs, dot-dirs — the overlaid framework tree
 * — and the `CLAUDE.md` overlay artifact), and the scan is restricted to
 * `src/` — the conventions govern application source; the sandbox's own
 * `tests/` directory is agent-editable and scored by the frozen suite, not
 * by greps (this is also what keeps an error-shaped literal inside a test
 * file from ever tripping the envelope oracle — the epic-r2 idor
 * false-positive lesson, pinned by the discrimination fixtures).
 *
 * Verdict shape (mirrors the trap-oracle result surface, adapted to the
 * multi-finding convention case): `{ class, clean, findings: string[] }`,
 * where each finding is `"<relative-path>:<line> — <explanation>"`.
 *
 * @module bench/scenarios/brownfield-longitudinal/conventions/convention-shared
 */

import fs from 'node:fs';
import path from 'node:path';

import { collectSourceFiles } from '../../trap-oracle-shared.js';

/**
 * Collect `{ path, text }` entries for every scannable source file under
 * `deliveredTreePath/src` — relative, slash-normalised paths (always
 * `src/…`) so per-convention allowlists are platform-stable.
 *
 * @param {string} deliveredTreePath — absolute path to the delivered tree.
 * @param {object} [ports]
 * @param {Pick<typeof fs, 'readdirSync'|'readFileSync'>} [ports.fsImpl]
 * @returns {Array<{ path: string, text: string }>}
 */
export function collectSourceEntries(deliveredTreePath, ports = {}) {
  if (typeof deliveredTreePath !== 'string' || deliveredTreePath.length === 0) {
    throw new TypeError(
      'collectSourceEntries(deliveredTreePath): deliveredTreePath must be a non-empty string',
    );
  }
  const fsImpl = ports.fsImpl ?? fs;
  const srcRoot = path.join(deliveredTreePath, 'src');
  const files = collectSourceFiles(srcRoot, fsImpl);
  const entries = [];
  for (const filePath of files) {
    let text;
    try {
      text = fsImpl.readFileSync(filePath, 'utf8');
    } catch {
      continue; // Unreadable file — a partial scan is still a valid verdict.
    }
    const rel = path
      .relative(deliveredTreePath, filePath)
      .split(path.sep)
      .join('/');
    entries.push({ path: rel, text });
  }
  return entries;
}

/**
 * Blank out comments (and optionally string/template-literal contents) in
 * JavaScript source while PRESERVING offsets: every masked character
 * becomes a space, newlines survive, so line numbers computed against the
 * masked text match the original file.
 *
 * This is what makes the oracles robust to the epic-r2 false-positive
 * shape: a violating-looking pattern inside a comment (`// parseFloat(...)`)
 * or a string literal (`"try parseFloat"` in an error message) never
 * reaches the detector regexes. Deliberately a lexer-grade heuristic, not
 * a parser: nested template-literal interpolation is treated as part of
 * the template (its contents are masked with the string), and regex
 * literals are not special-cased — the discrimination fixtures pin the
 * contract this needs to honour.
 *
 * @param {string} text — JavaScript source.
 * @param {object} [options]
 * @param {boolean} [options.keepStrings=false] — mask comments only,
 *   keeping string contents (needed to inspect import specifiers and SQL).
 * @returns {string}
 */
export function maskSource(text, { keepStrings = false } = {}) {
  const src = String(text);
  const out = [];
  let i = 0;
  const mask = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out.push(mask(src[i]));
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out.push('  ');
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out.push(mask(src[i]));
        i += 1;
      }
      if (i < src.length) {
        out.push('  ');
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out.push(quote);
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          out.push(keepStrings ? src[i] : mask(src[i]));
          out.push(keepStrings ? src[i + 1] : mask(src[i + 1]));
          i += 2;
          continue;
        }
        out.push(keepStrings ? src[i] : mask(src[i]));
        i += 1;
      }
      if (i < src.length) {
        out.push(quote);
        i += 1;
      }
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/**
 * 1-based line number of a character offset in `text`.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
export function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Run a global regex over (masked) text and emit one finding string per
 * match, formatted `"<path>:<line> — <explanation>"`.
 *
 * @param {object} args
 * @param {string} args.path — relative file path for the finding.
 * @param {string} args.text — the (masked) text to search.
 * @param {RegExp} args.pattern — a global regex.
 * @param {string} args.explanation — human-readable rule statement.
 * @returns {string[]}
 */
export function findingsFor({ path: relPath, text, pattern, explanation }) {
  const findings = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    findings.push(`${relPath}:${lineAt(text, match.index)} — ${explanation}`);
  }
  return findings;
}

/**
 * Assemble the shared verdict shape from a class name and findings.
 *
 * @param {string} className
 * @param {string[]} findings
 * @returns {{ class: string, clean: boolean, findings: string[] }}
 */
export function verdict(className, findings) {
  return { class: className, clean: findings.length === 0, findings };
}
