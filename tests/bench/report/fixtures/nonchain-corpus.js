// tests/bench/report/fixtures/nonchain-corpus.js
//
// A deterministic NON-CHAIN scorecard corpus used by the byte-identity
// snapshot guards (issue #124, PR-D): the chain report/dashboard sections are
// strictly additive, so rendering this corpus must produce byte-for-byte the
// same Markdown report and HTML dashboard as it did before the chain sections
// existed. The frozen expected bytes live beside this module
// (`nonchain-report.md`, `nonchain-dashboard.html`) and were generated from
// the pre-chain renderer; regenerate them ONLY when a deliberate report
// change lands (never as part of a chain-scoring change).
//
// Determinism: fixed timestamps, fixed run ids, no clock, no randomness.

const MODEL = { id: 'claude-opus-4-8[1m]' };
const ENV = { node: 'v24.16.0', os: 'darwin' };
const FW = '1.89.0';
const BV = '0.11.0';

function card({
  scenario,
  arm,
  runId,
  timestamp,
  quality,
  planningFidelity,
  maintainability,
  security,
  tokenRatio,
  wallClockMs,
  totalTokens,
  dispatches,
  costUsd,
  routingVerdict = null,
  trap = null,
  touch2 = null,
  phases = null,
}) {
  const sc = {
    schemaVersion: 1,
    runId,
    timestamp,
    model: MODEL,
    frameworkVersion: FW,
    benchmarkVersion: BV,
    env: ENV,
    scenario,
    arm,
    routingVerdict,
    routingMismatch: false,
    dimensions: {
      quality: { score: quality, frozenSuitePassRate: quality },
      planningFidelity: {
        score: arm === 'control' ? null : planningFidelity,
      },
      autonomy: {
        score: 1,
        hitlStops: 0,
        blockedEvents: 0,
        manualRescues: 0,
        guardrail: { threshold: 0.99, met: true },
      },
      maintainability: { score: maintainability },
      security: { score: security },
      overheadRatio: { tokenRatio },
      efficiency: { wallClockMs, totalTokens, dispatches, costUsd },
    },
  };
  if (trap) sc.trap = trap;
  if (touch2) sc.touch2 = touch2;
  if (phases) sc.phases = phases;
  return sc;
}

/**
 * Two scenarios × two arms × two runs, exercising the trap, continuity,
 * per-phase-cost and guardrail sections — every pre-chain section renders, so
 * the snapshot guard covers the whole report surface.
 *
 * @returns {Array<object>}
 */
export function nonChainCorpus() {
  const cards = [];
  // hello-world — floor/calibration rung, no trap, no touch2.
  for (let i = 0; i < 2; i += 1) {
    cards.push(
      card({
        scenario: 'hello-world',
        arm: 'mandrel',
        runId: `hello-world-mandrel-r${i + 1}`,
        timestamp: `2026-07-0${i + 1}T10:00:00.000Z`,
        routingVerdict: 'epic',
        quality: 1,
        planningFidelity: 0.9 + i * 0.02,
        maintainability: 0.9,
        security: 1,
        tokenRatio: 6 + i,
        wallClockMs: 400000 + i * 10000,
        totalTokens: 90000 + i * 2000,
        dispatches: 2,
        costUsd: 0.8 + i * 0.05,
        phases: [
          {
            phase: 'plan',
            costUsd: 0.3 + i * 0.02,
            totalTokens: 30000,
            wallClockMs: 120000,
          },
          {
            phase: 'deliver',
            costUsd: 0.5 + i * 0.03,
            totalTokens: 60000,
            wallClockMs: 280000,
          },
        ],
      }),
      card({
        scenario: 'hello-world',
        arm: 'control',
        runId: `hello-world-control-r${i + 1}`,
        timestamp: `2026-07-0${i + 1}T11:00:00.000Z`,
        quality: 1,
        maintainability: 0.85,
        security: 1,
        tokenRatio: 0.2,
        wallClockMs: 120000 + i * 5000,
        totalTokens: 20000 + i * 1000,
        dispatches: 1,
        costUsd: 0.2 + i * 0.01,
      }),
    );
  }
  // story-scope — value rung with trap + touch2.
  for (let i = 0; i < 2; i += 1) {
    cards.push(
      card({
        scenario: 'story-scope',
        arm: 'mandrel',
        runId: `story-scope-mandrel-r${i + 1}`,
        timestamp: `2026-07-0${i + 3}T10:00:00.000Z`,
        routingVerdict: 'story',
        quality: 0.95 + i * 0.02,
        planningFidelity: 0.85,
        maintainability: 0.9,
        security: 1,
        tokenRatio: 3 - i * 0.2,
        wallClockMs: 900000 + i * 20000,
        totalTokens: 250000 + i * 5000,
        dispatches: 3,
        costUsd: 4 + i * 0.2,
        trap: {
          classes: [
            { class: 'plaintext-password', score: 1 },
            { class: 'token-generation', score: 1 - i * 0.5 },
          ],
          cleanRate: 1 - i * 0.25,
        },
        touch2: { outcome: 0.9 - i * 0.1, cost: 1.2 + i * 0.1 },
        phases: [
          {
            phase: 'plan',
            costUsd: 1.5 + i * 0.1,
            totalTokens: 80000,
            wallClockMs: 300000,
          },
          {
            phase: 'deliver',
            costUsd: 2.5 + i * 0.1,
            totalTokens: 170000,
            wallClockMs: 600000,
          },
        ],
      }),
      card({
        scenario: 'story-scope',
        arm: 'control',
        runId: `story-scope-control-r${i + 1}`,
        timestamp: `2026-07-0${i + 3}T11:00:00.000Z`,
        quality: 0.85 - i * 0.05,
        maintainability: 0.8,
        security: 0.9,
        tokenRatio: 0.3,
        wallClockMs: 300000 + i * 10000,
        totalTokens: 60000 + i * 2000,
        dispatches: 1,
        costUsd: 0.6 + i * 0.05,
        trap: {
          classes: [
            { class: 'plaintext-password', score: 0 },
            { class: 'token-generation', score: 1 },
          ],
          cleanRate: 0.5,
        },
        touch2: { outcome: 0.7 - i * 0.1, cost: 1.5 + i * 0.2 },
      }),
    );
  }
  return cards;
}
