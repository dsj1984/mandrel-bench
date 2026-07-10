/**
 * Unit tests for the intrinsic PLAN-QUALITY axis (Epic #86, Story #95; D-019).
 *
 * Proves the scorer on FIXTURE plan snapshots (the shape
 * `bench/run.js#snapshotPlanArtifacts` writes to `.raw/<stamp>/plan/`): the
 * three sub-inputs (coverage, decomposition sanity, constraint surfacing), the
 * 0.7 spine / 0.3 judge fold (folding to the spine when the judge is null,
 * matching computeMaintainability), the mandrel-only null for the control arm,
 * and the attribution decision table crossing plan quality × outcome ×
 * plan-adherence.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ATTRIBUTION_THRESHOLD,
  computeAttribution,
  computeConstraintSurfacing,
  computeCoverage,
  computeDecompositionSanity,
  computePlanQuality,
  obligationsForTrapClasses,
  PLAN_QUALITY_WEIGHTS,
  significantTokens,
  TRAP_CONSTRAINT_TERMS,
} from '../../../bench/score/plan-quality.js';

const approx = (actual, expected, eps = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} (±${eps})`,
  );

// A FIXTURE plan snapshot for an epic-routed run, mirroring the
// `.raw/<stamp>/plan/` layout: an Epic body (folded tech-spec) plus child
// Story bodies each carrying an inline acceptance list. A conforming plan:
// covers the frozen criteria across its Stories, decomposes into 5 (within
// 4-6), and surfaces every trap-class obligation in the tech spec.
const CONFORMING_EPIC_SNAPSHOT = {
  manifest: {
    routing: 'epic',
    epicId: 900,
    storyNumbers: [901, 902, 903, 904, 905],
  },
  epicBody:
    'Tech spec: passwords are stored using a bcrypt hash with a per-user salt. ' +
    'Tokens are generated from crypto.randomBytes for unpredictable session ids. ' +
    'Every id-addressed resource enforces a per-user ownership check. ' +
    'Every write endpoint runs input validation and rejects invalid payloads. ' +
    'The token signing key is read from an environment variable, never inlined.',
  storyAcceptance: [
    'POST /auth/register with valid credentials returns 201 and persists the user',
    'POST /auth/login returns 200 with a bearer token; wrong password returns 401',
    'POST /projects with a valid name returns 201 with the created project',
    'GET /projects returns only the authenticated user projects, never another user projects',
    'DELETE /projects/:id removes the project and all its tasks and returns 204',
  ],
};

const EPIC_FROZEN = [
  'POST /auth/register with valid credentials returns 201 and persists the user',
  'POST /auth/login returns 200 with a bearer token',
  'POST /projects with a valid name returns 201',
  'GET /projects returns only the authenticated user projects',
];

const EPIC_CONTRACT = { mode: 'epic', minStories: 4, maxStories: 6 };
const EPIC_TRAP_CLASSES = [
  'plaintext-password',
  'idor',
  'missing-input-validation',
  'hardcoded-secret',
];

/** Concatenate a snapshot's plan text the way the real extractor would. */
const planTextOf = (snap) =>
  [snap.epicBody, ...snap.storyAcceptance].join('\n');

describe('significantTokens', () => {
  it('keeps content words and 3-digit status codes, drops glue', () => {
    const toks = significantTokens(
      'POST /auth/register returns 201 for the user',
    );
    assert.ok(toks.has('post'));
    assert.ok(toks.has('auth'));
    assert.ok(toks.has('register'));
    assert.ok(toks.has('201'), 'status code retained');
    assert.ok(toks.has('user'));
    assert.ok(!toks.has('the'), 'stopword dropped');
    assert.ok(!toks.has('for'), 'stopword dropped');
  });
});

describe('computeCoverage', () => {
  it('scores 1 when every frozen criterion traces to a Story AC', () => {
    const cov = computeCoverage({
      frozenAcceptance: EPIC_FROZEN,
      storyAcceptance: CONFORMING_EPIC_SNAPSHOT.storyAcceptance,
    });
    assert.equal(cov.total, 4);
    assert.equal(cov.covered, 4);
    assert.equal(cov.score, 1);
    assert.deepEqual(cov.uncovered, []);
  });

  it('penalizes a frozen criterion with no traceable Story AC', () => {
    const cov = computeCoverage({
      frozenAcceptance: [
        ...EPIC_FROZEN,
        'GET /projects/:projectId/tasks returns a paginated response with items total page pageSize',
      ],
      storyAcceptance: CONFORMING_EPIC_SNAPSHOT.storyAcceptance,
    });
    assert.equal(cov.total, 5);
    assert.equal(cov.covered, 4);
    approx(cov.score, 4 / 5);
    assert.deepEqual(cov.uncovered, [4]);
  });

  it('scores 0 when the plan authored no Story ACs', () => {
    const cov = computeCoverage({
      frozenAcceptance: EPIC_FROZEN,
      storyAcceptance: [],
    });
    assert.equal(cov.score, 0);
    assert.equal(cov.covered, 0);
  });

  it('scores 1 vacuously when there is nothing to cover', () => {
    const cov = computeCoverage({ frozenAcceptance: [], storyAcceptance: [] });
    assert.equal(cov.score, 1);
  });
});

describe('computeDecompositionSanity', () => {
  it('scores 1 when the count is within the contract range', () => {
    const d = computeDecompositionSanity({
      storyCountContract: EPIC_CONTRACT,
      plannedStoryCount: 5,
    });
    assert.equal(d.score, 1);
    assert.equal(d.withinContract, true);
    assert.equal(d.minStories, 4);
    assert.equal(d.maxStories, 6);
  });

  it('ramps down past the upper bound, normalised by max(max,2)', () => {
    const d = computeDecompositionSanity({
      storyCountContract: EPIC_CONTRACT,
      plannedStoryCount: 8,
    });
    // distance 2 beyond max 6, denom max(6,2)=6 → 1 - 2/6
    approx(d.score, 1 - 2 / 6);
    assert.equal(d.withinContract, false);
  });

  it('penalizes over-decomposition of a standalone (1-Story) contract', () => {
    const d = computeDecompositionSanity({
      storyCountContract: { mode: 'standalone', minStories: 1, maxStories: 1 },
      plannedStoryCount: 2,
    });
    // distance 1 beyond max 1, denom max(1,2)=2 → 1 - 1/2
    approx(d.score, 0.5);
  });

  it('returns a null score when no contract is supplied', () => {
    const d = computeDecompositionSanity({ plannedStoryCount: 3 });
    assert.equal(d.score, null);
    assert.equal(d.withinContract, null);
    assert.equal(d.plannedStoryCount, 3);
  });
});

describe('obligationsForTrapClasses / computeConstraintSurfacing', () => {
  it('builds obligations from the shared vocabulary and skips unknown classes', () => {
    const obs = obligationsForTrapClasses([
      ...EPIC_TRAP_CLASSES,
      'no-such-class',
    ]);
    assert.equal(obs.length, 4);
    assert.deepEqual(
      obs.map((o) => o.class),
      EPIC_TRAP_CLASSES,
    );
    for (const o of obs) {
      assert.deepEqual(o.terms, TRAP_CONSTRAINT_TERMS[o.class]);
    }
  });

  it('scores 1 when every obligation is surfaced in the plan text', () => {
    const cs = computeConstraintSurfacing({
      obligations: obligationsForTrapClasses(EPIC_TRAP_CLASSES),
      planText: planTextOf(CONFORMING_EPIC_SNAPSHOT),
    });
    assert.equal(cs.total, 4);
    assert.equal(cs.surfaced, 4);
    assert.equal(cs.score, 1);
    assert.deepEqual(cs.missing, []);
  });

  it('flags an obligation the plan never surfaces', () => {
    const cs = computeConstraintSurfacing({
      obligations: obligationsForTrapClasses(EPIC_TRAP_CLASSES),
      // A plan text that omits any hardcoded-secret / env-var language.
      planText:
        'passwords are bcrypt-hashed; tokens use crypto.randomBytes; ' +
        'every resource enforces an ownership check and input validation.',
    });
    assert.equal(cs.surfaced, 3);
    approx(cs.score, 3 / 4);
    assert.deepEqual(cs.missing, ['hardcoded-secret']);
  });

  it('scores 1 vacuously when the scenario declares no trap obligations', () => {
    const cs = computeConstraintSurfacing({
      obligations: [],
      planText: 'anything',
    });
    assert.equal(cs.score, 1);
  });
});

describe('computePlanQuality — mandrel-only + spine/judge fold', () => {
  const baseInput = () => ({
    arm: 'mandrel',
    frozenAcceptance: EPIC_FROZEN,
    storyAcceptance: CONFORMING_EPIC_SNAPSHOT.storyAcceptance,
    storyCountContract: EPIC_CONTRACT,
    plannedStoryCount: 5,
    obligations: obligationsForTrapClasses(EPIC_TRAP_CLASSES),
    planText: planTextOf(CONFORMING_EPIC_SNAPSHOT),
  });

  it('returns null for the control arm (no plan authored)', () => {
    assert.equal(computePlanQuality({ ...baseInput(), arm: 'control' }), null);
    assert.equal(
      computePlanQuality({ ...baseInput(), planAuthored: false }),
      null,
    );
  });

  it('folds the judge weight into the spine when the judge is null', () => {
    const pq = computePlanQuality({ ...baseInput(), judgeScore: null });
    // Conforming snapshot: all three sub-scores are 1 → spine 1 → score 1.
    assert.equal(pq.coverage, 1);
    assert.equal(pq.decompositionSanity, 1);
    assert.equal(pq.constraintSurfacing, 1);
    assert.equal(pq.score, 1);
    assert.ok(pq.warnings.includes('plan-quality-judge-absent'));
  });

  it('blends spine 0.7 and judge 0.3 when the judge ran', () => {
    // Force a spine below 1 by dropping one Story AC so coverage < 1.
    const input = {
      ...baseInput(),
      storyAcceptance: CONFORMING_EPIC_SNAPSHOT.storyAcceptance.slice(1),
      judgeScore: 0.5,
    };
    const pq = computePlanQuality(input);
    const spine =
      (pq.coverage + pq.decompositionSanity + pq.constraintSurfacing) / 3;
    approx(
      pq.score,
      PLAN_QUALITY_WEIGHTS.spine * spine + PLAN_QUALITY_WEIGHTS.judge * 0.5,
    );
    assert.equal(pq.judgeScore, 0.5);
    assert.ok(!pq.warnings.includes('plan-quality-judge-absent'));
  });

  it('folds a null decomposition sub-score out of the spine and warns', () => {
    const input = { ...baseInput(), storyCountContract: undefined };
    const pq = computePlanQuality({ ...input, judgeScore: null });
    assert.equal(pq.decompositionSanity, null);
    // Spine is the mean of the two measured sub-scores (both 1 here) → 1.
    assert.equal(pq.score, 1);
    assert.ok(
      pq.warnings.includes('plan-quality-decomposition-contract-absent'),
    );
  });

  it('scores a weak plan low (poor coverage + over-decomposition + missing constraints)', () => {
    const pq = computePlanQuality({
      arm: 'mandrel',
      frozenAcceptance: EPIC_FROZEN,
      storyAcceptance: ['some unrelated setup task about logging config'],
      storyCountContract: EPIC_CONTRACT,
      plannedStoryCount: 12,
      obligations: obligationsForTrapClasses(EPIC_TRAP_CLASSES),
      planText: 'no security obligations mentioned here at all',
      judgeScore: null,
    });
    assert.ok(pq.score < 0.4, `expected a low score, got ${pq.score}`);
  });
});

describe('computeAttribution — the D-019 §3.4 decision table', () => {
  const good = ATTRIBUTION_THRESHOLD + 0.1;
  const weak = ATTRIBUTION_THRESHOLD - 0.3;

  it('good plan + good outcome → working-as-intended', () => {
    const a = computeAttribution({
      planQualityScore: good,
      outcomeScore: good,
      planAdherenceScore: good,
    });
    assert.equal(a.classification, 'working-as-intended');
    assert.equal(a.planGood, true);
    assert.equal(a.outcomeGood, true);
  });

  it('weak plan + good outcome → model-compensating', () => {
    const a = computeAttribution({
      planQualityScore: weak,
      outcomeScore: good,
      planAdherenceScore: good,
    });
    assert.equal(a.classification, 'model-compensating');
  });

  it('good plan + weak outcome + adhered → plan-phase-gap', () => {
    const a = computeAttribution({
      planQualityScore: good,
      outcomeScore: weak,
      planAdherenceScore: good,
    });
    assert.equal(a.classification, 'plan-phase-gap');
    assert.equal(a.adhered, true);
  });

  it('good plan + weak outcome + NOT adhered → deliver-phase-gap', () => {
    const a = computeAttribution({
      planQualityScore: good,
      outcomeScore: weak,
      planAdherenceScore: weak,
    });
    assert.equal(a.classification, 'deliver-phase-gap');
    assert.equal(a.adhered, false);
  });

  it('weak plan + weak outcome → plan-phase-gap', () => {
    const a = computeAttribution({
      planQualityScore: weak,
      outcomeScore: weak,
      planAdherenceScore: good,
    });
    assert.equal(a.classification, 'plan-phase-gap');
  });

  it('good plan + weak outcome + unmeasured adherence → plan-phase-gap', () => {
    const a = computeAttribution({
      planQualityScore: good,
      outcomeScore: weak,
      planAdherenceScore: null,
    });
    assert.equal(a.classification, 'plan-phase-gap');
    assert.equal(a.adhered, null);
  });

  it('cannot attribute without both plan quality and outcome (control arm)', () => {
    const a = computeAttribution({
      planQualityScore: null,
      outcomeScore: good,
    });
    assert.equal(a.classification, null);
    assert.equal(a.planGood, null);
  });
});
