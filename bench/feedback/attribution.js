// bench/feedback/attribution.js
//
// Phase attribution + the class-5 (attribution & continuity) findings for the
// Mandrel self-benchmark feedback loop (Epic #86, Story #97; target-
// architecture §3.4 phase attribution, §4.5 the second touch, §7.1 finding
// class 5). Internal tooling only — never shipped in the distributed `.agents/`
// bundle, never run against the live repo.
//
// This is a PURE, deterministic, data-in/data-out module. It imports NO other
// bench/feedback module (not derive.js, not file.js, not fingerprint.js) and
// performs no I/O, no clock reads, and no randomness. Its purity is the whole
// point of the cross-Epic seam (Epic #86 pre-mortem, the F7 point): the Epic
// #85 feedback stage (derive.js / fingerprint.js / file.js) composes this
// module LATER — feeding it finding envelopes plus attribution inputs as plain
// data — without this module ever reaching back into that stage's stateful
// surfaces. It therefore ships whether or not that wiring has landed.
//
// It answers the feedback loop's routing question (§7.1): every finding must be
// routed to the HALF of Mandrel that owns it — `/plan`, `/deliver`, or the
// persistent artifacts — via a phase tag; and the §3.4 decision table + §4.5
// continuity read produce a NET-NEW fifth finding class (attribution &
// continuity findings) beside the four derive.js classes.
//
// Two pure capabilities:
//
//   1. A phase tag per finding (`derivePhaseTag` / `tagFindings`) — given a
//      finding envelope plus its scenario's attribution inputs (the §3.4
//      `computeAttribution` verdict from bench/score/plan-quality.js and the
//      §4.5 continuity read distilled from bench/score/differential.js's
//      `computeContinuityDelta`), return `phase::plan`, `phase::deliver`,
//      `phase::artifacts`, or NO tag. A finding that PREDATES attribution data
//      (no plan-quality verdict AND no touch-2 continuity read on its records)
//      degrades to NO tag rather than a WRONG one — a mis-routed finding is
//      worse than an un-routed one.
//
//   2. The class-5 findings (`deriveAttributionFindings`) — the attribution &
//      continuity finding class (§7.1 item 5): plan-phase vs deliver-phase gaps
//      read straight off the §3.4 table, plus artifact-continuity gaps (§4.5:
//      ceremony paid in touch 1 that failed to pay out in touch 2). Signal-
//      gated exactly like the four derive.js classes — a scenario with no gap
//      derives ZERO findings (no placeholder / always-on records).
//
// Determinism: same fixture corpus in, same tags and class-5 findings out. All
// inputs are plain data; scenarios are visited in stable (caller) order; the
// fingerprint is a pure hash of identity fields. Deriving twice from one corpus
// yields byte-identical output.

import { createHash } from 'node:crypto';

/** The net-new fifth finding class name (beside the four in derive.js). */
export const ATTRIBUTION_FINDING_CLASS = 'attribution';

/** The three phase tags a finding can route to. */
export const PHASE_TAGS = Object.freeze({
  PLAN: 'phase::plan',
  DELIVER: 'phase::deliver',
  ARTIFACTS: 'phase::artifacts',
});

/**
 * The three class-5 finding subjects, in stable render order:
 *   - `plan-phase-gap`         — §3.4: the obligation is owned by `/plan`.
 *   - `deliver-phase-gap`      — §3.4: a good plan was botched in delivery.
 *   - `artifact-continuity-gap`— §4.5: touch-1 ceremony did not pay out in
 *                                touch 2 (inherited artifacts did not help).
 */
export const CLASS5_SUBJECTS = Object.freeze([
  'plan-phase-gap',
  'deliver-phase-gap',
  'artifact-continuity-gap',
]);

/** Fixed subject → phase-tag map for the class-5 findings. */
const SUBJECT_PHASE = Object.freeze({
  'plan-phase-gap': PHASE_TAGS.PLAN,
  'deliver-phase-gap': PHASE_TAGS.DELIVER,
  'artifact-continuity-gap': PHASE_TAGS.ARTIFACTS,
});

/**
 * §3.4 attribution classifications (from `computeAttribution`) that route to the
 * PLAN phase. `plan-phase-gap` is the obligation that never surfaced;
 * `model-compensating` is a plan whose ceremony was not load-bearing — a
 * plan-phase observation in its own right (§3.4: "a finding in itself").
 */
const PLAN_CLASSIFICATIONS = new Set(['plan-phase-gap', 'model-compensating']);

/** §3.4 classifications that route to the DELIVER phase. */
const DELIVER_CLASSIFICATIONS = new Set(['deliver-phase-gap']);

/** The attribution finding-envelope schema version. */
export const ATTRIBUTION_ENVELOPE_SCHEMA_VERSION = 1;

/**
 * Field separator for the fingerprint key — the same U+001F unit-separator
 * bench/feedback/fingerprint.js uses, replicated here so this module imports NO
 * bench/feedback dependency and stays a self-contained pure surface.
 */
const FIELD_SEP = '';

/** Hex length of the truncated SHA-1 fingerprint (16 hex chars = 64 bits). */
const FINGERPRINT_HEX_LEN = 16;

/**
 * Normalize one fingerprint field into a stable string. `null` / `undefined`
 * collapse to the empty string so a missing field stays positionally stable.
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
function normalizeField(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * The stable fingerprint for a class-5 finding — the truncated SHA-1 identity of
 * `class ␟ scenario ␟ subject`, matching derive.js's fingerprint contract
 * (cohort-independent, so a recurring gap collides across cohorts into a
 * time-series). Pure.
 *
 * @param {object} args
 * @param {string|null} [args.scenario]
 * @param {string} args.subject  One of {@link CLASS5_SUBJECTS}.
 * @returns {string}  A 16-hex-char (64-bit) SHA-1 fingerprint.
 */
export function attributionFingerprint({ scenario = null, subject }) {
  const key = [
    normalizeField(ATTRIBUTION_FINDING_CLASS),
    normalizeField(scenario),
    normalizeField(subject),
  ].join(FIELD_SEP);
  return createHash('sha1')
    .update(key, 'utf8')
    .digest('hex')
    .slice(0, FINGERPRINT_HEX_LEN);
}

/**
 * Whether a §3.4 plan-attribution verdict is USABLE — an object carrying a
 * string `classification`. `computeAttribution` returns `classification: null`
 * when plan-quality or outcome is missing (e.g. a finding whose records predate
 * the plan-quality axis); that null is NOT usable and drives the degrade path.
 *
 * @param {object|null|undefined} attribution
 * @returns {boolean}
 */
function planAttributionUsable(attribution) {
  return (
    attribution != null &&
    typeof attribution === 'object' &&
    typeof attribution.classification === 'string'
  );
}

/**
 * Whether a §4.5 continuity read is USABLE — an object whose `present` is true
 * (a touch-2 block existed on the scorecard). A finding whose records predate
 * the second touch carries no continuity block, so `present` is falsy and the
 * read is not usable.
 *
 * @param {object|null|undefined} continuity
 * @returns {boolean}
 */
function continuityUsable(continuity) {
  return (
    continuity != null &&
    typeof continuity === 'object' &&
    continuity.present === true
  );
}

/**
 * Derive the phase tag for ONE finding from its scenario's attribution inputs.
 *
 * The §3.4 decision-table verdict takes precedence: `plan-phase-gap` /
 * `model-compensating` route to `phase::plan`, `deliver-phase-gap` to
 * `phase::deliver`. A `working-as-intended` (or otherwise gap-free) verdict
 * falls through to the §4.5 continuity read: a touch-2 that was NOT helped by
 * the inherited artifacts (`helped === false`) is an artifacts-phase gap.
 *
 * DEGRADE GUARD (Story #97 acceptance a): when NEITHER a usable plan-attribution
 * verdict NOR a usable continuity read is present — the finding predates the
 * attribution data — this returns `null` (NO tag) rather than guessing a WRONG
 * phase. A mis-routed finding is worse than an un-routed one.
 *
 * @param {object} input
 * @param {object|null} [input.attribution]  A §3.4 `computeAttribution` verdict
 *   (`{ classification, planGood, outcomeGood, adhered }`), or null.
 * @param {object|null} [input.continuity]  A distilled §4.5 continuity read
 *   (`{ present, helped, outcomeDelta?, costDelta? }`), or null. `helped` is the
 *   caller's verdict that the inherited artifacts made the second touch better
 *   and/or cheaper than the control arm's code-only inheritance.
 * @returns {'phase::plan'|'phase::deliver'|'phase::artifacts'|null}
 */
export function derivePhaseTag({ attribution = null, continuity = null } = {}) {
  const planUsable = planAttributionUsable(attribution);
  const contUsable = continuityUsable(continuity);

  // Degrade guard: no attribution data of any kind → no tag, never a wrong one.
  if (!planUsable && !contUsable) return null;

  if (planUsable) {
    const c = attribution.classification;
    if (PLAN_CLASSIFICATIONS.has(c)) return PHASE_TAGS.PLAN;
    if (DELIVER_CLASSIFICATIONS.has(c)) return PHASE_TAGS.DELIVER;
    // working-as-intended / unknown: no plan-or-deliver gap. Fall through to the
    // continuity read below.
  }

  // §4.5: ceremony paid in touch 1 that failed to pay out in touch 2.
  if (contUsable && continuity.helped === false) return PHASE_TAGS.ARTIFACTS;

  return null;
}

/**
 * Index a `scenarios` array (the per-scenario attribution inputs) by scenario
 * id, so `tagFindings` can look each finding's inputs up in O(1). Entries with
 * no string `scenario` are skipped. Pure.
 *
 * @param {Array<{ scenario: string, attribution?: object|null, continuity?: object|null }>} scenarios
 * @returns {Map<string, { attribution: object|null, continuity: object|null }>}
 */
function indexAttribution(scenarios) {
  const byScenario = new Map();
  for (const entry of scenarios ?? []) {
    if (!entry || typeof entry.scenario !== 'string') continue;
    byScenario.set(entry.scenario, {
      attribution: entry.attribution ?? null,
      continuity: entry.continuity ?? null,
    });
  }
  return byScenario;
}

/**
 * Tag a list of finding envelopes with a phase tag apiece (Story #97 acceptance
 * a). Each finding's tag is derived from ITS scenario's attribution inputs; a
 * cross-scenario finding (`scenario: null`) or a finding whose scenario carries
 * no attribution inputs degrades to `phaseTag: null`. Input findings are not
 * mutated — a shallow copy with an added `phaseTag` is returned per finding, in
 * the input order. Pure.
 *
 * @param {object} input
 * @param {Array<object>} [input.findings]  Finding envelopes (e.g. the
 *   `findings` array of a derive.js envelope). Only `scenario` is read.
 * @param {Array<{ scenario: string, attribution?: object|null, continuity?: object|null }>} [input.scenarios]
 *   Per-scenario attribution inputs.
 * @returns {Array<object>}  The findings, each with an added `phaseTag`.
 */
export function tagFindings({ findings = [], scenarios = [] } = {}) {
  const byScenario = indexAttribution(scenarios);
  return (findings ?? []).map((finding) => {
    const key = finding?.scenario ?? null;
    const inputs = key !== null ? byScenario.get(key) : undefined;
    const phaseTag = derivePhaseTag({
      attribution: inputs?.attribution ?? null,
      continuity: inputs?.continuity ?? null,
    });
    return { ...finding, phaseTag };
  });
}

/**
 * Build one class-5 finding record, stamping its fingerprint and phase tag. The
 * shape mirrors derive.js's finding envelope (`fingerprint` / `class` /
 * `scenario` / `subject` / `summary` / `cohort` / `evidence` / `links`) plus the
 * `phaseTag` this class introduces. Pure.
 *
 * @param {object} args
 * @param {string} args.scenario
 * @param {string} args.subject  One of {@link CLASS5_SUBJECTS}.
 * @param {string} args.summary
 * @param {object} args.evidence
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} args.cohort
 * @param {{ report: string|null, scorecards: string|null }} args.links
 * @returns {object}
 */
function makeAttributionFinding({
  scenario,
  subject,
  summary,
  evidence,
  cohort,
  links,
}) {
  return {
    fingerprint: attributionFingerprint({ scenario, subject }),
    class: ATTRIBUTION_FINDING_CLASS,
    scenario: scenario ?? null,
    subject,
    phaseTag: SUBJECT_PHASE[subject] ?? null,
    summary,
    cohort: { ...cohort },
    evidence,
    links: {
      report: links?.report ?? null,
      scorecards: links?.scorecards ?? null,
    },
  };
}

/**
 * Derive the class-5 (attribution & continuity) finding ENVELOPE from the
 * per-scenario attribution inputs (Story #97 acceptance b). For each scenario:
 *
 *   - a `plan-phase-gap` finding when the §3.4 verdict is `plan-phase-gap`;
 *   - a `deliver-phase-gap` finding when the §3.4 verdict is `deliver-phase-gap`;
 *   - an `artifact-continuity-gap` finding when the §4.5 continuity read is
 *     present and NOT helped (touch-1 ceremony did not pay out in touch 2).
 *
 * Signal-gated exactly like the four derive.js classes: a scenario with no gap
 * derives ZERO findings. Findings are emitted in scenario (caller) order, and
 * within a scenario the §3.4 gap precedes the §4.5 continuity gap — so deriving
 * twice from one corpus yields byte-identical findings and fingerprints. Pure.
 *
 * @param {object} args
 * @param {Array<{ scenario: string, attribution?: object|null, continuity?: object|null }>} args.scenarios
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} args.cohort
 * @param {{ report: string|null, scorecards: string|null }} [args.links]
 * @param {string|null} [args.generatedAt]  Injected ISO timestamp (null when not
 *   supplied — the derivation itself is clock-free).
 * @returns {{
 *   schemaVersion: number,
 *   generatedAt: string|null,
 *   cohort: object,
 *   counts: Record<string, number>,
 *   findings: Array<object>
 * }}
 */
export function deriveAttributionFindings({
  scenarios = [],
  cohort,
  links = { report: null, scorecards: null },
  generatedAt = null,
} = {}) {
  if (!Array.isArray(scenarios)) {
    throw new TypeError(
      'deriveAttributionFindings: scenarios must be an array',
    );
  }
  if (!cohort || typeof cohort !== 'object') {
    throw new TypeError('deriveAttributionFindings: cohort triple is required');
  }

  const findings = [];
  for (const entry of scenarios) {
    if (!entry || typeof entry.scenario !== 'string') continue;
    const { scenario } = entry;
    const attribution = entry.attribution ?? null;
    const continuity = entry.continuity ?? null;

    // §3.4 decision-table gap (plan-phase vs deliver-phase).
    if (planAttributionUsable(attribution)) {
      const c = attribution.classification;
      if (c === 'plan-phase-gap') {
        findings.push(
          makeAttributionFinding({
            scenario,
            subject: 'plan-phase-gap',
            summary:
              `Plan-phase gap on \`${scenario}\`: the delivered outcome fell ` +
              'short of an obligation the `/plan` phase owns (§3.4 attribution: ' +
              'plan-phase-gap) — routes to `phase::plan`.',
            evidence: {
              classification: c,
              planGood: attribution.planGood ?? null,
              outcomeGood: attribution.outcomeGood ?? null,
              adhered: attribution.adhered ?? null,
            },
            cohort,
            links,
          }),
        );
      } else if (c === 'deliver-phase-gap') {
        findings.push(
          makeAttributionFinding({
            scenario,
            subject: 'deliver-phase-gap',
            summary:
              `Deliver-phase gap on \`${scenario}\`: delivery diverged from a ` +
              'good-looking plan and missed it (§3.4 attribution: ' +
              'deliver-phase-gap) — routes to `phase::deliver`.',
            evidence: {
              classification: c,
              planGood: attribution.planGood ?? null,
              outcomeGood: attribution.outcomeGood ?? null,
              adhered: attribution.adhered ?? null,
            },
            cohort,
            links,
          }),
        );
      }
    }

    // §4.5 continuity gap — ceremony paid in touch 1 that failed to pay out in
    // touch 2 (inherited artifacts did not help the fresh second touch).
    if (continuityUsable(continuity) && continuity.helped === false) {
      findings.push(
        makeAttributionFinding({
          scenario,
          subject: 'artifact-continuity-gap',
          summary:
            `Artifact-continuity gap on \`${scenario}\`: Mandrel's fresh ` +
            'touch-2 session was not helped by its inherited artifacts — ' +
            'ceremony paid in touch 1 did not pay out in touch 2 (§4.5) — ' +
            'routes to `phase::artifacts`.',
          evidence: {
            present: true,
            helped: false,
            outcomeDelta: continuity.outcomeDelta ?? null,
            costDelta: continuity.costDelta ?? null,
          },
          cohort,
          links,
        }),
      );
    }
  }

  const counts = Object.fromEntries(CLASS5_SUBJECTS.map((s) => [s, 0]));
  for (const f of findings) counts[f.subject] += 1;

  return {
    schemaVersion: ATTRIBUTION_ENVELOPE_SCHEMA_VERSION,
    generatedAt: generatedAt ?? null,
    cohort: { ...cohort },
    counts,
    findings,
  };
}

/**
 * Convenience: run BOTH pure capabilities over one corpus in one call — tag the
 * existing finding envelopes AND derive the class-5 findings. A thin composition
 * of {@link tagFindings} and {@link deriveAttributionFindings}; pure and
 * deterministic like both.
 *
 * @param {object} args
 * @param {Array<object>} [args.findings]  Existing finding envelopes to tag.
 * @param {Array<{ scenario: string, attribution?: object|null, continuity?: object|null }>} [args.scenarios]
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} args.cohort
 * @param {{ report: string|null, scorecards: string|null }} [args.links]
 * @param {string|null} [args.generatedAt]
 * @returns {{ tagged: Array<object>, attribution: ReturnType<typeof deriveAttributionFindings> }}
 */
export function attribute({
  findings = [],
  scenarios = [],
  cohort,
  links = { report: null, scorecards: null },
  generatedAt = null,
} = {}) {
  return {
    tagged: tagFindings({ findings, scenarios }),
    attribution: deriveAttributionFindings({
      scenarios,
      cohort,
      links,
      generatedAt,
    }),
  };
}
