// tests/bench/driver/run-session.test.js
/**
 * Unit tests for bench/driver/run-session.js — Story #4216.
 *
 * Verifies the headless `claude -p --output-format json` launcher:
 *   - builds the correct argv (including `--output-format json`),
 *   - composes distinct Mandrel-arm vs control-arm prompts,
 *   - parses the real session envelope into usage/cost,
 *   - drives entirely through an INJECTED invoke function (no real process),
 *   - surfaces a non-zero exit and unparseable stdout as errors.
 *
 * The envelope fixture below is a verbatim shape captured from a live
 * `claude 2.1.178 -p --output-format json` run.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateEnvelopes,
  buildArmPrompt,
  buildClaudeArgs,
  buildControlPrompt,
  buildMandrelDeliverPrompt,
  buildMandrelPlanPrompt,
  DEFAULT_BENCH_MODEL,
  isTransientClaudeError,
  parseSessionEnvelope,
  rethrowIfTransientClaudeError,
  runSession,
  trustWorkspaceForClaude,
} from '../../../bench/driver/run-session.js';

const SCENARIO = {
  id: 'hello-world',
  taskPrompt: 'Create a hello-world HTTP server with a GET / route.',
};

/** A real-shape `claude -p --output-format json` envelope (trimmed). */
function realEnvelope(overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 4952,
    num_turns: 1,
    result: 'ok',
    session_id: '56d0b069-56c7-4d2b-bf76-b0cc4c5b388a',
    total_cost_usd: 0.346588,
    usage: {
      input_tokens: 4942,
      cache_creation_input_tokens: 31340,
      cache_read_input_tokens: 15626,
      output_tokens: 4,
      service_tier: 'standard',
    },
    modelUsage: {
      'claude-opus-4-8[1m]': { inputTokens: 4942, costUSD: 0.346023 },
    },
    permission_denials: [],
    terminal_reason: 'completed',
    uuid: '9d7dd296-f5c4-4156-9b50-f0cb4c0d053a',
    ...overrides,
  };
}

/**
 * Build an injected invoke that records its input and returns a fixed result.
 * @param {{ status?: number, stdout?: string, stderr?: string }} result
 */
function fakeInvoke(result = {}) {
  const calls = [];
  const fn = (input) => {
    calls.push(input);
    return {
      status: result.status ?? 0,
      stdout: result.stdout ?? JSON.stringify(realEnvelope()),
      stderr: result.stderr ?? '',
    };
  };
  fn.calls = calls;
  return fn;
}

/**
 * Build an injected invoke that returns a QUEUED result per call (falling back
 * to the last one), so a two-session mandrel run can hand the plan session and
 * the deliver session distinct envelopes.
 * @param {Array<{ status?: number, stdout?: string, stderr?: string }>} results
 */
function queuedInvoke(results) {
  const calls = [];
  const fn = (input) => {
    calls.push(input);
    const r = results[Math.min(calls.length - 1, results.length - 1)] ?? {};
    return {
      status: r.status ?? 0,
      stdout: r.stdout ?? JSON.stringify(realEnvelope()),
      stderr: r.stderr ?? '',
    };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// buildClaudeArgs
// ---------------------------------------------------------------------------

test('buildClaudeArgs: emits -p and --output-format json with the model', () => {
  const args = buildClaudeArgs({
    prompt: 'do the thing',
    model: 'claude-opus-4-8',
  });
  assert.deepEqual(args, [
    '-p',
    '--output-format',
    'json',
    '--model',
    'claude-opus-4-8',
    'do the thing',
  ]);
});

test('buildClaudeArgs: places the prompt last, after extraArgs', () => {
  const args = buildClaudeArgs({
    prompt: 'PROMPT',
    model: 'm',
    extraArgs: ['--yes', '--permission-mode', 'bypassPermissions'],
  });
  assert.equal(args[args.length - 1], 'PROMPT');
  assert.ok(args.includes('--yes'));
  // --output-format json is non-negotiable: it is what surfaces the envelope.
  assert.equal(args[1], '--output-format');
  assert.equal(args[2], 'json');
});

test('buildClaudeArgs: rejects empty prompt / model / non-array extraArgs', () => {
  assert.throws(
    () => buildClaudeArgs({ prompt: '', model: 'm' }),
    /non-empty prompt/,
  );
  assert.throws(
    () => buildClaudeArgs({ prompt: 'p', model: '' }),
    /non-empty model/,
  );
  assert.throws(
    () => buildClaudeArgs({ prompt: 'p', model: 'm', extraArgs: 'nope' }),
    /extraArgs must be an array/,
  );
});

// ---------------------------------------------------------------------------
// buildArmPrompt
// ---------------------------------------------------------------------------

test('buildArmPrompt: mandrel arm drives /plan then /deliver with auto-proceed', () => {
  const prompt = buildArmPrompt({ arm: 'mandrel', scenario: SCENARIO });
  // No seed Epic → the --idea drive, with /plan's headless --yes flag.
  assert.match(prompt, /\/plan --idea[\s\S]*--yes/);
  assert.match(prompt, /\/deliver[\s\S]*--yes/);
  assert.match(prompt, /headless/i);
  assert.match(prompt, /implicit approval|never block/i);
  assert.match(prompt, /hello-world/);
});

test('buildArmPrompt: mandrel arm drives an existing Epic id when one is supplied', () => {
  const prompt = buildArmPrompt({
    arm: 'mandrel',
    scenario: { ...SCENARIO, epicId: 42 },
  });
  assert.match(prompt, /\/plan 42 --yes/);
  assert.match(prompt, /\/deliver 42 --yes/);
  // Still carries the auto-proceed directive.
  assert.match(prompt, /implicit approval|never block/i);
});

test('buildArmPrompt: control arm is bare — no Mandrel pipeline', () => {
  const prompt = buildArmPrompt({ arm: 'control', scenario: SCENARIO });
  assert.doesNotMatch(prompt, /\/plan|\/deliver/);
  assert.match(prompt, /autonomously/i);
  assert.match(prompt, /hello-world/);
});

test('buildArmPrompt: rejects bad arm and missing scenario fields', () => {
  assert.throws(
    () => buildArmPrompt({ arm: 'nope', scenario: SCENARIO }),
    /must be one of mandrel, control/,
  );
  assert.throws(
    () => buildArmPrompt({ arm: 'mandrel', scenario: {} }),
    /string id/,
  );
  assert.throws(
    () => buildArmPrompt({ arm: 'mandrel', scenario: { id: 'x' } }),
    /taskPrompt/,
  );
});

// ---------------------------------------------------------------------------
// parseSessionEnvelope
// ---------------------------------------------------------------------------

test('parseSessionEnvelope: extracts usage + cost from the real envelope', () => {
  const parsed = parseSessionEnvelope(JSON.stringify(realEnvelope()));
  assert.equal(parsed.type, 'result');
  assert.equal(parsed.subtype, 'success');
  assert.equal(parsed.isError, false);
  assert.equal(parsed.result, 'ok');
  assert.equal(parsed.sessionId, '56d0b069-56c7-4d2b-bf76-b0cc4c5b388a');
  assert.equal(parsed.numTurns, 1);
  assert.equal(parsed.durationMs, 4952);
  assert.equal(parsed.cost.totalUsd, 0.346588);
  assert.equal(parsed.usage.inputTokens, 4942);
  assert.equal(parsed.usage.outputTokens, 4);
  assert.equal(parsed.usage.cacheCreationInputTokens, 31340);
  assert.equal(parsed.usage.cacheReadInputTokens, 15626);
  assert.equal(parsed.usage.totalTokens, 4942 + 4 + 31340 + 15626);
  assert.equal(parsed.terminalReason, 'completed');
  assert.deepEqual(parsed.permissionDenials, []);
  assert.equal(parsed.raw.uuid, '9d7dd296-f5c4-4156-9b50-f0cb4c0d053a');
});

test('parseSessionEnvelope: missing/malformed usage fields collapse to 0', () => {
  const parsed = parseSessionEnvelope(
    JSON.stringify({
      type: 'result',
      is_error: false,
      usage: { input_tokens: 'x' },
    }),
  );
  assert.equal(parsed.usage.inputTokens, 0);
  assert.equal(parsed.usage.outputTokens, 0);
  assert.equal(parsed.usage.totalTokens, 0);
  assert.equal(parsed.cost.totalUsd, null);
});

test('parseSessionEnvelope: tolerates a prose preface around the JSON', () => {
  const noisy = `Some banner line\n${JSON.stringify(realEnvelope())}\ntrailing note`;
  const parsed = parseSessionEnvelope(noisy);
  assert.equal(parsed.cost.totalUsd, 0.346588);
  assert.equal(parsed.usage.inputTokens, 4942);
});

test('parseSessionEnvelope: a brace inside a string value does not close the scan', () => {
  const env = realEnvelope({ result: 'done }{ ok' });
  const parsed = parseSessionEnvelope(`prefix ${JSON.stringify(env)}`);
  assert.equal(parsed.result, 'done }{ ok');
  assert.equal(parsed.cost.totalUsd, 0.346588);
});

test('parseSessionEnvelope: throws on non-JSON stdout', () => {
  assert.throws(
    () => parseSessionEnvelope('not json at all'),
    /Failed to parse/,
  );
  assert.throws(() => parseSessionEnvelope(''), /Failed to parse/);
});

// ---------------------------------------------------------------------------
// runSession (injected invoke — NEVER spawns a real process)
// ---------------------------------------------------------------------------

test('runSession (mandrel): drives TWO ordered sessions (plan → deliver) and SUMS the envelopes', () => {
  const invoke = fakeInvoke();
  const out = runSession(
    { arm: 'mandrel', scenario: SCENARIO, cwd: '/tmp/sandbox-xyz' },
    { invokeFn: invoke },
  );

  // Two ordered sessions: the plan prompt first, then the deliver prompt.
  assert.equal(invoke.calls.length, 2);
  assert.equal(invoke.calls[0].cwd, '/tmp/sandbox-xyz');
  assert.equal(invoke.calls[0].model, DEFAULT_BENCH_MODEL);
  assert.match(invoke.calls[0].prompt, /\/plan/);
  assert.doesNotMatch(invoke.calls[0].prompt, /\/deliver/);
  assert.match(invoke.calls[1].prompt, /\/deliver/);

  assert.equal(out.arm, 'mandrel');
  assert.equal(out.scenarioId, 'hello-world');
  assert.equal(out.model, DEFAULT_BENCH_MODEL);
  assert.equal(out.status, 0);

  // Both phases return the same fixture envelope, so the run total is 2×.
  const oneTokens = 4942 + 4 + 31340 + 15626;
  assert.equal(out.envelope.cost.totalUsd, 0.346588 * 2);
  assert.equal(out.envelope.usage.totalTokens, oneTokens * 2);

  // phases[] carries the per-phase split; costUsd/tokens SUM to the run totals.
  assert.equal(out.phases.length, 2);
  assert.deepEqual(
    out.phases.map((p) => p.phase),
    ['plan', 'deliver'],
  );
  const sumCost = out.phases.reduce((a, p) => a + p.costUsd, 0);
  const sumTokens = out.phases.reduce((a, p) => a + p.tokens, 0);
  assert.equal(sumCost, out.envelope.cost.totalUsd);
  assert.equal(sumTokens, out.envelope.usage.totalTokens);
  for (const p of out.phases) {
    assert.equal(p.tokens, oneTokens);
    assert.equal(p.wallClockMs, 4952);
  }
});

test('runSession (mandrel): SUMS distinct per-phase envelopes into the run total', () => {
  const invoke = queuedInvoke([
    {
      stdout: JSON.stringify(
        realEnvelope({
          total_cost_usd: 0.1,
          duration_ms: 1000,
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }),
      ),
    },
    {
      stdout: JSON.stringify(
        realEnvelope({
          total_cost_usd: 0.9,
          duration_ms: 5000,
          usage: {
            input_tokens: 900,
            output_tokens: 90,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }),
      ),
    },
  ]);
  const out = runSession(
    { arm: 'mandrel', scenario: SCENARIO, cwd: '/tmp/s' },
    { invokeFn: invoke },
  );
  assert.equal(out.envelope.cost.totalUsd, 1.0);
  assert.equal(out.envelope.usage.totalTokens, 110 + 990);
  assert.equal(out.envelope.durationMs, 6000);
  assert.deepEqual(
    out.phases.map((p) => ({ phase: p.phase, costUsd: p.costUsd })),
    [
      { phase: 'plan', costUsd: 0.1 },
      { phase: 'deliver', costUsd: 0.9 },
    ],
  );
});

test('runSession (control): drives a SINGLE session with no phases block', () => {
  const invoke = fakeInvoke();
  const out = runSession(
    { arm: 'control', scenario: SCENARIO, cwd: '/tmp/s' },
    { invokeFn: invoke },
  );
  assert.equal(invoke.calls.length, 1);
  assert.doesNotMatch(invoke.calls[0].prompt, /\/plan|\/deliver/);
  assert.equal(out.phases, null);
  assert.equal(out.envelope.cost.totalUsd, 0.346588);
});

test('runSession (mandrel): the betweenPhases hook threads deliverTarget into the deliver prompt', () => {
  const invoke = fakeInvoke();
  const hookCalls = [];
  const out = runSession(
    { arm: 'mandrel', scenario: SCENARIO, cwd: '/tmp/s' },
    {
      invokeFn: invoke,
      betweenPhases: (ctx) => {
        hookCalls.push(ctx);
        return { deliverTarget: 777 };
      },
    },
  );
  // Hook runs exactly once, AFTER the plan session, BEFORE the deliver session.
  assert.equal(hookCalls.length, 1);
  assert.equal(hookCalls[0].scenario.id, 'hello-world');
  assert.ok(hookCalls[0].planEnvelope);
  // The discovered id lands in the deliver prompt.
  assert.match(invoke.calls[1].prompt, /\/deliver 777 --yes/);
  assert.equal(out.phases.length, 2);
});

test('runSession: forwards model, extraArgs, and timeoutMs to the invoker', () => {
  const invoke = fakeInvoke();
  runSession(
    {
      arm: 'control',
      scenario: SCENARIO,
      cwd: '/tmp/s',
      model: 'claude-sonnet-4-6',
      extraArgs: ['--yes'],
      timeoutMs: 123,
    },
    { invokeFn: invoke },
  );
  const call = invoke.calls[0];
  assert.equal(call.model, 'claude-sonnet-4-6');
  assert.deepEqual(call.extraArgs, ['--yes']);
  assert.equal(call.timeoutMs, 123);
  // control arm prompt must not carry pipeline commands
  assert.doesNotMatch(call.prompt, /\/plan|\/deliver/);
});

test('runSession: non-zero exit throws with stderr context', () => {
  const invoke = fakeInvoke({ status: 137, stderr: 'killed: timeout' });
  assert.throws(
    () =>
      runSession(
        { arm: 'mandrel', scenario: SCENARIO, cwd: '/tmp/s' },
        { invokeFn: invoke },
      ),
    /exited with status 137.*killed: timeout/s,
  );
});

/**
 * A `claude -p` result that carries an Anthropic 529 Overload: a non-zero exit
 * whose stdout is the real error-envelope shape the CLI emits (verbatim from the
 * live batch failures — is_error + api_error_status 529 + an "Overloaded"
 * result string).
 */
function overloadedResult() {
  return {
    status: 1,
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 529,
      result:
        'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
      session_id: 'x',
      total_cost_usd: 0.0008,
      usage: {},
      modelUsage: {},
      terminal_reason: 'api_error',
    }),
    stderr: '',
  };
}

/** A queued invoke that also records how many times it was called. */
function scriptedInvoke(results) {
  const calls = [];
  const fn = (input) => {
    const r = results[Math.min(calls.length, results.length - 1)] ?? {};
    calls.push(input);
    return {
      status: r.status ?? 0,
      stdout: r.stdout ?? JSON.stringify(realEnvelope()),
      stderr: r.stderr ?? '',
    };
  };
  fn.calls = calls;
  return fn;
}

test('runSession: retries a transient 529 with backoff, then succeeds', () => {
  // Two overloads, then a clean session. The control arm is one session, so
  // this isolates the retry of a single invoke.
  const invoke = scriptedInvoke([
    overloadedResult(),
    overloadedResult(),
    {}, // clean
  ]);
  const sleeps = [];
  const out = runSession(
    { arm: 'control', scenario: SCENARIO, cwd: '/tmp/s' },
    { invokeFn: invoke, sleepFn: (ms) => sleeps.push(ms) },
  );
  // 1 initial + 2 retries = 3 invokes; 2 backoff sleeps between them.
  assert.equal(invoke.calls.length, 3);
  assert.equal(sleeps.length, 2);
  // Exponential: the second wait is strictly larger than the first.
  assert.ok(sleeps[1] > sleeps[0], `backoff not increasing: ${sleeps}`);
  assert.equal(out.status, 0);
  assert.equal(out.envelope.cost.totalUsd, 0.346588);
});

test('runSession: gives up after the retry budget and throws the transient error', () => {
  const invoke = scriptedInvoke([overloadedResult()]); // always overloaded
  const sleeps = [];
  assert.throws(
    () =>
      runSession(
        {
          arm: 'control',
          scenario: SCENARIO,
          cwd: '/tmp/s',
          sessionMaxRetries: 2,
        },
        { invokeFn: invoke, sleepFn: (ms) => sleeps.push(ms) },
      ),
    /529|Overloaded/,
  );
  // 1 initial + 2 retries = 3 attempts, then it re-throws so the batch's
  // existing abort-and-resume path still catches a PERSISTENT overload.
  assert.equal(invoke.calls.length, 3);
  assert.equal(sleeps.length, 2);
});

test('runSession: a NON-transient error is not retried', () => {
  // status 137 (killed) with no transient marker → fail fast, no retries.
  const invoke = scriptedInvoke([{ status: 137, stderr: 'killed: oom' }]);
  const sleeps = [];
  assert.throws(
    () =>
      runSession(
        { arm: 'control', scenario: SCENARIO, cwd: '/tmp/s' },
        { invokeFn: invoke, sleepFn: (ms) => sleeps.push(ms) },
      ),
    /exited with status 137/,
  );
  assert.equal(invoke.calls.length, 1);
  assert.equal(sleeps.length, 0);
});

test('runSession: sessionMaxRetries 0 disables retry (one attempt, then throw)', () => {
  const invoke = scriptedInvoke([overloadedResult()]);
  assert.throws(
    () =>
      runSession(
        {
          arm: 'control',
          scenario: SCENARIO,
          cwd: '/tmp/s',
          sessionMaxRetries: 0,
        },
        { invokeFn: invoke, sleepFn: () => {} },
      ),
    /529|Overloaded/,
  );
  assert.equal(invoke.calls.length, 1);
});

test('runSession: clean exit + is_error envelope warns but still returns the record', () => {
  const warnings = [];
  const invoke = fakeInvoke({
    status: 0,
    stdout: JSON.stringify(
      realEnvelope({
        is_error: true,
        subtype: 'error_during_execution',
        result: 'boom',
      }),
    ),
  });
  const out = runSession(
    { arm: 'mandrel', scenario: SCENARIO, cwd: '/tmp/s' },
    { invokeFn: invoke, logger: { warn: (m) => warnings.push(m), info() {} } },
  );
  assert.equal(out.envelope.isError, true);
  assert.equal(out.envelope.result, 'boom');
  // Both mandrel phases report is_error, so the warn fires once per phase.
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /is_error=true/);
});

// ---------------------------------------------------------------------------
// Per-phase prompt builders + aggregateEnvelopes (D-019, Epic #86 Story #94)
// ---------------------------------------------------------------------------

test('buildMandrelPlanPrompt: drives ONLY /plan (never /deliver)', () => {
  const idea = buildMandrelPlanPrompt({ scenario: SCENARIO });
  assert.match(idea, /\/plan --idea[\s\S]*--yes/);
  assert.doesNotMatch(idea, /\/deliver/);
  assert.match(idea, /never block|implicit approval/i);

  const seeded = buildMandrelPlanPrompt({
    scenario: { ...SCENARIO, epicId: 42 },
  });
  assert.match(seeded, /\/plan 42 --yes/);
  assert.doesNotMatch(seeded, /\/deliver/);
});

test('buildMandrelDeliverPrompt: drives /deliver at the discovered id, never /plan', () => {
  const withId = buildMandrelDeliverPrompt({
    scenario: SCENARIO,
    deliverTarget: 108,
  });
  assert.match(withId, /\/deliver 108 --yes/);
  assert.doesNotMatch(withId, /\/plan\b/);

  // Null target ⇒ a fallback that still drives /deliver (discover-in-session).
  const noId = buildMandrelDeliverPrompt({ scenario: SCENARIO });
  assert.match(noId, /\/deliver/);
  assert.doesNotMatch(noId, /\/plan\b/);
});

test('buildControlPrompt: bare task, no pipeline commands', () => {
  const p = buildControlPrompt({ scenario: SCENARIO });
  assert.doesNotMatch(p, /\/plan|\/deliver/);
  assert.match(p, /autonomously/i);
});

test('buildArmPrompt: phase selector routes to the per-phase builders', () => {
  assert.equal(
    buildArmPrompt({ arm: 'mandrel', scenario: SCENARIO, phase: 'plan' }),
    buildMandrelPlanPrompt({ scenario: SCENARIO }),
  );
  assert.equal(
    buildArmPrompt({
      arm: 'mandrel',
      scenario: SCENARIO,
      phase: 'deliver',
      deliverTarget: 5,
    }),
    buildMandrelDeliverPrompt({ scenario: SCENARIO, deliverTarget: 5 }),
  );
});

test('aggregateEnvelopes: sums cost/tokens/duration and folds nulls', () => {
  const e1 = parseSessionEnvelope(
    JSON.stringify(
      realEnvelope({
        total_cost_usd: 0.2,
        duration_ms: 1000,
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    ),
  );
  const e2 = parseSessionEnvelope(
    JSON.stringify(
      realEnvelope({
        total_cost_usd: 0.3,
        duration_ms: 2000,
        usage: {
          input_tokens: 20,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    ),
  );
  const agg = aggregateEnvelopes([e1, e2]);
  assert.equal(agg.cost.totalUsd, 0.5);
  assert.equal(agg.usage.totalTokens, 11 + 22);
  assert.equal(agg.durationMs, 3000);
  assert.equal(agg.raw.aggregatedFromPhases, true);
  assert.equal(agg.raw.phases.length, 2);

  // All-null costs ⇒ null total (no signal), not a faked 0.
  const n1 = parseSessionEnvelope(
    JSON.stringify(realEnvelope({ total_cost_usd: undefined })),
  );
  const n2 = parseSessionEnvelope(
    JSON.stringify(realEnvelope({ total_cost_usd: undefined })),
  );
  assert.equal(aggregateEnvelopes([n1, n2]).cost.totalUsd, null);
});

test('runSession: rejects bad arm and empty cwd', () => {
  assert.throws(
    () => runSession({ arm: 'nope', scenario: SCENARIO, cwd: '/tmp/s' }, {}),
    /must be one of mandrel, control/,
  );
  assert.throws(
    () => runSession({ arm: 'mandrel', scenario: SCENARIO, cwd: '' }, {}),
    /non-empty cwd/,
  );
});

test('runSession: throws when the injected invoke returns unparseable stdout', () => {
  const invoke = fakeInvoke({ status: 0, stdout: 'totally not json' });
  assert.throws(
    () =>
      runSession(
        { arm: 'control', scenario: SCENARIO, cwd: '/tmp/s' },
        { invokeFn: invoke },
      ),
    /Failed to parse/,
  );
});

// ---------------------------------------------------------------------------
// trustWorkspaceForClaude — pre-trust a throwaway workspace so headless
// `claude -p` doesn't hard-exit on the workspace-trust gate. Fully mocked fs.
// ---------------------------------------------------------------------------

/**
 * Build a mock fs deps bag over an in-memory file map, recording writes.
 */
function mockTrustDeps({
  files = {},
  configPath = '/home/u/.claude.json',
} = {}) {
  const store = { ...files };
  const writes = [];
  return {
    configPath,
    writes,
    store,
    deps: {
      configPath,
      existsSync: (p) => p in store,
      readFileSync: (p) => {
        if (!(p in store)) throw new Error(`ENOENT ${p}`);
        return store[p];
      },
      writeFileSync: (p, data) => {
        store[p] = data;
        writes.push({ path: p, data });
      },
      renameSync: (from, to) => {
        store[to] = store[from];
        delete store[from];
      },
      realpathSync: (p) => p,
    },
  };
}

test('trustWorkspaceForClaude — skips a workspace with no .claude/settings.json', () => {
  const m = mockTrustDeps();
  const trusted = trustWorkspaceForClaude('/tmp/sbx1', m.deps);
  assert.equal(trusted, false);
  assert.equal(
    m.writes.length,
    0,
    'must not touch ~/.claude.json for a bare dir',
  );
});

test('trustWorkspaceForClaude — writes hasTrustDialogAccepted for the realpath', () => {
  const m = mockTrustDeps({
    files: {
      '/tmp/sbx2/.claude/settings.json': '{"permissions":{"allow":["Bash"]}}',
      '/home/u/.claude.json': JSON.stringify({ projects: { '/other': {} } }),
    },
  });
  const trusted = trustWorkspaceForClaude('/tmp/sbx2', m.deps);
  assert.equal(trusted, true);
  const config = JSON.parse(m.store['/home/u/.claude.json']);
  assert.equal(config.projects['/tmp/sbx2'].hasTrustDialogAccepted, true);
  // Existing entries are preserved.
  assert.ok('/other' in config.projects);
});

test('trustWorkspaceForClaude — idempotent when already trusted (no write)', () => {
  const m = mockTrustDeps({
    files: {
      '/tmp/sbx3/.claude/settings.json': '{"permissions":{"allow":["Bash"]}}',
      '/home/u/.claude.json': JSON.stringify({
        projects: { '/tmp/sbx3': { hasTrustDialogAccepted: true } },
      }),
    },
  });
  const trusted = trustWorkspaceForClaude('/tmp/sbx3', m.deps);
  assert.equal(trusted, true);
  assert.equal(
    m.writes.length,
    0,
    'already-trusted must not rewrite the config',
  );
});

test('trustWorkspaceForClaude — refuses to clobber an unparseable config', () => {
  const m = mockTrustDeps({
    files: {
      '/tmp/sbx4/.claude/settings.json': '{"permissions":{"allow":["Bash"]}}',
      '/home/u/.claude.json': '{ this is not json',
    },
  });
  const trusted = trustWorkspaceForClaude('/tmp/sbx4', m.deps);
  assert.equal(trusted, false);
  assert.equal(
    m.writes.length,
    0,
    'a corrupt/concurrent config must never be overwritten',
  );
});

// ---------------------------------------------------------------------------
// isTransientClaudeError / rethrowIfTransientClaudeError — distinguish a
// transient infra blip (must abort the cell for a clean resume) from a genuine
// null (degrade gracefully).
// ---------------------------------------------------------------------------

test('isTransientClaudeError — flags rate/session limit, overload, network', () => {
  const transient = [
    'claude -p exited with status 1: {"api_error_status":429,"result":"You\'ve hit your session limit · resets 11:40am"}',
    'API Error: Request rejected (429 Too Many Requests)',
    'Overloaded (529)',
    'rate limited, retry later',
    'Error: socket hang up',
    'connect ETIMEDOUT 1.2.3.4:443',
    'read ECONNRESET',
    'getaddrinfo EAI_AGAIN api.anthropic.com',
  ];
  for (const m of transient) {
    assert.equal(
      isTransientClaudeError(new Error(m)),
      true,
      `should be transient: ${m}`,
    );
  }
});

test('isTransientClaudeError — does NOT flag genuine failures', () => {
  const genuine = [
    'touch2 failed: delivered app did not start on port 3000',
    'frozen acceptance oracle: GET / returned 500', // app 5xx is genuine, not infra
    'judge abstained: unparseable response',
    'boom',
    '',
    undefined,
    null,
  ];
  for (const m of genuine) {
    assert.equal(
      isTransientClaudeError(
        m instanceof Object ? m : new Error(String(m ?? '')),
      ),
      false,
      `should NOT be transient: ${m}`,
    );
  }
});

test('rethrowIfTransientClaudeError — throws on transient, no-op on genuine', () => {
  const t = new Error('{"api_error_status":429} session limit');
  assert.throws(() => rethrowIfTransientClaudeError(t), /session limit/);
  // Genuine → returns undefined, does not throw.
  assert.equal(
    rethrowIfTransientClaudeError(new Error('app crashed')),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Ticket #123 — variant arms: control-claudemd (arm 3) and
// mandrel-story-routed (arm 4). Arm 3 is a workspace seed, NOT a prompt
// delta; arm 4 is a plan-phase routing override on the existing two-session
// mandrel machinery, not a fork of it.
// ---------------------------------------------------------------------------

test('buildMandrelPlanPrompt (storyRouted): carries the single-Story routing override on the --idea drive', () => {
  const prompt = buildMandrelPlanPrompt({
    scenario: SCENARIO,
    storyRouted: true,
  });
  assert.match(prompt, /ROUTING OVERRIDE/);
  assert.match(prompt, /ONE standalone Story/);
  assert.match(prompt, /do NOT decompose it into an Epic/);
  assert.match(prompt, /one spec, one close-validate, one review, one PR/);
  assert.match(prompt, /\/plan --idea/);
  assert.match(prompt, /do NOT deliver/);
  assert.match(prompt, /hello-world/);
});

test('buildMandrelPlanPrompt (storyRouted): ignores a seed Epic id — entering at an Epic would contradict the override', () => {
  const prompt = buildMandrelPlanPrompt({
    scenario: { ...SCENARIO, epicId: 42 },
    storyRouted: true,
  });
  assert.match(prompt, /\/plan --idea/);
  assert.doesNotMatch(prompt, /\/plan 42/);
  assert.doesNotMatch(prompt, /#42/);
});

test('buildArmPrompt (control-claudemd): byte-identical to the control prompt — arm 3 differs only by the seeded CLAUDE.md', () => {
  assert.equal(
    buildArmPrompt({ arm: 'control-claudemd', scenario: SCENARIO }),
    buildControlPrompt({ scenario: SCENARIO }),
  );
});

test('buildArmPrompt (mandrel-story-routed): plan phase carries the override; deliver phase is the shared builder', () => {
  const plan = buildArmPrompt({
    arm: 'mandrel-story-routed',
    scenario: SCENARIO,
    phase: 'plan',
  });
  assert.match(plan, /ROUTING OVERRIDE/);
  // The plain mandrel plan prompt carries no override.
  assert.doesNotMatch(
    buildArmPrompt({ arm: 'mandrel', scenario: SCENARIO, phase: 'plan' }),
    /ROUTING OVERRIDE/,
  );
  assert.equal(
    buildArmPrompt({
      arm: 'mandrel-story-routed',
      scenario: SCENARIO,
      phase: 'deliver',
      deliverTarget: 7,
    }),
    buildMandrelDeliverPrompt({ scenario: SCENARIO, deliverTarget: 7 }),
  );
});

test('runSession (control-claudemd): ONE bare session with the control prompt; phases null; arm preserved', () => {
  const invoke = fakeInvoke();
  const result = runSession(
    { arm: 'control-claudemd', scenario: SCENARIO, cwd: '/tmp/s' },
    { invokeFn: invoke },
  );
  assert.equal(invoke.calls.length, 1);
  assert.equal(
    invoke.calls[0].prompt,
    buildControlPrompt({ scenario: SCENARIO }),
  );
  assert.equal(result.arm, 'control-claudemd');
  assert.equal(result.phases, null);
});

test('runSession (mandrel-story-routed): TWO ordered sessions; the plan prompt carries the routing override', () => {
  const invoke = fakeInvoke();
  const result = runSession(
    { arm: 'mandrel-story-routed', scenario: SCENARIO, cwd: '/tmp/s' },
    { invokeFn: invoke },
  );
  assert.equal(invoke.calls.length, 2);
  assert.match(invoke.calls[0].prompt, /ROUTING OVERRIDE/);
  assert.match(invoke.calls[0].prompt, /ONE standalone Story/);
  assert.match(invoke.calls[1].prompt, /\/deliver/);
  assert.equal(result.arm, 'mandrel-story-routed');
  assert.equal(result.phases.length, 2);
  assert.deepEqual(
    result.phases.map((p) => p.phase),
    ['plan', 'deliver'],
  );
});

test('runSession (mandrel-story-routed): betweenPhases deliverTarget threads into the deliver prompt; a seed Epic id is NOT the fallback target', () => {
  // With a betweenPhases hook: the discovered standalone Story id drives /deliver.
  const invoke = fakeInvoke();
  runSession(
    {
      arm: 'mandrel-story-routed',
      scenario: { ...SCENARIO, epicId: 42 },
      cwd: '/tmp/s',
    },
    { invokeFn: invoke, betweenPhases: () => ({ deliverTarget: 101 }) },
  );
  assert.match(invoke.calls[1].prompt, /\/deliver 101 --yes/);

  // Without a hook: the seed Epic id must NOT become the deliver target (the
  // story-routed plan session ignored it); the prompt falls back to in-session
  // discovery.
  const invoke2 = fakeInvoke();
  runSession(
    {
      arm: 'mandrel-story-routed',
      scenario: { ...SCENARIO, epicId: 42 },
      cwd: '/tmp/s',
    },
    { invokeFn: invoke2 },
  );
  assert.doesNotMatch(invoke2.calls[1].prompt, /\/deliver 42/);
});
