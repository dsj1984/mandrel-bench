// bench/collect/normalize.js
//
// Telemetry normalizer for the Mandrel self-benchmark harness (Epic #4211,
// Story #4217). Internal tooling only — never shipped in the distributed
// `.agents/` bundle, never run against the live repo.
//
// This module is the join point of the harness: it reads the raw artifacts a
// single (scenario × arm × run) produced —
//
//   1. the run's lifecycle NDJSON ledger (temp/epic-<id>/lifecycle.ndjson),
//   2. the per-Story signals NDJSON files,
//   3. the `claude -p --output-format json` usage/cost envelope (parsed by
//      bench/driver/run-session.js#parseSessionEnvelope),
//   4. the scenario's frozen acceptance-suite result + the acceptance-eval
//      cross-check verdict (the Quality inputs), and
//   5. the plan-vs-actual counts (planned/delivered Story counts, planned vs
//      touched file footprints)
//
// — and folds them into ONE per-run record that conforms to
// bench/schemas/scorecard.schema.json. The dimension math is delegated to
// bench/score/dimensions.js; this module owns the *extraction* of the raw
// sub-signals from the lifecycle ledger (timings, dispatch count, autonomy
// counters, and the ceremony/codegen token split) and the assembly of the
// surrounding scorecard envelope.
//
// Determinism: pure functions plus a thin file-reading shell. The NDJSON
// parser and every derivation are pure; only `normalizeRunFromPaths` touches
// the filesystem (and only to read the three artifact kinds), so the core is
// unit-testable from in-memory inputs with no I/O.

import { readFileSync } from 'node:fs';

import {
  baseArm,
  isControlArm,
  isMandrelArm,
  KNOWN_ARMS,
  routingOverrideForArm,
} from '../driver/arms.js';
import { computeDimensions } from '../score/dimensions.js';
import { computeAttribution } from '../score/plan-quality.js';

/** Scorecard-record schema version this normalizer emits. */
export const SCORECARD_SCHEMA_VERSION = 1;

/**
 * Lifecycle events that bound the *codegen* spans (shippable
 * Story-implementation work). Tokens spent inside a
 * `story.dispatch.start` → `story.dispatch.end` window are codegen; everything
 * else in the session (planning between `epic.plan.start`/`epic.plan.end`,
 * orchestration, gate/close machinery) is attributed to ceremony as the
 * `total − codegen` remainder (see `deriveTokenSplit`).
 */
const STORY_DISPATCH_START = 'story.dispatch.start';
const STORY_DISPATCH_END = 'story.dispatch.end';

/** Lifecycle events that count toward the autonomy intervention tally. */
const EPIC_BLOCKED = 'epic.blocked';
const STORY_BLOCKED = 'story.blocked';
const INTERVENTION_RECORDED = 'intervention.recorded';

/**
 * Parse an NDJSON string into an array of records. Blank lines are skipped;
 * a malformed line throws with its 1-based line number so a corrupt ledger
 * fails loudly rather than silently dropping telemetry.
 *
 * Each lifecycle record has the shape written by the LedgerWriter / the thin
 * emit helpers: `{ kind, ts, seqId?, event, payload }`.
 *
 * @param {string} text
 * @returns {Array<object>}
 * @throws {SyntaxError} on a non-blank line that is not valid JSON.
 */
export function parseNdjson(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseNdjson: input must be a string');
  }
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch (cause) {
      throw new SyntaxError(
        `parseNdjson: invalid JSON on line ${i + 1}: ${cause.message}`,
      );
    }
  }
  return out;
}

/**
 * The `emitted` records are the canonical lifecycle signal; the LedgerWriter
 * also writes `completed`/`failed` bookkeeping records that repeat an event
 * name without a payload. For deriving run telemetry we only ever want the
 * `emitted` records (every emit produces exactly one). Records written by the
 * thin direct-append helpers (heartbeat, dispatch-end) are already
 * `kind: 'emitted'`, so this filter unifies both producers.
 *
 * @param {Array<object>} records
 * @returns {Array<object>}
 */
function emittedRecords(records) {
  return records.filter(
    (r) => r?.event && r.kind !== 'completed' && r.kind !== 'failed',
  );
}

/**
 * Parse an ISO-8601 timestamp into epoch ms, or NaN when absent/malformed.
 *
 * @param {unknown} ts
 * @returns {number}
 */
function tsMs(ts) {
  if (typeof ts !== 'string') return Number.NaN;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Derive the wall-clock duration of a run from the span of its lifecycle
 * records: `last.ts − first.ts`, in milliseconds. Records are NOT assumed to
 * be sorted, so we scan for the min and max parseable timestamp. Returns 0
 * when fewer than two timestamps are present.
 *
 * GitHub round-trip latency is intentionally inside this window — it is part
 * of Mandrel's real overhead (README § 4).
 *
 * @param {Array<object>} records  Lifecycle records.
 * @returns {number}
 */
export function deriveWallClockMs(records) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const r of records) {
    const ms = tsMs(r?.ts);
    if (!Number.isFinite(ms)) continue;
    count += 1;
    if (ms < min) min = ms;
    if (ms > max) max = ms;
  }
  if (count < 2) return 0;
  return Math.max(0, max - min);
}

/**
 * Count Story dispatches (sub-agent launches) — one per
 * `story.dispatch.start` record.
 *
 * @param {Array<object>} records  Emitted lifecycle records.
 * @returns {number}
 */
export function deriveDispatchCount(records) {
  let n = 0;
  for (const r of records) {
    if (r.event === STORY_DISPATCH_START) n += 1;
  }
  return n;
}

/**
 * A `story.blocked` reason string emitted by a FAILED close-validate gate
 * (`pre-merge-validation.js` fires `story.blocked` with
 * `reason: 'close-validate-failed:<gate>'` on every gate failure, including
 * the ones the pipeline auto-recovers). These are self-recovered GATE RETRIES,
 * not terminal human-intervention blocks — Ticket #121, item 2 moves them out
 * of the autonomy tally into a separate `gateRetries` counter (they are
 * already priced in tokens).
 */
const CLOSE_VALIDATE_BLOCK_RE = /^close-validate-failed:/;

/**
 * Derive the autonomy counters from the lifecycle ledger plus the per-Story
 * signals.
 *
 *   blockedEvents — TERMINAL `epic.blocked` + `story.blocked` records: genuine
 *                   agent::blocked pauses that need a human. EXCLUDES
 *                   `story.blocked` records whose reason is a
 *                   `close-validate-failed:*` gate failure — those are
 *                   self-recovered close-validate retries counted separately as
 *                   `gateRetries` (Ticket #121, item 2), NOT interventions.
 *   gateRetries   — self-recovered close-validate gate failures (the
 *                   `story.blocked` `close-validate-failed:*` records). A cost
 *                   signal (already paid in tokens), reported under efficiency
 *                   rather than penalizing autonomy.
 *   manualRescues — `intervention.recorded` records.
 *   hitlStops     — STOP gates the run actually halted at. In a correctly
 *                   configured unattended run these auto-proceed (count 0); a
 *                   non-zero value is a finding. They are sourced from
 *                   explicit signal records (`kind: 'hitl-stop'` or
 *                   `signal: 'hitl-stop'`) in the per-Story signals, since the
 *                   lifecycle bus has no dedicated HITL-stop event — an
 *                   auto-proceeding gate emits nothing.
 *
 * @param {object} args
 * @param {Array<object>} args.lifecycle  Emitted lifecycle records.
 * @param {Array<object>} [args.signals]  Flattened per-Story signal records.
 * @returns {{ hitlStops: number, blockedEvents: number, manualRescues: number, gateRetries: number }}
 */
export function deriveAutonomyCounters({ lifecycle, signals = [] }) {
  let blockedEvents = 0;
  let manualRescues = 0;
  let gateRetries = 0;
  for (const r of lifecycle) {
    if (r.event === EPIC_BLOCKED) {
      blockedEvents += 1;
    } else if (r.event === STORY_BLOCKED) {
      const reason = r?.payload?.reason;
      if (typeof reason === 'string' && CLOSE_VALIDATE_BLOCK_RE.test(reason)) {
        gateRetries += 1;
      } else {
        blockedEvents += 1;
      }
    } else if (r.event === INTERVENTION_RECORDED) {
      manualRescues += 1;
    }
  }
  let hitlStops = 0;
  for (const s of signals) {
    if (s?.kind === 'hitl-stop' || s?.signal === 'hitl-stop') hitlStops += 1;
  }
  return { hitlStops, blockedEvents, manualRescues, gateRetries };
}

/**
 * Split the run's total tokens into a ceremony bucket and a codegen bucket
 * using the lifecycle phase boundaries (README § 5, "Token attribution").
 *
 * Mandrel records no per-phase token actuals — the only cost source is the
 * single session-level `claude -p` envelope (`totalTokens`). So we attribute
 * the *session total* across the two buckets in proportion to the wall-clock
 * time each bucket occupied:
 *
 *   codegenMs  = Σ (story.dispatch.end.ts − matching story.dispatch.start.ts)
 *   ceremonyMs = wallClockMs − codegenMs
 *   codegenTokens  = round(totalTokens · codegenMs / wallClockMs)
 *   ceremonyTokens = totalTokens − codegenTokens   (so the two always sum to total)
 *
 * Time-proportional attribution is the honest derivation available from the
 * recorded inputs: the implementation phases that produce shippable artifacts
 * are exactly the dispatch windows, and everything else in the session
 * (planning, orchestration, gate/close machinery) is ceremony. The per-Story
 * dispatch windows are matched start→end by `storyId`; an unclosed dispatch
 * (start with no end) contributes nothing to codegen time (it never produced a
 * settled shippable result within the recorded window).
 *
 * Edge cases:
 *   - `wallClockMs === 0` (single-timestamp ledger): the whole session total
 *     is ceremony (no measurable codegen window).
 *   - `totalTokens === 0`: both buckets are 0.
 *   - control arm: typically no dispatch windows, so codegen ≈ the bare run
 *     and ceremony ≈ 0 — matching the README's "control arm sits near the
 *     floor".
 *
 * @param {object} args
 * @param {Array<object>} args.lifecycle    Emitted lifecycle records.
 * @param {number} args.totalTokens         Session total tokens (from envelope).
 * @param {number} args.wallClockMs         Derived run wall-clock.
 * @returns {{
 *   ceremonyTokens: number,
 *   codegenTokens: number,
 *   ceremonyMs: number,
 *   codegenMs: number
 * }}
 */
export function deriveTokenSplit({ lifecycle, totalTokens, wallClockMs }) {
  // Sum the matched dispatch windows. Match start→end per storyId; a start
  // with no matching end contributes no codegen time.
  const openStartMsByStory = new Map();
  let codegenMs = 0;
  for (const r of lifecycle) {
    const storyId = r?.payload?.storyId;
    const ms = tsMs(r.ts);
    if (r.event === STORY_DISPATCH_START && Number.isFinite(ms)) {
      openStartMsByStory.set(storyId, ms);
    } else if (r.event === STORY_DISPATCH_END && Number.isFinite(ms)) {
      const startMs = openStartMsByStory.get(storyId);
      if (Number.isFinite(startMs) && ms >= startMs) {
        codegenMs += ms - startMs;
        openStartMsByStory.delete(storyId);
      }
    }
  }
  return deriveTokenSplitFromCodegenMs({ codegenMs, totalTokens, wallClockMs });
}

/**
 * Shared proportional-attribution core behind `deriveTokenSplit`: given a
 * raw codegen-window duration (however it was derived — matched Epic-ledger
 * dispatch windows, or a standalone Story's createdAt→closedAt span, Epic
 * #66 Story #77), attribute the session's total tokens across
 * ceremony/codegen buckets in proportion to wall-clock share.
 *
 *   ceremonyMs = wallClockMs − codegenMs               (clamped ≥ 0)
 *   codegenTokens  = round(totalTokens · codegenMs / wallClockMs)
 *   ceremonyTokens = totalTokens − codegenTokens        (buckets always sum to total)
 *
 * @param {object} args
 * @param {number} args.codegenMs      Raw (unclamped) codegen-window duration.
 * @param {number} args.totalTokens    Session total tokens (from envelope).
 * @param {number} args.wallClockMs    Derived run wall-clock.
 * @returns {{
 *   ceremonyTokens: number,
 *   codegenTokens: number,
 *   ceremonyMs: number,
 *   codegenMs: number
 * }}
 */
export function deriveTokenSplitFromCodegenMs({
  codegenMs,
  totalTokens,
  wallClockMs,
}) {
  const total =
    typeof totalTokens === 'number' && totalTokens >= 0
      ? Math.trunc(totalTokens)
      : 0;
  const wall =
    typeof wallClockMs === 'number' && wallClockMs > 0 ? wallClockMs : 0;

  let codegen =
    typeof codegenMs === 'number' && Number.isFinite(codegenMs)
      ? Math.max(0, codegenMs)
      : 0;
  // Codegen time can never exceed the run's wall-clock (overlapping parallel
  // dispatches, or a standalone Story window that outran the session clock,
  // could otherwise sum past it); clamp so the proportion is valid.
  if (wall > 0 && codegen > wall) codegen = wall;
  const ceremonyMs = wall > 0 ? Math.max(0, wall - codegen) : 0;

  let codegenTokens = 0;
  if (total > 0 && wall > 0) {
    codegenTokens = Math.round((total * codegen) / wall);
    if (codegenTokens > total) codegenTokens = total;
  }
  const ceremonyTokens = total - codegenTokens;

  return { ceremonyTokens, codegenTokens, ceremonyMs, codegenMs: codegen };
}

/**
 * Resolve the `modelUsage` map off a parsed envelope, tolerating both the
 * normalized top-level `modelUsage` (from `parseSessionEnvelope` /
 * `aggregateEnvelopes`) and a raw envelope carrying it under `raw.modelUsage`.
 *
 * @param {object} envelope
 * @returns {Record<string, object>|null}
 */
function resolveModelUsage(envelope) {
  if (envelope.modelUsage && typeof envelope.modelUsage === 'object') {
    return envelope.modelUsage;
  }
  if (
    envelope.raw &&
    typeof envelope.raw === 'object' &&
    envelope.raw.modelUsage &&
    typeof envelope.raw.modelUsage === 'object'
  ) {
    return envelope.raw.modelUsage;
  }
  return null;
}

/**
 * Sum the per-model `modelUsage` entries into ONE input/cacheRead/cacheWrite/
 * output split (Ticket #122, item 1). `modelUsage` is the sub-agent-INCLUSIVE
 * usage record: it carries a per-model entry for the parent session AND every
 * sub-agent session, whereas the top-level `usage` envelope reports the parent
 * session only. Field names tolerate both the camelCase envelope shape
 * (`inputTokens`, `cacheReadInputTokens`, …) and a snake_case raw shape.
 *
 * @param {Record<string, object>|null} modelUsage
 * @returns {{
 *   present: boolean,
 *   inputTokens: number,
 *   outputTokens: number,
 *   cacheReadTokens: number,
 *   cacheWriteTokens: number,
 *   total: number
 * }}
 */
function sumModelUsage(modelUsage) {
  const acc = {
    present: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    total: 0,
  };
  if (!modelUsage || typeof modelUsage !== 'object') return acc;
  for (const entry of Object.values(modelUsage)) {
    if (!entry || typeof entry !== 'object') continue;
    acc.present = true;
    acc.inputTokens += nonNeg(entry.inputTokens ?? entry.input_tokens);
    acc.outputTokens += nonNeg(entry.outputTokens ?? entry.output_tokens);
    acc.cacheReadTokens += nonNeg(
      entry.cacheReadInputTokens ?? entry.cache_read_input_tokens,
    );
    acc.cacheWriteTokens += nonNeg(
      entry.cacheCreationInputTokens ?? entry.cache_creation_input_tokens,
    );
  }
  acc.total =
    acc.inputTokens +
    acc.outputTokens +
    acc.cacheReadTokens +
    acc.cacheWriteTokens;
  return acc;
}

/**
 * Extract the usage/cost fields the scorecard needs from a parsed `claude -p`
 * envelope. Accepts either the normalized shape returned by
 * `run-session.js#parseSessionEnvelope` (`{ usage: { totalTokens, … },
 * modelUsage, cost: { totalUsd } }`) or a raw envelope (`{ usage: {
 * input_tokens, … }, modelUsage, total_cost_usd }`), so the normalizer is
 * robust to being handed either.
 *
 * **True vs reported tokens (Ticket #122, item 1).** The top-level `usage`
 * envelope reports the PARENT session's tokens only; a Mandrel Epic run fans
 * out to sub-agents whose tokens land in `modelUsage` and are NEVER in the
 * top-level `usage`, so summing only `usage` undercounts true spend 2–3× while
 * the dollar figure (`total_cost_usd`) is already sub-agent-inclusive — the
 * two columns end up mutually inconsistent. This function therefore records
 * BOTH figures: `reportedTokens` (the top-level `usage` total) and
 * `totalTokens` (the sub-agent-inclusive TRUE total, from `modelUsage` when it
 * is present and at least as large as the reported total). It also persists the
 * input / cacheRead / cacheWrite / output kind split rather than one conflated
 * total, so efficiency scoring never equates a ~$0.65/M cache read with a
 * ~$21.6/M output token. A control cell has no sub-agents, so its single
 * `modelUsage` entry equals the top-level `usage` and `totalTokens ==
 * reportedTokens`. A degenerate/incomplete `modelUsage` (sum < reported) falls
 * back to the reported split so the true figure can never UNDER-count.
 *
 * @param {object} envelope
 * @returns {{
 *   totalTokens: number,
 *   reportedTokens: number,
 *   inputTokens: number,
 *   outputTokens: number,
 *   cacheReadTokens: number,
 *   cacheWriteTokens: number,
 *   costUsd: number|null
 * }}
 */
export function extractUsage(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    return {
      totalTokens: 0,
      reportedTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
    };
  }
  const usage =
    envelope.usage && typeof envelope.usage === 'object' ? envelope.usage : {};

  // Reported split (top-level `usage` — the PARENT session only).
  let reported;
  let totalUsd;
  if (typeof usage.totalTokens === 'number') {
    // Normalized shape (from parseSessionEnvelope).
    reported = {
      inputTokens: nonNeg(usage.inputTokens),
      outputTokens: nonNeg(usage.outputTokens),
      cacheReadTokens: nonNeg(usage.cacheReadInputTokens),
      cacheWriteTokens: nonNeg(usage.cacheCreationInputTokens),
    };
    totalUsd =
      envelope.cost && typeof envelope.cost === 'object'
        ? envelope.cost.totalUsd
        : null;
  } else {
    // Raw `claude -p` envelope shape.
    reported = {
      inputTokens: nonNeg(usage.input_tokens),
      outputTokens: nonNeg(usage.output_tokens),
      cacheReadTokens: nonNeg(usage.cache_read_input_tokens),
      cacheWriteTokens: nonNeg(usage.cache_creation_input_tokens),
    };
    totalUsd =
      typeof envelope.total_cost_usd === 'number'
        ? envelope.total_cost_usd
        : null;
  }
  const reportedTotal =
    reported.inputTokens +
    reported.outputTokens +
    reported.cacheReadTokens +
    reported.cacheWriteTokens;

  // True (sub-agent-inclusive) split from `modelUsage`, when present AND at
  // least as large as the reported total (guards against a degenerate /
  // incomplete modelUsage that would otherwise UNDER-count the true figure).
  const mu = sumModelUsage(resolveModelUsage(envelope));
  const useModelUsage = mu.present && mu.total >= reportedTotal;
  const split = useModelUsage
    ? {
        inputTokens: mu.inputTokens,
        outputTokens: mu.outputTokens,
        cacheReadTokens: mu.cacheReadTokens,
        cacheWriteTokens: mu.cacheWriteTokens,
        total: mu.total,
      }
    : { ...reported, total: reportedTotal };

  return {
    totalTokens: split.total,
    reportedTokens: reportedTotal,
    inputTokens: split.inputTokens,
    outputTokens: split.outputTokens,
    cacheReadTokens: split.cacheReadTokens,
    cacheWriteTokens: split.cacheWriteTokens,
    costUsd: typeof totalUsd === 'number' && totalUsd >= 0 ? totalUsd : null,
  };
}

/**
 * Extract the session wall-clock duration (ms) from a parsed `claude -p`
 * envelope, tolerating the normalized shape (`durationMs`) or the raw envelope
 * (`duration_ms`). Returns 0 when absent. Used as the wall-clock fallback for
 * the control arm, which produces no lifecycle ledger.
 *
 * @param {object} envelope
 * @returns {number}
 */
export function extractDurationMs(envelope) {
  if (!envelope || typeof envelope !== 'object') return 0;
  const d =
    typeof envelope.durationMs === 'number'
      ? envelope.durationMs
      : typeof envelope.duration_ms === 'number'
        ? envelope.duration_ms
        : typeof envelope.raw?.duration_ms === 'number'
          ? envelope.raw.duration_ms
          : 0;
  return Number.isFinite(d) && d >= 0 ? d : 0;
}

/**
 * Coerce to a non-negative integer (0 on miss).
 * @param {unknown} v
 * @returns {number}
 */
function nonNeg(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? Math.trunc(v)
    : 0;
}

/**
 * Resolve WHICH telemetry source a run's value dimensions (planning fidelity,
 * autonomy) are measured from, and the routing-contract verdict that follows
 * from it (Epic #66 audit remediation, H3 — extracted out of `buildScorecard`
 * so the ledger/standalone routing decision has one home).
 *
 * A mandrel-arm run's Epic lifecycle ledger is the canonical source when
 * present; when it is absent (e.g. a trivial scope Mandrel routed through the
 * standalone single-Story path, which emits no Epic-scoped ledger), the
 * recovered standalone GitHub telemetry stands in instead. The control arm
 * has neither source. See `buildScorecard`'s own doc comment for the full
 * standalone-fallback rationale (Story #48) and the routing-contract
 * rationale (Story #76).
 *
 * @param {object} args
 * @param {{ arm: 'mandrel'|'control' }} args.run
 * @param {Array<object>} args.emitted        Emitted lifecycle records.
 * @param {object|null} args.standalone       Standalone-path telemetry, or null.
 * @param {string|null} args.scenarioRouting  The scenario contract's declared
 *   routing (`'story'|'epic'`), or null when undeclared.
 * @param {object} args.planning              The raw plan-vs-actual inputs
 *   (used verbatim when the ledger, not standalone telemetry, is the source).
 * @returns {{
 *   ledgerObserved: boolean,
 *   standaloneObserved: boolean,
 *   valueObserved: boolean,
 *   routingVerdict: 'epic'|'story'|null,
 *   routingMismatch: boolean,
 *   planningInput: object
 * }}
 */
function resolveTelemetrySource({
  run,
  emitted,
  standalone,
  scenarioRouting,
  planning,
}) {
  // Did this run produce a discoverable lifecycle ledger? The mandrel arm's
  // value dimensions (planning fidelity, autonomy) and its token split are
  // derived from that ledger; when it is absent, those signals are
  // UNMEASURED and must score `null` rather than a misleading default. The
  // control arm never has a ledger.
  const ledgerObserved = emitted.length > 0;
  // Standalone fallback (Story #48): when a mandrel-base arm produced no Epic
  // ledger but the run recovered the standalone Story's GitHub telemetry,
  // those signals stand in for the ledger so planning-fidelity + autonomy are
  // MEASURED rather than null. The control-base arms have neither source.
  const standaloneObserved =
    !ledgerObserved && standalone != null && isMandrelArm(run.arm);
  const valueObserved = ledgerObserved || standaloneObserved;
  // The routing Mandrel actually took for this cell — `epic` (ledger found),
  // `story` (standalone telemetry), or null (control / undetermined).
  const routingVerdict = ledgerObserved
    ? 'epic'
    : standaloneObserved
      ? (standalone.routingVerdict ?? 'story')
      : null;
  // Routing contract enforcement (Epic #66, Story #76), ARM-AWARE per Ticket
  // #123: a mandrel-base record whose OBSERVED routing diverges from its
  // EXPECTED routing measured a different pipeline than the one promised, so
  // it is excluded from the cell's noise-band pool downstream. The expected
  // routing is the ARM's forced routing override when it declares one — for
  // `mandrel-story-routed` the forced `story` routing IS the treatment, so a
  // story verdict on an `epic`-contract scenario is exactly what the arm
  // promises (no mismatch), while an arm-4 run that disobeys the override and
  // routes as an Epic is still a mismatch (the treatment failed to apply).
  // Arms with no override keep comparing against the scenario contract
  // unchanged. Both the expected routing and the observed verdict must be
  // known for a comparison to be meaningful — an undetermined verdict (no
  // ledger, no standalone recovery) is never itself treated as a divergence.
  const expectedRouting = routingOverrideForArm(run.arm) ?? scenarioRouting;
  const routingMismatch =
    isMandrelArm(run.arm) &&
    typeof expectedRouting === 'string' &&
    routingVerdict != null &&
    routingVerdict !== expectedRouting;
  const planningInput = standaloneObserved ? standalone.planning : planning;

  return {
    ledgerObserved,
    standaloneObserved,
    valueObserved,
    routingVerdict,
    routingMismatch,
    planningInput,
  };
}

/**
 * Resolve the ceremony/codegen token split for a run (Epic #66 audit
 * remediation, H3 — extracted out of `buildScorecard`'s nested ternary).
 * Three arm/telemetry shapes, in priority order:
 *
 *   1. control arm         — no Mandrel pipeline, so no ceremony: the whole
 *      session is shippable codegen (README: "control arm sits near the
 *      floor"). Attributing it via dispatch windows (which it lacks) would
 *      wrongly bucket the entire run as ceremony.
 *   2. standalone phase-split available — the standalone adapter's
 *      createdAt→closedAt span (Epic #66, Story #77) stands in for the Epic
 *      ledger's matched dispatch windows, giving a story-routed run with
 *      recovered telemetry a REAL ceremony/codegen split.
 *   3. lifecycle-ledger dispatch windows — the default mandrel-arm path.
 *
 * @param {object} args
 * @param {'mandrel'|'control'} args.arm
 * @param {boolean} args.standaloneObserved
 * @param {object|null} args.standalone
 * @param {Array<object>} args.emitted     Emitted lifecycle records.
 * @param {{ totalTokens: number }} args.usage
 * @param {number} args.wallClockMs
 * @returns {{
 *   ceremonyTokens: number,
 *   codegenTokens: number,
 *   ceremonyMs: number,
 *   codegenMs: number
 * }}
 */
function resolveTokenSplit({
  arm,
  standaloneObserved,
  standalone,
  emitted,
  usage,
  wallClockMs,
}) {
  if (isControlArm(arm)) {
    return {
      ceremonyTokens: 0,
      codegenTokens: usage.totalTokens,
      ceremonyMs: 0,
      codegenMs: wallClockMs,
    };
  }

  // Only engages when the adapter could actually parse both timestamps
  // (`phases.codegenMs` is a number); otherwise falls through to the
  // empty-lifecycle `deriveTokenSplit` path (codegenMs 0 ⇒ tokenRatio null),
  // whose absence is what `telemetryAbsent` turns into a loud warning.
  const standalonePhaseSplitAvailable =
    standaloneObserved &&
    standalone?.phases &&
    typeof standalone.phases.codegenMs === 'number' &&
    Number.isFinite(standalone.phases.codegenMs);

  if (standalonePhaseSplitAvailable) {
    return deriveTokenSplitFromCodegenMs({
      codegenMs: standalone.phases.codegenMs,
      totalTokens: usage.totalTokens,
      wallClockMs,
    });
  }

  return deriveTokenSplit({
    lifecycle: emitted,
    totalTokens: usage.totalTokens,
    wallClockMs,
  });
}

/**
 * Build one per-run scorecard record from already-parsed in-memory inputs.
 * This is the pure core — no filesystem access — so it is fully unit-testable.
 *
 * @param {object} args
 * @param {object} args.run             Run identity / stamp.
 * @param {string} args.run.runId
 * @param {string} args.run.timestamp   ISO-8601 run-complete time.
 * @param {{ id: string, displayName?: string }} args.run.model
 * @param {string} args.run.frameworkVersion
 * @param {string} args.run.benchmarkVersion  This benchmark repo's own version
 *   (D-014) — joins the cohort stamp; distinct from the pinned-dependency
 *   `frameworkVersion`.
 * @param {{ node: string, os: string, host?: string }} args.run.env
 * @param {'hello-world'|'story-scope'|'epic-scope'} args.run.scenario
 * @param {'mandrel'|'control'} args.run.arm
 * @param {Array<object>} args.lifecycle   Parsed lifecycle NDJSON records.
 * @param {Array<object>} [args.signals]   Flattened per-Story signal records.
 * @param {object} args.envelope           Parsed `claude -p` usage envelope.
 * @param {object} args.quality            Frozen-suite + judge inputs:
 *   `{ frozenSuitePassed, frozenSuiteTotal, acceptanceEvalScore? }`.
 * @param {object} [args.planning]         Plan-vs-actual inputs:
 *   `{ rePlanCount?, plannedStoryCount?, deliveredStoryCount?,
 *      fileFootprintDrift?|{plannedPaths, actualPaths} }`. Ignored for control.
 * @param {object} [args.maintainabilityInputs]  Static-collector sub-signals +
 *   optional judge cross-check score for the maintainability dimension:
 *   `{ objectiveMaintainabilityScore?, maintainabilityJudgeScore?,
 *      lintWarnings?, complexityScore?, maintainabilityIndex? }`.
 *   When absent the dimension scores 0 (conservative default).
 * @param {object} [args.securityInputs]   Static-collector sub-signals +
 *   optional judge cross-check score for the security dimension:
 *   `{ objectiveSecurityScore?, securityJudgeScore?,
 *      criticalFindings?, highFindings?, secretsDetected? }`.
 *   When absent the dimension scores 0 (conservative default).
 * @param {object} [args.trap]             Multi-class trap-runner verdict
 *   (Epic #66, Story #74 — replaces the single-oracle Story #57 shape):
 *   `{ classes: [{ class, score, defectPresent, evidence? }], cleanRate }`,
 *   the aggregate `bench/scenarios/trap-runner.js` produces. Present only
 *   when the scenario declares at least one trap class (non-empty
 *   `classes[]`); null/absent (or an empty `classes[]`) for every other
 *   scenario. Recorded under `scorecard.trap` as a SEPARATE differential
 *   signal — never folded into the seven composite dimensions.
 * @param {Array<object>} [args.phases]    Per-phase session envelopes for the
 *   mandrel arm's ordered two-session run (D-019, Epic #86 Story #94):
 *   `[{ phase: 'plan'|'deliver', costUsd, tokens, wallClockMs }, …]`. Each
 *   phase's own `claude -p` cost/tokens; the per-phase `costUsd`/`tokens` sum to
 *   the record's `efficiency.costUsd`/`efficiency.totalTokens` by construction
 *   (the run envelope is the sum of the phase envelopes — see
 *   `aggregateEnvelopes` in bench/driver/run-session.js). Attached to the
 *   scorecard as `phases[]` for the mandrel arm only; omitted entirely for the
 *   control arm (single session) and when absent, so control records stay valid
 *   without the block.
 * @param {object} [args.touch2]           Second-touch continuity block
 *   (Epic #86, Story #96): `{ changeRequestId?, inheritance?, outcome, cost,
 *   frozenSuitePassed, frozenSuiteTotal, totalTokens, wallClockMs, dimensions,
 *   regression? }`, the compact scored second touch `bench/run.js#runTouch2`
 *   produces. Present only when the scenario declares a `changeRequest` AND the
 *   second touch was scored; recorded under `scorecard.touch2` as a SEPARATE
 *   block reported apart from touch 1 (a sibling of `trap`/`phases`, never
 *   folded into the seven composite dimensions). Absent for touch-1-only
 *   scenarios (e.g. hello-world).
 * @param {object} [args.planQuality]      Intrinsic PLAN-QUALITY block (Epic
 *   #86, Story #95; D-019 §3.4), the `bench/score/plan-quality.js#computePlanQuality`
 *   result the driver scores off the mandrel arm's plan snapshot: `{ score,
 *   coverage, decompositionSanity, constraintSurfacing, judgeScore,
 *   plannedStoryCount, warnings, detail }`. MANDREL-ONLY — the control arm
 *   authors no plan, so its plan-quality is null and the axis is excluded from
 *   the Mandrel-vs-control differential. Present only when supplied AND the arm
 *   is mandrel; recorded under `scorecard.planQuality` as a SEPARATE block
 *   (a sibling of `trap`/`phases`/`touch2`, never folded into the seven
 *   composite dimensions). This function ALSO stamps `planQuality.attribution`
 *   — the §3.4 decision-table verdict (`computeAttribution`) crossing the plan
 *   score with the delivered OUTCOME (`dimensions.quality.score`) and
 *   plan-adherence (`dimensions.planningFidelity.score`) — so the renderer reads
 *   a stored classification instead of recomputing it. Absent/null ⇒ the block
 *   is omitted, so control + legacy corpora stay valid without it.
 * @param {object} [args.rawRefs]          Provenance breadcrumbs for `rawRefs`.
 * @param {object} [args.standalone]       Standalone-path telemetry (Story #48;
 *   phase-split added Epic #66 Story #77), present only when the mandrel arm
 *   produced no Epic ledger but the run recovered the standalone Story's
 *   GitHub telemetry: `{ planning: {...}, autonomy: {...}, routingVerdict:
 *   'story', phases?: { createdAt, closedAt, prMergedAt, codegenMs } }`. When
 *   present it stands in for the absent ledger so planning-fidelity + autonomy
 *   are measured. When `phases.codegenMs` is also a finite number, it drives a
 *   real ceremony/codegen overhead split (via `deriveTokenSplitFromCodegenMs`)
 *   instead of the permanent null the pre-#77 scope left in place. Null/absent
 *   ⇒ unchanged null behaviour (surfaced as the `standalone-telemetry-absent`
 *   entry in the record's `warnings[]` when the mandrel arm has no ledger and
 *   no recovered standalone telemetry at all).
 * @param {string|null} [args.scenarioRouting]  The scenario contract's
 *   declared routing (`scenario.json`'s `routing: 'story' | 'epic'`, Epic #66
 *   Story #76). Compared against the OBSERVED `routingVerdict`: a mandrel-arm
 *   record whose observed routing diverges from the contract is marked
 *   `routingMismatch: true` (it measured a different pipeline than the
 *   scenario declares — excluded from noise-band pooling downstream by
 *   `bench/report/render.js` `groupCells`). Null/absent (no contract
 *   declared, or the observed verdict could not be determined) ⇒ `false` —
 *   an undetermined comparison is never treated as a divergence.
 * @returns {object} A scorecard record conforming to scorecard.schema.json.
 */
export function buildScorecard({
  run,
  lifecycle = [],
  signals = [],
  envelope,
  quality,
  planning = {},
  maintainabilityInputs = {},
  securityInputs = {},
  trap = null,
  phases = null,
  touch2 = null,
  planQuality = null,
  rawRefs,
  standalone = null,
  scenarioRouting = null,
  deliveryNotMaterialized = false,
  landed = null,
}) {
  if (!run || typeof run !== 'object') {
    throw new TypeError('buildScorecard: run identity is required');
  }
  const required = [
    'runId',
    'timestamp',
    'model',
    'frameworkVersion',
    'benchmarkVersion',
    'env',
    'scenario',
    'arm',
  ];
  for (const key of required) {
    if (run[key] === undefined || run[key] === null) {
      throw new TypeError(`buildScorecard: run.${key} is required`);
    }
  }
  if (!KNOWN_ARMS.includes(run.arm)) {
    throw new TypeError(
      `buildScorecard: run.arm must be one of ${KNOWN_ARMS.join(', ')}, got ${String(run.arm)}`,
    );
  }
  if (!quality || typeof quality !== 'object') {
    throw new TypeError('buildScorecard: quality inputs are required');
  }

  const emitted = emittedRecords(lifecycle);
  const {
    standaloneObserved,
    valueObserved,
    routingVerdict,
    routingMismatch,
    planningInput,
  } = resolveTelemetrySource({
    run,
    emitted,
    standalone,
    scenarioRouting,
    planning,
  });

  // ---- Lifecycle-derived raw sub-signals -------------------------------
  // Wall-clock comes from the lifecycle span when present; the control arm
  // carries no lifecycle ledger, so fall back to the `claude -p` envelope's
  // session duration so its Efficiency is a real number, not 0.
  const lifecycleWallMs = deriveWallClockMs(emitted);
  const wallClockMs =
    lifecycleWallMs > 0 ? lifecycleWallMs : extractDurationMs(envelope);
  const dispatches = deriveDispatchCount(emitted);
  const autonomy = standaloneObserved
    ? standalone.autonomy
    : deriveAutonomyCounters({ lifecycle: emitted, signals });
  const usage = extractUsage(envelope);
  // Overhead token-split (Epic #66, Story #77, target-architecture §8):
  // resolved by `resolveTokenSplit` — control (all-codegen), standalone
  // phase-split (Story #77's createdAt→closedAt span standing in for the
  // Epic ledger's matched dispatch windows), or the default lifecycle-ledger
  // dispatch-window attribution. See that function's doc comment for the
  // full per-branch rationale.
  const split = resolveTokenSplit({
    arm: run.arm,
    standaloneObserved,
    standalone,
    emitted,
    usage,
    wallClockMs,
  });
  // Loud null (§8): the mandrel arm produced NEITHER an Epic ledger NOR
  // recovered standalone telemetry, so planning-fidelity, autonomy, and the
  // overhead split are all genuinely unmeasured — not silently defaulted.
  const telemetryAbsent = isMandrelArm(run.arm) && !valueObserved;
  // Footprint on an Epic-routed run (which threads only story counts, no
  // plan-vs-actual path set) is now DROPPED from the planning-fidelity mean by
  // `computePlanningFidelity` rather than silently defaulting to a perfect 1.0.
  // So the old `planning-footprint-unmeasured-epic-routed` loud-null is
  // obsolete: `dimensions.planningFidelity.footprintDropped` is the honest,
  // self-documenting marker that the term was excluded, not scored as flawless.

  // ---- Dimension math (delegated to the scorer) ------------------------
  const dimensions = computeDimensions({
    // The dimension scorers key arm-conditional logic (the control arm's
    // planning-fidelity null) off the BASE arm, so the Ticket #123 variants
    // score under the identical rules as their base shape.
    arm: baseArm(run.arm),
    quality: {
      // `measured: false` (an unmaterialized mandrel delivery) forces a null
      // quality score, so it must survive the reshape into the scorer input.
      ...(quality.measured === false ? { measured: false } : {}),
      frozenSuitePassed: quality.frozenSuitePassed,
      frozenSuiteTotal: quality.frozenSuiteTotal,
      acceptanceEvalScore:
        isControlArm(run.arm) && quality.acceptanceEvalScore === undefined
          ? null
          : (quality.acceptanceEvalScore ?? null),
    },
    planningFidelity: {
      rePlanCount: planningInput.rePlanCount,
      plannedStoryCount: planningInput.plannedStoryCount,
      deliveredStoryCount: planningInput.deliveredStoryCount,
      fileFootprintDrift: planningInput.fileFootprintDrift,
      plannedPaths: planningInput.plannedPaths,
      actualPaths: planningInput.actualPaths,
      planObserved: valueObserved,
    },
    autonomy: {
      ...autonomy,
      // Autonomy is a MANDREL-arm guardrail measured from the run's own
      // telemetry (Ticket #121, item 2). The control arm's former definitional
      // `observed: true` 1.0 was an unearned baseline — it has no gates that can
      // fail — so it is dropped: the arm is "observed" only when a real
      // telemetry source exists (Epic ledger or recovered standalone telemetry).
      // Control has neither, so its autonomy is null (N/A), not a free 1.0.
      observed: valueObserved,
      // Unattended-landing is a first-class autonomy input now: a mandrel
      // delivery that did not land unattended (landed:false) is a reliability
      // failure that must show up in autonomy, not vanish into a null.
      landed,
    },
    maintainability: {
      // `measured: false` (unmaterialized delivery) forces a null score — must
      // survive the reshape, like the quality input above.
      ...(maintainabilityInputs.measured === false ? { measured: false } : {}),
      objectiveMaintainabilityScore:
        maintainabilityInputs.objectiveMaintainabilityScore ?? null,
      maintainabilityJudgeScore:
        maintainabilityInputs.maintainabilityJudgeScore ?? null,
      lintWarnings: maintainabilityInputs.lintWarnings,
      complexityScore: maintainabilityInputs.complexityScore ?? null,
      maintainabilityIndex: maintainabilityInputs.maintainabilityIndex ?? null,
    },
    security: {
      ...(securityInputs.measured === false ? { measured: false } : {}),
      objectiveSecurityScore: securityInputs.objectiveSecurityScore ?? null,
      securityJudgeScore: securityInputs.securityJudgeScore ?? null,
      criticalFindings: securityInputs.criticalFindings,
      highFindings: securityInputs.highFindings,
      secretsDetected: securityInputs.secretsDetected,
    },
    efficiency: {
      wallClockMs,
      // `totalTokens` is the TRUE (sub-agent-inclusive) figure so the token
      // column matches the sub-agent-inclusive dollar column; `reportedTokens`
      // preserves the top-level `usage` figure, and the kind split
      // (input/cacheRead/cacheWrite/output) is persisted so efficiency scoring
      // never equates cache reads with output tokens (Ticket #122, item 1).
      totalTokens: usage.totalTokens,
      reportedTokens: usage.reportedTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      dispatches,
      costUsd: usage.costUsd,
      // Self-recovered close-validate gate churn (Ticket #121, item 2), moved
      // off the autonomy tally and reported here as a cost signal.
      gateRetries: autonomy.gateRetries,
    },
    overheadRatio: {
      ceremonyTokens: split.ceremonyTokens,
      codegenTokens: split.codegenTokens,
      ceremonyMs: split.ceremonyMs,
      codegenMs: split.codegenMs,
    },
  });

  // Loud nulls (§8): surface the dimension-level warning codes (security /
  // maintainability signal-or-judge absent) plus the record-level telemetry
  // gap at the top of the scorecard, so an operator scanning persisted
  // records sees an explicit marker instead of having to notice a `null`.
  const warnings = [
    ...(dimensions.security.warnings ?? []),
    ...(dimensions.maintainability.warnings ?? []),
    ...(telemetryAbsent ? ['standalone-telemetry-absent'] : []),
    // The mandrel /deliver never landed on origin/main (stalled/blocked Epic or
    // an auto-merge that never completed), so quality was scored `null` rather
    // than a fabricated 0 on the empty seed tree — this is the loud autonomy
    // marker for that (see computeQuality's `measured` path in run.js).
    ...(deliveryNotMaterialized ? ['delivery-not-materialized'] : []),
  ];

  const scorecard = {
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    runId: run.runId,
    timestamp: run.timestamp,
    model:
      typeof run.model === 'string'
        ? { id: run.model }
        : {
            id: run.model.id,
            ...(run.model.displayName
              ? { displayName: run.model.displayName }
              : {}),
          },
    frameworkVersion: run.frameworkVersion,
    benchmarkVersion: run.benchmarkVersion,
    env: {
      node: run.env.node,
      os: run.env.os,
      ...(run.env.host ? { host: run.env.host } : {}),
    },
    scenario: run.scenario,
    arm: run.arm,
    routingVerdict,
    routingMismatch,
    dimensions,
    warnings,
  };

  // Landing datum (Ticket #121, item 1): whether the mandrel delivery LANDED
  // on the default branch (PR merged) — recorded SEPARATELY from whether the
  // delivered tree was scoreable. `true` = merged; `false` = an unlanded
  // PR-head tree was scored instead (a reliability failure that feeds autonomy,
  // NOT a data-destroying null); `null` = not applicable / undetermined
  // (control arm commits directly, so landing is not a concept). Present only
  // as an explicit boolean so control records stay unchanged.
  if (typeof landed === 'boolean') {
    scorecard.landed = landed;
  }

  // Multi-class differential trap signal (Epic #66, Story #74). Present only
  // when the scenario declares at least one trap class; the SEPARATE
  // per-class trap-runner verdict, NOT folded into the seven composite
  // dimensions — it is a differential axis reported on its own. A
  // `null`/absent trap, or one with an empty `classes[]` (every non-trap
  // scenario, or a runner that failed), leaves the block off the scorecard
  // entirely, so the schema keeps it optional and no false delta is
  // introduced.
  if (
    trap &&
    typeof trap === 'object' &&
    Array.isArray(trap.classes) &&
    trap.classes.length > 0
  ) {
    scorecard.trap = {
      classes: trap.classes.map((entry) => ({
        class: entry.class,
        score: entry.score,
        defectPresent: Boolean(entry.defectPresent),
        ...(Array.isArray(entry.evidence) ? { evidence: entry.evidence } : {}),
      })),
      cleanRate: trap.cleanRate,
    };
  }

  // Per-phase session envelopes (D-019, Epic #86 Story #94). Mandrel-arm ONLY:
  // the ordered /plan + /deliver sessions each carry their own cost/tokens/
  // wall-clock, whose costUsd/tokens sum to this record's efficiency totals (the
  // run envelope is their sum). The control arm is a single session, so it
  // carries no `phases` block — and an absent/empty array leaves the block off
  // entirely, keeping control records valid without it.
  if (isMandrelArm(run.arm) && Array.isArray(phases) && phases.length > 0) {
    scorecard.phases = phases.map((p) => ({
      phase: p.phase,
      costUsd:
        typeof p.costUsd === 'number' && Number.isFinite(p.costUsd)
          ? p.costUsd
          : null,
      tokens:
        typeof p.tokens === 'number' &&
        Number.isFinite(p.tokens) &&
        p.tokens >= 0
          ? Math.trunc(p.tokens)
          : 0,
      wallClockMs:
        typeof p.wallClockMs === 'number' &&
        Number.isFinite(p.wallClockMs) &&
        p.wallClockMs >= 0
          ? p.wallClockMs
          : 0,
    }));
  }

  // Second-touch continuity block (Epic #86, Story #96). Present only when the
  // scenario declared a `changeRequest` AND the driver scored the second touch;
  // reported SEPARATELY from touch 1 (a sibling of `trap`/`phases` at the
  // scorecard's top level, never folded into the seven composite dimensions).
  // The continuity delta (mandrel touch-2 outcome/cost − control) is derived
  // downstream by bench/score/differential.js from `touch2.outcome` /
  // `touch2.cost`. An absent/malformed touch2 leaves the block off entirely, so
  // touch-1-only scenarios (hello-world) stay valid without it.
  if (
    touch2 &&
    typeof touch2 === 'object' &&
    touch2.dimensions &&
    typeof touch2.dimensions === 'object'
  ) {
    scorecard.touch2 = {
      ...(typeof touch2.changeRequestId === 'string'
        ? { changeRequestId: touch2.changeRequestId }
        : {}),
      ...(typeof touch2.inheritance === 'string'
        ? { inheritance: touch2.inheritance }
        : {}),
      ...(typeof touch2.materialized === 'boolean'
        ? { materialized: touch2.materialized }
        : {}),
      outcome:
        typeof touch2.outcome === 'number' && Number.isFinite(touch2.outcome)
          ? touch2.outcome
          : null,
      cost:
        typeof touch2.cost === 'number' && Number.isFinite(touch2.cost)
          ? touch2.cost
          : null,
      frozenSuitePassed:
        typeof touch2.frozenSuitePassed === 'number'
          ? Math.trunc(touch2.frozenSuitePassed)
          : 0,
      frozenSuiteTotal:
        typeof touch2.frozenSuiteTotal === 'number'
          ? Math.trunc(touch2.frozenSuiteTotal)
          : 0,
      totalTokens:
        typeof touch2.totalTokens === 'number'
          ? Math.trunc(touch2.totalTokens)
          : 0,
      wallClockMs:
        typeof touch2.wallClockMs === 'number' &&
        Number.isFinite(touch2.wallClockMs)
          ? touch2.wallClockMs
          : 0,
      dimensions: touch2.dimensions,
      ...(touch2.regression &&
      Array.isArray(touch2.regression.classes) &&
      touch2.regression.classes.length > 0
        ? {
            regression: {
              classes: touch2.regression.classes.map((entry) => ({
                class: entry.class,
                score: entry.score,
                defectPresent: Boolean(entry.defectPresent),
                ...(Array.isArray(entry.evidence)
                  ? { evidence: entry.evidence }
                  : {}),
              })),
              cleanRate: touch2.regression.cleanRate,
            },
          }
        : {}),
    };
  }

  // Intrinsic PLAN-QUALITY axis (Epic #86, Story #95; D-019 §3.4). MANDREL-arm
  // ONLY: the plan the /plan session authored, scored against the scenario's
  // frozen spec — recorded as a SEPARATE block (a sibling of trap/phases/touch2,
  // never folded into the seven composite dimensions). We ALSO stamp the §3.4
  // attribution decision-table verdict here, crossing the plan score with the
  // delivered OUTCOME (`dimensions.quality.score`) and plan-adherence
  // (`dimensions.planningFidelity.score`) THIS function just computed, so the
  // renderer honours a stored classification instead of recomputing it. A
  // null/absent planQuality, or the control arm, leaves the block off entirely.
  if (
    isMandrelArm(run.arm) &&
    planQuality &&
    typeof planQuality === 'object' &&
    typeof planQuality.score === 'number'
  ) {
    const attribution = computeAttribution({
      planQualityScore: planQuality.score,
      outcomeScore: dimensions.quality?.score ?? null,
      planAdherenceScore: dimensions.planningFidelity?.score ?? null,
    });
    // Drop the scorer's internal `detail` spine breakdown — the persisted
    // planQualityBlock schema (additionalProperties:false) enumerates only the
    // headline sub-scores + attribution, not the intermediate detail object.
    const { detail: _detail, ...persisted } = planQuality;
    scorecard.planQuality = { ...persisted, attribution };
  }

  if (rawRefs && typeof rawRefs === 'object') {
    scorecard.rawRefs = rawRefs;
  }

  return scorecard;
}

/**
 * Filesystem shell over `buildScorecard`: read the lifecycle NDJSON, the
 * per-Story signals NDJSON files, and the `claude -p` envelope JSON from disk,
 * then assemble the scorecard. The Quality and planning inputs are passed
 * in-memory by the caller (they come from the frozen-suite/judge run and the
 * decomposer output, not from a single artifact file on disk).
 *
 * @param {object} args
 * @param {object} args.run                 Run identity (see buildScorecard).
 * @param {string} args.lifecyclePath       Path to lifecycle.ndjson.
 * @param {string[]} [args.signalsPaths]    Paths to per-Story signals.ndjson.
 * @param {string} args.costEnvelopePath    Path to the captured envelope JSON.
 * @param {object} args.quality             Quality inputs.
 * @param {object} [args.planning]          Plan-vs-actual inputs.
 * @param {object} [args.maintainabilityInputs]  Maintainability collector inputs.
 * @param {object} [args.securityInputs]    Security collector inputs.
 * @param {object} [args.rawRefs]           Provenance overrides; when omitted,
 *   the supplied paths are recorded.
 * @param {object} [deps]
 * @param {(p: string, enc: string) => string} [deps.readFileImpl]  Injectable
 *   reader (tests).
 * @returns {object} A scorecard record.
 */
export function normalizeRunFromPaths(
  {
    run,
    lifecyclePath,
    signalsPaths = [],
    costEnvelopePath,
    quality,
    planning = {},
    maintainabilityInputs = {},
    securityInputs = {},
    rawRefs,
  },
  deps = {},
) {
  const read = deps.readFileImpl ?? readFileSync;

  if (typeof lifecyclePath !== 'string' || lifecyclePath.length === 0) {
    throw new TypeError('normalizeRunFromPaths: lifecyclePath is required');
  }
  if (typeof costEnvelopePath !== 'string' || costEnvelopePath.length === 0) {
    throw new TypeError('normalizeRunFromPaths: costEnvelopePath is required');
  }

  const lifecycle = parseNdjson(read(lifecyclePath, 'utf8'));

  const signals = [];
  for (const p of signalsPaths) {
    const recs = parseNdjson(read(p, 'utf8'));
    for (const r of recs) signals.push(r);
  }

  const envelope = JSON.parse(read(costEnvelopePath, 'utf8'));

  const resolvedRawRefs = rawRefs ?? {
    lifecycleNdjson: lifecyclePath,
    ...(signalsPaths.length > 0 ? { signalsNdjson: [...signalsPaths] } : {}),
    costEnvelope: costEnvelopePath,
  };

  return buildScorecard({
    run,
    lifecycle,
    signals,
    envelope,
    quality,
    planning,
    maintainabilityInputs,
    securityInputs,
    rawRefs: resolvedRawRefs,
  });
}
