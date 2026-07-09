// bench/feedback/fingerprint.js
//
// Stable finding fingerprints for the Mandrel self-benchmark feedback loop
// (Epic #85, Story #91). Internal tooling only — never shipped in the
// distributed `.agents/` bundle, never run against the live repo.
//
// A "finding" is one derived, evidence-carrying recommendation the feedback
// slice (bench/feedback/derive.js) extracts from a results corpus. Every
// finding needs a STABLE identity so the filing engine can tell a brand-new
// finding from one that has recurred across benchmark runs — the same defect,
// seen again in a later cohort, must collide onto the same fingerprint so it
// reads as a time-series rather than a fresh issue every run.
//
// The fingerprint is therefore computed from exactly the fields that describe
// WHAT the finding is about — its finding class, the scenario it was seen in,
// and the specific subject (a dimension / metric / trap-defect-class / pipeline
// signal) — and DELIBERATELY EXCLUDES the cohort triple
// (model, frameworkVersion, benchmarkVersion). Excluding the cohort is the
// whole point: the same regression observed under mandrel 1.70 and again under
// 1.71 shares one fingerprint, so the two observations line up into a series.
// The cohort triple still travels on the finding envelope itself
// (derive.js) — it is just not part of the identity key.
//
// Determinism: pure functions, no I/O, no clock, no randomness. The same
// (class, scenario, subject) triple always yields the same fingerprint string,
// so deriving twice from one corpus produces byte-identical fingerprints.

import { createHash } from 'node:crypto';

/**
 * Field separator for the canonical fingerprint key. A control character that
 * cannot appear in a finding class, scenario id, or subject, so the key can
 * never be ambiguously reconstructed from two different field splits.
 */
const FIELD_SEP = '';

/**
 * Length (hex chars) of the truncated SHA-1 digest used as the fingerprint. 16
 * hex chars = 64 bits of the digest — ample collision resistance for the small
 * finding population one corpus produces, while staying short enough to read in
 * a PR body or a filed issue title.
 */
const FINGERPRINT_HEX_LEN = 16;

/**
 * Normalize one fingerprint field into a stable string. `null` / `undefined`
 * (e.g. a cross-scenario finding has no single scenario) collapse to the empty
 * string so a missing field is still positionally stable in the key. Everything
 * else is coerced via `String`.
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
function normalizeField(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Build the canonical fingerprint KEY (the pre-hash string) for a finding from
 * its identity-bearing fields. The key is `class ␟ scenario ␟ subject` — the
 * three fields that describe what the finding is about, joined by a control
 * separator. It intentionally carries NO cohort information, so two findings
 * that describe the same thing in different cohorts produce the identical key.
 * Pure.
 *
 * @param {object} args
 * @param {string} args.findingClass  One of the four Phase-4 finding classes.
 * @param {string|null} [args.scenario]  Scenario id, or null for a
 *   cross-scenario finding (e.g. difficulty monotonicity).
 * @param {string} args.subject  The specific dimension / metric /
 *   trap-defect-class / pipeline signal the finding is about.
 * @returns {string}
 */
export function fingerprintKey({ findingClass, scenario = null, subject }) {
  return [
    normalizeField(findingClass),
    normalizeField(scenario),
    normalizeField(subject),
  ].join(FIELD_SEP);
}

/**
 * Compute the stable fingerprint for a finding — a truncated SHA-1 digest of
 * the canonical `class ␟ scenario ␟ subject` key. Deterministic and
 * cohort-independent: the same three identity fields always hash to the same
 * string, and the cohort triple is never mixed in, so recurring findings across
 * cohorts collide onto one fingerprint. Pure.
 *
 * @param {object} args
 * @param {string} args.findingClass
 * @param {string|null} [args.scenario]
 * @param {string} args.subject
 * @returns {string}  A 16-hex-char (64-bit) SHA-1 fingerprint.
 */
export function computeFingerprint({ findingClass, scenario = null, subject }) {
  const key = fingerprintKey({ findingClass, scenario, subject });
  return createHash('sha1')
    .update(key, 'utf8')
    .digest('hex')
    .slice(0, FINGERPRINT_HEX_LEN);
}
