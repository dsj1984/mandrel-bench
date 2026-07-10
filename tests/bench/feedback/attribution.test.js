// tests/bench/feedback/attribution.test.js
//
// Unit tier (pure logic, no I/O) for phase attribution + the class-5
// (attribution & continuity) findings (Epic #86, Story #97). Exercises
// bench/feedback/attribution.js against the Story's binding acceptance items:
//   - phase tags per finding (phase::plan / phase::deliver / phase::artifacts)
//     derived from the §3.4 decision table and the §4.5 continuity read;
//   - the class-5 finding types (plan-phase / deliver-phase gaps; touch-1
//     ceremony that failed to pay out in touch 2), signal-gated;
//   - findings that predate attribution data degrade to NO tag, never a wrong
//     one;
//   - derivation is deterministic: same fixture corpus in, same tags and
//     class-5 findings out.
//
// This test imports NO other bench/feedback module (acceptance: no dependency on
// any other bench/feedback module) — only the module under test.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ATTRIBUTION_FINDING_CLASS,
  attribute,
  attributionFingerprint,
  CLASS5_SUBJECTS,
  deriveAttributionFindings,
  derivePhaseTag,
  PHASE_TAGS,
  tagFindings,
} from '../../../bench/feedback/attribution.js';

const COHORT = {
  model: 'claude-opus-4-8[1m]',
  frameworkVersion: '1.88.0',
  benchmarkVersion: '0.5.0',
};
const LINKS = {
  report: 'claude-opus-4-8-1m/1.88.0/reports/report-x.md',
  scorecards: 'claude-opus-4-8-1m/1.88.0/scorecards.ndjson',
};

/** A minimal finding envelope (only `scenario` is read by the tagger). */
function finding({
  scenario = 'story-scope',
  subject = 'plaintext-password',
} = {}) {
  return {
    fingerprint: 'deadbeefdeadbeef',
    class: 'trap-differential',
    scenario,
    subject,
    summary: `leaked ${subject} on ${scenario}`,
  };
}

/** A §3.4 computeAttribution-shaped verdict. */
function verdict(classification, extra = {}) {
  return {
    classification,
    planGood: true,
    outcomeGood: false,
    adhered: false,
    ...extra,
  };
}

/**
 * The canonical fixture corpus: four scenarios covering each §3.4 verdict plus a
 * §4.5 continuity gap and a working-as-intended (no-signal) scenario.
 */
function fixtureScenarios() {
  return [
    {
      scenario: 'story-scope',
      attribution: verdict('plan-phase-gap', { planGood: false }),
      continuity: {
        present: true,
        helped: true,
        outcomeDelta: 0.2,
        costDelta: -0.5,
      },
    },
    {
      scenario: 'epic-scope',
      attribution: verdict('deliver-phase-gap', { planGood: true }),
      continuity: {
        present: true,
        helped: false,
        outcomeDelta: -0.1,
        costDelta: 0.3,
      },
    },
    {
      scenario: 'hello-world',
      attribution: verdict('working-as-intended', {
        outcomeGood: true,
        adhered: true,
      }),
      continuity: null,
    },
    {
      scenario: 'compensating-scope',
      attribution: verdict('model-compensating', {
        planGood: false,
        outcomeGood: true,
      }),
      continuity: {
        present: true,
        helped: false,
        outcomeDelta: -0.2,
        costDelta: 0.4,
      },
    },
  ];
}

describe('derivePhaseTag — §3.4 table + §4.5 continuity read', () => {
  it('routes a plan-phase-gap verdict to phase::plan', () => {
    assert.equal(
      derivePhaseTag({ attribution: verdict('plan-phase-gap') }),
      PHASE_TAGS.PLAN,
    );
  });

  it('routes a deliver-phase-gap verdict to phase::deliver', () => {
    assert.equal(
      derivePhaseTag({ attribution: verdict('deliver-phase-gap') }),
      PHASE_TAGS.DELIVER,
    );
  });

  it('routes a model-compensating verdict to phase::plan (ceremony not load-bearing)', () => {
    assert.equal(
      derivePhaseTag({ attribution: verdict('model-compensating') }),
      PHASE_TAGS.PLAN,
    );
  });

  it('routes a working-as-intended verdict with an unhelpful touch-2 to phase::artifacts', () => {
    assert.equal(
      derivePhaseTag({
        attribution: verdict('working-as-intended', { outcomeGood: true }),
        continuity: { present: true, helped: false },
      }),
      PHASE_TAGS.ARTIFACTS,
    );
  });

  it('gives a working-as-intended verdict with a helpful touch-2 no tag', () => {
    assert.equal(
      derivePhaseTag({
        attribution: verdict('working-as-intended', { outcomeGood: true }),
        continuity: { present: true, helped: true },
      }),
      null,
    );
  });

  it('lets the §3.4 verdict win over the continuity read when both are present', () => {
    assert.equal(
      derivePhaseTag({
        attribution: verdict('plan-phase-gap'),
        continuity: { present: true, helped: false },
      }),
      PHASE_TAGS.PLAN,
    );
  });

  it('routes purely on continuity when no plan verdict is usable', () => {
    assert.equal(
      derivePhaseTag({
        attribution: null,
        continuity: { present: true, helped: false },
      }),
      PHASE_TAGS.ARTIFACTS,
    );
    assert.equal(
      derivePhaseTag({
        attribution: { classification: null },
        continuity: { present: true, helped: false },
      }),
      PHASE_TAGS.ARTIFACTS,
    );
  });
});

describe('degrade guard — findings that predate attribution data get NO tag', () => {
  it('returns null when neither a plan verdict nor a continuity read is present', () => {
    assert.equal(derivePhaseTag({}), null);
    assert.equal(derivePhaseTag({ attribution: null, continuity: null }), null);
  });

  it('treats a null-classification verdict (missing plan-quality/outcome) as no verdict', () => {
    // computeAttribution returns { classification: null } for the control arm /
    // pre-plan-quality records — with no continuity that must degrade, not guess.
    assert.equal(
      derivePhaseTag({ attribution: { classification: null } }),
      null,
    );
  });

  it('treats an absent touch-2 block (present: false) as no continuity read', () => {
    assert.equal(
      derivePhaseTag({ continuity: { present: false, helped: false } }),
      null,
    );
  });

  it('degrades — never a WRONG tag — for a legacy finding with bare records', () => {
    const legacy = tagFindings({
      findings: [finding({ scenario: 'story-scope' })],
      scenarios: [{ scenario: 'story-scope' }], // no attribution, no continuity
    });
    assert.equal(legacy[0].phaseTag, null);
  });
});

describe('tagFindings — a phase tag per finding envelope', () => {
  it('tags each finding from its own scenario, leaving inputs unmutated', () => {
    const input = [
      finding({ scenario: 'story-scope' }),
      finding({ scenario: 'epic-scope' }),
      finding({ scenario: 'hello-world' }),
    ];
    const tagged = tagFindings({
      findings: input,
      scenarios: fixtureScenarios(),
    });
    assert.deepEqual(
      tagged.map((f) => f.phaseTag),
      [PHASE_TAGS.PLAN, PHASE_TAGS.DELIVER, null],
    );
    // Input findings are not mutated.
    assert.equal('phaseTag' in input[0], false);
  });

  it('degrades a cross-scenario finding (scenario: null) to no tag', () => {
    const tagged = tagFindings({
      findings: [{ ...finding(), scenario: null }],
      scenarios: fixtureScenarios(),
    });
    assert.equal(tagged[0].phaseTag, null);
  });

  it('degrades a finding whose scenario has no attribution inputs', () => {
    const tagged = tagFindings({
      findings: [finding({ scenario: 'unknown-scope' })],
      scenarios: fixtureScenarios(),
    });
    assert.equal(tagged[0].phaseTag, null);
  });
});

describe('deriveAttributionFindings — the class-5 finding types', () => {
  it('derives plan-phase, deliver-phase, and artifact-continuity gaps, signal-gated', () => {
    const envelope = deriveAttributionFindings({
      scenarios: fixtureScenarios(),
      cohort: COHORT,
      links: LINKS,
      generatedAt: '2026-07-09T00:00:00.000Z',
    });

    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.generatedAt, '2026-07-09T00:00:00.000Z');
    assert.deepEqual(envelope.cohort, COHORT);

    const subjects = envelope.findings.map((f) => f.subject);
    // story-scope → plan gap; epic-scope → deliver gap + continuity gap;
    // hello-world (working-as-intended, no touch-2) → nothing;
    // compensating-scope → continuity gap (model-compensating is NOT a class-5
    // gap subject, but its unhelpful touch-2 IS).
    assert.deepEqual(subjects, [
      'plan-phase-gap',
      'deliver-phase-gap',
      'artifact-continuity-gap',
      'artifact-continuity-gap',
    ]);
    assert.deepEqual(envelope.counts, {
      'plan-phase-gap': 1,
      'deliver-phase-gap': 1,
      'artifact-continuity-gap': 2,
    });
  });

  it('stamps each finding with the class, phase tag, fingerprint, cohort, and links', () => {
    const envelope = deriveAttributionFindings({
      scenarios: fixtureScenarios(),
      cohort: COHORT,
      links: LINKS,
    });
    for (const f of envelope.findings) {
      assert.equal(f.class, ATTRIBUTION_FINDING_CLASS);
      assert.ok(CLASS5_SUBJECTS.includes(f.subject));
      assert.ok(Object.values(PHASE_TAGS).includes(f.phaseTag));
      assert.equal(
        f.fingerprint,
        attributionFingerprint({ scenario: f.scenario, subject: f.subject }),
      );
      assert.deepEqual(f.cohort, COHORT);
      assert.deepEqual(f.links, LINKS);
    }
    // The subject → phase-tag mapping is fixed.
    const byScenario = Object.fromEntries(
      envelope.findings.map((f) => [`${f.scenario}:${f.subject}`, f.phaseTag]),
    );
    assert.equal(byScenario['story-scope:plan-phase-gap'], PHASE_TAGS.PLAN);
    assert.equal(
      byScenario['epic-scope:deliver-phase-gap'],
      PHASE_TAGS.DELIVER,
    );
    assert.equal(
      byScenario['epic-scope:artifact-continuity-gap'],
      PHASE_TAGS.ARTIFACTS,
    );
  });

  it('derives ZERO findings from a corpus with no attribution signal', () => {
    const envelope = deriveAttributionFindings({
      scenarios: [
        { scenario: 'a' }, // no attribution, no continuity
        {
          scenario: 'b',
          attribution: { classification: null },
          continuity: { present: false },
        },
        {
          scenario: 'c',
          attribution: verdict('working-as-intended', { outcomeGood: true }),
          continuity: { present: true, helped: true },
        },
      ],
      cohort: COHORT,
    });
    assert.equal(envelope.findings.length, 0);
    assert.deepEqual(envelope.counts, {
      'plan-phase-gap': 0,
      'deliver-phase-gap': 0,
      'artifact-continuity-gap': 0,
    });
  });

  it('carries the §3.4 verdict terms and §4.5 deltas as evidence', () => {
    const envelope = deriveAttributionFindings({
      scenarios: fixtureScenarios(),
      cohort: COHORT,
    });
    const planGap = envelope.findings.find(
      (f) => f.subject === 'plan-phase-gap',
    );
    assert.equal(planGap.evidence.classification, 'plan-phase-gap');
    assert.equal(planGap.evidence.planGood, false);

    const contGap = envelope.findings.find(
      (f) =>
        f.scenario === 'epic-scope' && f.subject === 'artifact-continuity-gap',
    );
    assert.equal(contGap.evidence.helped, false);
    assert.equal(contGap.evidence.outcomeDelta, -0.1);
    assert.equal(contGap.evidence.costDelta, 0.3);
  });

  it('throws on a non-array scenarios or a missing cohort', () => {
    assert.throws(
      () => deriveAttributionFindings({ scenarios: null, cohort: COHORT }),
      /scenarios must be an array/,
    );
    assert.throws(
      () => deriveAttributionFindings({ scenarios: [], cohort: null }),
      /cohort triple is required/,
    );
  });
});

describe('determinism — same fixture corpus in, same output out', () => {
  it('tagFindings is byte-identical across two runs', () => {
    const findings = [
      finding({ scenario: 'story-scope' }),
      finding({ scenario: 'epic-scope' }),
      finding({ scenario: 'compensating-scope' }),
    ];
    const a = tagFindings({ findings, scenarios: fixtureScenarios() });
    const b = tagFindings({ findings, scenarios: fixtureScenarios() });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it('deriveAttributionFindings is byte-identical across two runs', () => {
    const a = deriveAttributionFindings({
      scenarios: fixtureScenarios(),
      cohort: COHORT,
      links: LINKS,
      generatedAt: '2026-07-09T00:00:00.000Z',
    });
    const b = deriveAttributionFindings({
      scenarios: fixtureScenarios(),
      cohort: COHORT,
      links: LINKS,
      generatedAt: '2026-07-09T00:00:00.000Z',
    });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    // Fingerprints are stable and cohort-independent.
    const other = deriveAttributionFindings({
      scenarios: fixtureScenarios(),
      cohort: { ...COHORT, frameworkVersion: '1.99.0' },
      links: LINKS,
    });
    assert.deepEqual(
      a.findings.map((f) => f.fingerprint),
      other.findings.map((f) => f.fingerprint),
    );
  });
});

describe('attribute — the combined convenience entry', () => {
  it('tags existing findings AND derives the class-5 envelope in one call', () => {
    const result = attribute({
      findings: [
        finding({ scenario: 'story-scope' }),
        finding({ scenario: 'epic-scope' }),
      ],
      scenarios: fixtureScenarios(),
      cohort: COHORT,
      links: LINKS,
    });
    assert.deepEqual(
      result.tagged.map((f) => f.phaseTag),
      [PHASE_TAGS.PLAN, PHASE_TAGS.DELIVER],
    );
    assert.equal(result.attribution.findings.length, 4);
    assert.equal(result.attribution.schemaVersion, 1);
  });
});
