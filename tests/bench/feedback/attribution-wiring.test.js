// tests/bench/feedback/attribution-wiring.test.js
//
// Unit tier (pure logic, mocked ports — no I/O, no live GitHub) for the
// composition of bench/feedback/attribution.js into the feedback pipeline
// (the post-Epic-#86 wiring that closes target-architecture §10's Phase-5
// open seam). Exercises:
//
//   - the per-scenario distillers derive.js feeds attribution.js with
//     (`modalAttributionVerdict`, `distillContinuity`);
//   - `deriveFindings` emitting the class-5 `attribution` findings and a
//     `phaseTag` on EVERY finding, with the four pre-existing classes'
//     fingerprints BYTE-IDENTICAL to their pre-wiring values (the tag is a
//     routing field, never fingerprint identity);
//   - `renderFindingsMarkdown` rendering the attribution section + phase tags;
//   - the END-TO-END proof this wiring's Story demanded: an envelope derived by
//     the REAL deriveFindings, filed by the REAL fileFindings through a MOCKED
//     gh port, creates issues carrying the `phase::*` LABEL and a body phase
//     line — a test that fails against the pre-wiring pipeline;
//   - the label-not-found fallback: a target repo without the `phase::*` label
//     retries the create without it (tag survives in the body) instead of
//     failing the filing run.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALL_FINDING_CLASSES,
  deriveFindings,
  distillContinuity,
  FINDING_CLASSES,
  modalAttributionVerdict,
  renderFindingsMarkdown,
} from '../../../bench/feedback/derive.js';
import { fileFindings, isLabelError } from '../../../bench/feedback/file.js';
import { computeFingerprint } from '../../../bench/feedback/fingerprint.js';
import { groupCells } from '../../../bench/report/cells.js';

const MODEL = { id: 'claude-opus-4-8[1m]' };
const ENV = { node: 'v24.16.0', os: 'darwin' };
const LINKS = {
  report: 'claude-opus-4-8-1m/1.88.0/reports/report-x.md',
  scorecards: 'claude-opus-4-8-1m/1.88.0/scorecards.ndjson',
};
const COHORT = {
  model: MODEL.id,
  frameworkVersion: '1.88.0',
  benchmarkVersion: '0.5.0',
};

/** A mandrel-arm attribution block as buildScorecard stamps it. */
function attributionBlock(classification, overrides = {}) {
  return {
    classification,
    planGood: true,
    outcomeGood: classification === 'working-as-intended',
    adhered: true,
    ...overrides,
  };
}

/**
 * A fully-shaped scorecard carrying everything this wiring reads: the trap
 * block (a phase-4 finding source), the planQuality.attribution stamp (§3.4),
 * and the touch2 block (§4.5).
 */
function card({
  scenario = 'epic-scope',
  arm = 'mandrel',
  runId,
  trapScore = 0,
  attribution = null,
  touch2 = null,
} = {}) {
  const sc = {
    schemaVersion: 1,
    runId: runId ?? `${scenario}-${arm}-${Math.abs(trapScore)}`,
    timestamp: '2026-07-10T12:00:00.000Z',
    model: MODEL,
    frameworkVersion: COHORT.frameworkVersion,
    benchmarkVersion: COHORT.benchmarkVersion,
    env: ENV,
    scenario,
    arm,
    routingVerdict: arm === 'control' ? null : 'epic',
    routingMismatch: false,
    dimensions: {
      quality: { score: 1, frozenSuitePassRate: 1 },
      planningFidelity: { score: arm === 'control' ? null : 0.9 },
      autonomy: {
        score: 1,
        hitlStops: 0,
        blockedEvents: 0,
        manualRescues: 0,
        guardrail: { threshold: 0.99, met: true },
      },
      maintainability: { score: 0.9 },
      security: { score: 1 },
      overheadRatio: { tokenRatio: 4 },
      efficiency: {
        wallClockMs: 600000,
        totalTokens: 180000,
        dispatches: 2,
        costUsd: 1.4,
      },
    },
    trap: {
      classes: [
        { class: 'idor', score: trapScore, defectPresent: trapScore < 1 },
      ],
      cleanRate: trapScore,
    },
  };
  if (arm === 'mandrel' && attribution) {
    sc.planQuality = {
      score: 0.5,
      coverage: 0.5,
      decompositionSanity: 0.5,
      constraintSurfacing: 0.5,
      judgeScore: null,
      plannedStoryCount: 5,
      warnings: [],
      attribution,
    };
  }
  if (touch2) sc.touch2 = touch2;
  return sc;
}

/**
 * A corpus for one scenario cell: 3 mandrel runs (leaking the `idor` trap, all
 * classified `plan-phase-gap`, touch-2 outcome really WORSE than control's) and
 * 3 control runs. Every finding class this test asserts on fires from it.
 */
function gapCorpus({ scenario = 'epic-scope' } = {}) {
  const cards = [];
  for (let i = 0; i < 3; i += 1) {
    cards.push(
      card({
        scenario,
        arm: 'mandrel',
        runId: `${scenario}-m-${i}`,
        trapScore: 0,
        attribution: attributionBlock('plan-phase-gap', { outcomeGood: false }),
        touch2: { outcome: 0.5, cost: 30 },
      }),
      card({
        scenario,
        arm: 'control',
        runId: `${scenario}-c-${i}`,
        trapScore: 1,
        touch2: { outcome: 1, cost: 10 },
      }),
    );
  }
  return cards;
}

describe('modalAttributionVerdict', () => {
  it('returns the modal classification with unanimous booleans', () => {
    const runs = [
      card({
        attribution: attributionBlock('plan-phase-gap', { outcomeGood: false }),
      }),
      card({
        attribution: attributionBlock('plan-phase-gap', { outcomeGood: false }),
      }),
      card({ attribution: attributionBlock('working-as-intended') }),
    ];
    const verdict = modalAttributionVerdict(runs);
    assert.equal(verdict.classification, 'plan-phase-gap');
    assert.equal(verdict.planGood, true);
    assert.equal(verdict.outcomeGood, false);
  });

  it('breaks a tie toward the more actionable gap', () => {
    const runs = [
      card({ attribution: attributionBlock('working-as-intended') }),
      card({
        attribution: attributionBlock('deliver-phase-gap', { adhered: false }),
      }),
    ];
    assert.equal(
      modalAttributionVerdict(runs).classification,
      'deliver-phase-gap',
    );
  });

  it('nulls a boolean the modal-class runs disagree on', () => {
    const runs = [
      card({
        attribution: attributionBlock('plan-phase-gap', { adhered: true }),
      }),
      card({
        attribution: attributionBlock('plan-phase-gap', { adhered: false }),
      }),
    ];
    const verdict = modalAttributionVerdict(runs);
    assert.equal(verdict.classification, 'plan-phase-gap');
    assert.equal(verdict.adhered, null);
  });

  it('returns null when no run carries a usable attribution block (pre-axis corpus)', () => {
    assert.equal(modalAttributionVerdict([card({}), card({})]), null);
    assert.equal(modalAttributionVerdict([]), null);
  });
});

describe('distillContinuity', () => {
  const cellOf = (cards) => groupCells(cards)[0];

  it('reports present:false with null verdict when neither arm carries touch2', () => {
    const read = distillContinuity(
      cellOf(gapCorpus().map(({ touch2: _t, ...sc }) => sc)),
      'iqr',
    );
    assert.deepEqual(read, {
      present: false,
      helped: null,
      outcomeDelta: null,
      costDelta: null,
    });
  });

  it('grades helped:false on a REALLY worse mandrel touch-2 outcome', () => {
    const read = distillContinuity(cellOf(gapCorpus()), 'iqr');
    assert.equal(read.present, true);
    assert.equal(read.helped, false);
    assert.ok(read.outcomeDelta < 0);
  });

  it('grades helped:true on a REALLY better mandrel touch-2 outcome', () => {
    const cards = gapCorpus().map((sc) => ({
      ...sc,
      touch2: { outcome: sc.arm === 'mandrel' ? 1 : 0.5, cost: 10 },
    }));
    assert.equal(distillContinuity(cellOf(cards), 'iqr').helped, true);
  });

  it('grades helped:null when the deltas stay within noise', () => {
    // Wide per-run jitter on both arms swamps the tiny center shift.
    const cards = gapCorpus().map((sc, i) => ({
      ...sc,
      touch2: { outcome: 0.5 + (i % 3) * 0.25, cost: 10 + (i % 3) * 20 },
    }));
    assert.equal(distillContinuity(cellOf(cards), 'iqr').helped, null);
  });

  it('grades helped:false on REALLY higher touch-2 cost without a real outcome gain', () => {
    const cards = gapCorpus().map((sc) => ({
      ...sc,
      touch2: { outcome: 0.8, cost: sc.arm === 'mandrel' ? 40 : 10 },
    }));
    const read = distillContinuity(cellOf(cards), 'iqr');
    assert.equal(read.helped, false);
    assert.ok(read.costDelta > 0);
  });
});

describe('deriveFindings — attribution composition', () => {
  const envelope = deriveFindings({
    corpus: gapCorpus(),
    cohort: COHORT,
    links: LINKS,
    generatedAt: '2026-07-10T12:00:00.000Z',
  });

  it('derives the class-5 attribution findings from the distilled inputs', () => {
    const class5 = envelope.findings.filter((f) => f.class === 'attribution');
    assert.deepEqual(class5.map((f) => f.subject).sort(), [
      'artifact-continuity-gap',
      'plan-phase-gap',
    ]);
    assert.equal(envelope.counts.attribution, 2);
    for (const f of class5) {
      assert.deepEqual(f.cohort, COHORT);
      assert.deepEqual(f.links, LINKS);
    }
  });

  it('stamps a phaseTag on every finding — the §3.4 verdict routing the phase-4 classes too', () => {
    assert.ok(
      envelope.findings.length > 2,
      'expected phase-4 findings beside class 5',
    );
    for (const f of envelope.findings) {
      assert.ok(
        'phaseTag' in f,
        `finding ${f.class}/${f.subject} carries no phaseTag`,
      );
    }
    const trapFinding = envelope.findings.find(
      (f) => f.class === 'trap-differential',
    );
    assert.equal(trapFinding.phaseTag, 'phase::plan');
  });

  it('keeps the four pre-existing classes’ fingerprints byte-identical to their pre-wiring values', () => {
    const trapFinding = envelope.findings.find(
      (f) => f.class === 'trap-differential',
    );
    // The pre-wiring identity contract, computed independently: the tag joins
    // the finding as a FIELD, never the fingerprint.
    assert.equal(
      trapFinding.fingerprint,
      computeFingerprint({
        findingClass: 'trap-differential',
        scenario: 'epic-scope',
        subject: 'idor',
      }),
    );

    // And against a corpus with NO attribution data at all (planQuality/touch2
    // stripped): same phase-4 findings, same fingerprints, tags degraded to null.
    const stripped = gapCorpus().map(
      ({ touch2: _t, planQuality: _p, ...sc }) => sc,
    );
    const bare = deriveFindings({
      corpus: stripped,
      cohort: COHORT,
      links: LINKS,
      generatedAt: '2026-07-10T12:00:00.000Z',
    });
    assert.equal(bare.counts.attribution, 0);
    const key = (f) => `${f.class}|${f.scenario}|${f.subject}`;
    const bareByKey = new Map(bare.findings.map((f) => [key(f), f]));
    for (const f of envelope.findings.filter((x) =>
      FINDING_CLASSES.includes(x.class),
    )) {
      const twin = bareByKey.get(key(f));
      assert.ok(
        twin,
        `phase-4 finding ${key(f)} vanished without attribution data`,
      );
      assert.equal(twin.fingerprint, f.fingerprint);
      assert.equal(twin.phaseTag, null);
    }
  });

  it('renders the attribution section and inline phase tags in the PR-body Markdown', () => {
    const md = renderFindingsMarkdown(envelope);
    assert.match(md, /### attribution \(2\)/);
    assert.match(md, /`phase::plan`/);
    assert.match(md, /`phase::artifacts`/);
  });

  it('exports the five-class order with attribution last', () => {
    assert.deepEqual(ALL_FINDING_CLASSES, [...FINDING_CLASSES, 'attribution']);
  });
});

describe('end-to-end: derived phase tags reach the filed issue (mocked gh port)', () => {
  const envelope = deriveFindings({
    corpus: gapCorpus(),
    cohort: COHORT,
    links: LINKS,
    generatedAt: '2026-07-10T12:00:00.000Z',
  });
  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  /** A gh port: empty LIST (every finding is a miss), recording every argv. */
  function recordingGh(calls, { failPhaseLabel = false } = {}) {
    let created = 100;
    return (args) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') {
        const phaseLabel = args.filter((a) => a.startsWith('phase::'));
        if (failPhaseLabel && phaseLabel.length > 0) {
          throw new Error(`could not add label: '${phaseLabel[0]}' not found`);
        }
        created += 1;
        return `https://github.com/dsj1984/mandrel/issues/${created}\n`;
      }
      return '';
    };
  }

  it('creates issues carrying the phase::* label and a body phase line', () => {
    const calls = [];
    const result = fileFindings(
      { envelope },
      { gh: recordingGh(calls), logger },
    );
    assert.equal(result.degraded, false);

    const creates = calls.filter((a) => a[0] === 'issue' && a[1] === 'create');
    assert.equal(creates.length, envelope.findings.length);

    const planGapCreate = creates.find((a) =>
      a[a.indexOf('--title') + 1].includes('attribution: plan-phase-gap'),
    );
    assert.ok(
      planGapCreate,
      'no create call for the class-5 plan-phase-gap finding',
    );
    const labels = planGapCreate
      .map((a, i) => (planGapCreate[i - 1] === '--label' ? a : null))
      .filter(Boolean);
    assert.ok(labels.includes('bench-feedback'));
    assert.ok(labels.includes('meta::framework-gap'));
    assert.ok(labels.includes('phase::plan'), `labels were ${labels}`);
    const body = planGapCreate[planGapCreate.indexOf('--body') + 1];
    assert.match(body, /- phase: `phase::plan`/);
  });

  it('retries a create without the phase label when the target repo lacks it', () => {
    const calls = [];
    const warnings = [];
    const result = fileFindings(
      { envelope },
      {
        gh: recordingGh(calls, { failPhaseLabel: true }),
        logger: { ...logger, warn: (m) => warnings.push(m) },
      },
    );
    assert.equal(result.degraded, false);
    assert.equal(
      result.actions.filter((a) => a.action === 'created').length,
      envelope.findings.length,
    );
    const creates = calls.filter((a) => a[0] === 'issue' && a[1] === 'create');
    const withPhase = creates.filter((a) =>
      a.some((x) => x.startsWith('phase::')),
    );
    const withoutPhase = creates.filter(
      (a) => !a.some((x) => x.startsWith('phase::')),
    );
    assert.ok(withPhase.length > 0, 'never attempted the phase label');
    assert.equal(withoutPhase.length, envelope.findings.length);
    assert.ok(warnings.some((m) => /label `phase::/.test(m)));
  });

  it('isLabelError recognizes label failures and not scope failures', () => {
    assert.equal(
      isLabelError(new Error("could not add label: 'phase::plan' not found")),
      true,
    );
    assert.equal(
      isLabelError(new Error('HTTP 403: Resource not accessible')),
      false,
    );
  });
});
