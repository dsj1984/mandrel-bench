// tests/bench/feedback/derive.test.js
//
// Unit tier (pure logic, no I/O) for feedback finding derivation
// (Epic #85, Story #91). Exercises bench/feedback/derive.js against the
// Story's binding acceptance items:
//   - all four finding classes derived from a fixture corpus, each carrying the
//     cohort triple, noise-band evidence, and report/scorecard links;
//   - the previous-comparable-cohort resolver is derive.js's own (same model +
//     benchmarkVersion, immediately-prior frameworkVersion — exactly one key
//     changed) and does NOT reuse compare.js cohortMatch semantics;
//   - a finding class with no signal derives ZERO findings (no placeholders);
//   - deriving twice yields identical findings (stable fingerprints).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cohortTriple,
  compareVersions,
  deriveFindings,
  previousComparableCohort,
  renderFindingsMarkdown,
} from '../../../bench/feedback/derive.js';
import { compareRuns } from '../../../bench/report/compare.js';

const MODEL = { id: 'claude-opus-4-8[1m]' };
const ENV = { node: 'v24.16.0', os: 'darwin' };
const LINKS = {
  report: 'claude-opus-4-8-1m/1.70.0/reports/report-x.md',
  scorecards: 'claude-opus-4-8-1m/1.70.0/scorecards.ndjson',
};

/**
 * A fully-shaped scorecard for the fixture corpus. Every field the four finding
 * classes read is expressible via a keyword arg.
 */
function card({
  scenario = 'story-scope',
  arm = 'mandrel',
  runId = `${scenario}-${arm}-r1`,
  frameworkVersion = '1.70.0',
  benchmarkVersion = '0.5.0',
  model = MODEL,
  env = ENV,
  quality = 1,
  planningFidelity = 0.9,
  autonomy = 1,
  guardrailMet = true,
  guardrailThreshold = 0.99,
  maintainability = 0.9,
  security = 1,
  tokenRatio = 4,
  totalTokens = 180000,
  costUsd = 1.4,
  wallClockMs = 600000,
  dispatches = 2,
  routingMismatch = false,
  routingVerdict = 'story',
  warnings,
  trap,
} = {}) {
  const sc = {
    schemaVersion: 1,
    runId,
    timestamp: '2026-06-16T19:42:11.000Z',
    model,
    frameworkVersion,
    benchmarkVersion,
    env,
    scenario,
    arm,
    routingVerdict: arm === 'control' ? null : routingVerdict,
    routingMismatch: arm === 'control' ? false : routingMismatch,
    dimensions: {
      quality: { score: quality, frozenSuitePassRate: quality },
      planningFidelity: { score: arm === 'control' ? null : planningFidelity },
      autonomy: {
        score: autonomy,
        hitlStops: 0,
        blockedEvents: 0,
        manualRescues: 0,
        guardrail: { threshold: guardrailThreshold, met: guardrailMet },
      },
      maintainability: { score: maintainability },
      security: { score: security },
      overheadRatio: {
        tokenRatio: arm === 'control' ? tokenRatio : tokenRatio,
      },
      efficiency: { wallClockMs, totalTokens, dispatches, costUsd },
    },
  };
  if (warnings) sc.warnings = warnings;
  if (trap) sc.trap = trap;
  return sc;
}

/** N mandrel+control cards for one scenario with tiny per-run jitter. */
function cell({
  scenario,
  frameworkVersion = '1.70.0',
  benchmarkVersion = '0.5.0',
  n = 4,
  mandrel = {},
  control = {},
}) {
  const cards = [];
  for (let i = 0; i < n; i += 1) {
    const jitter = i % 2 === 0 ? 0.001 : -0.001;
    cards.push(
      card({
        scenario,
        arm: 'mandrel',
        runId: `${scenario}-m-${frameworkVersion}-${i}`,
        frameworkVersion,
        benchmarkVersion,
        quality: (mandrel.quality ?? 1) + jitter,
        totalTokens: (mandrel.totalTokens ?? 180000) + i * 10,
        tokenRatio: (mandrel.tokenRatio ?? 4) + jitter,
        ...mandrel.extra,
      }),
    );
    cards.push(
      card({
        scenario,
        arm: 'control',
        runId: `${scenario}-c-${frameworkVersion}-${i}`,
        frameworkVersion,
        benchmarkVersion,
        quality: (control.quality ?? 1) + jitter,
        totalTokens: (control.totalTokens ?? 40000) + i * 10,
        tokenRatio: (control.tokenRatio ?? 0.1) + jitter,
        ...control.extra,
      }),
    );
  }
  return cards;
}

const TARGET = {
  model: MODEL.id,
  frameworkVersion: '1.70.0',
  benchmarkVersion: '0.5.0',
};

describe('compareVersions', () => {
  it('orders dotted versions numerically, not lexically', () => {
    assert.equal(compareVersions('1.9.0', '1.70.0'), -1);
    assert.equal(compareVersions('1.70.0', '1.9.0'), 1);
    assert.equal(compareVersions('1.70.0', '1.70.0'), 0);
  });
});

describe('previousComparableCohort', () => {
  it('picks the immediately-prior frameworkVersion (same model + benchmark)', () => {
    const corpus = [
      card({ frameworkVersion: '1.68.0' }),
      card({ frameworkVersion: '1.69.0' }),
      card({ frameworkVersion: '1.70.0' }),
    ];
    const prev = previousComparableCohort(corpus, TARGET);
    assert.equal(prev.frameworkVersion, '1.69.0');
    assert.equal(prev.model, TARGET.model);
    assert.equal(prev.benchmarkVersion, TARGET.benchmarkVersion);
  });

  it('requires the SAME benchmarkVersion — a prior fw under a different benchmark is not comparable', () => {
    const corpus = [
      card({ frameworkVersion: '1.69.0', benchmarkVersion: '0.4.0' }),
      card({ frameworkVersion: '1.70.0', benchmarkVersion: '0.5.0' }),
    ];
    const prev = previousComparableCohort(corpus, TARGET);
    assert.equal(prev, null);
  });

  it('returns null when no prior framework version exists', () => {
    const corpus = [card({ frameworkVersion: '1.70.0' })];
    assert.equal(previousComparableCohort(corpus, TARGET), null);
  });
});

describe('deriveFindings — regressions vs previous comparable cohort', () => {
  // Baseline fw 1.69 quality ≈ 1.0; target fw 1.70 quality ≈ 0.5 — a real drop.
  const baseline = cell({
    scenario: 'hello-world',
    frameworkVersion: '1.69.0',
    mandrel: { quality: 1.0 },
    control: { quality: 1.0 },
  });
  const target = cell({
    scenario: 'hello-world',
    frameworkVersion: '1.70.0',
    mandrel: { quality: 0.5 },
    control: { quality: 1.0 },
  });
  const corpus = [...baseline, ...target];

  it('derives a regression finding carrying the cohort triple, noise-band evidence and links', () => {
    const env = deriveFindings({ corpus, cohort: TARGET, links: LINKS });
    const reg = env.findings.find(
      (f) => f.class === 'regression' && f.subject === 'quality',
    );
    assert.ok(reg, 'expected a quality regression finding');
    assert.equal(reg.scenario, 'hello-world');
    assert.deepEqual(reg.cohort, TARGET);
    assert.ok(
      reg.evidence.shiftIsReal,
      'regression must clear the noise floor',
    );
    assert.equal(typeof reg.evidence.noiseFloor, 'number');
    assert.equal(
      reg.evidence.previousComparableCohort.frameworkVersion,
      '1.69.0',
    );
    assert.equal(reg.links.report, LINKS.report);
    assert.equal(reg.links.scorecards, LINKS.scorecards);
    assert.match(reg.fingerprint, /^[0-9a-f]{16}$/);
    assert.equal(env.previousComparableCohort.frameworkVersion, '1.69.0');
  });

  it('resolves the baseline itself — it does NOT gate on compare.js cohortMatch', () => {
    // compare.js (correctly, for ITS purpose) flags a prior-fw baseline as a
    // cohort mismatch...
    const comparison = compareRuns({ baseline, candidate: target });
    assert.equal(comparison.cohortMatch, false);
    // ...yet derive.js still produces the regression, proving it uses its own
    // resolver rather than reusing cohortMatch as a comparability gate.
    const env = deriveFindings({ corpus, cohort: TARGET, links: LINKS });
    assert.ok(env.counts.regression > 0);
  });

  it('derives ZERO regressions when there is no prior comparable cohort', () => {
    const env = deriveFindings({
      corpus: target,
      cohort: TARGET,
      links: LINKS,
    });
    assert.equal(env.counts.regression, 0);
    assert.equal(env.previousComparableCohort, null);
  });
});

describe('deriveFindings — standing costs', () => {
  it('derives an overhead-floor finding when hello-world ceremony has no quality gain', () => {
    const corpus = cell({
      scenario: 'hello-world',
      mandrel: { quality: 1.0, totalTokens: 180000 },
      control: { quality: 1.0, totalTokens: 40000 },
    });
    const env = deriveFindings({ corpus, cohort: TARGET, links: LINKS });
    const floor = env.findings.find(
      (f) => f.class === 'standing-cost' && f.subject === 'overhead-floor',
    );
    assert.ok(floor, 'expected an overhead-floor standing-cost finding');
    assert.ok(floor.evidence.overheadFloorTokens > 0);
    assert.equal(floor.evidence.noQualityGain, true);
  });

  it('derives an overhead-ratio finding when the mandrel ratio really exceeds control', () => {
    const corpus = cell({
      scenario: 'story-scope',
      mandrel: { tokenRatio: 4 },
      control: { tokenRatio: 0.1 },
    });
    const env = deriveFindings({ corpus, cohort: TARGET, links: LINKS });
    const ratio = env.findings.find(
      (f) => f.class === 'standing-cost' && f.subject === 'overhead-ratio',
    );
    assert.ok(ratio, 'expected an overhead-ratio standing-cost finding');
    assert.ok(ratio.evidence.delta > ratio.evidence.noiseFloor);
  });

  it('derives a monotonicity finding when efficiency does not rise with difficulty', () => {
    // hello-world (diff 1) uses MORE tokens than story-scope (diff 3): a
    // calibration violation.
    const corpus = [
      ...cell({
        scenario: 'hello-world',
        mandrel: { totalTokens: 200000, tokenRatio: 1 },
      }),
      ...cell({
        scenario: 'story-scope',
        mandrel: { totalTokens: 100000, tokenRatio: 2 },
      }),
    ];
    const env = deriveFindings({ corpus, cohort: TARGET, links: LINKS });
    const mono = env.findings.find(
      (f) =>
        f.class === 'standing-cost' && f.subject.startsWith('monotonicity:'),
    );
    assert.ok(mono, 'expected a monotonicity standing-cost finding');
    assert.equal(mono.scenario, null);
    assert.ok(Array.isArray(mono.evidence.violations));
  });
});

describe('deriveFindings — trap differentials', () => {
  it('derives a finding when the mandrel arm leaks a planted defect class', () => {
    const dirtyTrap = {
      classes: [
        { class: 'plaintext-password', score: 0, defectPresent: true },
        { class: 'token-generation', score: 1, defectPresent: false },
      ],
      cleanRate: 0.5,
    };
    const cleanTrap = {
      classes: [
        { class: 'plaintext-password', score: 1, defectPresent: false },
        { class: 'token-generation', score: 1, defectPresent: false },
      ],
      cleanRate: 1,
    };
    const corpus = [
      card({
        scenario: 'story-scope',
        arm: 'mandrel',
        runId: 'm1',
        trap: dirtyTrap,
      }),
      card({
        scenario: 'story-scope',
        arm: 'mandrel',
        runId: 'm2',
        trap: dirtyTrap,
      }),
      card({
        scenario: 'story-scope',
        arm: 'control',
        runId: 'c1',
        trap: cleanTrap,
      }),
      card({
        scenario: 'story-scope',
        arm: 'control',
        runId: 'c2',
        trap: cleanTrap,
      }),
    ];
    const env = deriveFindings({ corpus, cohort: TARGET, links: LINKS });
    const trap = env.findings.find(
      (f) =>
        f.class === 'trap-differential' && f.subject === 'plaintext-password',
    );
    assert.ok(trap, 'expected a plaintext-password trap-differential finding');
    assert.equal(trap.scenario, 'story-scope');
    assert.equal(trap.evidence.mandrelCleanRate, 0);
    assert.equal(trap.evidence.controlCleanRate, 1);
    // The clean token-generation class derives nothing.
    assert.ok(
      !env.findings.some((f) => f.subject === 'token-generation'),
      'a clean trap class must derive zero findings',
    );
  });
});

describe('deriveFindings — pipeline calibration', () => {
  it('derives a routing-mismatch finding when >25% of a cell diverges', () => {
    const corpus = [
      card({
        scenario: 'epic-scope',
        arm: 'mandrel',
        runId: 'ok1',
        routingMismatch: false,
      }),
      card({
        scenario: 'epic-scope',
        arm: 'mandrel',
        runId: 'bad1',
        routingMismatch: true,
      }),
      card({
        scenario: 'epic-scope',
        arm: 'mandrel',
        runId: 'bad2',
        routingMismatch: true,
      }),
      card({ scenario: 'epic-scope', arm: 'control', runId: 'cc1' }),
    ];
    const env = deriveFindings({ corpus, cohort: TARGET, links: LINKS });
    const routing = env.findings.find(
      (f) =>
        f.class === 'pipeline-calibration' && f.subject === 'routing-mismatch',
    );
    assert.ok(routing, 'expected a routing-mismatch finding');
    assert.ok(routing.evidence.mismatchRate > 0.25);
  });

  it('derives an autonomy-guardrail finding when a mandrel run falls below threshold', () => {
    const corpus = [
      card({
        scenario: 'story-scope',
        arm: 'mandrel',
        runId: 'g1',
        guardrailMet: false,
        autonomy: 0.8,
      }),
      card({
        scenario: 'story-scope',
        arm: 'mandrel',
        runId: 'g2',
        guardrailMet: true,
      }),
    ];
    const env = deriveFindings({ corpus, cohort: TARGET, links: LINKS });
    const guard = env.findings.find((f) => f.subject === 'autonomy-guardrail');
    assert.ok(guard, 'expected an autonomy-guardrail finding');
    assert.equal(guard.evidence.failingRuns, 1);
    assert.equal(guard.evidence.threshold, 0.99);
  });

  it('derives a standalone-telemetry-absent finding when the warning is present', () => {
    const corpus = [
      card({
        scenario: 'story-scope',
        arm: 'mandrel',
        runId: 't1',
        warnings: ['standalone-telemetry-absent'],
      }),
    ];
    const env = deriveFindings({ corpus, cohort: TARGET, links: LINKS });
    const tele = env.findings.find(
      (f) => f.subject === 'standalone-telemetry-absent',
    );
    assert.ok(tele, 'expected a standalone-telemetry-absent finding');
    assert.equal(tele.evidence.affectedRuns, 1);
  });
});

describe('deriveFindings — no signal ⇒ zero findings (no placeholders)', () => {
  it('derives an empty finding set from a clean single-cohort corpus', () => {
    const corpus = cell({
      scenario: 'story-scope',
      mandrel: { quality: 1, tokenRatio: 0.1 },
      control: { quality: 1, tokenRatio: 0.1 },
    }).map((sc) =>
      sc.arm === 'mandrel'
        ? {
            ...sc,
            trap: {
              classes: [
                { class: 'plaintext-password', score: 1, defectPresent: false },
              ],
              cleanRate: 1,
            },
          }
        : sc,
    );
    const env = deriveFindings({ corpus, cohort: TARGET, links: LINKS });
    assert.equal(env.findings.length, 0);
    for (const c of Object.values(env.counts)) assert.equal(c, 0);
  });
});

describe('deriveFindings — determinism', () => {
  it('yields byte-identical findings when derived twice', () => {
    const corpus = [
      ...cell({
        scenario: 'hello-world',
        frameworkVersion: '1.69.0',
        mandrel: { quality: 1 },
      }),
      ...cell({
        scenario: 'hello-world',
        frameworkVersion: '1.70.0',
        mandrel: { quality: 0.5 },
      }),
    ];
    const a = deriveFindings({
      corpus,
      cohort: TARGET,
      links: LINKS,
      generatedAt: 'T',
    });
    const b = deriveFindings({
      corpus,
      cohort: TARGET,
      links: LINKS,
      generatedAt: 'T',
    });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});

describe('cohortTriple + renderFindingsMarkdown', () => {
  it('extracts the D-014 triple from a scorecard', () => {
    assert.deepEqual(cohortTriple(card({})), TARGET);
  });

  it('renders a findings section and a clean-cohort note', () => {
    const empty = deriveFindings({
      corpus: cell({
        scenario: 'story-scope',
        mandrel: { tokenRatio: 0.1 },
        control: { tokenRatio: 0.1 },
      }),
      cohort: TARGET,
      links: LINKS,
    });
    const md = renderFindingsMarkdown(empty);
    assert.match(md, /## Benchmark findings/);
    assert.match(md, /No findings derived/);

    const dirty = deriveFindings({
      corpus: cell({
        scenario: 'hello-world',
        mandrel: { totalTokens: 180000 },
        control: { totalTokens: 40000 },
      }),
      cohort: TARGET,
      links: LINKS,
    });
    const dirtyMd = renderFindingsMarkdown(dirty);
    assert.match(dirtyMd, /### standing-cost/);
    assert.match(dirtyMd, /fingerprint:/);
    assert.match(dirtyMd, /\[report\]/);
  });
});
