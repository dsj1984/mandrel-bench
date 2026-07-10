// bench/feedback/derive.js
//
// Feedback finding derivation for the Mandrel self-benchmark harness
// (Epic #85, Story #91). Internal tooling only — never shipped in the
// distributed `.agents/` bundle, never run against the live repo.
//
// This is the inferential core of Phase 4 (the feedback loop): it turns a
// results corpus into DETERMINISTIC, evidence-carrying FINDINGS the results-PR
// body and the downstream filing engine consume — replacing the report's old
// free-text "Recommended improvements" prose with structured records. It reads
// ONLY in-memory scorecard arrays (the aggregator, bench/report/aggregate.js,
// does the disk walk) and writes nothing: pure derivation, no GitHub writes, no
// filesystem, no clock.
//
// Five finding classes are derived, each strictly SIGNAL-GATED — a class with
// no signal in the corpus derives ZERO findings (no placeholder / always-on
// records):
//
//   1. regression        — a metric that REGRESSED vs the previous comparable
//                          cohort (real-delta rule, bench/report/compare.js).
//   2. standing-cost      — the fixed framework taxes: overhead floor
//                          (bench/score/differential.js overheadFloor), a
//                          real above-noise overhead ratio, and difficulty
//                          monotonicity violations.
//   3. trap-differential  — a planted defect class the mandrel arm did NOT keep
//                          clean (per trap.classes[] clean-rate).
//   4. pipeline-calibration — routing mismatch >25%, an unmet autonomy
//                          guardrail, or a standalone-telemetry-absent warning.
//   5. attribution        — plan-phase vs deliver-phase gaps read off the §3.4
//                          decision table, plus §4.5 artifact-continuity gaps
//                          (bench/feedback/attribution.js — the Epic #86 F7
//                          seam, composed here). This class also supplies the
//                          `phaseTag` (`phase::plan` / `phase::deliver` /
//                          `phase::artifacts`) stamped on EVERY finding whose
//                          scenario carries usable attribution inputs; findings
//                          predating that data degrade to `phaseTag: null`.
//
// Phase-tag / class-5 inputs are DISTILLED per scenario from the cohort's own
// scorecards: the §3.4 verdict is the MODAL `planQuality.attribution`
// classification across the cell's mandrel runs (ties break toward the more
// actionable gap), and the §4.5 continuity read distils
// `computeContinuityDelta` into a helped/not-helped verdict that is only ever
// `false` on a REAL (above-noise) signal. Adding `phaseTag` does NOT touch
// fingerprint identity — the four pre-existing classes keep byte-identical
// fingerprints (`class ␟ scenario ␟ subject`, cohort- and tag-independent).
//
// The previous-comparable-cohort resolver is THIS module's own (see
// `previousComparableCohort`): comparable means same model + benchmarkVersion
// with the immediately-prior frameworkVersion — exactly ONE cohort key changed.
// It deliberately does NOT reuse compare.js's `cohortMatch`, which by design
// flags a prior-frameworkVersion baseline as a mismatch; we resolve the
// baseline ourselves and then borrow compare.js's real-delta math (with
// `requireSameCohort: false`) purely to compute the per-metric verdicts.
//
// Every finding carries: a stable fingerprint (bench/feedback/fingerprint.js,
// which EXCLUDES the cohort triple so recurring findings collide across
// cohorts), the cohort triple, noise-band evidence, and report/scorecard links.
//
// Determinism: pure functions, no I/O, no clock, no randomness. Scenarios,
// classes, and metrics are visited in a stable order, so deriving twice from
// one corpus yields byte-identical findings (and thus identical fingerprints).

import { groupCells, MISMATCH_RATE_FLAG_THRESHOLD } from '../report/cells.js';
import { compareRuns } from '../report/compare.js';
import {
  computeContinuityDelta,
  computeDifferential,
  difficultyMonotonicity,
  overheadFloor,
} from '../score/differential.js';
import { ATTRIBUTION_FINDING_CLASS, attribute } from './attribution.js';
import { computeFingerprint } from './fingerprint.js';
import { joinMarkdownBlocks } from './markdown.js';

/** The finding-envelope schema version (bumped on a breaking envelope change). */
export const FINDING_ENVELOPE_SCHEMA_VERSION = 1;

/** The four Phase-4 finding classes, in stable render order. */
export const FINDING_CLASSES = Object.freeze([
  'regression',
  'standing-cost',
  'trap-differential',
  'pipeline-calibration',
]);

/**
 * Every finding class an envelope can carry, in stable render order — the four
 * Phase-4 classes plus the Phase-5 `attribution` class (§7.1 item 5,
 * bench/feedback/attribution.js).
 */
export const ALL_FINDING_CLASSES = Object.freeze([
  ...FINDING_CLASSES,
  ATTRIBUTION_FINDING_CLASS,
]);

/** Warning marker a mandrel-arm record carries when its telemetry was absent. */
const STANDALONE_TELEMETRY_ABSENT = 'standalone-telemetry-absent';

/**
 * Derive the D-014 cohort TRIPLE for a scorecard — the (model, frameworkVersion,
 * benchmarkVersion) identity a finding is stamped with. Note this is the
 * feedback slice's cohort identity; it is narrower than persist.js's cohort KEY
 * (which also pins env). Pure.
 *
 * @param {object} scorecard
 * @returns {{ model: string, frameworkVersion: string, benchmarkVersion: string }}
 */
export function cohortTriple(scorecard) {
  return {
    model: scorecard?.model?.id ?? '',
    frameworkVersion: scorecard?.frameworkVersion ?? '',
    benchmarkVersion: scorecard?.benchmarkVersion ?? '',
  };
}

/**
 * Stable string key for a cohort triple. Pure.
 *
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} triple
 * @returns {string}
 */
export function cohortTripleKey(triple) {
  return `${triple.model}|${triple.frameworkVersion}|${triple.benchmarkVersion}`;
}

/**
 * Whether a scorecard belongs to a given cohort triple. Pure.
 *
 * @param {object} scorecard
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} triple
 * @returns {boolean}
 */
function inCohort(scorecard, triple) {
  const t = cohortTriple(scorecard);
  return (
    t.model === triple.model &&
    t.frameworkVersion === triple.frameworkVersion &&
    t.benchmarkVersion === triple.benchmarkVersion
  );
}

/**
 * Compare two dotted version strings numerically (`1.9.0` < `1.70.0`), segment
 * by segment; a non-numeric segment falls back to a lexical compare of that
 * segment. Returns -1 / 0 / 1. Pure — good enough for the SemVer-shaped
 * frameworkVersion strings this harness stamps.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/);
  const pb = String(b).split(/[.-]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const sa = pa[i] ?? '';
    const sb = pb[i] ?? '';
    const na = Number(sa);
    const nb = Number(sb);
    const bothNumeric = Number.isFinite(na) && Number.isFinite(nb);
    if (bothNumeric) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The distinct cohort triples present in a corpus, in first-seen order. Pure.
 *
 * @param {Array<object>} corpus
 * @returns {Array<{ model: string, frameworkVersion: string, benchmarkVersion: string }>}
 */
export function cohortTriplesOf(corpus) {
  const seen = new Map();
  for (const sc of corpus) {
    const t = cohortTriple(sc);
    const k = cohortTripleKey(t);
    if (!seen.has(k)) seen.set(k, t);
  }
  return [...seen.values()];
}

/**
 * Resolve the PREVIOUS COMPARABLE COHORT for a target cohort — THIS module's own
 * resolver, deliberately NOT compare.js's `cohortMatch`.
 *
 * Comparable means: same `model` AND same `benchmarkVersion`, with the
 * immediately-prior `frameworkVersion` (the greatest frameworkVersion strictly
 * less than the target's). Model and benchmarkVersion held equal means EXACTLY
 * ONE cohort key changed (frameworkVersion), so any movement between the two is
 * attributable to the framework version alone — which is precisely the baseline
 * compare.js's `cohortMatch` would (correctly, for ITS purpose) reject as a
 * mismatch. Returns null when no prior framework version exists. Pure.
 *
 * @param {Array<object>} corpus  The full corpus (all cohorts).
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} target
 * @returns {{ model: string, frameworkVersion: string, benchmarkVersion: string }|null}
 */
export function previousComparableCohort(corpus, target) {
  let best = null;
  for (const triple of cohortTriplesOf(corpus)) {
    if (triple.model !== target.model) continue;
    if (triple.benchmarkVersion !== target.benchmarkVersion) continue;
    if (triple.frameworkVersion === target.frameworkVersion) continue;
    // Only versions strictly PRIOR to the target are candidate baselines.
    if (
      compareVersions(triple.frameworkVersion, target.frameworkVersion) >= 0
    ) {
      continue;
    }
    if (
      best === null ||
      compareVersions(triple.frameworkVersion, best.frameworkVersion) > 0
    ) {
      best = triple;
    }
  }
  return best;
}

/**
 * Build one finding record, stamping its stable fingerprint, the cohort triple,
 * and the report/scorecard links. Pure.
 *
 * @param {object} args
 * @param {string} args.findingClass
 * @param {string|null} args.scenario
 * @param {string} args.subject
 * @param {string} args.summary
 * @param {object} args.evidence
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} args.cohort
 * @param {{ report: string|null, scorecards: string|null }} args.links
 * @returns {object}
 */
function makeFinding({
  findingClass,
  scenario,
  subject,
  summary,
  evidence,
  cohort,
  links,
}) {
  return {
    fingerprint: computeFingerprint({ findingClass, scenario, subject }),
    class: findingClass,
    scenario: scenario ?? null,
    subject,
    summary,
    cohort: { ...cohort },
    evidence,
    links: {
      report: links.report ?? null,
      scorecards: links.scorecards ?? null,
    },
  };
}

/**
 * Derive REGRESSION findings — metrics that regressed vs the previous comparable
 * cohort. Zero findings when there is no prior comparable cohort. Uses
 * compare.js's real-delta math (`requireSameCohort: false`) over the
 * self-resolved baseline. Pure.
 *
 * @param {object} args
 * @param {Array<object>} args.cohortCards  Target cohort's scorecards.
 * @param {Array<object>} args.baselineCards  Previous comparable cohort's cards.
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} args.previous
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} args.cohort
 * @param {'iqr'|'ci'} args.method
 * @param {{ report: string|null, scorecards: string|null }} args.links
 * @returns {Array<object>}
 */
function deriveRegressions({
  cohortCards,
  baselineCards,
  previous,
  cohort,
  method,
  links,
}) {
  if (!baselineCards || baselineCards.length === 0) return [];
  const comparison = compareRuns({
    baseline: baselineCards,
    candidate: cohortCards,
    method,
    requireSameCohort: false,
  });
  const findings = [];
  for (const s of comparison.scenarios) {
    if (!s.inBaseline || !s.inCandidate) continue;
    for (const m of s.metrics) {
      const c = m.mandrel;
      if (c.verdict !== 'regressed') continue;
      findings.push(
        makeFinding({
          findingClass: 'regression',
          scenario: s.scenario,
          subject: m.metric,
          summary:
            `\`${m.metric}\` regressed on \`${s.scenario}\` vs framework ` +
            `${previous.frameworkVersion}: center ${c.baselineCenter} → ${c.candidateCenter} ` +
            `(shift ${c.shift}, clears noise floor ${c.noiseFloor}).`,
          evidence: {
            method,
            baselineCenter: c.baselineCenter,
            candidateCenter: c.candidateCenter,
            shift: c.shift,
            noiseFloor: c.noiseFloor,
            shiftIsReal: c.shiftIsReal,
            previousComparableCohort: { ...previous },
          },
          cohort,
          links,
        }),
      );
    }
  }
  return findings;
}

/**
 * Derive STANDING-COST findings — the fixed framework taxes: the overhead floor
 * (ceremony with no matching quality gain), a real above-noise overhead ratio,
 * and difficulty-monotonicity violations. Each is signal-gated. Pure.
 *
 * @param {object} args
 * @param {Array<object>} args.cells  groupCells output for the cohort.
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} args.cohort
 * @param {'iqr'|'ci'} args.method
 * @param {{ report: string|null, scorecards: string|null }} args.links
 * @returns {Array<object>}
 */
function deriveStandingCosts({ cells, cohort, method, links }) {
  const findings = [];

  // 1. Overhead floor — the hello-world ceremony tax with no quality gain.
  const floorCell = cells.find((c) => c.scenario === 'hello-world');
  if (floorCell) {
    const floor = overheadFloor({
      mandrelRuns: floorCell.mandrelRuns,
      controlRuns: floorCell.controlRuns,
      method,
    });
    if (floor.recommendCeremonyLite) {
      findings.push(
        makeFinding({
          findingClass: 'standing-cost',
          scenario: 'hello-world',
          subject: 'overhead-floor',
          summary:
            `Mandrel pays a ${floor.overheadFloorTokens}-token overhead floor on ` +
            `\`hello-world\` with no matching quality gain (Δquality ${floor.qualityGain}) — ` +
            'a candidate for a ceremony-lite path on trivial scopes.',
          evidence: {
            method,
            overheadFloorTokens: floor.overheadFloorTokens,
            overheadFloorUsd: floor.overheadFloorUsd,
            qualityGain: floor.qualityGain,
            noQualityGain: floor.noQualityGain,
          },
          cohort,
          links,
        }),
      );
    }
  }

  // 2. Overhead ratio — a real, above-noise ceremony ratio the mandrel arm pays
  //    over control (per scenario).
  for (const cell of cells) {
    if (cell.mandrelRuns.length === 0 || cell.controlRuns.length === 0)
      continue;
    const differential = computeDifferential({
      mandrelRuns: cell.mandrelRuns,
      controlRuns: cell.controlRuns,
      method,
      scenario: cell.scenario,
    });
    const ratio = differential.dimensions.overheadRatio;
    if (ratio.comparable && ratio.deltaIsReal && ratio.delta > 0) {
      findings.push(
        makeFinding({
          findingClass: 'standing-cost',
          scenario: cell.scenario,
          subject: 'overhead-ratio',
          summary:
            `Mandrel pays a real overhead ratio on \`${cell.scenario}\`: ` +
            `${ratio.mandrelCenter} vs control ${ratio.controlCenter} ` +
            `(delta ${ratio.delta} clears noise floor ${ratio.noiseFloor}).`,
          evidence: {
            method,
            mandrelCenter: ratio.mandrelCenter,
            controlCenter: ratio.controlCenter,
            delta: ratio.delta,
            noiseFloor: ratio.noiseFloor,
          },
          cohort,
          links,
        }),
      );
    }
  }

  // 3. Difficulty monotonicity — a calibration guardrail; each violating pair is
  //    a cross-scenario standing-cost finding.
  const mono = difficultyMonotonicity({
    cells: cells.map((c) => ({
      scenario: c.scenario,
      difficulty: c.difficulty,
      mandrelRuns: c.mandrelRuns,
    })),
    method,
  });
  for (const pair of mono.pairs) {
    if (pair.holds) continue;
    findings.push(
      makeFinding({
        findingClass: 'standing-cost',
        scenario: null,
        subject: `monotonicity:${pair.from}->${pair.to}`,
        summary:
          `Difficulty monotonicity violated between \`${pair.from}\` and ` +
          `\`${pair.to}\`: ${pair.violations.join('; ')}.`,
        evidence: {
          method,
          from: pair.from,
          to: pair.to,
          efficiencyRises: pair.efficiencyRises,
          overheadFalls: pair.overheadFalls,
          violations: pair.violations,
        },
        cohort,
        links,
      }),
    );
  }

  return findings;
}

/**
 * Mean of the finite numbers in `values`, or null when there are none. Pure.
 *
 * @param {Array<number>} values
 * @returns {number|null}
 */
function meanOrNull(values) {
  const finite = values.filter(
    (v) => typeof v === 'number' && Number.isFinite(v),
  );
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

/**
 * Per-arm mean clean-rate for one trap class in one scenario cell. Pure.
 *
 * @param {Array<object>} cards  Scorecards for one arm.
 * @param {string} klass
 * @returns {number|null}
 */
function trapClassCleanRate(cards, klass) {
  const scores = [];
  for (const sc of cards) {
    const entry = sc?.trap?.classes?.find((e) => e?.class === klass);
    if (entry && typeof entry.score === 'number') scores.push(entry.score);
  }
  return meanOrNull(scores);
}

/**
 * Derive TRAP-DIFFERENTIAL findings — a planted defect class the mandrel arm did
 * not keep clean (mean clean-rate < 1). The differential vs the control arm's
 * clean-rate travels as evidence. Zero findings when every declared trap class
 * is clean across the mandrel arm. Pure.
 *
 * @param {object} args
 * @param {Array<object>} args.cohortCards
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} args.cohort
 * @param {{ report: string|null, scorecards: string|null }} args.links
 * @returns {Array<object>}
 */
function deriveTrapDifferentials({ cohortCards, cohort, links }) {
  // scenario -> { mandrel: [], control: [], classes: Set }
  const byScenario = new Map();
  for (const sc of cohortCards) {
    const scenario = sc?.scenario;
    const classes = sc?.trap?.classes;
    if (typeof scenario !== 'string' || !Array.isArray(classes)) continue;
    if (!byScenario.has(scenario)) {
      byScenario.set(scenario, {
        mandrel: [],
        control: [],
        classes: new Set(),
      });
    }
    const cell = byScenario.get(scenario);
    if (sc.arm === 'mandrel') cell.mandrel.push(sc);
    else if (sc.arm === 'control') cell.control.push(sc);
    for (const entry of classes) {
      if (typeof entry?.class === 'string') cell.classes.add(entry.class);
    }
  }

  const findings = [];
  for (const scenario of [...byScenario.keys()].sort()) {
    const cell = byScenario.get(scenario);
    for (const klass of [...cell.classes].sort()) {
      const mandrelCleanRate = trapClassCleanRate(cell.mandrel, klass);
      if (mandrelCleanRate === null || mandrelCleanRate >= 1) continue;
      const controlCleanRate = trapClassCleanRate(cell.control, klass);
      findings.push(
        makeFinding({
          findingClass: 'trap-differential',
          scenario,
          subject: klass,
          summary:
            `Mandrel arm leaked the \`${klass}\` planted defect on ` +
            `\`${scenario}\`: clean-rate ${mandrelCleanRate}` +
            (controlCleanRate === null
              ? ' (control clean-rate unmeasured).'
              : ` vs control ${controlCleanRate}.`),
          evidence: {
            defectClass: klass,
            mandrelCleanRate,
            controlCleanRate,
            mandrelRuns: cell.mandrel.length,
            controlRuns: cell.control.length,
          },
          cohort,
          links,
        }),
      );
    }
  }
  return findings;
}

/**
 * Derive PIPELINE-CALIBRATION findings — routing mismatch >25% per cell, an
 * unmet autonomy guardrail on the mandrel arm, and standalone-telemetry-absent
 * warnings. Each is signal-gated. Pure.
 *
 * @param {object} args
 * @param {Array<object>} args.cohortCards
 * @param {Array<object>} args.cells  groupCells output for the cohort.
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} args.cohort
 * @param {{ report: string|null, scorecards: string|null }} args.links
 * @returns {Array<object>}
 */
function derivePipelineCalibration({ cohortCards, cells, cohort, links }) {
  const findings = [];

  // 1. Routing mismatch >25% (groupCells already computes the rate + flag).
  for (const cell of cells) {
    if (!cell.mismatchFlag) continue;
    findings.push(
      makeFinding({
        findingClass: 'pipeline-calibration',
        scenario: cell.scenario,
        subject: 'routing-mismatch',
        summary:
          `Routing mismatch on \`${cell.scenario}\` is ` +
          `${(cell.mismatchRate * 100).toFixed(1)}% ` +
          `(>${(MISMATCH_RATE_FLAG_THRESHOLD * 100).toFixed(0)}%): the observed ` +
          'route diverges from the scenario contract on more than the flagged ' +
          'fraction of runs.',
        evidence: {
          mismatchRate: cell.mismatchRate,
          threshold: MISMATCH_RATE_FLAG_THRESHOLD,
          mismatchedRuns: cell.mismatchedRuns.length,
        },
        cohort,
        links,
      }),
    );
  }

  // Group the mandrel arm by scenario for the per-scenario guardrail / telemetry
  // scans (stable scenario order).
  const mandrelByScenario = new Map();
  for (const sc of cohortCards) {
    if (sc?.arm !== 'mandrel') continue;
    const scenario = sc?.scenario;
    if (typeof scenario !== 'string') continue;
    if (!mandrelByScenario.has(scenario)) mandrelByScenario.set(scenario, []);
    mandrelByScenario.get(scenario).push(sc);
  }

  for (const scenario of [...mandrelByScenario.keys()].sort()) {
    const cards = mandrelByScenario.get(scenario);

    // 2. Autonomy guardrail unmet (met === false; an undetermined null is NOT a
    //    failure).
    const unmet = cards.filter(
      (sc) => sc?.dimensions?.autonomy?.guardrail?.met === false,
    );
    if (unmet.length > 0) {
      const threshold =
        unmet[0]?.dimensions?.autonomy?.guardrail?.threshold ?? null;
      findings.push(
        makeFinding({
          findingClass: 'pipeline-calibration',
          scenario,
          subject: 'autonomy-guardrail',
          summary:
            `Autonomy guardrail unmet on \`${scenario}\`: ${unmet.length} of ` +
            `${cards.length} mandrel run(s) fell below the ${threshold} threshold.`,
          evidence: {
            failingRuns: unmet.length,
            mandrelRuns: cards.length,
            threshold,
            scores: unmet.map((sc) => sc?.dimensions?.autonomy?.score ?? null),
          },
          cohort,
          links,
        }),
      );
    }

    // 3. Standalone-telemetry-absent warnings.
    const absent = cards.filter(
      (sc) =>
        Array.isArray(sc?.warnings) &&
        sc.warnings.includes(STANDALONE_TELEMETRY_ABSENT),
    );
    if (absent.length > 0) {
      findings.push(
        makeFinding({
          findingClass: 'pipeline-calibration',
          scenario,
          subject: STANDALONE_TELEMETRY_ABSENT,
          summary:
            `Standalone telemetry absent on \`${scenario}\`: ${absent.length} of ` +
            `${cards.length} mandrel run(s) recovered no Epic or standalone ` +
            'telemetry, so planning fidelity / autonomy / overhead are unmeasured.',
          evidence: {
            affectedRuns: absent.length,
            mandrelRuns: cards.length,
          },
          cohort,
          links,
        }),
      );
    }
  }

  return findings;
}

/**
 * Tie-break order for the modal §3.4 verdict — when two classifications are
 * equally frequent across a cell's runs, the more ACTIONABLE one wins (a gap
 * outranks a non-gap, and a plan gap outranks a deliver gap because the
 * obligation never surfacing at all is the earlier failure).
 */
const ATTRIBUTION_TIEBREAK_ORDER = Object.freeze([
  'plan-phase-gap',
  'deliver-phase-gap',
  'model-compensating',
  'working-as-intended',
]);

/**
 * The MODAL §3.4 attribution verdict across a cell's mandrel runs — the
 * cell-level distillation of the per-run `planQuality.attribution` blocks
 * `buildScorecard` stamps. The most frequent classification wins; ties break by
 * {@link ATTRIBUTION_TIEBREAK_ORDER}. The boolean fields (`planGood` /
 * `outcomeGood` / `adhered`) carry the UNANIMOUS value across the modal-class
 * runs, or null when they disagree — a cell-level boolean is only asserted when
 * every run behind the verdict agrees on it. Returns null when NO run carries a
 * usable (string-classification) attribution block, so a corpus predating the
 * plan-quality axis degrades to no verdict rather than a fabricated one. Pure.
 *
 * @param {Array<object>} mandrelCards  The cell's mandrel-arm scorecards.
 * @returns {{ classification: string, planGood: boolean|null, outcomeGood: boolean|null, adhered: boolean|null }|null}
 */
export function modalAttributionVerdict(mandrelCards) {
  const usable = (mandrelCards ?? []).filter(
    (sc) => typeof sc?.planQuality?.attribution?.classification === 'string',
  );
  if (usable.length === 0) return null;

  const counts = new Map();
  for (const sc of usable) {
    const c = sc.planQuality.attribution.classification;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const max = Math.max(...counts.values());
  const tied = [...counts.keys()].filter((c) => counts.get(c) === max);
  const ranked = ATTRIBUTION_TIEBREAK_ORDER.filter((c) => tied.includes(c));
  // An unranked (unknown) classification only wins when nothing ranked ties it;
  // among unranked ties, lexical order keeps the verdict deterministic.
  const classification = ranked[0] ?? tied.sort()[0];

  const modalRuns = usable.filter(
    (sc) => sc.planQuality.attribution.classification === classification,
  );
  const unanimous = (field) => {
    const values = modalRuns.map(
      (sc) => sc.planQuality.attribution[field] ?? null,
    );
    const first = values[0];
    if (typeof first !== 'boolean') return null;
    return values.every((v) => v === first) ? first : null;
  };

  return {
    classification,
    planGood: unanimous('planGood'),
    outcomeGood: unanimous('outcomeGood'),
    adhered: unanimous('adhered'),
  };
}

/**
 * Distil one cell's `computeContinuityDelta` into the §4.5 continuity read
 * attribution.js consumes (`{ present, helped, outcomeDelta, costDelta }`).
 *
 * `helped` is verdict-graded on REAL (above-noise) signals only, matching the
 * signal-gating of every other finding class:
 *
 *   - `false` — the inherited artifacts demonstrably did NOT pay out: the
 *     mandrel arm's touch-2 outcome is REALLY worse than control's, OR its
 *     touch-2 cost is REALLY higher without a REALLY better outcome to buy.
 *   - `true`  — the touch-2 outcome is REALLY better (the artifacts paid out).
 *   - `null`  — indeterminate (within noise, incomparable, or no touch-2 data);
 *     downstream this derives no finding and no tag, never a guessed one.
 *
 * @param {{ scenario: string, mandrelRuns: Array<object>, controlRuns: Array<object> }} cell
 * @param {'iqr'|'ci'} method
 * @returns {{ present: boolean, helped: boolean|null, outcomeDelta: number|null, costDelta: number|null }}
 */
export function distillContinuity(cell, method) {
  const delta = computeContinuityDelta({
    mandrelRuns: cell.mandrelRuns,
    controlRuns: cell.controlRuns,
    method,
    scenario: cell.scenario,
  });
  const outcome = delta.metrics['touch2.outcome'];
  const cost = delta.metrics['touch2.cost'];
  if (!delta.present) {
    return {
      present: false,
      helped: null,
      outcomeDelta: null,
      costDelta: null,
    };
  }

  const outcomeWorse =
    outcome.comparable && outcome.deltaIsReal && outcome.delta < 0;
  const outcomeBetter =
    outcome.comparable && outcome.deltaIsReal && outcome.delta > 0;
  const costWorse = cost.comparable && cost.deltaIsReal && cost.delta > 0;

  let helped = null;
  if (outcomeWorse || (!outcomeBetter && costWorse)) helped = false;
  else if (outcomeBetter) helped = true;

  return {
    present: true,
    helped,
    outcomeDelta: outcome.delta,
    costDelta: cost.delta,
  };
}

/**
 * The per-scenario attribution inputs (`{ scenario, attribution, continuity }`)
 * attribution.js's `attribute()` consumes, distilled from the cohort's cells in
 * stable (sorted-scenario) order. A scenario with neither a usable §3.4 verdict
 * nor a usable §4.5 continuity read still appears (with nulls) — attribution.js
 * owns the degrade-to-no-tag decision. Pure.
 *
 * @param {Array<object>} cells  groupCells output for the cohort.
 * @param {'iqr'|'ci'} method
 * @returns {Array<{ scenario: string, attribution: object|null, continuity: object|null }>}
 */
export function attributionInputsForCells(cells, method) {
  return [...(cells ?? [])]
    .sort((a, b) => (a.scenario < b.scenario ? -1 : 1))
    .map((cell) => ({
      scenario: cell.scenario,
      attribution: modalAttributionVerdict(cell.mandrelRuns),
      continuity: distillContinuity(cell, method),
    }));
}

/**
 * Derive the full finding ENVELOPE for one target cohort from a corpus.
 *
 * All five finding classes are derived and concatenated in class order
 * (regression, standing-cost, trap-differential, pipeline-calibration,
 * attribution); within a class, findings are emitted in a stable
 * scenario/metric order. A class with no signal contributes nothing — there are
 * no placeholder findings. Every finding additionally carries a `phaseTag`
 * (`phase::plan` / `phase::deliver` / `phase::artifacts`, or null when its
 * scenario has no usable attribution inputs); the tag is a routing FIELD, never
 * part of fingerprint identity, so pre-existing fingerprints are unchanged.
 * Pure: the `generatedAt` timestamp is injected, so the same inputs always
 * yield the same envelope.
 *
 * @param {object} args
 * @param {Array<object>} args.corpus  Full corpus (all cohorts) — the source of
 *   the previous-comparable-cohort baseline.
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} args.cohort
 *   The target cohort triple to derive findings for.
 * @param {'iqr'|'ci'} [args.method='iqr']
 * @param {{ report: string|null, scorecards: string|null }} [args.links]
 *   Report / scorecard links stamped on every finding.
 * @param {string} [args.generatedAt]  Injected ISO timestamp for the envelope.
 * @returns {object}  The finding envelope.
 */
export function deriveFindings({
  corpus,
  cohort,
  method = 'iqr',
  links = { report: null, scorecards: null },
  generatedAt = null,
} = {}) {
  if (!Array.isArray(corpus)) {
    throw new TypeError('deriveFindings: corpus must be an array');
  }
  if (!cohort || typeof cohort !== 'object') {
    throw new TypeError('deriveFindings: cohort triple is required');
  }

  const cohortCards = corpus.filter((sc) => inCohort(sc, cohort));
  const cells = groupCells(cohortCards);

  const previous = previousComparableCohort(corpus, cohort);
  const baselineCards = previous
    ? corpus.filter((sc) => inCohort(sc, previous))
    : [];

  const phase4Findings = [
    ...deriveRegressions({
      cohortCards,
      baselineCards,
      previous,
      cohort,
      method,
      links,
    }),
    ...deriveStandingCosts({ cells, cohort, method, links }),
    ...deriveTrapDifferentials({ cohortCards, cohort, links }),
    ...derivePipelineCalibration({ cohortCards, cells, cohort, links }),
  ];

  // Compose the Epic #86 attribution seam (bench/feedback/attribution.js): tag
  // the four Phase-4 classes with per-scenario phase routing and derive the
  // class-5 attribution/continuity findings from the same distilled inputs.
  const scenarios = attributionInputsForCells(cells, method);
  const { tagged, attribution } = attribute({
    findings: phase4Findings,
    scenarios,
    cohort,
    links,
    generatedAt,
  });
  const findings = [...tagged, ...attribution.findings];

  const counts = Object.fromEntries(ALL_FINDING_CLASSES.map((c) => [c, 0]));
  for (const f of findings) counts[f.class] += 1;

  return {
    schemaVersion: FINDING_ENVELOPE_SCHEMA_VERSION,
    generatedAt: generatedAt ?? null,
    cohort: { ...cohort },
    previousComparableCohort: previous ? { ...previous } : null,
    method,
    counts,
    findings,
  };
}

/**
 * Render a finding envelope as the Markdown findings section embedded in the
 * results-PR body. Pure — a deterministic function of the envelope.
 *
 * @param {object} envelope  A `deriveFindings` result.
 * @returns {string}  Markdown ending in a single trailing newline.
 */
export function renderFindingsMarkdown(envelope) {
  const { cohort, previousComparableCohort: prev, findings, counts } = envelope;
  const lines = [
    '## Benchmark findings',
    '',
    `Cohort: **${cohort.model}** · framework \`${cohort.frameworkVersion}\` · ` +
      `benchmark \`${cohort.benchmarkVersion}\``,
    prev
      ? `Previous comparable cohort: framework \`${prev.frameworkVersion}\` ` +
        '(same model + benchmark version).'
      : 'Previous comparable cohort: none (no prior framework version on record).',
    '',
  ];

  if (findings.length === 0) {
    lines.push(
      'No findings derived — every finding class was clean for this cohort.',
      '',
    );
    return `${lines.join('\n')}\n`;
  }

  lines.push(
    `Derived **${findings.length}** finding(s): ` +
      ALL_FINDING_CLASSES.filter((c) => counts[c] > 0)
        .map((c) => `${counts[c]} ${c}`)
        .join(', ') +
      '.',
    '',
  );

  for (const findingClass of ALL_FINDING_CLASSES) {
    const inClass = findings.filter((f) => f.class === findingClass);
    if (inClass.length === 0) continue;
    lines.push(`### ${findingClass} (${inClass.length})`, '');
    for (const f of inClass) {
      const where = f.scenario ? ` · \`${f.scenario}\`` : '';
      const phase = f.phaseTag ? ` · \`${f.phaseTag}\`` : '';
      lines.push(`- **${f.subject}**${where}${phase} — ${f.summary}`);
      lines.push(`  - fingerprint: \`${f.fingerprint}\``);
      if (f.links.report || f.links.scorecards) {
        const parts = [];
        if (f.links.report) parts.push(`[report](${f.links.report})`);
        if (f.links.scorecards) {
          parts.push(`[scorecards](${f.links.scorecards})`);
        }
        lines.push(`  - ${parts.join(' · ')}`);
      }
    }
    lines.push('');
  }

  return joinMarkdownBlocks(lines);
}
