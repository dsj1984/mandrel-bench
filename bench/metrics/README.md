# Mandrel Self-Benchmark — Metrics Model

> **Internal tooling.** Everything under `bench/` is development tooling, like
> `tests/` and `docs/`. It is **never** shipped in the distributed `.agents/`
> bundle and **never** runs against the live `mandrel` repo — all churn lands
> in a dedicated sandbox repo on ephemeral clones (Epic
> [#4211](https://github.com/dsj1984/mandrel/issues/4211), Story
> [#4215](https://github.com/dsj1984/mandrel/issues/4215)).

This document is the **measurement contract** the whole harness conforms to.
It defines, with explicit reproducible formulas:

1. The **seven dimensions** — five on the value side (what scaffolding
   _buys_) and two on the cost side (what it _charges_).
2. The **variance / noise-band method** — how every dimension is reported as a
   distribution across N runs, and the rule for when a Mandrel-vs-control delta
   is called _real_.
3. Two **cross-scenario derived metrics** — the difficulty-monotonicity check
   and the overhead-floor estimate — that are computed by comparing scenarios,
   not scored per run.

The scorecard JSON contract is
[`../schemas/scorecard.schema.json`](../schemas/scorecard.schema.json); a
worked example is [`../fixtures/sample-scorecard.json`](../fixtures/sample-scorecard.json).
The noise-band is implemented in [`variance.js`](./variance.js).

---

## Design principles (binding)

- **No single composite score.** We report the value/cost frontier; we never
  collapse the five dimensions into one scalar that would get gamed
  (Goodhart's law — see Epic #4211 Non-Goals). Each dimension stands alone.
- **Every score is a distribution, never a point.** Each `(scenario × arm)`
  cell runs at **N≈8–10**. A dimension's headline number is always reported
  with its noise-band; a bare point estimate is a reporting bug.
- **Apples-to-apples by construction.** Both arms — the **Mandrel arm**
  (clone carries `.agents/`, runs `/plan`→`/deliver`) and the **control arm**
  (no scaffolding, bare task prompt) — are driven by the same `claude -p
  --output-format json` launcher and costed by the same usage envelope. The
  overhead ratio is therefore a like-for-like comparison, not an estimate.
- **Like model to like.** Every scorecard is stamped with the exact pinned
  model id, framework version, and environment. A cross-version comparison
  only ever compares cells with the same `(model, frameworkVersion, env)`.
- **Reproducible formulas only.** Every dimension below reduces to a
  deterministic function of recorded inputs (lifecycle NDJSON fields, the
  `claude -p` envelope, frozen-suite results, the acceptance-eval verdict). No
  formula depends on a wall-clock read at scoring time, a random draw, or an
  un-recorded judgment.

### Inputs (recorded per run)

| Input                  | Source                                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| Timings, dispatches    | `temp/epic-<id>/lifecycle.ndjson` (append-only NDJSON)                 |
| Autonomy events        | `lifecycle.ndjson` (`agent::blocked`, HITL stops) + per-Story `signals.ndjson` |
| Cost (tokens, USD)     | `claude -p --output-format json` usage/cost envelope                   |
| Quality (objective)    | Scenario's **frozen acceptance suite** (deterministic HTTP/Playwright) |
| Quality (cross-check)  | `acceptance-eval.js` LLM-judge verdict                                 |
| Plan vs. actual        | Decomposer output (planned Stories / `changes[]`) vs. delivered Stories / touched files |

All inputs are persisted onto the scorecard's `rawRefs` for traceability, even
though the ephemeral workspace is torn down after each run.

---

## The seven dimensions

Each formula yields a value in a stated range. Per-run values land on the
scorecard under `dimensions.<name>`; the distribution and band are computed
across the N per-run values by the scoring slice (see
[§ Variance](#variance--noise-band-method)).

### 1. Quality — _is the output correct & on-intent?_ (value side)

The objective spine is the scenario's **frozen acceptance suite** — a fixed
set of deterministic assertions (HTTP status/body, Playwright steps) run
against the delivered app. The LLM-judge (`acceptance-eval.js`) is a
**cross-check**, never the spine, so Quality cannot be gamed by persuading the
judge.

```text
frozenSuitePassRate = frozenSuitePassed / frozenSuiteTotal           ∈ [0, 1]

quality.score =
    w_suite · frozenSuitePassRate  +  w_judge · acceptanceEvalScore
  with w_suite = 0.7, w_judge = 0.3, and w_judge folded into w_suite
  (renormalized to w_suite = 1.0) when acceptanceEvalScore is null
                                                                     ∈ [0, 1]
```

- The frozen suite is **frozen**: its assertions are authored once per
  scenario and never edited to match a particular run's output.
- `acceptanceEvalScore` is the fraction of acceptance criteria the judge marks
  satisfied. It is `null` for the control arm when no acceptance criteria were
  authored; the weight then collapses entirely onto the frozen suite.
- A run that fails to deliver a runnable app scores `frozenSuitePassRate = 0`
  (every assertion fails), i.e. `quality.score = 0` — not "no data".

### 2. Planning fidelity — _did the plan match reality?_ (value side)

Measures how well the authored plan predicted the delivered work. Three
recorded sub-signals combine into a `[0, 1]` score; **`null` for the control
arm** (it authors no plan).

```text
storyAccuracy   = 1 − |plannedStoryCount − deliveredStoryCount|
                       / max(plannedStoryCount, deliveredStoryCount, 1)   ∈ [0, 1]

rePlanPenalty   = 1 / (1 + rePlanCount)                                   ∈ (0, 1]

footprintAccuracy = 1 − fileFootprintDrift                                ∈ [0, 1]
  where fileFootprintDrift = Jaccard distance between the planned changes[]
  path set P and the actually-touched path set A:
    fileFootprintDrift = 1 − |P ∩ A| / |P ∪ A|         (0 when both empty)

planningFidelity.score =
    (storyAccuracy + rePlanPenalty + footprintAccuracy) / 3               ∈ [0, 1]
```

- `rePlanCount` counts decomposition-revision / re-plan events observed during
  the run (a high count means the plan needed reshaping mid-flight).
- `fileFootprintDrift` is the symmetric set distance; recall that under the
  Engineer persona's _logged-deviation_ latitude, `changes[]` is an advisory
  sketch — so modest drift is expected and only a large drift dents fidelity.

### 3. Autonomy — _how little human intervention?_ (value side)

How close the run came to fully unattended. Counts every point a human had to
step in. The harness's whole make-or-break risk is that the pipeline runs
**unattended**, so this is the dimension that proves it.

```text
interventions = hitlStops + blockedEvents + manualRescues

autonomy.score = 1 / (1 + interventions)                                  ∈ (0, 1]
```

- `autonomy.score = 1.0` ⇒ zero interventions: the run completed end-to-end
  with no human in the loop.
- `hitlStops` — STOP gates the run actually halted at (one-pager confirm, spec
  review, decomposition diff gate, the auto-merge-else-operator-merge step).
  In a correctly-configured unattended run these auto-proceed and the count is
  0; any non-zero value is a finding.
- `blockedEvents` — `agent::blocked` transitions in `lifecycle.ndjson`.
- `manualRescues` — operator interventions that unblocked or restarted the run.

**Reclassified as a guardrail (Epic #66, Story #77).** The formula above is
unchanged, but autonomy is no longer reported as a Mandrel-vs-control DELTA
(`SCALAR_DIMENSIONS` in `bench/score/differential.js` excludes it). The bare
control arm's "autonomy" is a defined baseline (1.0, zero interventions by
construction — it authors no plan and hits no HITL gate), not a measurement,
so diffing it against Mandrel's measured score was never a meaningful
comparison. Instead the record carries `dimensions.autonomy.guardrail =
{ threshold, met }`: a pass/fail verdict against a fixed cohort threshold
(default 0.99). A drop below threshold is itself a finding, surfaced in its
own report section (`renderAutonomyGuardrailSection`,
`autonomyGuardrailFindings`) rather than folded into the per-dimension delta
table.

### 4. Maintainability — _how readable and low-complexity is the output?_ (value side)

Added in Epic #32. Same two-oracle shape as Quality: an objective spine
(static-analysis signals, weighted 0.7) cross-checked by an LLM judge (0.3),
with the judge weight folded into the spine when the cross-check is null.

```text
lintScore            = 1 − clamp(lintWarnings / LINT_WARN_FLOOR, 0, 1)
                                                                     ∈ [0, 1]
spineScore =
    objectiveMaintainabilityScore                                    ∈ [0, 1]
  — or, when the pre-computed spine is absent, the mean of whichever
    sub-signals are non-null: { complexityScore, maintainabilityIndex }

maintainability.score =
    w_spine · spineScore  +  w_judge · maintainabilityJudgeScore
  with w_spine = 0.7, w_judge = 0.3, and w_judge folded into w_spine
  (renormalized to w_spine = 1.0) when maintainabilityJudgeScore is null
                                                                     ∈ [0, 1]
```

Sub-signals recorded for provenance:

| Sub-signal               | Source                                               |
| ------------------------ | ---------------------------------------------------- |
| `lintWarnings`           | Biome (or project linter) warning count              |
| `complexityScore`        | Normalised cyclomatic complexity in [0,1], 1 = least complex |
| `maintainabilityIndex`   | Normalised maintainability index in [0,1], 1 = most maintainable |
| `maintainabilityJudgeScore` | LLM judge cross-check against the engineer/refactorer rubric |

- The judge rubric is the mandrel `engineer` + `refactorer` persona baselines
  (the legitimate "what good looks like" for Mandrel's own output).
- A run that ships no analyzable output scores `spineScore = 0`.
- `null` sub-signals are excluded from the spine mean; if all are `null` the
  spine is 0.

### 5. Security — _how free of vulnerabilities is the output?_ (value side)

Added in Epic #32. Same two-oracle shape: objective spine (scanner signals,
weighted 0.7) plus judge cross-check (0.3); judge weight folds into spine
when null.

```text
spineScore = objectiveSecurityScore                                  ∈ [0, 1]
  — defaults to 0 when not supplied (conservative: no scan data → lowest score)

security.score =
    w_spine · spineScore  +  w_judge · securityJudgeScore
  with w_spine = 0.7, w_judge = 0.3, and w_judge folded into w_spine
  (renormalized to w_spine = 1.0) when securityJudgeScore is null
                                                                     ∈ [0, 1]
```

Sub-signals recorded for provenance:

| Sub-signal           | Source                                                     |
| -------------------- | ---------------------------------------------------------- |
| `criticalFindings`   | Critical-severity findings from the security scanner       |
| `highFindings`       | High-severity findings from the scanner                    |
| `secretsDetected`    | Boolean — true iff a secret/credential was found in output |
| `securityJudgeScore` | LLM judge cross-check against the `security-baseline.md` MUSTs |

- The judge rubric is `security-baseline.md` (edge input-validation, password
  hashing, `httpOnly` token storage, server-side ownership/authorization, auth
  rate-limiting). This is the inviolable baseline Mandrel enforces by default —
  the bare control is most likely to miss it on auth-bearing scenarios.
- `secretsDetected = true` is a hard signal; the spine incorporates it via the
  pre-computed `objectiveSecurityScore` (computed by `bench/collect/security.js`
  before the scorer runs).
- Both new dimension judge cross-checks share **one batched judge call per run**
  to keep latency and cost contained.

### 6. Efficiency — _what did it cost absolutely?_ (cost side)

Absolute cost as a **vector**, never collapsed to one number. The three
components are reported independently (each gets its own distribution + band):

```text
efficiency.wallClockMs  = run end − run start, from lifecycle.ndjson    (ms, ≥ 0)
efficiency.totalTokens  = Σ (inputTokens + outputTokens) over the
                          claude -p usage envelope                      (≥ 0)
efficiency.dispatches   = count of Story sub-agent launches in
                          lifecycle.ndjson                              (≥ 0)
efficiency.costUsd      = total USD from the envelope when reported,
                          else null
```

- Tokens and USD come **only** from the `claude -p` envelope — Mandrel records
  no token actuals of its own (`epic-deliver-preflight.js` merely _estimates_).
  Measuring both arms from the same envelope is what makes the comparison
  honest.
- GitHub round-trip latency is intentionally **inside** `wallClockMs` — it is
  part of Mandrel's real overhead.

### 7. Overhead ratio — _ceremony tax vs. shippable output?_ (cost side)

The framework's _tax_: how much ceremony (planning, decomposition,
orchestration, gate machinery) it spends per unit of shippable codegen.

```text
overheadRatio.tokenRatio = ceremonyTokens / codegenTokens               (≥ 0)
overheadRatio.timeRatio  = ceremonyMs    / codegenMs   (null if unavailable)
```

- **Token attribution.** `codegenTokens` are the tokens spent inside the
  Story-implementation phases that produce shippable artifacts (the
  delivery sub-agents' edit/commit work). `ceremonyTokens` are everything
  else in the session: `/plan` authoring (PRD, Tech Spec, decomposition),
  orchestration overhead, and the gate/close machinery. The split is derived
  from the lifecycle phase boundaries; `ceremonyTokens + codegenTokens` equals
  `efficiency.totalTokens`.
- A `tokenRatio` of `4.0` means four tokens of ceremony per token of shippable
  output. For the **control arm** there is effectively no ceremony, so its
  ratio sits near the floor (~0) — the gap between the arms _is_ the tax.
- This dimension is the most direct lever for the "ceremony-lite path for
  trivial scopes" recommendation when `hello-world` shows a high ratio with no
  quality gain.

---

## Variance / noise-band method

Every dimension above is reported as a **distribution** across the N≈8–10
per-run values, summarized by a **noise-band**. The band is the spread a
Mandrel-vs-control delta must clear before we call it real. The canonical
implementation is [`variance.js`](./variance.js); this section is its
specification.

`noiseBand(values, { method })` accepts an array of per-run values for one
dimension (non-finite entries — a run that produced no value — are filtered
out first) and returns:

```text
{ method, n, center, low, high, spread, detail }
```

Two methods, both robust for tiny samples:

### `iqr` — median + inter-quartile range (default)

```text
center = median(values)
Q1     = 25th percentile          (linear-interpolation / type-7 estimator)
Q3     = 75th percentile
IQR    = Q3 − Q1
low    = max(min(values), Q1 − 1.5·IQR)      (Tukey inner fence, clamped)
high   = min(max(values), Q3 + 1.5·IQR)      (Tukey inner fence, clamped)
spread = high − low
```

The default. Resistant to the heavy-tailed outliers an agent run produces (one
stalled 40-minute wall-clock run must not blow out the band). Fences are
clamped to the observed range so the band never claims an unobserved value.

### `ci` — mean + 95% confidence interval of the mean

```text
center = mean(values)
sd     = sample standard deviation (Bessel-corrected, n − 1 denominator)
sem    = sd / √n
margin = t₀.₉₇₅(n − 1) · sem        (Student's t critical value, df = n − 1)
low    = mean − margin
high   = mean + margin
spread = 2 · margin
```

A parametric band on the **mean**, for roughly-symmetric dimensions. The
Student's _t_ critical value (not the normal 1.96) is used because the samples
are tiny — at df ≈ 7–9 the difference is material.

### Real-delta rule (consumed by the scoring slice)

A Mandrel-vs-control difference on a dimension is only reported as **real** when
the absolute difference of the two arms' band centers exceeds the larger of the
two arms' `spread`:

```text
deltaIsReal = |centerMandrel − centerControl| > max(spreadMandrel, spreadControl)
```

Otherwise the delta is **within noise** and reported as "no significant
difference." This module produces the bands; the comparison itself lives in the
scoring slice.

---

## Cross-scenario derived metrics

These two relationships are computed by **comparing scenarios** and reported as
calibration guardrails plus framework findings — they are **not** scored
per-run dimensions and never appear on a single scorecard. The Epic #66
3-rung matrix (`hello-world`, `story-scope`, `epic-scope`) is the full ladder:
three rungs is exactly the minimum the difficulty-monotonicity check (D-010)
needs, so both the monotonicity check and the floor estimate run on every
cohort.

### A. Difficulty monotonicity (calibration guardrail)

As scenario difficulty rises along the ladder, two things **must** hold for the
Mandrel arm:

- **Efficiency rises** — absolute cost / time / dispatches increase
  (`hello-world` < `story-scope` < `epic-scope`). Harder work costs more in
  absolute terms.
- **Overhead ratio falls** — ceremony amortizes over more shippable output as
  the task grows, so `overheadRatio.tokenRatio` _decreases_ down the ladder
  (`hello-world` > `story-scope` > `epic-scope`).

Formally, over the difficulty-ordered scenario list `s₁ … s_k` (easy → hard),
comparing the band centers:

```text
monotonicityHolds =
      center(efficiency.totalTokens, sᵢ)   < center(efficiency.totalTokens, sᵢ₊₁)
  AND center(overheadRatio.tokenRatio, sᵢ) > center(overheadRatio.tokenRatio, sᵢ₊₁)
  for every adjacent pair (sᵢ, sᵢ₊₁)
```

A **violation is a calibration warning**, not a silent pass: it means either
the instrument is insensitive or a scenario is mis-graded for difficulty. The
report surfaces the violation explicitly rather than trusting the numbers.

### B. Overhead floor (framework finding)

The fixed ceremony tax Mandrel pays on **near-zero work** — the most direct
"is the scaffolding worth it for trivial scopes?" signal. Estimated from the
`hello-world` rung as the cost the Mandrel arm pays _above_ the control arm:

```text
overheadFloorTokens = center(efficiency.totalTokens, hello-world, mandrel)
                     − center(efficiency.totalTokens, hello-world, control)

overheadFloorUsd    = center(efficiency.costUsd,     hello-world, mandrel)
                     − center(efficiency.costUsd,     hello-world, control)
```

- Computed on the **band centers** so it inherits the distribution method, and
  reported with its own band derived from the per-run differences.
- A large floor with **no** corresponding `quality.score` gain on `hello-world`
  is the canonical evidence feeding the report's **Recommended improvements**
  section (e.g. _"hello-world overhead ratio is 4.2× with no quality gain →
  consider a ceremony-lite path for trivial scopes"_).
- It is a **floor**, not the full curve: characterizing whether ceremony is a
  flat fixed cost or scales with task size needs at least three ladder rungs —
  satisfied by the Epic #66 matrix below.

---

## Scenario ladder and difficulty rungs (Epic #66 3-rung matrix, D-015)

The harness runs dimensions across a difficulty-ordered scenario ladder. Each
rung is a scenario tagged with a `difficulty` integer, a `rung` label, a
`routing` contract (`"story"` or `"epic"` — the delivery route the scenario
is expected to take), and a `targetN`:

| Rung label   | Difficulty | Scenario       | Routing | targetN | Purpose                                                         |
| ------------ | ---------- | -------------- | ------- | ------- | ---------------------------------------------------------------- |
| `floor`      | 1          | `hello-world`  | story   | 4       | Instrumentation only — overhead floor + pipeline smoke test. **Never a value-delta rung**; reported under the floor/calibration framing (Epic #66, Story #76). |
| `story-scope`| 3          | `story-scope`  | story   | 8       | Persisted-auth API with per-user notes — the story-routed value rung; traps `plaintext-password` + `token-generation`. |
| `epic-scope` | 5          | `epic-scope`   | epic    | 8       | Multi-user project/task management API sized to decompose into 4–6 Stories — the epic-routed value rung; traps `plaintext-password`, `idor`, `missing-input-validation`, `hardcoded-secret`. |

The prior two-scenario ladder (plus the single-defect spike scenario it grew
alongside) was retired in full when this matrix landed (Epic #66, Story #79):
`story-scope` absorbs that spike's frozen suite + plaintext-password oracle
as its foundation, and `epic-scope` evolves the retired largest-difficulty
rung's multi-resource API surface. The prior `results/` corpus was deleted
rather than migrated — the schema changed (`trap`, `routingMismatch`) in a
way that needs no back-compat shim (operator-authorized fresh longitudinal
start, 2026-07-09).

**Routing contract enforcement (Story #76).** Each scenario's `routing`
declares the delivery route the harness EXPECTS the mandrel arm to take. The
OBSERVED `routingVerdict` (from the lifecycle ledger or the standalone-Story
telemetry adapter) is compared against it at collect time; a divergent record
is marked `routingMismatch: true` and excluded from the cell's noise-band pool
(`bench/report/render.js` `groupCells`), with the per-cell mismatch rate
surfaced explicitly — a rate above 25% is itself a scope-triage calibration
finding, not noise the harness papers over.

The difficulty-monotonicity check (D-010) requires ≥ 3 rungs; this matrix
satisfies that condition exactly, with no deferred fourth rung.

---

## Trap axis — differential, adversarial signal (Epic #66, Story #74/#79)

Separate from the seven composite dimensions above, `story-scope` and
`epic-scope` each declare one or more **trap classes** — planted defects a
dedicated oracle module (`bench/scenarios/<id>/traps/<class>.js`) source-scans
the delivered tree for. The frozen acceptance suite is deliberately BLIND to
every trap class: both arms can pass the exact same behavioural suite while
one silently ships the vulnerable shortcut, which is precisely the signal the
seven dimensions (Quality in particular) cannot see.

Each declared oracle runs against BOTH arms' delivered trees identically and
emits `{ class, score: 0|1, defectPresent, evidence[] }`; the aggregate lands
on the scorecard as:

```json
"trap": {
  "classes": [ { "class": "plaintext-password", "score": 1, "defectPresent": false } ],
  "cleanRate": 0.5
}
```

- `score` — 1 = clean (defect absent), 0 = defect present. Higher is better,
  matching the polarity of every other value-side dimension.
- `cleanRate` — the mean of the run's per-class scores.
- Present only when the scenario declares at least one trap class; absent
  (no `trap` key at all) for a non-trap scenario, so the schema keeps it
  optional and no false delta is introduced.

**Never folded into the seven dimensions.** The trap axis is reported as its
OWN section — per-class scores and `cleanRate` as distributions with mean,
spread, and worst-case (min) per arm (`bench/report/render.js`
`renderTrapAxisSection`, `bench/report/html.js`'s trap-axis panel) — never
mixed into the Quality/Security tables above. Folding it in would let a
planted-defect regression hide behind an unrelated composite gain, exactly
the Goodhart failure mode § "Design principles" rules out for the seven
dimensions; the trap axis gets the same protection by staying structurally
separate.

- Trap-class oracles and their defect descriptions live ONLY in this repo
  (`bench/scenarios/**`), never overlaid into the sandbox — the #58
  git-exclude overlay discipline is the enforced boundary. Scenario prompts
  stay terse with no trap hints, so the headroom the trap needs is never
  destroyed by an accidental spoiler in the seed text.
- Every declared oracle ships a discrimination unit test over hand-crafted
  clean/vulnerable sample trees (`tests/bench/scenarios/<id>/`), proving the
  oracle actually discriminates rather than trivially passing everything.

---

## Why these and not a composite

The split — five value dimensions, two cost dimensions, reported as
distributions with an explicit real-delta rule — is deliberate. Collapsing them
into one number would let a regression on one axis hide behind a gain on
another, and would invite gaming the scalar. The harness's job is to show the
**value/cost frontier at a fixed model**, so a human can decide whether
Mandrel still earns its tax at the current frontier — not to declare a single
winner.
