// bench/report/cohort-path.js
//
// Cohort-directory derivation for the Mandrel self-benchmark results tree
// (Epic #2, Story #17). Internal tooling only — never shipped in the
// distributed `.agents/` bundle, never run against the live repo.
//
// The results tree is restructured into per-cohort subdirectories keyed by the
// two dimensions a human navigates by — model, then framework version:
//
//   results/<model-slug>/<frameworkVersion>/
//     scorecards.ndjson          ← per-cohort append-only store
//     reports/report-<stamp>.md   ← per-run Markdown reports
//     .raw/<runId>/...            ← provenance
//
// `<model-slug>` is the slugified `model.id`. A model id can contain
// shell/path-hostile characters (e.g. `claude-opus-4-8[1m]`), so it is
// normalized into a filesystem-safe segment before it is ever used as a
// directory name. The full cohort key (which also includes env) still lives in
// every persisted record — the directory tree intentionally branches only on
// model + version for navigability.
//
// Determinism: every function here is pure. No I/O, no clock, no randomness —
// the same scorecard always maps to the same cohort directory.

import path from 'node:path';

/**
 * Slugify an arbitrary model id into a filesystem-safe path segment. The result
 * is lowercased, with every run of non `[a-z0-9]` characters collapsed to a
 * single hyphen and leading/trailing hyphens trimmed. Bracketed suffixes like
 * `[1m]` therefore fold into the slug body rather than producing stray
 * separators (e.g. `claude-opus-4-8[1m]` → `claude-opus-4-8-1m`).
 *
 * An empty / non-string input slugifies to `unknown-model` so a malformed
 * record can never produce an empty (or `.`/`..`) directory segment.
 *
 * @param {unknown} modelId
 * @returns {string}
 */
export function slugifyModelId(modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) {
    return 'unknown-model';
  }
  const slug = modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'unknown-model';
}

/**
 * Sanitize a framework-version string into a filesystem-safe path segment. A
 * SemVer version (`1.70.0`) is already safe and passes through unchanged; any
 * path separator or hostile character is collapsed to a hyphen. An empty /
 * non-string input becomes `unknown-version` so the segment is never empty.
 *
 * @param {unknown} frameworkVersion
 * @returns {string}
 */
export function sanitizeFrameworkVersion(frameworkVersion) {
  if (typeof frameworkVersion !== 'string' || frameworkVersion.length === 0) {
    return 'unknown-version';
  }
  const safe = frameworkVersion
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return safe.length > 0 ? safe : 'unknown-version';
}

/**
 * Derive the per-cohort directory segments (`<model-slug>`, `<frameworkVersion>`)
 * for a scorecard. Pure — returns just the two path segments so a caller can
 * join them onto whatever results root it owns.
 *
 * @param {object} scorecard  A scorecard (or any object carrying `model.id` and
 *   `frameworkVersion`).
 * @returns {{ modelSlug: string, frameworkVersion: string }}
 */
export function cohortSegments(scorecard) {
  return {
    modelSlug: slugifyModelId(scorecard?.model?.id),
    frameworkVersion: sanitizeFrameworkVersion(scorecard?.frameworkVersion),
  };
}

/**
 * Derive the absolute (or results-root-relative) per-cohort directory for a
 * scorecard: `<resultsDir>/<model-slug>/<frameworkVersion>`. Pure — uses
 * `path.join` only, touches no filesystem.
 *
 * @param {object} args
 * @param {string} args.resultsDir   The results-tree root.
 * @param {object} args.scorecard    The scorecard whose cohort dir is wanted.
 * @returns {string}
 */
export function cohortDir({ resultsDir, scorecard }) {
  if (typeof resultsDir !== 'string' || resultsDir.length === 0) {
    throw new TypeError('cohortDir: resultsDir is required');
  }
  const { modelSlug, frameworkVersion } = cohortSegments(scorecard);
  return path.join(resultsDir, modelSlug, frameworkVersion);
}
