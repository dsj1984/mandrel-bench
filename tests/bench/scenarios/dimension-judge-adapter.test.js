/**
 * Unit tests for bench/scenarios/dimension-judge-adapter.js (Epic #32, Story #41).
 *
 * All tests run with a stubbed judge transport — no real model calls are made.
 * The batched call, prompt-building, response-parsing, and null-fallback
 * paths are all exercised at the unit tier.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildJudgePrompt,
  parseJudgeResponse,
  runDimensionJudge,
} from '../../../bench/scenarios/dimension-judge-adapter.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const STUB_MAINTAINABILITY = {
  objectiveMaintainabilityScore: 0.72,
  lintErrorDensity: 0.5,
  testPresence: 0.67,
  complexityScore: 0.8,
  deadCodeCount: 2,
  docsScore: 0.6,
};

const STUB_SECURITY = {
  secretScanCount: 0,
  depAuditVulnCount: 0,
  hasEdgeInputValidation: true,
  hasPasswordHashing: true,
  hasSafeTokenStorage: true,
  hasServerSideAuthz: true,
  hasAuthRateLimiting: false,
};

// ────────────────────────────────────────────────────────────────────────────
// buildJudgePrompt
// ────────────────────────────────────────────────────────────────────────────

describe('buildJudgePrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildJudgePrompt({
      maintainabilitySignals: STUB_MAINTAINABILITY,
      securitySignals: STUB_SECURITY,
    });
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.length > 0);
  });

  it('includes both "maintainability" and "security" section headers', () => {
    const prompt = buildJudgePrompt({
      maintainabilitySignals: STUB_MAINTAINABILITY,
      securitySignals: STUB_SECURITY,
    });
    assert.ok(
      prompt.includes('Maintainability'),
      'prompt must contain Maintainability section',
    );
    assert.ok(
      prompt.includes('Security'),
      'prompt must contain Security section',
    );
  });

  it('serialises the sub-signals into the prompt body', () => {
    const prompt = buildJudgePrompt({
      maintainabilitySignals: { lintErrorDensity: 1.23 },
      securitySignals: { secretScanCount: 5 },
    });
    assert.ok(prompt.includes('1.23'), 'maintainability signal value present');
    assert.ok(prompt.includes('5'), 'security signal value present');
  });

  it('accepts a rubric override', () => {
    const prompt = buildJudgePrompt({
      maintainabilitySignals: {},
      securitySignals: {},
      rubric: 'CUSTOM_RUBRIC',
    });
    assert.ok(prompt.startsWith('CUSTOM_RUBRIC'), 'custom rubric is used');
  });

  it('handles null or missing signals without throwing', () => {
    assert.doesNotThrow(() =>
      buildJudgePrompt({ maintainabilitySignals: null, securitySignals: null }),
    );
    assert.doesNotThrow(() =>
      buildJudgePrompt({
        maintainabilitySignals: undefined,
        securitySignals: undefined,
      }),
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseJudgeResponse
// ────────────────────────────────────────────────────────────────────────────

describe('parseJudgeResponse', () => {
  it('parses a clean JSON string', () => {
    const result = parseJudgeResponse(
      '{"maintainability": 0.85, "security": 0.72}',
    );
    assert.deepEqual(result, { maintainability: 0.85, security: 0.72 });
  });

  it('parses a JSON object returned directly by the transport', () => {
    const result = parseJudgeResponse({ maintainability: 0.9, security: 0.6 });
    assert.deepEqual(result, { maintainability: 0.9, security: 0.6 });
  });

  it('clamps values outside [0, 1] to [0, 1]', () => {
    const result = parseJudgeResponse(
      '{"maintainability": 1.5, "security": -0.1}',
    );
    assert.deepEqual(result, { maintainability: 1, security: 0 });
  });

  it('extracts JSON embedded in prose (trailing object)', () => {
    const raw =
      'Here is my analysis:\nSome prose.\n{"maintainability": 0.7, "security": 0.8}';
    const result = parseJudgeResponse(raw);
    assert.deepEqual(result, { maintainability: 0.7, security: 0.8 });
  });

  it('returns null for null input', () => {
    assert.equal(parseJudgeResponse(null), null);
  });

  it('returns null for undefined input', () => {
    assert.equal(parseJudgeResponse(undefined), null);
  });

  it('returns null for an empty string', () => {
    assert.equal(parseJudgeResponse(''), null);
  });

  it('returns null for unparseable text', () => {
    assert.equal(parseJudgeResponse('not json'), null);
  });

  it('returns null when the object lacks the required keys', () => {
    assert.equal(parseJudgeResponse('{"foo": 1}'), null);
    assert.equal(
      parseJudgeResponse({ maintainability: 0.5 /* no security */ }),
      null,
    );
  });

  it('returns null when values are non-finite', () => {
    assert.equal(
      parseJudgeResponse({ maintainability: NaN, security: 0.5 }),
      null,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// runDimensionJudge — the main exported function
// ────────────────────────────────────────────────────────────────────────────

describe('runDimensionJudge', () => {
  it('issues ONE judge call (not one per dimension) and returns { maintainability, security }', async () => {
    let callCount = 0;
    const judgeTransport = async () => {
      callCount += 1;
      return { maintainability: 0.8, security: 0.75 };
    };

    const result = await runDimensionJudge(
      {
        maintainabilitySignals: STUB_MAINTAINABILITY,
        securitySignals: STUB_SECURITY,
      },
      { judgeTransport },
    );

    assert.equal(callCount, 1, 'exactly one judge call must be issued');
    assert.deepEqual(result, { maintainability: 0.8, security: 0.75 });
  });

  it('returns scores in [0, 1]', async () => {
    const judgeTransport = async () => ({
      maintainability: 0.55,
      security: 0.91,
    });
    const result = await runDimensionJudge(
      { maintainabilitySignals: {}, securitySignals: {} },
      { judgeTransport },
    );
    assert.ok(result !== null);
    assert.ok(result.maintainability >= 0 && result.maintainability <= 1);
    assert.ok(result.security >= 0 && result.security <= 1);
  });

  it('returns null when the transport returns null (judge did not run — control arm)', async () => {
    const judgeTransport = async () => null;
    const result = await runDimensionJudge(
      { maintainabilitySignals: {}, securitySignals: {} },
      { judgeTransport },
    );
    assert.equal(
      result,
      null,
      'null transport response must propagate as null',
    );
  });

  it('returns null when the transport returns undefined', async () => {
    const judgeTransport = async () => undefined;
    const result = await runDimensionJudge(
      { maintainabilitySignals: {}, securitySignals: {} },
      { judgeTransport },
    );
    assert.equal(result, null);
  });

  it('returns null (does not throw) when the transport throws', async () => {
    const judgeTransport = async () => {
      throw new Error('network error');
    };
    const result = await runDimensionJudge(
      { maintainabilitySignals: {}, securitySignals: {} },
      { judgeTransport },
    );
    assert.equal(
      result,
      null,
      'transport errors must be caught and returned as null',
    );
  });

  it('returns null when the default transport is used (no-op fallback)', async () => {
    // When no judgeTransport is injected, the default no-op returns null
    // (judge-disabled path — weight folds into the spine).
    const result = await runDimensionJudge({
      maintainabilitySignals: STUB_MAINTAINABILITY,
      securitySignals: STUB_SECURITY,
    });
    assert.equal(result, null, 'default transport must return null');
  });

  it('passes the prompt to the transport (prompt contains both signal sets)', async () => {
    let receivedPrompt = null;
    const judgeTransport = async (prompt) => {
      receivedPrompt = prompt;
      return { maintainability: 0.6, security: 0.7 };
    };

    await runDimensionJudge(
      {
        maintainabilitySignals: { lintErrorDensity: 2.5 },
        securitySignals: { secretScanCount: 3 },
      },
      { judgeTransport },
    );

    assert.ok(
      typeof receivedPrompt === 'string' && receivedPrompt.length > 0,
      'transport must receive a non-empty prompt string',
    );
    assert.ok(
      receivedPrompt.includes('2.5'),
      'prompt must embed the maintainability signal value',
    );
    assert.ok(
      receivedPrompt.includes('3'),
      'prompt must embed the security signal value',
    );
  });

  it('accepts an injectable parseResponseFn', async () => {
    const judgeTransport = async () => 'RAW_RESPONSE';
    let parsedWith = null;
    const parseResponseFn = (raw) => {
      parsedWith = raw;
      return { maintainability: 0.5, security: 0.5 };
    };

    const result = await runDimensionJudge(
      { maintainabilitySignals: {}, securitySignals: {} },
      { judgeTransport, parseResponseFn },
    );

    assert.equal(
      parsedWith,
      'RAW_RESPONSE',
      'custom parser must receive raw response',
    );
    assert.deepEqual(result, { maintainability: 0.5, security: 0.5 });
  });

  it('returns null when the parseResponseFn returns null (unparseable judge output)', async () => {
    const judgeTransport = async () => 'garbage';
    const parseResponseFn = () => null;

    const result = await runDimensionJudge(
      { maintainabilitySignals: {}, securitySignals: {} },
      { judgeTransport, parseResponseFn },
    );

    assert.equal(
      result,
      null,
      'null from parseResponseFn must propagate as null',
    );
  });

  it('accepts an injectable buildPromptFn', async () => {
    let builtPrompt = null;
    const buildPromptFn = (args) => {
      builtPrompt = args;
      return 'STUB_PROMPT';
    };
    const judgeTransport = async (prompt) => {
      assert.equal(prompt, 'STUB_PROMPT');
      return { maintainability: 0.4, security: 0.6 };
    };

    await runDimensionJudge(
      { maintainabilitySignals: { x: 1 }, securitySignals: { y: 2 } },
      { judgeTransport, buildPromptFn },
    );

    assert.ok(builtPrompt !== null, 'custom prompt builder must be called');
    assert.deepEqual(builtPrompt.maintainabilitySignals, { x: 1 });
    assert.deepEqual(builtPrompt.securitySignals, { y: 2 });
  });
});
