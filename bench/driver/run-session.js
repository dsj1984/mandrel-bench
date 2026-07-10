// bench/driver/run-session.js
/**
 * Headless run driver for the Mandrel self-benchmark harness.
 *
 * A "run" is one headless Claude Code session driving one arm over one
 * scenario. The driver shells out to `claude -p --output-format json`, which
 * runs the agent non-interactively and emits a single JSON result envelope on
 * stdout carrying the real usage/cost actuals (`total_cost_usd`, `usage`,
 * `modelUsage`, timings). This is the ONLY cost source in the harness — Mandrel
 * itself records no token actuals — and it is measured identically for both
 * arms, so the value/cost comparison is apples-to-apples by construction
 * (Epic #4211, Tech Spec #4213).
 *
 * Precedent: `.agents/scripts/lib/orchestration/review-providers/security-review.js`
 * (`defaultInvokeSecurityReview`) already shells `claude --print` and parses
 * its stdout. This module follows the same shape — a default `spawnSync`-based
 * invoker that is **injectable** (`invokeFn`) so unit tests never spawn a real
 * process — but targets the `-p --output-format json` envelope rather than the
 * free-text `--print` mode.
 *
 * The driver does NOT score, persist, or read lifecycle telemetry — those are
 * downstream slices. It launches the session, parses the envelope, and returns
 * a normalized `{ usage, cost, raw, ... }` record plus the per-run prompt that
 * was sent.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Pinned default model id. The harness records the exact model on every
 * scorecard and only ever compares like-model to like-model (Epic Non-Goal:
 * "A model benchmark — the model is pinned and recorded"). Overridable per run.
 */
export const DEFAULT_BENCH_MODEL = 'claude-opus-4-8';

/**
 * Hard ceiling for a single headless session. Long agentic `/deliver` runs are
 * the expensive case; default to one hour and let callers override.
 */
export const DEFAULT_SESSION_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Validate the shared scenario contract every prompt builder needs (a string
 * `id` and a non-empty `taskPrompt`). Throws the same `TypeError`s the public
 * builders historically threw so callers/tests see an unchanged failure surface.
 *
 * @param {{ id?: unknown, taskPrompt?: unknown }} scenario
 * @param {string} who  The public builder name, for the error message.
 * @returns {void}
 */
function assertScenario(scenario, who) {
  if (!scenario || typeof scenario.id !== 'string') {
    throw new TypeError(`${who} requires a scenario with a string id`);
  }
  if (
    typeof scenario.taskPrompt !== 'string' ||
    scenario.taskPrompt.length === 0
  ) {
    throw new TypeError(`${who} requires scenario.taskPrompt`);
  }
}

/**
 * The unattended-mode preamble injected into every Mandrel-arm session (both
 * the `/plan` and the `/deliver` phase). Auto-proceed through every HITL STOP /
 * confirmation gate keeps the headless session from stalling (see
 * `bench/driver/unattended.md`). Kept as one constant so the two phase builders
 * can never drift on the directive.
 */
const MANDREL_UNATTENDED_PREAMBLE =
  `You are operating Mandrel's pipeline non-interactively under a headless ` +
  `benchmark driver. There is no human at the keyboard. At every ` +
  `human-in-the-loop STOP / confirmation gate (one-pager confirm, spec ` +
  `review, decomposition diff gate, and the auto-merge-else-operator-merge ` +
  `step), treat the absence of an operator as implicit approval and proceed ` +
  `with the best available interpretation — never block waiting for input. `;

/**
 * Bare-model control-arm prompt: the task, no Mandrel scaffolding, no pipeline
 * ceremony. Exported so docs tooling and tests reference one canonical builder.
 *
 * @param {object} input
 * @param {{ id: string, taskPrompt: string }} input.scenario
 * @returns {string}
 */
export function buildControlPrompt(input) {
  const { scenario } = input ?? {};
  assertScenario(scenario, 'buildControlPrompt');
  return (
    `You are working in a fresh git checkout. Complete the following task ` +
    `end to end, committing your work. Do not ask for confirmation — proceed ` +
    `autonomously to completion.\n\nTask (${scenario.id}):\n${scenario.taskPrompt}`
  );
}

/**
 * Mandrel-arm PLAN-phase prompt (D-019). Session 1 of the ordered two-session
 * mandrel run drives `/plan` to completion and STOPS — it does NOT deliver.
 * Splitting `/plan` and `/deliver` into their own sessions makes each phase's
 * `claude -p` envelope (cost/tokens/wall-clock) individually attributable, and
 * a fresh `/deliver` session (session 2) is faithful to Mandrel's
 * tickets-are-state design.
 *
 * Both drive paths pass `--yes` (v1.72.0+ headless flag, mandrel#4223): it
 * deterministically auto-proceeds /plan's HITL stop gates (the ideation
 * one-pager / scope-triage confirm and the Phase-7 review gate).
 *   - With a seed Epic id: `/plan <id> --yes` (enters at the existing Epic).
 *   - Without one (the default for N>1 cohorts, since each Epic-id run consumes
 *     and closes its Epic): the `--idea` drive — the run self-authors a fresh
 *     Epic from the task and runs the full /plan pipeline. The id it creates is
 *     unknown to the harness until the between-session id-discovery seam recovers
 *     it (see bench/run.js), so this prompt does not reference an id.
 *
 * @param {object} input
 * @param {{ id: string, taskPrompt: string, epicId?: number|string }} input.scenario
 * @returns {string}
 */
export function buildMandrelPlanPrompt(input) {
  const { scenario } = input ?? {};
  assertScenario(scenario, 'buildMandrelPlanPrompt');
  const drive =
    scenario.epicId !== undefined && scenario.epicId !== null
      ? `An Epic issue (#${scenario.epicId}) capturing the task below has already ` +
        `been opened in this repository. Plan it with \`/plan ${scenario.epicId} --yes\`. ` +
        `Run ONLY the planning pipeline in this session — do NOT deliver; do not ` +
        `re-author the Epic from an idea and do not pre-stage any planning artifact.`
      : `Author the plan with \`/plan --idea "<the task described below>" --yes\` ` +
        `(the --yes flag drives /plan headlessly through its HITL stop gates). ` +
        `Run ONLY the planning pipeline in this session — do NOT deliver, and do ` +
        `not pre-stage any planning artifact.`;
  return `${MANDREL_UNATTENDED_PREAMBLE}${drive}\n\nTask (${scenario.id}):\n${scenario.taskPrompt}`;
}

/**
 * Mandrel-arm DELIVER-phase prompt (D-019). Session 2 of the ordered
 * two-session mandrel run delivers the plan session 1 authored, in a FRESH
 * session (state lives in the tickets, not the transcript). `deliverTarget` is
 * the id the between-session id-discovery seam recovered from the ephemeral
 * repo (the Epic id for epic-routed scenarios; the standalone Story id for
 * story-routed ones); it is threaded in so `/deliver` enters at the artifact
 * the plan session created.
 *
 * @param {object} input
 * @param {{ id: string, taskPrompt: string }} input.scenario
 * @param {number|string|null} [input.deliverTarget]  The Epic/Story id to
 *   deliver, discovered between the sessions. When null the prompt falls back to
 *   instructing delivery of the Epic the plan session just produced.
 * @returns {string}
 */
export function buildMandrelDeliverPrompt(input) {
  const { scenario, deliverTarget = null } = input ?? {};
  assertScenario(scenario, 'buildMandrelDeliverPrompt');
  const drive =
    deliverTarget !== undefined && deliverTarget !== null
      ? `The planning pipeline has already run in a previous session and opened ` +
        `the ticket(s) for the task below in this repository. Deliver it now with ` +
        `\`/deliver ${deliverTarget} --yes\` (the --yes flag drives /deliver ` +
        `headlessly through its HITL stop gates). Do NOT re-plan or re-author any ` +
        `planning artifact — deliver the existing plan.`
      : `The planning pipeline has already run in a previous session and opened ` +
        `the ticket(s) for the task below in this repository. Discover the Epic it ` +
        `created and deliver it with \`/deliver <epicId> --yes\`. Do NOT re-plan or ` +
        `re-author any planning artifact — deliver the existing plan.`;
  return `${MANDREL_UNATTENDED_PREAMBLE}${drive}\n\nTask (${scenario.id}):\n${scenario.taskPrompt}`;
}

/**
 * Compose the prompt sent to `claude -p` for a given arm + scenario (+ phase).
 * A thin phase-aware dispatcher over the per-phase builders above:
 *
 * - **control** arm: the bare task via `buildControlPrompt` (single session).
 * - **mandrel** arm + `phase: 'plan'`  → `buildMandrelPlanPrompt`.
 * - **mandrel** arm + `phase: 'deliver'` → `buildMandrelDeliverPrompt`.
 * - **mandrel** arm with NO phase → the legacy combined `/plan then /deliver`
 *   prompt (back-compat for callers that still want one prompt; `runSession`
 *   itself now uses the per-phase builders).
 *
 * Exported so docs tooling and tests reference one canonical builder.
 *
 * @param {object} input
 * @param {'mandrel'|'control'} input.arm
 * @param {{ id: string, taskPrompt: string, epicId?: number|string }} input.scenario
 * @param {'plan'|'deliver'} [input.phase]  Mandrel phase selector.
 * @param {number|string|null} [input.deliverTarget]  Passed through to the
 *   deliver-phase builder.
 * @returns {string}
 */
export function buildArmPrompt(input) {
  const { arm, scenario, phase, deliverTarget } = input ?? {};

  if (arm === 'control') {
    return buildControlPrompt({ scenario });
  }

  if (arm === 'mandrel') {
    if (phase === 'plan') return buildMandrelPlanPrompt({ scenario });
    if (phase === 'deliver') {
      return buildMandrelDeliverPrompt({ scenario, deliverTarget });
    }
    // Legacy combined single-prompt path (no phase): drive /plan then /deliver
    // in one prompt. Retained for back-compat; the driver now runs the two
    // phases as separate sessions via the per-phase builders above.
    assertScenario(scenario, 'buildArmPrompt');
    const drive =
      scenario.epicId !== undefined && scenario.epicId !== null
        ? `An Epic issue (#${scenario.epicId}) capturing the task below has already ` +
          `been opened in this repository. Plan it with \`/plan ${scenario.epicId} --yes\` ` +
          `and then deliver it with \`/deliver ${scenario.epicId} --yes\`; do not ` +
          `re-author the Epic from an idea and do not pre-stage any planning artifact.`
        : `Author the plan with \`/plan --idea "<the task described below>" --yes\` and ` +
          `then deliver the resulting Epic with \`/deliver <epicId> --yes\` (the --yes ` +
          `flags drive /plan and /deliver headlessly through their HITL stop gates); do ` +
          `not pre-stage any planning artifact.`;
    return `${MANDREL_UNATTENDED_PREAMBLE}${drive}\n\nTask (${scenario.id}):\n${scenario.taskPrompt}`;
  }

  throw new TypeError(
    `buildArmPrompt arm must be "mandrel" or "control", got: ${String(arm)}`,
  );
}

/**
 * Build the argv passed to the `claude` binary for a headless JSON run.
 * Exported so tests assert the exact invocation shape (notably
 * `--output-format json`, which is what makes the usage/cost envelope appear).
 *
 * `--permission-mode bypassPermissions` and `--dangerously-skip-permissions`
 * are intentionally NOT added here by default — the harness runs inside a
 * throwaway sandbox clone (see `sandbox.js`); callers that need a broader
 * autorun posture pass `extraArgs`. We keep the default surface minimal.
 *
 * @param {object} input
 * @param {string} input.prompt
 * @param {string} input.model
 * @param {string[]} [input.extraArgs]
 * @returns {string[]}
 */
export function buildClaudeArgs(input) {
  const { prompt, model, extraArgs = [] } = input ?? {};
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new TypeError('buildClaudeArgs requires a non-empty prompt');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('buildClaudeArgs requires a non-empty model');
  }
  if (!Array.isArray(extraArgs)) {
    throw new TypeError('buildClaudeArgs extraArgs must be an array');
  }
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    ...extraArgs,
    prompt,
  ];
}

/**
 * Recognise a TRANSIENT infrastructure failure (rate/session limit, Anthropic
 * overload, network) in a `claude -p` error — as opposed to a GENUINE null (the
 * delivered app is broken, the judge legitimately abstained). The run-session
 * layer throws on a non-zero exit with the failed session's envelope JSON in the
 * message, so the 429 / "session limit" / "overloaded" text is matched there.
 *
 * Deliberately narrow: it matches `429`/`529`, explicit rate/session-limit and
 * overload phrasing, and network errnos — NOT ambiguous 5xx codes, which a
 * *delivered app* could legitimately return through the acceptance oracle (that
 * is a genuine failure, not an infra blip).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientClaudeError(err) {
  const msg = String(err?.message ?? err ?? '');
  return /\b(429|529)\b|rate.?limit(ed)?|session limit|overloaded|too many requests|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network error|timed out/i.test(
    msg,
  );
}

/**
 * Re-throw `err` when it is a transient infrastructure failure, so a caught,
 * normally-degrading stage (the dimension judge, the second touch) ABORTS its
 * cell instead of completing degraded. The cell is then neither persisted nor
 * checkpointed, so a resume redoes it cleanly rather than baking a transient
 * blip into a "complete" scorecard indistinguishable from a genuine null. A
 * genuine (non-transient) error is a no-op here — the caller swallows and
 * degrades it exactly as before.
 *
 * @param {unknown} err
 * @returns {void}
 */
export function rethrowIfTransientClaudeError(err) {
  if (isTransientClaudeError(err)) throw err;
}

/**
 * Pre-trust a throwaway benchmark workspace for headless `claude -p`.
 *
 * Claude Code gates on WORKSPACE TRUST: `claude -p` in a directory it has never
 * trusted that carries a `.claude/settings.json` with `permissions.allow`
 * entries refuses to honor them — and in practice hard-exits 1 (observed on the
 * mandrel arm's second-touch workspace, whose overlaid `.agents`/`.claude` bring
 * the harness's own allow-list along). No CLI flag or env var bypasses this gate
 * (`--dangerously-skip-permissions` only covers permission PROMPTS); the sole
 * non-interactive path is to pre-write `hasTrustDialogAccepted` for the exact
 * absolute realpath into `~/.claude.json`, which Claude Code re-reads on every
 * invocation.
 *
 * Runs at the single session choke point (both arms, both touches, AND the
 * dimension judge flow through `defaultInvokeClaudeSession`), immediately before
 * each spawn. GUARDED on the presence of `.claude/settings.json` — the only case
 * that trips the gate — so a bare workspace (e.g. the judge's temp dir) never
 * touches `~/.claude.json`. Best-effort: any read/parse/write failure is
 * swallowed (untrusted merely means the allow-list is ignored, the prior
 * behaviour), and the write is atomic (temp + rename) so a concurrent reader
 * never sees a half-written config.
 *
 * @param {string|undefined} cwd  Absolute path of the workspace `claude -p` runs in.
 * @param {object} [deps]  Injectable fs/config for tests.
 * @returns {boolean} true when the workspace is (now) trusted; false if skipped/failed.
 */
export function trustWorkspaceForClaude(cwd, deps = {}) {
  const existsFn = deps.existsSync ?? existsSync;
  const readFn = deps.readFileSync ?? readFileSync;
  const writeFn = deps.writeFileSync ?? writeFileSync;
  const renameFn = deps.renameSync ?? renameSync;
  const realpathFn = deps.realpathSync ?? realpathSync;
  const configPath = deps.configPath ?? path.join(homedir(), '.claude.json');
  try {
    if (!cwd || !existsFn(path.join(cwd, '.claude', 'settings.json'))) {
      return false;
    }
    const real = realpathFn(cwd);
    let config = {};
    if (existsFn(configPath)) {
      try {
        config = JSON.parse(readFn(configPath, 'utf-8')) || {};
      } catch {
        // Refuse to clobber a config we couldn't parse (e.g. a concurrent write).
        return false;
      }
    }
    if (config.projects?.[real]?.hasTrustDialogAccepted === true) return true;
    config.projects = config.projects ?? {};
    config.projects[real] = {
      ...(config.projects[real] ?? {}),
      hasTrustDialogAccepted: true,
    };
    const tmp = `${configPath}.bench-${process.pid}.tmp`;
    writeFn(tmp, JSON.stringify(config, null, 2));
    renameFn(tmp, configPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default invoker: shell out to the host's `claude` CLI in headless JSON mode.
 * Exported and injectable — the production caller accepts an `invokeFn`
 * override so tests never spawn a real process.
 *
 * Mirrors `defaultInvokeSecurityReview`'s contract: returns
 * `{ status, stdout, stderr }`. The `cwd` is the ephemeral sandbox clone, so
 * all churn lands there and never in the live repo.
 *
 * @param {object} input
 * @param {string} input.prompt
 * @param {string} input.model
 * @param {string} input.cwd       Absolute path of the sandbox clone to run in.
 * @param {string[]} [input.extraArgs]
 * @param {number} [input.timeoutMs]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function defaultInvokeClaudeSession(input) {
  const { prompt, model, cwd, extraArgs, timeoutMs } = input ?? {};
  // Ensure `claude -p` trusts this throwaway workspace (see
  // trustWorkspaceForClaude) BEFORE spawning — else an untrusted dir carrying an
  // overlaid `.claude/settings.json` hard-exits 1.
  trustWorkspaceForClaude(cwd);
  const args = buildClaudeArgs({ prompt, model, extraArgs });
  const result = spawnSync('claude', args, {
    cwd,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    timeout: timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Parse the `claude -p --output-format json` envelope into the fields the
 * harness needs. The envelope is a single JSON object on stdout; we tolerate
 * leading/trailing whitespace and a possible prose preface by extracting the
 * first balanced top-level object.
 *
 * Verified against a live run on `claude` 2.1.178: the envelope carries
 * `type:"result"`, `subtype`, `is_error`, `result`, `total_cost_usd`,
 * `usage:{ input_tokens, output_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens, ... }`, `modelUsage`, `duration_ms`, `num_turns`,
 * `session_id`, `permission_denials`, and `terminal_reason`.
 *
 * Exported for testing.
 *
 * @param {string} rawStdout
 * @returns {{
 *   type: string|undefined,
 *   subtype: string|undefined,
 *   isError: boolean,
 *   result: string|undefined,
 *   sessionId: string|undefined,
 *   numTurns: number|undefined,
 *   durationMs: number|undefined,
 *   cost: { totalUsd: number|null },
 *   usage: {
 *     inputTokens: number,
 *     outputTokens: number,
 *     cacheCreationInputTokens: number,
 *     cacheReadInputTokens: number,
 *     totalTokens: number
 *   },
 *   modelUsage: Record<string, unknown>,
 *   permissionDenials: unknown[],
 *   terminalReason: string|undefined,
 *   raw: object
 * }}
 * @throws {Error} when stdout contains no parseable JSON object.
 */
export function parseSessionEnvelope(rawStdout) {
  const obj = extractFirstJsonObject(rawStdout);
  if (obj === null) {
    throw new Error(
      '[run-session] Failed to parse claude --output-format json stdout as a JSON object.',
    );
  }

  const usage = obj.usage && typeof obj.usage === 'object' ? obj.usage : {};
  const inputTokens = toNonNegInt(usage.input_tokens);
  const outputTokens = toNonNegInt(usage.output_tokens);
  const cacheCreationInputTokens = toNonNegInt(
    usage.cache_creation_input_tokens,
  );
  const cacheReadInputTokens = toNonNegInt(usage.cache_read_input_tokens);

  const totalCost =
    typeof obj.total_cost_usd === 'number' &&
    Number.isFinite(obj.total_cost_usd)
      ? obj.total_cost_usd
      : null;

  return {
    type: typeof obj.type === 'string' ? obj.type : undefined,
    subtype: typeof obj.subtype === 'string' ? obj.subtype : undefined,
    isError: obj.is_error === true,
    result: typeof obj.result === 'string' ? obj.result : undefined,
    sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
    numTurns: Number.isFinite(obj.num_turns) ? obj.num_turns : undefined,
    durationMs: Number.isFinite(obj.duration_ms) ? obj.duration_ms : undefined,
    cost: { totalUsd: totalCost },
    usage: {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      totalTokens:
        inputTokens +
        outputTokens +
        cacheCreationInputTokens +
        cacheReadInputTokens,
    },
    modelUsage:
      obj.modelUsage && typeof obj.modelUsage === 'object'
        ? obj.modelUsage
        : {},
    permissionDenials: Array.isArray(obj.permission_denials)
      ? obj.permission_denials
      : [],
    terminalReason:
      typeof obj.terminal_reason === 'string' ? obj.terminal_reason : undefined,
    raw: obj,
  };
}

/**
 * Launch ONE headless `claude -p --output-format json` session, parse its
 * envelope, and surface a non-zero exit / is_error as the callers expect.
 * Shared by both arms; the mandrel arm calls it twice (plan, then deliver).
 *
 * @param {object} args
 * @param {string} args.prompt
 * @param {'mandrel'|'control'} args.arm
 * @param {string} args.scenarioId
 * @param {string} args.cwd
 * @param {string} args.model
 * @param {string[]} args.extraArgs
 * @param {number} args.timeoutMs
 * @param {(input: object) => { status: number, stdout: string, stderr: string }} args.invokeFn
 * @param {{ info?: Function, warn?: Function }} [args.logger]
 * @param {string} [args.phase]  Label for logging ('plan'|'deliver'|undefined).
 * @returns {{ status: number, envelope: ReturnType<typeof parseSessionEnvelope> }}
 */
function invokeOneSession({
  prompt,
  arm,
  scenarioId,
  cwd,
  model,
  extraArgs,
  timeoutMs,
  invokeFn,
  logger,
  phase,
}) {
  const phaseTag = phase ? ` phase=${phase}` : '';
  logger?.info?.(
    `[run-session] Launching headless session: arm=${arm} scenario=${scenarioId}${phaseTag} model=${model}`,
  );

  const { status, stdout, stderr } = invokeFn({
    prompt,
    model,
    cwd,
    extraArgs,
    timeoutMs,
  });

  if (status !== 0) {
    throw new Error(
      `[run-session] claude -p exited with status ${status} ` +
        `(arm=${arm}, scenario=${scenarioId}${phaseTag}): ${
          stderr || stdout || '<no output>'
        }`,
    );
  }

  const envelope = parseSessionEnvelope(stdout);

  // A clean exit code with an error envelope is still a failed run — surface it
  // rather than silently returning a zero-cost record the scorer would trust.
  if (envelope.isError) {
    logger?.warn?.(
      `[run-session] Session reported is_error=true (arm=${arm}, scenario=${scenarioId}${phaseTag}): ${
        envelope.result ?? '<no result text>'
      }`,
    );
  }

  logger?.info?.(
    `[run-session] Session complete: arm=${arm} scenario=${scenarioId}${phaseTag} ` +
      `cost=$${envelope.cost.totalUsd ?? '?'} tokens=${envelope.usage.totalTokens} turns=${
        envelope.numTurns ?? '?'
      }`,
  );

  return { status, envelope };
}

/**
 * Sum a list of `costUsd` values into one total, treating a `null`/absent cost
 * as "no signal": if EVERY phase reports null the total is null; otherwise the
 * numeric costs are summed (a null phase contributes 0). This keeps the run
 * total honest when only some phases report a cost.
 *
 * @param {Array<number|null>} costs
 * @returns {number|null}
 */
function sumCostUsd(costs) {
  const nums = costs.filter((c) => typeof c === 'number' && Number.isFinite(c));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0);
}

/**
 * Merge two `modelUsage` maps additively (per model id), summing the common
 * numeric token/cost fields so the aggregated envelope's `modelUsage` still
 * lets `resolveModelId` pick the pinned model across BOTH phases.
 *
 * @param {Record<string, object>} a
 * @param {Record<string, object>} b
 * @returns {Record<string, object>}
 */
function mergeModelUsage(a = {}, b = {}) {
  const out = {};
  for (const src of [a, b]) {
    if (!src || typeof src !== 'object') continue;
    for (const [key, val] of Object.entries(src)) {
      const prev = out[key] ?? {};
      const cur = val && typeof val === 'object' ? val : {};
      const merged = { ...prev };
      for (const field of Object.keys(cur)) {
        const cv = cur[field];
        const pv = prev[field];
        merged[field] =
          typeof cv === 'number' && typeof pv === 'number' ? pv + cv : cv;
      }
      out[key] = merged;
    }
  }
  return out;
}

/**
 * Fold the ordered per-phase envelopes of a mandrel run into ONE run-level
 * envelope whose cost/tokens/duration are the SUM of the phases — so every
 * downstream consumer (`extractUsage`, `resolveModelId`, the persisted
 * `cost-envelope.json`) sees the run total, exactly as it did before the
 * session split. The per-phase envelopes are preserved separately in the
 * `phases` array (`runSession`'s return) and on `raw.phases` for provenance.
 *
 * @param {Array<ReturnType<typeof parseSessionEnvelope>>} envelopes  Ordered.
 * @returns {ReturnType<typeof parseSessionEnvelope>}
 */
export function aggregateEnvelopes(envelopes) {
  const list = Array.isArray(envelopes) ? envelopes : [];
  const last = list[list.length - 1] ?? {};
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  };
  let durationMs = 0;
  let numTurns = 0;
  let modelUsage = {};
  const permissionDenials = [];
  let isError = false;
  for (const e of list) {
    const u = e?.usage ?? {};
    usage.inputTokens += toNonNegInt(u.inputTokens);
    usage.outputTokens += toNonNegInt(u.outputTokens);
    usage.cacheCreationInputTokens += toNonNegInt(u.cacheCreationInputTokens);
    usage.cacheReadInputTokens += toNonNegInt(u.cacheReadInputTokens);
    usage.totalTokens += toNonNegInt(u.totalTokens);
    if (typeof e?.durationMs === 'number' && Number.isFinite(e.durationMs)) {
      durationMs += e.durationMs;
    }
    if (typeof e?.numTurns === 'number' && Number.isFinite(e.numTurns)) {
      numTurns += e.numTurns;
    }
    modelUsage = mergeModelUsage(modelUsage, e?.modelUsage);
    if (Array.isArray(e?.permissionDenials)) {
      permissionDenials.push(...e.permissionDenials);
    }
    if (e?.isError === true) isError = true;
  }
  const totalUsd = sumCostUsd(list.map((e) => e?.cost?.totalUsd ?? null));
  return {
    type: last.type,
    subtype: last.subtype,
    isError,
    result: last.result,
    sessionId: last.sessionId,
    numTurns,
    durationMs,
    cost: { totalUsd },
    usage,
    modelUsage,
    permissionDenials,
    terminalReason: last.terminalReason,
    raw: {
      aggregatedFromPhases: true,
      phases: list.map((e) => e?.raw ?? e),
    },
  };
}

/**
 * Project one parsed phase envelope into the compact `phases[]` record the
 * scorecard carries: `{ phase, costUsd, tokens, wallClockMs }`. The per-phase
 * cost/tokens sum to the run totals (see `aggregateEnvelopes`); `wallClockMs`
 * is the phase session's own `claude -p` duration.
 *
 * @param {string} phase
 * @param {ReturnType<typeof parseSessionEnvelope>} envelope
 * @returns {{ phase: string, costUsd: number|null, tokens: number, wallClockMs: number }}
 */
function phaseRecord(phase, envelope) {
  return {
    phase,
    costUsd: envelope?.cost?.totalUsd ?? null,
    tokens: toNonNegInt(envelope?.usage?.totalTokens),
    wallClockMs:
      typeof envelope?.durationMs === 'number' &&
      Number.isFinite(envelope.durationMs)
        ? envelope.durationMs
        : 0,
  };
}

/**
 * Run a benchmark cell's arm as one (control) or two ordered (mandrel) headless
 * `claude -p --output-format json` sessions and return the parsed usage/cost.
 *
 * - **control** — ONE session (`buildControlPrompt`); `phases` is null.
 * - **mandrel** — TWO ordered sessions (D-019): session 1 drives `/plan`
 *   (`buildMandrelPlanPrompt`), then the injected `deps.betweenPhases` hook runs
 *   the between-session id-discovery + plan snapshot (see bench/run.js) and
 *   returns the `deliverTarget` id; session 2 drives `/deliver`
 *   (`buildMandrelDeliverPrompt`) in a fresh session. The returned `envelope` is
 *   the SUM of both phase envelopes (via `aggregateEnvelopes`) so every
 *   downstream consumer sees the run total unchanged; `phases` carries the
 *   per-phase `{ phase, costUsd, tokens, wallClockMs }` breakdown.
 *
 * @param {object} opts
 * @param {'mandrel'|'control'} opts.arm
 * @param {{ id: string, taskPrompt: string, epicId?: number|string }} opts.scenario
 * @param {string} opts.cwd  Absolute path of the ephemeral sandbox clone.
 * @param {string} [opts.model=DEFAULT_BENCH_MODEL]
 * @param {string[]} [opts.extraArgs]
 * @param {number} [opts.timeoutMs=DEFAULT_SESSION_TIMEOUT_MS]
 * @param {object} [deps]
 * @param {(input: object) => { status: number, stdout: string, stderr: string }} [deps.invokeFn]
 *   Injected session invoker. Defaults to `defaultInvokeClaudeSession`. Tests
 *   override this so no real `claude` process is spawned.
 * @param {(ctx: { scenario: object, planEnvelope: object, cwd: string }) => { deliverTarget?: number|string|null }} [deps.betweenPhases]
 *   Mandrel-only between-session hook (id-discovery + plan snapshot). Returns the
 *   `deliverTarget` id threaded into the deliver prompt. A no-op default keeps
 *   `runSession` runnable in isolation (the deliver prompt falls back to
 *   discovering the Epic in-session).
 * @param {{ info?: Function, warn?: Function, error?: Function }} [deps.logger]
 * @returns {{
 *   arm: 'mandrel'|'control',
 *   scenarioId: string,
 *   model: string,
 *   prompt: string,
 *   status: number,
 *   envelope: ReturnType<typeof parseSessionEnvelope>,
 *   phases: Array<{ phase: string, costUsd: number|null, tokens: number, wallClockMs: number }>|null
 * }}
 */
export function runSession(opts = {}, deps = {}) {
  const {
    arm,
    scenario,
    cwd,
    model = DEFAULT_BENCH_MODEL,
    extraArgs = [],
    timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  } = opts;

  if (arm !== 'mandrel' && arm !== 'control') {
    throw new TypeError(
      `runSession arm must be "mandrel" or "control", got: ${String(arm)}`,
    );
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError(
      'runSession requires a non-empty cwd (sandbox clone path)',
    );
  }

  const invokeFn = deps.invokeFn ?? defaultInvokeClaudeSession;
  const logger = deps.logger;

  // Control arm: a single bare session.
  if (arm === 'control') {
    const prompt = buildControlPrompt({ scenario });
    const { status, envelope } = invokeOneSession({
      prompt,
      arm,
      scenarioId: scenario.id,
      cwd,
      model,
      extraArgs,
      timeoutMs,
      invokeFn,
      logger,
    });
    return {
      arm,
      scenarioId: scenario.id,
      model,
      prompt,
      status,
      envelope,
      phases: null,
    };
  }

  // Mandrel arm: two ordered sessions (plan → deliver), D-019.
  const planPrompt = buildMandrelPlanPrompt({ scenario });
  const plan = invokeOneSession({
    prompt: planPrompt,
    arm,
    scenarioId: scenario.id,
    cwd,
    model,
    extraArgs,
    timeoutMs,
    invokeFn,
    logger,
    phase: 'plan',
  });

  // Between-session seam: id-discovery + plan snapshot (bench/run.js wires the
  // real gh-backed hook; the default no-op leaves deliverTarget null so the
  // deliver prompt falls back to in-session Epic discovery).
  let deliverTarget = null;
  if (typeof deps.betweenPhases === 'function') {
    const between =
      deps.betweenPhases({ scenario, planEnvelope: plan.envelope, cwd }) ?? {};
    deliverTarget = between.deliverTarget ?? null;
  } else if (scenario.epicId !== undefined && scenario.epicId !== null) {
    // No hook, but a seed Epic id is known up front — deliver it directly.
    deliverTarget = scenario.epicId;
  }

  const deliverPrompt = buildMandrelDeliverPrompt({ scenario, deliverTarget });
  const deliver = invokeOneSession({
    prompt: deliverPrompt,
    arm,
    scenarioId: scenario.id,
    cwd,
    model,
    extraArgs,
    timeoutMs,
    invokeFn,
    logger,
    phase: 'deliver',
  });

  const envelope = aggregateEnvelopes([plan.envelope, deliver.envelope]);
  const phases = [
    phaseRecord('plan', plan.envelope),
    phaseRecord('deliver', deliver.envelope),
  ];

  return {
    arm,
    scenarioId: scenario.id,
    model,
    // The deliver-phase prompt is the run's "primary" prompt for provenance;
    // both phase prompts are recoverable from the phase builders + scenario.
    prompt: deliverPrompt,
    status: deliver.status,
    envelope,
    phases,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a value to a non-negative integer, defaulting to 0. Token-count
 * fields in the envelope are always non-negative integers; a missing or
 * malformed field collapses to 0 rather than NaN so downstream sums stay valid.
 *
 * @param {unknown} v
 * @returns {number}
 */
function toNonNegInt(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
    return Math.trunc(v);
  }
  return 0;
}

/**
 * Extract the first balanced top-level JSON object from a string, tolerating a
 * prose preface or trailing text around it. Returns the parsed object, or
 * `null` when no parseable object is present.
 *
 * Brace-counting is done outside string literals (with escape handling) so a
 * `}` inside a JSON string value does not prematurely close the scan.
 *
 * @param {string} raw
 * @returns {object|null}
 */
function extractFirstJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Fast path: the whole stdout is one JSON object.
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      return direct;
    }
  } catch {
    // Fall through to the scanning path.
  }

  const start = trimmed.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
          }
        } catch {
          return null;
        }
        return null;
      }
    }
  }
  return null;
}
