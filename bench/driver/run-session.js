// bench/driver/run-session.js
/**
 * Headless run driver for the Mandrel self-benchmark harness.
 *
 * A "run" is one headless Claude Code session driving one arm over one
 * scenario. The driver shells out to `claude -p --output-format stream-json`,
 * which runs the agent non-interactively and emits one NDJSON event per turn on
 * stdout, terminated by a `type:"result"` event carrying the real usage/cost
 * actuals (`total_cost_usd`, `usage`, `modelUsage`, timings). That terminal
 * event is the ONLY cost source in the harness — Mandrel itself records no
 * token actuals — and it is measured identically for both arms, so the
 * value/cost comparison is apples-to-apples by construction (Epic #4211, Tech
 * Spec #4213).
 *
 * **Transcript capture (Story #154).** The stream carries the per-turn record
 * that the legacy single-envelope `--output-format json` mode threw away with
 * the sandbox, so turn-level cost attribution (the dominant cache-read spend)
 * was impossible after the fact. The driver now tees the FULL event stream to a
 * gzipped per-phase NDJSON file under the cell's `.raw/<idStamp>/` directory
 * (`<phase>-transcript.ndjson.gz`) and parses the terminal `result` event into
 * the exact same envelope shape the legacy path produced — every existing
 * envelope consumer is bit-compatible. Capture is strictly best-effort: an
 * unwritable transcript warns and never fails the run.
 *
 * Precedent: `.agents/scripts/lib/orchestration/review-providers/security-review.js`
 * (`defaultInvokeSecurityReview`) already shells `claude --print` and parses
 * its stdout. This module follows the same shape — a default `spawnSync`-based
 * invoker that is **injectable** (`invokeFn`) so unit tests never spawn a real
 * process — but targets the `-p --output-format stream-json` event stream
 * rather than the free-text `--print` mode.
 *
 * The driver does NOT score, persist, or read lifecycle telemetry — those are
 * downstream slices. It launches the session, parses the envelope, and returns
 * a normalized `{ usage, cost, raw, ... }` record plus the per-run prompt that
 * was sent.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { baseArm, KNOWN_ARMS, routingOverrideForArm } from './arms.js';

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
 * **Story-routing override (arm 4, Ticket #123).** When `storyRouted` is true
 * the prompt drives the `--idea` path (a seed Epic id is deliberately ignored —
 * entering at an existing Epic would contradict the override) and instructs
 * the scope-triage step to route the task as ONE standalone Story regardless
 * of apparent scope — one guarded session: spec once, close-validate once,
 * review once, one PR. The override is the arm-4 treatment; the harness's
 * routing-mismatch exclusion is made arm-aware to match (see
 * bench/driver/arms.js `routingOverrideForArm`).
 *
 * @param {object} input
 * @param {{ id: string, taskPrompt: string, epicId?: number|string }} input.scenario
 * @param {boolean} [input.storyRouted]  Force single-standalone-Story routing.
 * @returns {string}
 */
export function buildMandrelPlanPrompt(input) {
  const { scenario, storyRouted = false } = input ?? {};
  assertScenario(scenario, 'buildMandrelPlanPrompt');
  if (storyRouted) {
    const drive =
      `Author the plan with \`/plan --idea "<the task described below>" --yes\` ` +
      `(the --yes flag drives /plan headlessly through its HITL stop gates). ` +
      `ROUTING OVERRIDE: at the scope-triage decision, route this task as ONE ` +
      `standalone Story — do NOT decompose it into an Epic with child Stories, ` +
      `regardless of how large the task appears. The entire task must be ` +
      `specified, delivered, and reviewed as a single Story: one spec, one ` +
      `close-validate, one review, one PR. Run ONLY the planning pipeline in ` +
      `this session — do NOT deliver, and do not pre-stage any planning artifact.`;
    return `${MANDREL_UNATTENDED_PREAMBLE}${drive}\n\nTask (${scenario.id}):\n${scenario.taskPrompt}`;
  }
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
 * A thin phase-aware dispatcher over the per-phase builders above, keyed on
 * the arm's BASE shape (bench/driver/arms.js) so the Ticket #123 variants
 * reuse the existing builders:
 *
 * - **control-base** arms (`control`, `control-claudemd`): the bare task via
 *   `buildControlPrompt` (single session; arm 3's static CLAUDE.md is a
 *   workspace seed, not a prompt delta).
 * - **mandrel-base** arms + `phase: 'plan'`  → `buildMandrelPlanPrompt`
 *   (with the story-routing override for `mandrel-story-routed`).
 * - **mandrel-base** arms + `phase: 'deliver'` → `buildMandrelDeliverPrompt`.
 * - **mandrel** arm with NO phase → the legacy combined `/plan then /deliver`
 *   prompt (back-compat for callers that still want one prompt; `runSession`
 *   itself now uses the per-phase builders).
 *
 * Exported so docs tooling and tests reference one canonical builder.
 *
 * @param {object} input
 * @param {string} input.arm  Any arm in bench/driver/arms.js KNOWN_ARMS.
 * @param {{ id: string, taskPrompt: string, epicId?: number|string }} input.scenario
 * @param {'plan'|'deliver'} [input.phase]  Mandrel phase selector.
 * @param {number|string|null} [input.deliverTarget]  Passed through to the
 *   deliver-phase builder.
 * @returns {string}
 */
export function buildArmPrompt(input) {
  const { arm, scenario, phase, deliverTarget } = input ?? {};
  const base = KNOWN_ARMS.includes(arm) ? baseArm(arm) : arm;

  if (base === 'control') {
    return buildControlPrompt({ scenario });
  }

  if (base === 'mandrel') {
    const storyRouted = routingOverrideForArm(arm) === 'story';
    if (phase === 'plan') {
      return buildMandrelPlanPrompt({ scenario, storyRouted });
    }
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
    `buildArmPrompt arm must be one of ${KNOWN_ARMS.join(', ')}, got: ${String(arm)}`,
  );
}

/**
 * Build the argv passed to the `claude` binary for a headless streaming run.
 * Exported so tests assert the exact invocation shape (notably
 * `--output-format stream-json`, which is what makes BOTH the per-turn event
 * stream and the terminal usage/cost envelope appear).
 *
 * `--verbose` is mandatory alongside `--output-format stream-json` in `-p`
 * mode — the CLI refuses the combination without it, and it is what emits the
 * per-turn assistant/user/tool events the transcript capture exists to keep.
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
    'stream-json',
    '--verbose',
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
 * overload phrasing, network errnos, and the claude CLI's OWN structured
 * `terminal_reason":"api_error"` marker (a session that died from an upstream
 * API/server error, e.g. a mid-response server error with a null http status)
 * — but NOT ambiguous 5xx codes, which a *delivered app* could legitimately
 * return through the acceptance oracle (that is a genuine failure, not an infra
 * blip). The `api_error` marker is safe against that exclusion because it is the
 * `claude -p` envelope's own terminal reason for ITS api call, never an app
 * HTTP response — the oracle scores the app in-process and produces no such
 * envelope.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientClaudeError(err) {
  const msg = String(err?.message ?? err ?? '');
  return /\b(429|529)\b|rate.?limit(ed)?|session limit|overloaded|too many requests|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network error|timed out|terminal_reason"\s*:\s*"api_error"|server error mid-response/i.test(
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

// ---------------------------------------------------------------------------
// Transient-error retry (in-session backoff)
// ---------------------------------------------------------------------------

/**
 * How many times a single `claude -p` session is RE-attempted after a transient
 * infrastructure failure (Anthropic 429/529, network blip) before the error is
 * re-thrown to the batch's abort-and-resume path. `0` disables retry.
 *
 * The default (and the base backoff) are operator-overridable so a run during a
 * known Anthropic incident can wait longer without a code change. This is an
 * in-session softening of the pre-existing behaviour, NOT a replacement for it:
 * once the budget is exhausted the transient error is still thrown, so a
 * PERSISTENT overload still aborts the cell cleanly for a later resume rather
 * than baking a degraded session into the cohort.
 */
const DEFAULT_SESSION_MAX_RETRIES = toNonNegIntOr(
  process.env.BENCH_SESSION_MAX_RETRIES,
  4,
);
/** First backoff wait; each subsequent retry doubles it, capped below. */
const DEFAULT_SESSION_RETRY_BASE_MS = toNonNegIntOr(
  process.env.BENCH_SESSION_RETRY_BASE_MS,
  5000,
);
/** Hard cap on any single backoff wait, so exponential growth stays bounded. */
const SESSION_RETRY_MAX_DELAY_MS = 60000;

/**
 * Parse a non-negative integer from an env string, falling back to `fallback`
 * for absent/blank/invalid input (so a typo'd env var never yields NaN retries).
 *
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function toNonNegIntOr(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Backoff delay for retry attempt `n` (1-based): `base × 2^(n-1)`, capped at
 * `SESSION_RETRY_MAX_DELAY_MS`. With the 5s default: 5s, 10s, 20s, 40s, 60s…
 *
 * @param {number} attempt  1-based retry number.
 * @param {number} baseMs
 * @returns {number}
 */
function backoffDelayMs(attempt, baseMs) {
  const raw = baseMs * 2 ** (attempt - 1);
  return Math.min(raw, SESSION_RETRY_MAX_DELAY_MS);
}

/**
 * Synchronous blocking sleep, used as the default backoff between retries. The
 * benchmark runner is a strictly sequential batch that already blocks on
 * `spawnSync` for minutes per session, so a blocking wait here is consistent
 * with the surrounding design and keeps the whole call chain synchronous (no
 * async ripple through `runSession` → `runOneRun` → `main`). Injected in tests
 * so no test ever actually waits.
 *
 * @param {number} ms
 * @returns {void}
 */
export function blockingSleep(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  // Prefer the terminal `result` event: under `--output-format stream-json`
  // stdout is NDJSON whose FIRST object is the `system:init` event, so the
  // legacy first-balanced-object scan would read the wrong record. For legacy
  // single-envelope stdout the sole object IS the `result` event, so this
  // lookup returns exactly what the old fast path returned — bit-compatible.
  const obj =
    extractResultEvent(rawStdout) ?? extractFirstJsonObject(rawStdout);
  if (obj === null) {
    throw new Error(
      '[run-session] Failed to parse claude --output-format json stdout as a JSON object.',
    );
  }
  return normalizeSessionEnvelope(obj);
}

/**
 * Parse a `claude -p --output-format stream-json` NDJSON stream into the SAME
 * envelope shape `parseSessionEnvelope` produces, by normalizing its terminal
 * `type:"result"` event. Split out from `parseSessionEnvelope` so the
 * stream path can fail loudly when no terminal result event is present (a
 * truncated/aborted stream) rather than silently normalizing an init event.
 *
 * @param {string} rawStdout
 * @returns {ReturnType<typeof parseSessionEnvelope>}
 * @throws {Error} when the stream carries no terminal `result` event.
 */
export function parseStreamEnvelope(rawStdout) {
  const obj = extractResultEvent(rawStdout);
  if (obj === null) {
    throw new Error(
      '[run-session] Failed to parse claude --output-format stream-json stdout: no terminal result event.',
    );
  }
  return normalizeSessionEnvelope(obj);
}

/**
 * Project a raw `result` event object into the harness's normalized envelope.
 * The single home of that mapping — both the legacy single-object path and the
 * stream-json terminal-event path funnel through it, which is what makes the
 * two bit-compatible by construction rather than by convention.
 *
 * @param {object} obj  A raw `type:"result"` envelope object.
 * @returns {ReturnType<typeof parseSessionEnvelope>}
 */
function normalizeSessionEnvelope(obj) {
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
 * Canonical filename for one phase's captured event stream. Kept as a helper so
 * the writer and every consumer (bench/run.js `rawRefs`, later analysis) agree
 * on the shape without restating the literal.
 *
 * @param {string} [phase]  'plan' | 'deliver' | undefined (control's lone session).
 * @returns {string}
 */
export function transcriptFileName(phase) {
  const label =
    typeof phase === 'string' && phase.length > 0 ? phase : 'session';
  return `${label}-transcript.ndjson.gz`;
}

/**
 * Tee one session's FULL `--output-format stream-json` stdout to a gzipped
 * per-phase NDJSON file (Story #154). Transcripts run to multiple MB per
 * session, so they are compressed on write.
 *
 * **Best-effort by contract.** Capture exists to make turn-level cost
 * attribution possible after the fact; it is never load-bearing for the run
 * itself. An absent directory arg is a silent no-op, and ANY write failure
 * (read-only volume, ENOSPC, a mocked-to-throw fs) logs a warning and returns
 * `null` — the session record it accompanies is returned complete and
 * unchanged.
 *
 * @param {object} input
 * @param {string} [input.dir]     Absolute capture directory (`.raw/<idStamp>/`).
 * @param {string} [input.phase]   Phase label; see `transcriptFileName`.
 * @param {string} [input.stdout]  The raw event stream to persist.
 * @param {object} [deps]          Injectable fs/gzip/logger for tests.
 * @returns {string|null}  Absolute path written, or null when skipped/failed.
 */
export function writeSessionTranscript(input, deps = {}) {
  const { dir, phase, stdout } = input ?? {};
  if (typeof dir !== 'string' || dir.length === 0) return null;
  const mkdirFn = deps.mkdirSync ?? mkdirSync;
  const writeFn = deps.writeFileSync ?? writeFileSync;
  const gzipFn = deps.gzipSync ?? gzipSync;
  const filePath = path.join(dir, transcriptFileName(phase));
  try {
    mkdirFn(dir, { recursive: true });
    writeFn(
      filePath,
      gzipFn(Buffer.from(typeof stdout === 'string' ? stdout : '', 'utf-8')),
    );
    return filePath;
  } catch (err) {
    deps.logger?.warn?.(
      `[run-session] transcript capture failed for ${filePath} (continuing): ${
        err?.message ?? err
      }`,
    );
    return null;
  }
}

/**
 * Launch ONE headless `claude -p --output-format stream-json` session, parse
 * its terminal envelope, tee the event stream to the capture directory, and
 * surface a non-zero exit / is_error as the callers expect.
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
 * @param {number} [args.maxRetries]  Transient-error re-attempts (default env-driven).
 * @param {number} [args.retryBaseMs]  First backoff wait (default env-driven).
 * @param {(ms: number) => void} [args.sleepFn]  Backoff sleeper (injected in tests).
 * @param {string} [args.transcriptDir]  Capture dir for the event stream.
 * @param {object} [args.transcriptDeps]  Injectable fs/gzip for the capture.
 * @returns {{ status: number, envelope: ReturnType<typeof parseSessionEnvelope>, transcriptPath: string|null }}
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
  maxRetries = DEFAULT_SESSION_MAX_RETRIES,
  retryBaseMs = DEFAULT_SESSION_RETRY_BASE_MS,
  sleepFn = blockingSleep,
  transcriptDir,
  transcriptDeps,
}) {
  const phaseTag = phase ? ` phase=${phase}` : '';
  logger?.info?.(
    `[run-session] Launching headless session: arm=${arm} scenario=${scenarioId}${phaseTag} model=${model}`,
  );

  // Retry loop: a TRANSIENT infrastructure failure (Anthropic 429/529, network
  // blip) is re-attempted with exponential backoff up to `maxRetries` times.
  // A non-transient failure — or a transient one past the budget — throws, so
  // the batch's existing abort-and-resume path is unchanged for anything the
  // retry cannot absorb.
  let status;
  let stdout;
  let stderr;
  for (let attempt = 0; ; attempt += 1) {
    ({ status, stdout, stderr } = invokeFn({
      prompt,
      model,
      cwd,
      extraArgs,
      timeoutMs,
    }));

    if (status === 0) break;

    const err = new Error(
      `[run-session] claude -p exited with status ${status} ` +
        `(arm=${arm}, scenario=${scenarioId}${phaseTag}): ${
          stderr || stdout || '<no output>'
        }`,
    );
    // Retry only a transient error, and only while budget remains.
    if (isTransientClaudeError(err) && attempt < maxRetries) {
      const delay = backoffDelayMs(attempt + 1, retryBaseMs);
      logger?.warn?.(
        `[run-session] transient error (arm=${arm} scenario=${scenarioId}${phaseTag}); ` +
          `retry ${attempt + 1}/${maxRetries} after ${delay}ms`,
      );
      sleepFn(delay);
      continue;
    }
    throw err;
  }

  // Tee the FULL event stream before parsing: the transcript is the whole point
  // of the stream-json cutover (Story #154), and it must survive even a session
  // whose terminal envelope turns out to be unparseable.
  const transcriptPath = writeSessionTranscript(
    { dir: transcriptDir, phase, stdout },
    { ...(transcriptDeps ?? {}), logger },
  );

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

  return { status, envelope, transcriptPath };
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
 * @param {string} [opts.transcriptDir]  Absolute capture directory for the
 *   per-phase event streams (bench/run.js threads the cell's `.raw/<idStamp>/`).
 *   Omit to disable capture entirely.
 * @param {object} [deps]
 * @param {object} [deps.transcriptDeps]  Injectable fs/gzip for the transcript
 *   writer, so a unit test can assert the capture and the write-failure path
 *   without touching disk.
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
 *   phases: Array<{ phase: string, costUsd: number|null, tokens: number, wallClockMs: number }>|null,
 *   transcripts: Array<{ phase: string, path: string }>
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
    sessionMaxRetries = DEFAULT_SESSION_MAX_RETRIES,
    sessionRetryBaseMs = DEFAULT_SESSION_RETRY_BASE_MS,
    transcriptDir,
  } = opts;

  if (!KNOWN_ARMS.includes(arm)) {
    throw new TypeError(
      `runSession arm must be one of ${KNOWN_ARMS.join(', ')}, got: ${String(arm)}`,
    );
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError(
      'runSession requires a non-empty cwd (sandbox clone path)',
    );
  }

  const invokeFn = deps.invokeFn ?? defaultInvokeClaudeSession;
  const sleepFn = deps.sleepFn ?? blockingSleep;
  const logger = deps.logger;
  const base = baseArm(arm);
  // Retry config threaded uniformly into every session this run launches.
  const retryOpts = {
    maxRetries: sessionMaxRetries,
    retryBaseMs: sessionRetryBaseMs,
    sleepFn,
    transcriptDir,
    transcriptDeps: deps.transcriptDeps,
  };

  /**
   * Fold a phase's capture result into the run-level `transcripts` list,
   * dropping the `null` a skipped or failed (best-effort) capture returns.
   *
   * @param {Array<{ phase: string, path: string }>} into
   * @param {string} phase
   * @param {string|null} transcriptPath
   * @returns {void}
   */
  const recordTranscript = (into, phase, transcriptPath) => {
    if (typeof transcriptPath === 'string' && transcriptPath.length > 0) {
      into.push({ phase, path: transcriptPath });
    }
  };

  // Control-base arms (`control`, `control-claudemd`): a single bare session.
  // Arm 3's only delta is the CLAUDE.md the driver seeded into `cwd`.
  if (base === 'control') {
    const prompt = buildControlPrompt({ scenario });
    const { status, envelope, transcriptPath } = invokeOneSession({
      prompt,
      arm,
      scenarioId: scenario.id,
      cwd,
      model,
      extraArgs,
      timeoutMs,
      invokeFn,
      logger,
      ...retryOpts,
    });
    const transcripts = [];
    recordTranscript(transcripts, 'session', transcriptPath);
    return {
      arm,
      scenarioId: scenario.id,
      model,
      prompt,
      status,
      envelope,
      phases: null,
      transcripts,
    };
  }

  // Mandrel-base arms: two ordered sessions (plan → deliver), D-019. The
  // `mandrel-story-routed` variant (arm 4, Ticket #123) threads the
  // story-routing override into the plan-phase prompt; everything else —
  // between-phases discovery, deliver phase, envelope aggregation — is the
  // identical machinery.
  const storyRouted = routingOverrideForArm(arm) === 'story';
  const planPrompt = buildMandrelPlanPrompt({ scenario, storyRouted });
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
    ...retryOpts,
  });

  // Between-session seam: id-discovery + plan snapshot (bench/run.js wires the
  // real gh-backed hook; the default no-op leaves deliverTarget null so the
  // deliver prompt falls back to in-session Epic discovery).
  let deliverTarget = null;
  if (typeof deps.betweenPhases === 'function') {
    const between =
      deps.betweenPhases({ scenario, planEnvelope: plan.envelope, cwd }) ?? {};
    deliverTarget = between.deliverTarget ?? null;
  } else if (
    !storyRouted &&
    scenario.epicId !== undefined &&
    scenario.epicId !== null
  ) {
    // No hook, but a seed Epic id is known up front — deliver it directly.
    // (Not for the story-routed variant: its plan session ignored the seed
    // Epic and authored a standalone Story, so the Epic id is not the target.)
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
    ...retryOpts,
  });

  const envelope = aggregateEnvelopes([plan.envelope, deliver.envelope]);
  const phases = [
    phaseRecord('plan', plan.envelope),
    phaseRecord('deliver', deliver.envelope),
  ];
  const transcripts = [];
  recordTranscript(transcripts, 'plan', plan.transcriptPath);
  recordTranscript(transcripts, 'deliver', deliver.transcriptPath);

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
    transcripts,
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
 * Scan an NDJSON event stream for its TERMINAL `type:"result"` event and return
 * it parsed, or `null` when no line parses into one.
 *
 * Scans from the END so the terminal event is found in one hop on a multi-MB
 * transcript, and so a stream that (pathologically) carried more than one
 * result event yields the last — the run total, matching what the legacy
 * single-envelope mode emitted.
 *
 * Lines that are not standalone JSON objects (a prose preface, a
 * pretty-printed multi-line envelope) simply do not match; the caller falls
 * back to the balanced-object scan.
 *
 * @param {string} raw
 * @returns {object|null}
 */
function extractResultEvent(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.length === 0 || !line.startsWith('{') || !line.endsWith('}')) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && parsed.type === 'result') {
      return parsed;
    }
  }
  return null;
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
