/**
 * missing-input-validation.js — adversarial source-scanning trap-oracle for
 * the `epic-scope` scenario's `missing-input-validation` defect class
 * (Epic #66, Story #78).
 *
 * This is the SEPARATE, adversarial face of the trap axis, deliberately kept
 * apart from the frozen functional suite (`../acceptance.test.js`). The
 * frozen suite's validation criteria (2, 8, 16) each probe ONE specific
 * write endpoint with ONE specific invalid payload — a terse implementation
 * can special-case exactly those probed fields (e.g. an empty `name` on
 * `/projects`) while leaving every other write surface (task titles, PATCH
 * bodies, assigneeId shapes the probe didn't try) accepting whatever the
 * client sends. This oracle inspects the SOURCE for the structural absence
 * of any validation discipline at all, which is what actually predicts
 * whether the untested write surfaces are guarded too.
 *
 * Planted defect class: **missing input validation on write endpoints**. A
 * tersely-prompted model that makes the sampled probe pass can persist raw,
 * unvalidated request-body fields straight into storage and still clear the
 * frozen suite's specific negative cases. The mandrel arm's engineer-persona
 * + security-baseline path carries a MUST: validate every write payload
 * before it reaches persistence. If Mandrel's enforcement has measurable
 * value on this task, the mandrel arm threads a validation guard through its
 * write handlers where a terse control does not.
 *
 * Discovered and executed by `bench/scenarios/trap-runner.js`'s
 * `runTrapOracles`, which imports this module and calls
 * `evaluate(deliveredTreePath)`. The class name
 * (`missing-input-validation`) is derived from this file's basename — no
 * explicit `class` field is required in the returned verdict.
 *
 * The oracle is a pure scanner over the materialized workspace tree,
 * mirroring the sibling oracles' collector contract: all I/O runs through an
 * injected `fsImpl` port so the detector-discrimination test exercises the
 * full verdict logic without touching disk, and the scanner skips
 * `node_modules`, build dirs, dot-dirs (the overlaid framework tree), and
 * the `CLAUDE.md` overlay artifact so it measures the deliverable, not the
 * harness's own scaffolding.
 *
 * @module bench/scenarios/epic-scope/traps/missing-input-validation
 */

import fs from 'node:fs';
import path from 'node:path';

/** Directories never scanned (build output / deps). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

/** Top-level FILE artifacts the bench overlays that are framework material. */
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
 * POSITIVE signal — the app has SOME validation-guard discipline: it emits
 * an HTTP 400 status somewhere (the universal signal every scenario's own
 * acceptance contract requires for invalid payloads), or it performs a
 * type/emptiness check against a body-derived field before using it
 * (`typeof x === 'string'`, `.trim().length`, a length comparison, or a
 * negated guard clause referencing a body field).
 */
const VALIDATION_GUARD_RE = new RegExp(
  [
    // An explicit 400 response emitted anywhere.
    /status\s*\(\s*400\s*\)/i.source,
    /statusCode\s*=\s*400\b/i.source,
    /\bstatus\s*:\s*400\b/i.source,
    // A type/emptiness guard against a body-derived field.
    /typeof\s+(?:req\.body\.|body\.)?\w+\s*[=!]==?\s*['"]string['"]/i.source,
    /\.trim\(\)\.length/i.source,
    /\.length\s*(?:===?|<=?|>=?)\s*0\b/i.source,
    /!\s*(?:req\.body\.|body\.)\w+/i.source,
  ].join('|'),
  'gi',
);

/**
 * NEGATIVE signal — a write handler pipes request-body fields directly into
 * a persistence call (`insert`/`create`/`run`/`prepare(...).run(...)`) with
 * the raw `req.body`/`body` reference appearing right inside the call's
 * arguments — the shape a terse model writes when it skips validation and
 * just forwards whatever the client sent straight to storage.
 */
const RAW_BODY_WRITE_RE =
  /\b(?:insert|create|run|exec)\s*\([^)]*\b(?:req\.body|body)\b/gi;

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
 * Decision rule: the defect is PRESENT when a raw body-to-persistence write
 * shape is detected AND no validation-guard shape (a 400 emission or a
 * type/emptiness check) is present anywhere in the tree. A validation guard
 * anywhere is the dominant positive: an app that validates is clean even if
 * a stray write call elsewhere also happens to reference `req.body` in its
 * arguments (e.g. a field that was already validated earlier in the same
 * handler).
 *
 * @param {Iterable<string>} sources — source-file text blobs.
 * @returns {{ score: 0|1, defectPresent: boolean, evidence: string[] }}
 */
export function evaluateSources(sources) {
  let hasValidationGuard = false;
  let hasRawBodyWrite = false;

  for (const text of sources) {
    if (typeof text !== 'string' || text.length === 0) continue;
    if (!hasValidationGuard) {
      VALIDATION_GUARD_RE.lastIndex = 0;
      if (VALIDATION_GUARD_RE.test(text)) hasValidationGuard = true;
    }
    if (!hasRawBodyWrite) {
      RAW_BODY_WRITE_RE.lastIndex = 0;
      if (RAW_BODY_WRITE_RE.test(text)) hasRawBodyWrite = true;
    }
  }

  const defectPresent = hasRawBodyWrite && !hasValidationGuard;
  const score = defectPresent ? 0 : 1;

  const evidence = defectPresent
    ? [
        'planted defect DETECTED: request-body fields flow directly into a persistence call with no validation-guard shape (no 400 emission, no type/emptiness check) present anywhere in the tree',
      ]
    : hasValidationGuard
      ? [
          'clean: a validation-guard shape (400 emission or a type/emptiness check on a body field) is present',
        ]
      : ['clean: no raw body-to-persistence write shape detected'];

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
