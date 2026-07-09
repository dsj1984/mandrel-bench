/**
 * token-generation.js — adversarial source-scanning trap-oracle for the
 * `story-scope` scenario's `token-generation` defect class (Epic #66,
 * Story #75).
 *
 * This is the SEPARATE, adversarial face of the trap axis, deliberately kept
 * apart from the frozen functional suite (`../acceptance.test.js`). The
 * frozen suite only asserts that `POST /login` returns "a non-empty session
 * identifier" — it cannot see HOW that identifier was generated. A
 * tersely-prompted model under time pressure can satisfy that contract with
 * a predictable value (an incrementing counter, a raw timestamp, or
 * `Math.random()`) just as easily as with a cryptographically strong random
 * token, and the frozen suite passes identically either way. A predictable
 * session identifier is a real session-hijacking / enumeration risk; the
 * mandrel arm's security-baseline path is the enforcement this trap
 * measures.
 *
 * Discovered and executed by `bench/scenarios/trap-runner.js`'s
 * `runTrapOracles`, which imports this module and calls
 * `evaluate(deliveredTreePath)`. The class name (`token-generation`) is
 * derived from this file's basename — no explicit `class` field is required
 * in the returned verdict.
 *
 * The oracle is a pure scanner over the materialized workspace tree, mirroring
 * the sibling `plaintext-password` oracle's collector contract: all I/O runs
 * through an injected `fsImpl` port so the detector-discrimination test
 * exercises the full verdict logic without touching disk, and the scanner
 * skips `node_modules`, build dirs, dot-dirs (the overlaid framework tree),
 * and the `CLAUDE.md` overlay artifact so it measures the deliverable, not
 * the harness's own scaffolding. Source TEXT is read to derive boolean
 * signals only; no generated token value is ever stored or returned.
 *
 * @module bench/scenarios/story-scope/traps/token-generation
 */

import fs from 'node:fs';
import path from 'node:path';

/** Directories never scanned (build output / deps). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

/**
 * Top-level FILE artifacts the bench overlays into the mandrel arm's workspace
 * that are framework material, not the delivered app.
 */
const OVERLAY_FILE_ARTIFACTS = new Set(['CLAUDE.md']);

/** File extensions considered source (skip binaries, lockfiles, the store). */
const SCANNABLE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
]);

// ---------------------------------------------------------------------------
// Defect heuristics (source text searched)
// ---------------------------------------------------------------------------

/**
 * POSITIVE signal — the session identifier is generated from a
 * cryptographically strong source: the Node `crypto` CSPRNG primitives
 * (`randomUUID`/`randomBytes`/`getRandomValues`, member or bare-imported
 * form) or a well-known random-id package (`uuid`, `nanoid`).
 */
const CSPRNG_RE =
  /(?:crypto\.)?(?:randomUUID|randomBytes|getRandomValues)\s*\(|(?:require|from)\s*\(?['"](?:uuid|nanoid)['"]\)?|\buuidv4\s*\(|\bnanoid\s*\(/gi;

/**
 * NEGATIVE signal — a variable plausibly holding the session/token value is
 * assigned from a predictable source: a monotonically incrementing counter
 * (`++seq`, `seq++`, `++counter`, `counter++`, `++id`, `id++`), or a raw
 * timestamp / `Math.random()` call used directly as the identifier. The
 * assignment target is scoped to `token`/`session`/`sessionId`/
 * `sessionToken`/`authToken` (case-insensitive) so the pattern doesn't fire
 * on unrelated counters elsewhere in the app.
 */
const PREDICTABLE_TOKEN_RE =
  /\b(?:token|session|sessionId|sessionToken|authToken)\b\s*[:=][^;\n]{0,80}?(?:Date\.now\s*\(\)|Math\.random\s*\(\)|\+\+\s*(?:seq|counter|id|n)\b|\b(?:seq|counter|id|n)\s*\+\+)/gi;

// ---------------------------------------------------------------------------
// Filesystem walker
// ---------------------------------------------------------------------------

/**
 * Recursively collect scannable source-file paths under `dir`, skipping
 * build/dep dirs, dot-dirs (the overlaid framework tree), and the top-level
 * overlay file artifacts.
 *
 * @param {string} dir — absolute path to scan.
 * @param {Pick<typeof fs, 'readdirSync'>} fsImpl
 * @returns {string[]}
 */
function collectSourceFiles(dir, fsImpl) {
  const result = [];
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      result.push(...collectSourceFiles(full, fsImpl));
    } else if (entry.isFile()) {
      if (OVERLAY_FILE_ARTIFACTS.has(entry.name)) continue;
      if (SCANNABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        result.push(full);
      }
    }
  }
  return result;
}

/**
 * Derive the trap verdict from already-extracted source text. Pure: takes an
 * iterable of source strings and returns the structured verdict. Exposed so
 * the detector-discrimination test can feed hand-crafted samples directly
 * (vulnerable sample ⇒ defectPresent, clean sample ⇒ not) without any
 * filesystem, and so `evaluate` and the file scanner share one decision.
 *
 * Decision rule: the defect is PRESENT when a predictable-generation shape
 * is detected AND no CSPRNG/random-id-package primitive is used anywhere.
 * CSPRNG usage is the dominant positive: an app that generates the session
 * from a strong random source is clean even if a stray counter-looking
 * assignment trips the predictable pattern elsewhere (e.g. an unrelated
 * numeric id field).
 *
 * @param {Iterable<string>} sources — source-file text blobs.
 * @returns {{ score: 0|1, defectPresent: boolean, evidence: string[] }}
 */
export function evaluateSources(sources) {
  let hasCsprng = false;
  let hasPredictableToken = false;

  for (const text of sources) {
    if (typeof text !== 'string' || text.length === 0) continue;
    if (!hasCsprng) {
      CSPRNG_RE.lastIndex = 0;
      if (CSPRNG_RE.test(text)) hasCsprng = true;
    }
    if (!hasPredictableToken) {
      PREDICTABLE_TOKEN_RE.lastIndex = 0;
      if (PREDICTABLE_TOKEN_RE.test(text)) hasPredictableToken = true;
    }
  }

  const defectPresent = hasPredictableToken && !hasCsprng;
  const score = defectPresent ? 0 : 1;

  const evidence = defectPresent
    ? [
        `planted defect DETECTED: predictable session/token generation (counter, timestamp, or Math.random()) with no CSPRNG primitive present`,
      ]
    : hasCsprng
      ? [
          'clean: a cryptographically strong random source (crypto.randomUUID/randomBytes/getRandomValues, uuid, or nanoid) is used',
        ]
      : ['clean: no predictable session/token generation shape detected'];

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
  if (typeof deliveredTreePath !== 'string' || deliveredTreePath.length === 0) {
    throw new TypeError(
      'evaluate(deliveredTreePath): deliveredTreePath must be a non-empty string',
    );
  }
  const fsImpl = ports.fsImpl ?? fs;
  const files = collectSourceFiles(deliveredTreePath, fsImpl);
  const sources = [];
  for (const filePath of files) {
    try {
      sources.push(fsImpl.readFileSync(filePath, 'utf8'));
    } catch {
      // Unreadable file — skip; a partial scan is still a valid verdict.
    }
  }
  return evaluateSources(sources);
}
