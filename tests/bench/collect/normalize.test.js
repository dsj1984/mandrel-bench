// tests/bench/collect/normalize.test.js
//
// Unit + contract tier for the telemetry normalizer (Epic #4211, Story #4217).
// Exercises bench/collect/normalize.js:
//   - NDJSON parsing (blank-line tolerance, malformed-line failure),
//   - lifecycle-derived raw sub-signals (wall-clock, dispatch count, autonomy
//     counters, the ceremony/codegen token split),
//   - usage extraction from both the normalized and raw `claude -p` envelope
//     shapes,
//   - the binding acceptance item: the assembled per-run record CONFORMS to
//     bench/schemas/scorecard.schema.json (validated with the same Ajv 2020
//     strict setup the schema's own contract test uses),
//   - the file-reading shell via an injected reader, including reading the
//     committed bench/fixtures/lifecycle.sample.ndjson.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  buildScorecard,
  deriveAutonomyCounters,
  deriveDispatchCount,
  deriveTokenSplit,
  deriveTokenSplitFromCodegenMs,
  deriveWallClockMs,
  extractDurationMs,
  extractUsage,
  normalizeRunFromPaths,
  parseNdjson,
  SCORECARD_SCHEMA_VERSION,
} from '../../../bench/collect/normalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/bench/collect/ → repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  'bench',
  'schemas',
  'scorecard.schema.json',
);
const LIFECYCLE_FIXTURE = path.join(
  REPO_ROOT,
  'bench',
  'fixtures',
  'lifecycle.sample.ndjson',
);

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

/** A validator built exactly like the schema's own contract test. */
function buildValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** A canonical run-identity stamp (hello-world / mandrel). */
function runStamp(overrides = {}) {
  return {
    runId: 'hello-world-mandrel-2026-06-16-r01',
    timestamp: '2026-06-16T19:42:11.000Z',
    model: {
      id: 'claude-opus-4-8[1m]',
      displayName: 'Claude Opus 4.8 (1M context)',
    },
    frameworkVersion: '1.70.0',
    benchmarkVersion: '0.5.0',
    env: { node: 'v24.16.0', os: 'darwin', host: 'bench-runner-01' },
    scenario: 'hello-world',
    arm: 'mandrel',
    ...overrides,
  };
}

/** A normalized envelope (the shape parseSessionEnvelope returns). */
function normalizedEnvelope(overrides = {}) {
  return {
    usage: {
      inputTokens: 151200,
      outputTokens: 33120,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 184320,
    },
    cost: { totalUsd: 1.47 },
    ...overrides,
  };
}

describe('parseNdjson', () => {
  it('parses non-blank lines and skips blanks', () => {
    const recs = parseNdjson('{"a":1}\n\n  \n{"b":2}\n');
    assert.deepEqual(recs, [{ a: 1 }, { b: 2 }]);
  });

  it('throws with the 1-based line number on a malformed line', () => {
    assert.throws(() => parseNdjson('{"a":1}\nnot json\n'), /line 2/);
  });

  it('rejects a non-string input', () => {
    assert.throws(() => parseNdjson(null), TypeError);
  });
});

describe('deriveWallClockMs', () => {
  it('is the span between the earliest and latest timestamp', () => {
    const recs = [
      { ts: '2026-06-16T19:32:00.000Z' },
      { ts: '2026-06-16T19:42:11.000Z' },
      { ts: '2026-06-16T19:34:30.000Z' },
    ];
    // 19:42:11 − 19:32:00 = 611 s = 611000 ms
    assert.equal(deriveWallClockMs(recs), 611000);
  });

  it('is 0 when fewer than two timestamps are parseable', () => {
    assert.equal(deriveWallClockMs([{ ts: '2026-06-16T19:32:00.000Z' }]), 0);
    assert.equal(deriveWallClockMs([{ ts: 'nope' }, { ts: 'also nope' }]), 0);
  });
});

describe('deriveDispatchCount', () => {
  it('counts story.dispatch.start records', () => {
    const recs = [
      { event: 'story.dispatch.start', payload: { storyId: 1 } },
      { event: 'story.dispatch.start', payload: { storyId: 2 } },
      { event: 'story.dispatch.end', payload: { storyId: 1 } },
      { event: 'epic.plan.start' },
    ];
    assert.equal(deriveDispatchCount(recs), 2);
  });
});

describe('deriveAutonomyCounters', () => {
  it('counts blocked events, manual rescues, and hitl stops', () => {
    const lifecycle = [
      { event: 'epic.blocked', payload: { reason: 'x' } },
      { event: 'story.blocked', payload: { storyId: 1, reason: 'y' } },
      { event: 'intervention.recorded', payload: { epicId: 1, reason: 'z' } },
      { event: 'story.dispatch.start', payload: { storyId: 1 } },
    ];
    const signals = [
      { kind: 'hitl-stop' },
      { signal: 'hitl-stop' },
      { kind: 'other' },
    ];
    const counters = deriveAutonomyCounters({ lifecycle, signals });
    assert.deepEqual(counters, {
      hitlStops: 2,
      blockedEvents: 2,
      manualRescues: 1,
      gateRetries: 0,
    });
  });

  it('is all zeros for a clean unattended run', () => {
    const counters = deriveAutonomyCounters({
      lifecycle: [{ event: 'story.dispatch.start', payload: { storyId: 1 } }],
      signals: [],
    });
    assert.deepEqual(counters, {
      hitlStops: 0,
      blockedEvents: 0,
      manualRescues: 0,
      gateRetries: 0,
    });
  });

  it('routes self-recovered close-validate failures to gateRetries, not blockedEvents (Ticket #121, item 2)', () => {
    const lifecycle = [
      // A terminal block (genuine intervention).
      { event: 'story.blocked', payload: { storyId: 1, reason: 'stuck' } },
      // Two self-recovered close-validate gate failures — NOT interventions.
      {
        event: 'story.blocked',
        payload: { storyId: 2, reason: 'close-validate-failed:test' },
      },
      {
        event: 'story.blocked',
        payload: { storyId: 2, reason: 'close-validate-failed:lint' },
      },
      { event: 'epic.blocked', payload: { reason: 'x' } },
    ];
    const counters = deriveAutonomyCounters({ lifecycle, signals: [] });
    assert.deepEqual(counters, {
      hitlStops: 0,
      // 1 terminal story.blocked + 1 epic.blocked; the two close-validate
      // failures are excluded from the terminal tally.
      blockedEvents: 2,
      manualRescues: 0,
      gateRetries: 2,
    });
  });
});

describe('deriveTokenSplit', () => {
  it('attributes tokens to codegen in proportion to dispatch wall-clock', () => {
    // One dispatch window of 100s inside a 200s run ⇒ 50% codegen.
    const lifecycle = [
      { event: 'epic.plan.start', ts: '2026-06-16T19:00:00.000Z' },
      {
        event: 'story.dispatch.start',
        ts: '2026-06-16T19:01:00.000Z',
        payload: { storyId: 1 },
      },
      {
        event: 'story.dispatch.end',
        ts: '2026-06-16T19:02:40.000Z',
        payload: { storyId: 1 },
      },
      { event: 'epic.complete', ts: '2026-06-16T19:03:20.000Z' },
    ];
    // wall = 200s, codegen window = 100s
    const split = deriveTokenSplit({
      lifecycle,
      totalTokens: 1000,
      wallClockMs: 200000,
    });
    assert.equal(split.codegenMs, 100000);
    assert.equal(split.ceremonyMs, 100000);
    assert.equal(split.codegenTokens, 500);
    assert.equal(split.ceremonyTokens, 500);
  });

  it('keeps ceremonyTokens + codegenTokens === totalTokens', () => {
    const lifecycle = [
      {
        event: 'story.dispatch.start',
        ts: '2026-06-16T19:01:00.000Z',
        payload: { storyId: 1 },
      },
      {
        event: 'story.dispatch.end',
        ts: '2026-06-16T19:01:33.000Z',
        payload: { storyId: 1 },
      },
    ];
    const split = deriveTokenSplit({
      lifecycle,
      totalTokens: 999,
      wallClockMs: 90000,
    });
    assert.equal(split.codegenTokens + split.ceremonyTokens, 999);
  });

  it('attributes everything to ceremony when there is no measurable codegen window', () => {
    const split = deriveTokenSplit({
      lifecycle: [{ event: 'epic.plan.start', ts: '2026-06-16T19:00:00.000Z' }],
      totalTokens: 500,
      wallClockMs: 0,
    });
    assert.equal(split.codegenTokens, 0);
    assert.equal(split.ceremonyTokens, 500);
  });

  it('clamps codegen time that would exceed wall-clock (overlapping dispatches)', () => {
    // Two fully-overlapping 200s windows inside a 200s run: summed = 400s,
    // clamped to 200s ⇒ all tokens are codegen.
    const lifecycle = [
      {
        event: 'story.dispatch.start',
        ts: '2026-06-16T19:00:00.000Z',
        payload: { storyId: 1 },
      },
      {
        event: 'story.dispatch.start',
        ts: '2026-06-16T19:00:00.000Z',
        payload: { storyId: 2 },
      },
      {
        event: 'story.dispatch.end',
        ts: '2026-06-16T19:03:20.000Z',
        payload: { storyId: 1 },
      },
      {
        event: 'story.dispatch.end',
        ts: '2026-06-16T19:03:20.000Z',
        payload: { storyId: 2 },
      },
    ];
    const split = deriveTokenSplit({
      lifecycle,
      totalTokens: 800,
      wallClockMs: 200000,
    });
    assert.equal(split.codegenMs, 200000);
    assert.equal(split.codegenTokens, 800);
    assert.equal(split.ceremonyTokens, 0);
  });
});

describe('deriveTokenSplitFromCodegenMs — direct edge-case coverage (Epic #66 audit remediation, M4-M10)', () => {
  it('attributes tokens proportionally for a plain in-range codegenMs', () => {
    const split = deriveTokenSplitFromCodegenMs({
      codegenMs: 50000,
      totalTokens: 1000,
      wallClockMs: 200000,
    });
    assert.equal(split.codegenMs, 50000);
    assert.equal(split.ceremonyMs, 150000);
    assert.equal(split.codegenTokens, 250);
    assert.equal(split.ceremonyTokens, 750);
  });

  it('treats a negative codegenMs as 0 (all ceremony)', () => {
    const split = deriveTokenSplitFromCodegenMs({
      codegenMs: -5000,
      totalTokens: 400,
      wallClockMs: 100000,
    });
    assert.equal(split.codegenMs, 0);
    assert.equal(split.ceremonyMs, 100000);
    assert.equal(split.codegenTokens, 0);
    assert.equal(split.ceremonyTokens, 400);
  });

  it('treats a non-finite codegenMs (NaN/Infinity) as 0', () => {
    const nanSplit = deriveTokenSplitFromCodegenMs({
      codegenMs: Number.NaN,
      totalTokens: 400,
      wallClockMs: 100000,
    });
    assert.equal(nanSplit.codegenMs, 0);
    assert.equal(nanSplit.codegenTokens, 0);

    const infSplit = deriveTokenSplitFromCodegenMs({
      codegenMs: Number.POSITIVE_INFINITY,
      totalTokens: 400,
      wallClockMs: 100000,
    });
    // Infinity is non-finite, so it also falls back to 0 raw codegen — NOT
    // clamped-to-wall, since the finiteness guard runs before the clamp.
    assert.equal(infSplit.codegenMs, 0);
    assert.equal(infSplit.codegenTokens, 0);
  });

  it('clamps a codegenMs exceeding wallClockMs down to wallClockMs (all codegen)', () => {
    const split = deriveTokenSplitFromCodegenMs({
      codegenMs: 999999,
      totalTokens: 600,
      wallClockMs: 100000,
    });
    assert.equal(split.codegenMs, 100000);
    assert.equal(split.ceremonyMs, 0);
    assert.equal(split.codegenTokens, 600);
    assert.equal(split.ceremonyTokens, 0);
  });

  it('attributes everything to ceremony when wallClockMs <= 0', () => {
    const zeroWall = deriveTokenSplitFromCodegenMs({
      codegenMs: 5000,
      totalTokens: 300,
      wallClockMs: 0,
    });
    assert.equal(zeroWall.codegenTokens, 0);
    assert.equal(zeroWall.ceremonyTokens, 300);
    assert.equal(zeroWall.ceremonyMs, 0);

    const negWall = deriveTokenSplitFromCodegenMs({
      codegenMs: 5000,
      totalTokens: 300,
      wallClockMs: -1000,
    });
    assert.equal(negWall.codegenTokens, 0);
    assert.equal(negWall.ceremonyTokens, 300);
    assert.equal(negWall.ceremonyMs, 0);
  });

  it('both buckets are 0 when totalTokens is 0 or negative', () => {
    const zeroTokens = deriveTokenSplitFromCodegenMs({
      codegenMs: 5000,
      totalTokens: 0,
      wallClockMs: 100000,
    });
    assert.equal(zeroTokens.codegenTokens, 0);
    assert.equal(zeroTokens.ceremonyTokens, 0);

    const negTokens = deriveTokenSplitFromCodegenMs({
      codegenMs: 5000,
      totalTokens: -100,
      wallClockMs: 100000,
    });
    assert.equal(negTokens.codegenTokens, 0);
    assert.equal(negTokens.ceremonyTokens, 0);
  });
});

describe('extractUsage', () => {
  it('reads the normalized envelope shape (no modelUsage ⇒ true==reported)', () => {
    const u = extractUsage(normalizedEnvelope());
    assert.deepEqual(u, {
      totalTokens: 184320,
      reportedTokens: 184320,
      inputTokens: 151200,
      outputTokens: 33120,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 1.47,
    });
  });

  it('reads the raw `claude -p` envelope shape and sums cache tokens', () => {
    const u = extractUsage({
      total_cost_usd: 0.35,
      usage: {
        input_tokens: 4942,
        output_tokens: 100,
        cache_creation_input_tokens: 31340,
        cache_read_input_tokens: 1000,
      },
    });
    assert.equal(u.totalTokens, 4942 + 100 + 31340 + 1000);
    assert.equal(u.reportedTokens, 4942 + 100 + 31340 + 1000);
    assert.equal(u.inputTokens, 4942);
    assert.equal(u.outputTokens, 100);
    assert.equal(u.cacheReadTokens, 1000);
    assert.equal(u.cacheWriteTokens, 31340);
    assert.equal(u.costUsd, 0.35);
  });

  it('sums modelUsage into a TRUE, sub-agent-inclusive total distinct from reported (Ticket #122, item 1)', () => {
    // Parent session reports 10k; two sub-agents add 20k + 15k → true 45k.
    const u = extractUsage({
      cost: { totalUsd: 12.5 },
      usage: {
        inputTokens: 8000,
        outputTokens: 2000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalTokens: 10000,
      },
      modelUsage: {
        'claude-opus-4-8[1m]': {
          inputTokens: 8000,
          outputTokens: 2000,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        'claude-opus-4-8[1m]#sub-a': {
          inputTokens: 1000,
          outputTokens: 4000,
          cacheReadInputTokens: 15000,
          cacheCreationInputTokens: 0,
        },
        'claude-opus-4-8[1m]#sub-b': {
          inputTokens: 500,
          outputTokens: 2500,
          cacheReadInputTokens: 12000,
          cacheCreationInputTokens: 0,
        },
      },
    });
    assert.equal(u.reportedTokens, 10000, 'reported stays the parent figure');
    assert.equal(
      u.totalTokens,
      10000 + 20000 + 15000,
      'true total is sub-agent-inclusive',
    );
    assert.equal(u.cacheReadTokens, 27000);
    assert.equal(u.outputTokens, 8500);
  });

  it('falls back to reported when modelUsage is degenerately smaller (never under-counts)', () => {
    // Incomplete modelUsage (only inputTokens) must not shrink the true total.
    const u = extractUsage({
      total_cost_usd: 0.35,
      usage: {
        input_tokens: 4942,
        output_tokens: 100,
        cache_creation_input_tokens: 31340,
        cache_read_input_tokens: 1000,
      },
      modelUsage: {
        'claude-opus-4-8[1m]': { inputTokens: 4942, costUSD: 0.35 },
      },
    });
    assert.equal(u.totalTokens, 4942 + 100 + 31340 + 1000);
    assert.equal(u.reportedTokens, 4942 + 100 + 31340 + 1000);
  });

  it('returns zeros / null for a missing envelope', () => {
    assert.deepEqual(extractUsage(null), {
      totalTokens: 0,
      reportedTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
    });
  });
});

describe('extractDurationMs', () => {
  it('reads durationMs / duration_ms / raw.duration_ms, else 0', () => {
    assert.equal(extractDurationMs({ durationMs: 1200 }), 1200);
    assert.equal(extractDurationMs({ duration_ms: 3400 }), 3400);
    assert.equal(extractDurationMs({ raw: { duration_ms: 5600 } }), 5600);
    assert.equal(extractDurationMs({}), 0);
    assert.equal(extractDurationMs(null), 0);
  });
});

describe('buildScorecard — control arm efficiency/overhead', () => {
  it('falls back to the envelope duration for wall-clock and attributes all tokens to codegen', () => {
    const sc = buildScorecard({
      run: {
        runId: 'hw-control-r1',
        timestamp: '2026-06-17T00:00:00.000Z',
        model: { id: 'claude-opus-4-8' },
        frameworkVersion: '1.70.0',
        benchmarkVersion: '0.5.0',
        env: { node: 'v24.0.0', os: 'darwin' },
        scenario: 'hello-world',
        arm: 'control',
      },
      lifecycle: [], // control has no ledger
      signals: [],
      envelope: {
        usage: { totalTokens: 100000, inputTokens: 80000, outputTokens: 20000 },
        cost: { totalUsd: 0.18 },
        durationMs: 35600,
      },
      quality: { frozenSuitePassed: 3, frozenSuiteTotal: 3 },
    });
    // Real wall-clock from the envelope, not 0.
    assert.equal(sc.dimensions.efficiency.wallClockMs, 35600);
    // Control does no ceremony: all codegen, overhead ratio at the floor.
    assert.equal(sc.dimensions.overheadRatio.ceremonyTokens, 0);
    assert.equal(sc.dimensions.overheadRatio.codegenTokens, 100000);
    assert.equal(sc.dimensions.overheadRatio.tokenRatio, 0);
  });
});

describe('buildScorecard — per-phase envelopes (D-019, Epic #86 Story #94)', () => {
  it('attaches phases[] on the mandrel arm; per-phase cost/tokens SUM to the efficiency totals', () => {
    // The run envelope is the SUM of the phase envelopes (aggregateEnvelopes),
    // so the phases[] block sums to efficiency.costUsd / totalTokens.
    const phases = [
      { phase: 'plan', costUsd: 0.4, tokens: 40000, wallClockMs: 120000 },
      { phase: 'deliver', costUsd: 1.1, tokens: 140000, wallClockMs: 480000 },
    ];
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel', scenario: 'story-scope' }),
      lifecycle: [],
      envelope: {
        usage: {
          totalTokens: 180000,
          inputTokens: 150000,
          outputTokens: 30000,
        },
        cost: { totalUsd: 1.5 },
        durationMs: 600000,
      },
      quality: { frozenSuitePassed: 8, frozenSuiteTotal: 8 },
      phases,
    });
    assert.ok(Array.isArray(sc.phases));
    assert.deepEqual(
      sc.phases.map((p) => p.phase),
      ['plan', 'deliver'],
    );
    // The binding sum-invariant (Story #94 AC4).
    const sumCost = sc.phases.reduce((a, p) => a + p.costUsd, 0);
    const sumTokens = sc.phases.reduce((a, p) => a + p.tokens, 0);
    assert.equal(sumCost, sc.dimensions.efficiency.costUsd);
    assert.equal(sumTokens, sc.dimensions.efficiency.totalTokens);
  });

  it('omits phases[] entirely for the control arm (single session)', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'control', scenario: 'story-scope' }),
      lifecycle: [],
      envelope: {
        usage: { totalTokens: 100000, inputTokens: 80000, outputTokens: 20000 },
        cost: { totalUsd: 0.5 },
        durationMs: 300000,
      },
      quality: { frozenSuitePassed: 8, frozenSuiteTotal: 8 },
      // Even if phases are (wrongly) supplied, a control record must not carry them.
      phases: [{ phase: 'plan', costUsd: 0.5, tokens: 100000, wallClockMs: 1 }],
    });
    assert.equal('phases' in sc, false);
  });

  it('leaves phases[] off when none are supplied (a control record stays valid)', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
    });
    assert.equal('phases' in sc, false);
  });
});

describe('buildScorecard — standalone fallback (Story #48)', () => {
  it('measures planning + autonomy from standalone telemetry when no ledger exists', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel', scenario: 'story-scope' }),
      lifecycle: [], // standalone path → no Epic ledger
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 8, frozenSuiteTotal: 8 },
      standalone: {
        planning: {
          plannedStoryCount: 1,
          deliveredStoryCount: 1,
          rePlanCount: 0,
        },
        autonomy: { hitlStops: 0, blockedEvents: 0, manualRescues: 0 },
        routingVerdict: 'story',
      },
    });
    // Measured, NOT null — the whole point of #48.
    assert.equal(sc.dimensions.planningFidelity.score, 1);
    assert.equal(sc.dimensions.planningFidelity.deliveredStoryCount, 1);
    assert.equal(sc.dimensions.autonomy.score, 1);
    assert.equal(sc.routingVerdict, 'story');
    // Overhead stays null — unmeasurable on the standalone path (decided scope).
    assert.equal(sc.dimensions.overheadRatio.tokenRatio, null);
  });

  it('an autonomy intervention from standalone telemetry lowers the score below 1', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
      standalone: {
        planning: {
          plannedStoryCount: 1,
          deliveredStoryCount: 0,
          rePlanCount: 0,
        },
        autonomy: { hitlStops: 0, blockedEvents: 1, manualRescues: 0 },
        routingVerdict: 'story',
      },
    });
    // 1 intervention ⇒ 1/(1+1) = 0.5
    assert.ok(Math.abs(sc.dimensions.autonomy.score - 0.5) < 1e-9);
    // delivered 0 of 1 planned ⇒ storyAccuracy 0 ⇒ score < 1
    assert.ok(sc.dimensions.planningFidelity.score < 1);
  });

  it('without standalone telemetry, a no-ledger mandrel cell stays null with routingVerdict null', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
    });
    assert.equal(sc.dimensions.planningFidelity.score, null);
    assert.equal(sc.dimensions.autonomy.score, null);
    assert.equal(sc.routingVerdict, null);
  });

  it('an Epic ledger yields routingVerdict "epic"', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [
        {
          kind: 'emitted',
          ts: '2026-06-16T19:00:00.000Z',
          event: 'story.dispatch.start',
        },
        {
          kind: 'emitted',
          ts: '2026-06-16T19:30:00.000Z',
          event: 'story.dispatch.end',
        },
      ],
      planning: { plannedStoryCount: 1, deliveredStoryCount: 1 },
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
    });
    assert.equal(sc.routingVerdict, 'epic');
  });
});

describe('buildScorecard — standalone overhead phase-split (Epic #66, Story #77)', () => {
  it('yields a non-null ceremony/codegen split for a story-routed run with phase telemetry', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel', scenario: 'story-scope' }),
      lifecycle: [], // standalone path → no Epic ledger
      envelope: normalizedEnvelope({ durationMs: 40 * 60 * 1000 }), // 40min session
      quality: { frozenSuitePassed: 8, frozenSuiteTotal: 8 },
      standalone: {
        planning: {
          plannedStoryCount: 1,
          deliveredStoryCount: 1,
          rePlanCount: 0,
        },
        autonomy: { hitlStops: 0, blockedEvents: 0, manualRescues: 0 },
        routingVerdict: 'story',
        phases: {
          createdAt: '2026-06-16T19:00:00Z',
          closedAt: '2026-06-16T19:38:00Z', // 38min of the 40min session
          prMergedAt: '2026-06-16T19:38:33Z',
          codegenMs: 38 * 60 * 1000,
        },
      },
    });
    assert.notEqual(sc.dimensions.overheadRatio.tokenRatio, null);
    assert.equal(sc.dimensions.overheadRatio.codegenTokens > 0, true);
    // ceremony + codegen tokens sum to the session total.
    assert.equal(
      sc.dimensions.overheadRatio.ceremonyTokens +
        sc.dimensions.overheadRatio.codegenTokens,
      184320,
    );
    assert.ok(!sc.warnings.includes('standalone-telemetry-absent'));
  });

  it('falls back to a null tokenRatio when phases.codegenMs could not be derived', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel', scenario: 'story-scope' }),
      lifecycle: [],
      envelope: normalizedEnvelope({ durationMs: 40 * 60 * 1000 }),
      quality: { frozenSuitePassed: 8, frozenSuiteTotal: 8 },
      standalone: {
        planning: {
          plannedStoryCount: 1,
          deliveredStoryCount: 1,
          rePlanCount: 0,
        },
        autonomy: { hitlStops: 0, blockedEvents: 0, manualRescues: 0 },
        routingVerdict: 'story',
        phases: {
          createdAt: null,
          closedAt: null,
          prMergedAt: null,
          codegenMs: null,
        },
      },
    });
    assert.equal(sc.dimensions.overheadRatio.tokenRatio, null);
  });

  it('marks a loud warning when the mandrel arm has no ledger and no recovered standalone telemetry', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
    });
    assert.equal(sc.dimensions.overheadRatio.tokenRatio, null);
    assert.ok(sc.warnings.includes('standalone-telemetry-absent'));
  });

  it('never marks the telemetry-absent warning for the control arm', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'control' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
    });
    assert.ok(!sc.warnings.includes('standalone-telemetry-absent'));
  });

  it('never marks the telemetry-absent warning when an Epic ledger was found', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [
        {
          kind: 'emitted',
          ts: '2026-06-16T19:00:00.000Z',
          event: 'story.dispatch.start',
        },
        {
          kind: 'emitted',
          ts: '2026-06-16T19:30:00.000Z',
          event: 'story.dispatch.end',
        },
      ],
      planning: { plannedStoryCount: 1, deliveredStoryCount: 1 },
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
    });
    assert.ok(!sc.warnings.includes('standalone-telemetry-absent'));
  });

  it('validates a schema-valid record carrying a non-empty warnings array', () => {
    const validate = buildValidator();
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
    });
    assert.ok(sc.warnings.length > 0);
    const ok = validate(sc);
    assert.ok(
      ok,
      `record failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  });
});

describe('buildScorecard — planning-fidelity footprint DROPPED when unmeasurable (supersedes the M3 loud-null)', () => {
  it('drops the footprint term (and emits no warning) when the Epic-routed run carries no footprint signal', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [
        {
          kind: 'emitted',
          ts: '2026-06-16T19:00:00.000Z',
          event: 'story.dispatch.start',
        },
        {
          kind: 'emitted',
          ts: '2026-06-16T19:30:00.000Z',
          event: 'story.dispatch.end',
        },
      ],
      // No fileFootprintDrift / plannedPaths / actualPaths / plannedFileCount:
      // the Epic-ledger routing path in bench/run.js never threads a
      // plan-size signal, so footprint accuracy is genuinely unmeasured here.
      planning: { plannedStoryCount: 1, deliveredStoryCount: 1 },
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
    });
    // Unmeasurable footprint is DROPPED from the mean (not scored a fake 1.0),
    // and the obsolete loud-null is gone — footprintDropped is the honest marker.
    assert.equal(sc.dimensions.planningFidelity.footprintDropped, true);
    assert.ok(
      !sc.warnings.includes('planning-footprint-unmeasured-epic-routed'),
    );
  });

  it('measures (does not drop) the footprint when a real drift signal is threaded', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [
        {
          kind: 'emitted',
          ts: '2026-06-16T19:00:00.000Z',
          event: 'story.dispatch.start',
        },
        {
          kind: 'emitted',
          ts: '2026-06-16T19:30:00.000Z',
          event: 'story.dispatch.end',
        },
      ],
      planning: {
        plannedStoryCount: 1,
        deliveredStoryCount: 1,
        fileFootprintDrift: 0.2,
      },
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
    });
    assert.ok(
      !sc.warnings.includes('planning-footprint-unmeasured-epic-routed'),
    );
  });

  it('never fires for a non-Epic-routed (standalone story) run, even with no footprint signal', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel', scenario: 'story-scope' }),
      lifecycle: [], // no Epic ledger → standalone path
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
      standalone: {
        planning: {
          plannedStoryCount: 1,
          deliveredStoryCount: 1,
          // Deliberately no footprint signal either — the warning is scoped
          // to the Epic-ledger path, so it must stay absent here regardless.
        },
        autonomy: { hitlStops: 0, blockedEvents: 0, manualRescues: 0 },
        routingVerdict: 'story',
      },
    });
    assert.ok(
      !sc.warnings.includes('planning-footprint-unmeasured-epic-routed'),
    );
  });
});

describe('buildScorecard — autonomy guardrail surfaced on the record (Epic #66, Story #77)', () => {
  it('carries guardrail.met on dimensions.autonomy for a MEASURED (mandrel-ledger) run', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      // A clean Epic ledger → autonomy is observed and fully unattended.
      lifecycle: [
        {
          kind: 'emitted',
          ts: '2026-06-16T19:00:00.000Z',
          event: 'story.dispatch.start',
          payload: { storyId: 1 },
        },
        {
          kind: 'emitted',
          ts: '2026-06-16T19:05:00.000Z',
          event: 'story.dispatch.end',
          payload: { storyId: 1 },
        },
      ],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
      landed: true,
    });
    assert.equal(sc.dimensions.autonomy.score, 1);
    assert.equal(sc.dimensions.autonomy.guardrail.met, true);
    assert.equal(sc.dimensions.autonomy.guardrail.threshold, 0.99);
  });

  it('drops the control arm’s definitional 1.0 — autonomy is null/N-A, not an unearned baseline (Ticket #121, item 2)', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'control' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
    });
    assert.equal(sc.dimensions.autonomy.score, null);
    assert.equal(sc.dimensions.autonomy.guardrail.met, null);
  });

  it('an unlanded mandrel PR-head run scores autonomy below a landed one (unattended-landing, Ticket #121)', () => {
    const ledger = [
      {
        kind: 'emitted',
        ts: '2026-06-16T19:00:00.000Z',
        event: 'story.dispatch.start',
        payload: { storyId: 1 },
      },
      {
        kind: 'emitted',
        ts: '2026-06-16T19:05:00.000Z',
        event: 'story.dispatch.end',
        payload: { storyId: 1 },
      },
    ];
    const landedSc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: ledger,
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
      landed: true,
    });
    const unlandedSc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: ledger,
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
      landed: false,
    });
    assert.equal(landedSc.dimensions.autonomy.score, 1);
    // landed:false is one intervention → 1/(1+1) = 0.5.
    assert.equal(unlandedSc.dimensions.autonomy.score, 0.5);
    assert.equal(unlandedSc.dimensions.autonomy.landed, false);
    assert.equal(unlandedSc.landed, false);
  });
});

describe('buildScorecard — routing contract enforcement (Epic #66, Story #76)', () => {
  it('marks routingMismatch: true when the observed epic routing diverges from a declared story contract', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [
        {
          kind: 'emitted',
          ts: '2026-06-16T19:00:00.000Z',
          event: 'story.dispatch.start',
        },
        {
          kind: 'emitted',
          ts: '2026-06-16T19:30:00.000Z',
          event: 'story.dispatch.end',
        },
      ],
      planning: { plannedStoryCount: 1, deliveredStoryCount: 1 },
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
      scenarioRouting: 'story',
    });
    assert.equal(sc.routingVerdict, 'epic');
    assert.equal(sc.routingMismatch, true);
  });

  it('carries routingMismatch: false when the observed routing matches the declared contract', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel', scenario: 'story-scope' }),
      lifecycle: [], // standalone path → no Epic ledger
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 8, frozenSuiteTotal: 8 },
      standalone: {
        planning: {
          plannedStoryCount: 1,
          deliveredStoryCount: 1,
          rePlanCount: 0,
        },
        autonomy: { hitlStops: 0, blockedEvents: 0, manualRescues: 0 },
        routingVerdict: 'story',
      },
      scenarioRouting: 'story',
    });
    assert.equal(sc.routingVerdict, 'story');
    assert.equal(sc.routingMismatch, false);
  });

  it('defaults routingMismatch to false when no scenario contract is declared', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [
        {
          kind: 'emitted',
          ts: '2026-06-16T19:00:00.000Z',
          event: 'story.dispatch.start',
        },
      ],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
    });
    assert.equal(sc.routingMismatch, false);
  });

  it('defaults routingMismatch to false when the observed routing could not be determined', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [], // no ledger, no standalone recovery ⇒ routingVerdict null
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
      scenarioRouting: 'story',
    });
    assert.equal(sc.routingVerdict, null);
    assert.equal(sc.routingMismatch, false);
  });

  it('is always false for the control arm regardless of the declared contract', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'control' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
      scenarioRouting: 'story',
    });
    assert.equal(sc.routingMismatch, false);
  });

  it('validates against scorecard.schema.json with routingMismatch true and with it defaulted false', () => {
    const validate = buildValidator();
    const mismatched = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [
        {
          kind: 'emitted',
          ts: '2026-06-16T19:00:00.000Z',
          event: 'story.dispatch.start',
        },
      ],
      planning: { plannedStoryCount: 1, deliveredStoryCount: 1 },
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
      scenarioRouting: 'story',
    });
    assert.equal(mismatched.routingMismatch, true);
    assert.equal(validate(mismatched), true, JSON.stringify(validate.errors));

    const clean = buildScorecard({
      run: runStamp({ arm: 'control' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
    });
    assert.equal(clean.routingMismatch, false);
    assert.equal(validate(clean), true, JSON.stringify(validate.errors));
  });
});

describe('buildScorecard — second-touch continuity block (Epic #86, Story #96)', () => {
  it('attaches a schema-valid touch2 block reported separately from touch 1', () => {
    const validate = buildValidator();
    // Reuse a touch-1 scorecard's dimensions object as the touch-2 full
    // dimension set (the same seven-dimension shape).
    const base = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 2, frozenSuiteTotal: 2 },
    });
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 2, frozenSuiteTotal: 2 },
      touch2: {
        changeRequestId: 'password-change',
        inheritance: 'full-pipeline',
        outcome: 0.9,
        cost: 0.21,
        frozenSuitePassed: 4,
        frozenSuiteTotal: 4,
        totalTokens: 5000,
        wallClockMs: 12000,
        dimensions: base.dimensions,
        regression: {
          classes: [
            { class: 'regression-hashing', score: 1, defectPresent: false },
          ],
          cleanRate: 1,
        },
      },
    });
    assert.ok(sc.touch2, 'the scorecard carries a touch2 block');
    assert.equal(sc.touch2.outcome, 0.9);
    assert.equal(sc.touch2.cost, 0.21);
    assert.equal(sc.touch2.inheritance, 'full-pipeline');
    assert.equal(sc.touch2.regression.cleanRate, 1);
    // touch2 lives at the top level, a sibling of dimensions — never nested in it.
    assert.equal('touch2' in sc.dimensions, false);
    assert.equal(validate(sc), true, JSON.stringify(validate.errors));
  });

  it('preserves the touch2 materialized flag + null outcome (the #115 guard round-trips)', () => {
    const validate = buildValidator();
    const base = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: {},
    });
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 2, frozenSuiteTotal: 2 },
      // The shape runTouch2 returns when the change-request PR never landed.
      touch2: {
        changeRequestId: 'password-change',
        inheritance: 'full-pipeline',
        materialized: false,
        outcome: null,
        cost: 1.9,
        frozenSuitePassed: 0,
        frozenSuiteTotal: 0,
        totalTokens: 5000,
        wallClockMs: 12000,
        dimensions: base.dimensions,
      },
    });
    assert.equal(
      sc.touch2.materialized,
      false,
      'materialized must survive the buildScorecard reshape',
    );
    assert.equal(sc.touch2.outcome, null);
    assert.equal(validate(sc), true, JSON.stringify(validate.errors));
  });

  it('omits the touch2 block entirely for a touch-1-only record (e.g. hello-world)', () => {
    const validate = buildValidator();
    const sc = buildScorecard({
      run: runStamp({ arm: 'control' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
      touch2: null,
    });
    assert.equal('touch2' in sc, false);
    assert.equal(validate(sc), true, JSON.stringify(validate.errors));
  });
});

describe('buildScorecard — maintainability and security inputs', () => {
  it('threads maintainabilityInputs into dimensions.maintainability', () => {
    const sc = buildScorecard({
      run: runStamp(),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 2, frozenSuiteTotal: 2 },
      maintainabilityInputs: {
        objectiveMaintainabilityScore: 0.8,
        maintainabilityJudgeScore: 0.9,
        lintWarnings: 3,
        complexityScore: 0.75,
        maintainabilityIndex: null,
      },
    });
    // score = 0.7 * 0.8 + 0.3 * 0.9 = 0.56 + 0.27 = 0.83
    assert.ok(
      Math.abs(sc.dimensions.maintainability.score - 0.83) < 0.001,
      `maintainability.score should be ~0.83, got ${sc.dimensions.maintainability.score}`,
    );
    assert.equal(sc.dimensions.maintainability.lintWarnings, 3);
    assert.equal(sc.dimensions.maintainability.complexityScore, 0.75);
    assert.equal(sc.dimensions.maintainability.maintainabilityJudgeScore, 0.9);
  });

  it('threads securityInputs into dimensions.security', () => {
    const sc = buildScorecard({
      run: runStamp(),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 2, frozenSuiteTotal: 2 },
      securityInputs: {
        objectiveSecurityScore: 0.6,
        securityJudgeScore: 0.7,
        criticalFindings: 1,
        highFindings: 2,
        secretsDetected: false,
      },
    });
    // score = 0.7 * 0.6 + 0.3 * 0.7 = 0.42 + 0.21 = 0.63
    assert.ok(
      Math.abs(sc.dimensions.security.score - 0.63) < 0.001,
      `security.score should be ~0.63, got ${sc.dimensions.security.score}`,
    );
    assert.equal(sc.dimensions.security.criticalFindings, 1);
    assert.equal(sc.dimensions.security.highFindings, 2);
    assert.equal(sc.dimensions.security.secretsDetected, false);
    assert.equal(sc.dimensions.security.securityJudgeScore, 0.7);
  });

  it('defaults both dimensions to score 0 when inputs are omitted', () => {
    const sc = buildScorecard({
      run: runStamp(),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 2, frozenSuiteTotal: 2 },
      // maintainabilityInputs and securityInputs omitted
    });
    assert.equal(sc.dimensions.maintainability.score, 0);
    assert.equal(sc.dimensions.security.score, 0);
  });

  it('assembles a schema-valid scorecard with populated maintainability and security', () => {
    const sc = buildScorecard({
      run: runStamp(),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: {
        frozenSuitePassed: 3,
        frozenSuiteTotal: 3,
        acceptanceEvalScore: 1,
      },
      maintainabilityInputs: {
        objectiveMaintainabilityScore: 0.72,
        maintainabilityJudgeScore: 0.8,
        lintWarnings: 0,
        complexityScore: 0.85,
      },
      securityInputs: {
        objectiveSecurityScore: 0.9,
        securityJudgeScore: null,
        criticalFindings: 0,
        highFindings: 0,
        secretsDetected: false,
      },
    });
    const validate = buildValidator();
    assert.ok(
      validate(sc),
      `scorecard failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`,
    );
    assert.ok(sc.dimensions.maintainability.score > 0);
    assert.ok(sc.dimensions.security.score > 0);
  });
});

describe('buildScorecard — multi-class differential trap signal (Epic #66, Story #74)', () => {
  const trapVerdict = (overrides = {}) => ({
    classes: [
      { class: 'plaintext-password', score: 1, defectPresent: false },
      {
        class: 'idor',
        score: 1,
        defectPresent: false,
        evidence: ['no cross-user resource access detected'],
      },
    ],
    cleanRate: 1,
    ...overrides,
  });

  it('attaches a clean multi-class trap verdict under scorecard.trap (NOT folded into dimensions)', () => {
    const sc = buildScorecard({
      run: runStamp({ scenario: 'epic-scope' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 6, frozenSuiteTotal: 6 },
      trap: trapVerdict(),
    });
    assert.ok(sc.trap, 'expected a trap block on the scorecard');
    assert.equal(sc.trap.cleanRate, 1);
    assert.equal(sc.trap.classes.length, 2);
    assert.equal(sc.trap.classes[0].class, 'plaintext-password');
    assert.equal(sc.trap.classes[0].defectPresent, false);
    assert.deepEqual(sc.trap.classes[1].evidence, [
      'no cross-user resource access detected',
    ]);
    // The trap signal is SEPARATE — it must not appear inside dimensions.
    assert.equal(sc.dimensions.trap, undefined);
  });

  it('attaches a mixed clean/defect-present verdict with cleanRate as the mean of per-class scores', () => {
    const sc = buildScorecard({
      run: runStamp({ scenario: 'story-scope', arm: 'control' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 6, frozenSuiteTotal: 6 },
      trap: trapVerdict({
        classes: [
          { class: 'plaintext-password', score: 0, defectPresent: true },
          { class: 'token-generation', score: 1, defectPresent: false },
        ],
        cleanRate: 0.5,
      }),
    });
    assert.equal(sc.trap.classes[0].defectPresent, true);
    assert.equal(sc.trap.classes[0].score, 0);
    assert.equal(sc.trap.cleanRate, 0.5);
  });

  it('omits the trap block entirely for non-trap scenarios (trap null/absent)', () => {
    const sc = buildScorecard({
      run: runStamp({ scenario: 'hello-world' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 3, frozenSuiteTotal: 3 },
      // trap omitted
    });
    assert.equal('trap' in sc, false);
  });

  it('omits the trap block when the runner verdict has an empty classes[] (no trap classes declared)', () => {
    const sc = buildScorecard({
      run: runStamp({ scenario: 'hello-world' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 3, frozenSuiteTotal: 3 },
      trap: { classes: [], cleanRate: null },
    });
    assert.equal('trap' in sc, false);
  });

  it('a scorecard carrying a trap block validates against the schema', () => {
    const sc = buildScorecard({
      run: runStamp({ scenario: 'epic-scope' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: {
        frozenSuitePassed: 6,
        frozenSuiteTotal: 6,
        acceptanceEvalScore: 1,
      },
      trap: trapVerdict(),
    });
    const validate = buildValidator();
    assert.ok(
      validate(sc),
      `trap scorecard failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  });
});

describe('buildScorecard — schema conformance (binding acceptance)', () => {
  it('assembles a per-run record that validates against scorecard.schema.json', () => {
    const lifecycle = parseNdjson(readFileSync(LIFECYCLE_FIXTURE, 'utf8'));
    const scorecard = buildScorecard({
      run: runStamp(),
      lifecycle,
      signals: [],
      envelope: normalizedEnvelope(),
      quality: {
        frozenSuitePassed: 3,
        frozenSuiteTotal: 3,
        acceptanceEvalScore: 1,
      },
      planning: {
        rePlanCount: 0,
        plannedStoryCount: 2,
        deliveredStoryCount: 2,
        plannedPaths: ['server.js', 'package.json'],
        actualPaths: ['server.js', 'package.json'],
      },
    });

    const validate = buildValidator();
    const ok = validate(scorecard);
    assert.ok(
      ok,
      `scorecard failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`,
    );

    assert.equal(scorecard.schemaVersion, SCORECARD_SCHEMA_VERSION);
    assert.equal(scorecard.scenario, 'hello-world');
    assert.equal(scorecard.arm, 'mandrel');
    // Seven dimensions present.
    assert.deepEqual(Object.keys(scorecard.dimensions).sort(), [
      'autonomy',
      'efficiency',
      'maintainability',
      'overheadRatio',
      'planningFidelity',
      'quality',
      'security',
    ]);
    // Wall-clock derived from the fixture span (19:32:00 → 19:42:11 = 611000ms).
    assert.equal(scorecard.dimensions.efficiency.wallClockMs, 611000);
    // Two dispatch.start records in the fixture.
    assert.equal(scorecard.dimensions.efficiency.dispatches, 2);
    // Clean autonomy.
    assert.equal(scorecard.dimensions.autonomy.score, 1);
    // Token split sums to the envelope total.
    assert.equal(
      scorecard.dimensions.overheadRatio.ceremonyTokens +
        scorecard.dimensions.overheadRatio.codegenTokens,
      scorecard.dimensions.efficiency.totalTokens,
    );
  });

  it('produces a schema-valid control-arm record (planningFidelity null)', () => {
    const scorecard = buildScorecard({
      run: runStamp({ runId: 'hw-control-r01', arm: 'control' }),
      lifecycle: [
        {
          kind: 'emitted',
          event: 'epic.plan.start',
          ts: '2026-06-16T19:00:00.000Z',
          payload: { epicId: 1 },
        },
        {
          kind: 'emitted',
          event: 'epic.complete',
          ts: '2026-06-16T19:01:40.000Z',
          payload: { epicId: 1, prUrl: 'https://x/y' },
        },
      ],
      envelope: normalizedEnvelope({ cost: { totalUsd: 0.2 } }),
      quality: { frozenSuitePassed: 3, frozenSuiteTotal: 3 },
    });
    const validate = buildValidator();
    assert.ok(
      validate(scorecard),
      `control scorecard failed: ${JSON.stringify(validate.errors, null, 2)}`,
    );
    assert.equal(scorecard.dimensions.planningFidelity.score, null);
    // No judge ⇒ quality is the frozen pass rate.
    assert.equal(scorecard.dimensions.quality.score, 1);
  });

  it('rejects an unknown arm', () => {
    assert.throws(
      () =>
        buildScorecard({
          run: runStamp({ arm: 'bogus' }),
          lifecycle: [],
          envelope: normalizedEnvelope(),
          quality: { frozenSuitePassed: 0, frozenSuiteTotal: 0 },
        }),
      /arm must be/,
    );
  });

  it('requires the run identity fields', () => {
    assert.throws(
      () =>
        buildScorecard({
          run: { runId: 'x' },
          lifecycle: [],
          envelope: normalizedEnvelope(),
          quality: {},
        }),
      /required/,
    );
  });

  it('stamps benchmarkVersion onto the emitted record from the run identity (D-014)', () => {
    const sc = buildScorecard({
      run: runStamp({ frameworkVersion: '1.88.0', benchmarkVersion: '0.6.0' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 3, frozenSuiteTotal: 3 },
    });
    // benchmarkVersion is threaded through the collect pipeline distinct from
    // frameworkVersion — the pinned dependency version and the benchmark's own
    // version are separate stamp fields.
    assert.equal(sc.frameworkVersion, '1.88.0');
    assert.equal(sc.benchmarkVersion, '0.6.0');
    const validate = buildValidator();
    assert.ok(
      validate(sc),
      `scorecard failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  });

  it('rejects a run identity missing benchmarkVersion', () => {
    const run = runStamp();
    delete run.benchmarkVersion;
    assert.throws(
      () =>
        buildScorecard({
          run,
          lifecycle: [],
          envelope: normalizedEnvelope(),
          quality: { frozenSuitePassed: 0, frozenSuiteTotal: 0 },
        }),
      /benchmarkVersion is required/,
    );
  });
});

describe('normalizeRunFromPaths — file-reading shell', () => {
  it('reads lifecycle, signals, and envelope from disk via an injected reader', () => {
    const lifecycleText = readFileSync(LIFECYCLE_FIXTURE, 'utf8');
    const signalsText = '{"kind":"hitl-stop"}\n';
    const envelopeText = JSON.stringify(normalizedEnvelope());

    const files = {
      '/run/lifecycle.ndjson': lifecycleText,
      '/run/story-1/signals.ndjson': signalsText,
      '/run/cost-envelope.json': envelopeText,
    };
    const readFileImpl = (p) => {
      if (!(p in files)) throw new Error(`unexpected read: ${p}`);
      return files[p];
    };

    const scorecard = normalizeRunFromPaths(
      {
        run: runStamp(),
        lifecyclePath: '/run/lifecycle.ndjson',
        signalsPaths: ['/run/story-1/signals.ndjson'],
        costEnvelopePath: '/run/cost-envelope.json',
        quality: {
          frozenSuitePassed: 3,
          frozenSuiteTotal: 3,
          acceptanceEvalScore: 1,
        },
        planning: {
          rePlanCount: 0,
          plannedStoryCount: 2,
          deliveredStoryCount: 2,
        },
      },
      { readFileImpl },
    );

    const validate = buildValidator();
    assert.ok(
      validate(scorecard),
      `scorecard failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`,
    );
    // The injected signals file carried one hitl-stop ⇒ one intervention.
    assert.equal(scorecard.dimensions.autonomy.hitlStops, 1);
    // rawRefs default to the supplied paths.
    assert.equal(scorecard.rawRefs.lifecycleNdjson, '/run/lifecycle.ndjson');
    assert.deepEqual(scorecard.rawRefs.signalsNdjson, [
      '/run/story-1/signals.ndjson',
    ]);
    assert.equal(scorecard.rawRefs.costEnvelope, '/run/cost-envelope.json');
  });

  it('requires lifecyclePath and costEnvelopePath', () => {
    assert.throws(
      () =>
        normalizeRunFromPaths({
          run: runStamp(),
          costEnvelopePath: '/x.json',
          quality: {},
        }),
      /lifecyclePath is required/,
    );
  });
});

describe('buildScorecard — arm-aware routing-mismatch + variant arms (Ticket #123)', () => {
  const EPIC_LEDGER = [
    {
      kind: 'emitted',
      ts: '2026-06-16T19:00:00.000Z',
      event: 'story.dispatch.start',
    },
    {
      kind: 'emitted',
      ts: '2026-06-16T19:30:00.000Z',
      event: 'story.dispatch.end',
    },
  ];
  const STANDALONE = {
    planning: { plannedStoryCount: 1, deliveredStoryCount: 1, rePlanCount: 0 },
    autonomy: { hitlStops: 0, blockedEvents: 0, manualRescues: 0 },
    routingVerdict: 'story',
  };

  it('mandrel-story-routed: story routing on an epic-contract scenario is the TREATMENT, not a mismatch', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel-story-routed', scenario: 'epic-scope' }),
      lifecycle: [], // no Epic ledger — the standalone path
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 8, frozenSuiteTotal: 8 },
      standalone: STANDALONE,
      scenarioRouting: 'epic',
    });
    assert.equal(sc.arm, 'mandrel-story-routed');
    assert.equal(sc.routingVerdict, 'story');
    // The exclusion is ARM-AWARE, not globally weakened: this arm's expected
    // routing is its own 'story' override, so the divergence from the
    // scenario contract is exactly what the arm promises.
    assert.equal(sc.routingMismatch, false);
    // The standalone telemetry stands in for the ledger — value dims MEASURED.
    assert.equal(typeof sc.dimensions.planningFidelity.score, 'number');
  });

  it('mandrel-story-routed: an EPIC verdict is still a mismatch — the treatment failed to apply', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel-story-routed', scenario: 'epic-scope' }),
      lifecycle: EPIC_LEDGER, // the run disobeyed the override and epic-routed
      planning: { plannedStoryCount: 1, deliveredStoryCount: 1 },
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 8, frozenSuiteTotal: 8 },
      scenarioRouting: 'epic',
    });
    assert.equal(sc.routingVerdict, 'epic');
    assert.equal(sc.routingMismatch, true);
  });

  it('plain mandrel keeps the scenario-contract comparison unchanged (not weakened by the arm-4 exemption)', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel', scenario: 'epic-scope' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 8, frozenSuiteTotal: 8 },
      standalone: STANDALONE,
      scenarioRouting: 'epic',
    });
    assert.equal(sc.routingVerdict, 'story');
    assert.equal(sc.routingMismatch, true);
  });

  it('mandrel-story-routed attaches the per-phase envelopes like the base mandrel arm', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'mandrel-story-routed' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
      phases: [
        { phase: 'plan', costUsd: 0.1, tokens: 100, wallClockMs: 1000 },
        { phase: 'deliver', costUsd: 0.3, tokens: 300, wallClockMs: 3000 },
      ],
    });
    assert.equal(sc.phases.length, 2);
  });

  it('control-claudemd scores under the control shape: all-codegen split, null planning fidelity, null default acceptanceEvalScore, no mismatch', () => {
    const sc = buildScorecard({
      run: runStamp({ arm: 'control-claudemd' }),
      lifecycle: [],
      envelope: normalizedEnvelope(),
      quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
      scenarioRouting: 'story',
    });
    assert.equal(sc.arm, 'control-claudemd');
    assert.equal(sc.dimensions.planningFidelity.score, null);
    assert.equal(sc.dimensions.quality.acceptanceEvalScore, null);
    assert.equal(sc.dimensions.overheadRatio.ceremonyTokens, 0);
    assert.equal(sc.routingMismatch, false);
    // No standalone-telemetry-absent loud null — that marker is mandrel-base only.
    assert.ok(!sc.warnings.includes('standalone-telemetry-absent'));
  });

  it('variant-arm scorecards validate against scorecard.schema.json; an unknown arm still throws', () => {
    const validate = buildValidator();
    for (const arm of ['control-claudemd', 'mandrel-story-routed']) {
      const sc = buildScorecard({
        run: runStamp({ arm }),
        lifecycle: [],
        envelope: normalizedEnvelope(),
        quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
      });
      assert.equal(validate(sc), true, JSON.stringify(validate.errors));
    }
    assert.throws(
      () =>
        buildScorecard({
          run: runStamp({ arm: 'contrl' }),
          lifecycle: [],
          envelope: normalizedEnvelope(),
          quality: { frozenSuitePassed: 1, frozenSuiteTotal: 1 },
        }),
      /run\.arm must be one of/,
    );
  });
});
