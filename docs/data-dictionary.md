# Data Dictionary

> The authoritative field-level reference for the persisted scorecard record.
> The full JSON Schema contract lives at
> [`../bench/schemas/scorecard.schema.json`](../bench/schemas/scorecard.schema.json)
> (draft 2020-12); this document is the human-readable companion — every field
> named here matches that schema exactly. A worked example is at
> [`../bench/fixtures/sample-scorecard.json`](../bench/fixtures/sample-scorecard.json).
> Formulas for the seven composite dimensions live in
> [`../bench/metrics/README.md`](../bench/metrics/README.md).

## Scope

One scorecard record represents ONE `(scenario × arm × run)` cell. Records
are append-only NDJSON under `results/<model-slug>/<frameworkVersion>/
scorecards.ndjson` (one per line), validated against the schema on emit.

## Top-level identity fields

| Field | Type | Description |
| --- | --- | --- |
| `schemaVersion` | integer (const `1`) | Scorecard-record schema version. Bumped on any breaking shape change (hard cutover, no dual-read). |
| `runId` | string | Unique id for this `(scenario × arm × run)`. |
| `timestamp` | string (RFC 3339) | Run-complete time. |
| `model.id` | string | Exact pinned model id from the `claude -p` envelope. |
| `frameworkVersion` | string | The `mandrel` version under test — the `version` of the pinned `mandrel` dependency (`node_modules/mandrel/package.json`), read by `bench/run.js#readFrameworkVersion`. |
| `benchmarkVersion` | string | The benchmark harness version this record was produced under — THIS repo's own `version` (the `mandrel-bench` `package.json`, read by `bench/run.js#readBenchmarkVersion`), NOT the pinned `mandrel` dependency version `frameworkVersion` records. Joins the cohort key (D-014) — see [The triple cohort key](#the-triple-cohort-key-d-014) below. |
| `env.node` / `env.os` | string | Execution environment stamp — part of the cohort key (see below). |
| `scenario` | enum | `hello-world` \| `story-scope` \| `epic-scope` — the Epic #66 3-rung corpus (see `docs/architecture.md` § 6). |
| `arm` | enum | `mandrel` \| `control`. |

## The triple cohort key (D-014)

A **cohort** is the unit of statistical comparison — the harness only ever
pools, bands, and diffs records that match on the full stamp. Per D-014
(`docs/target-architecture.md` § 3.1) that stamp is the triple:

```text
cohort = (model, frameworkVersion, benchmarkVersion)   [+ env guard]
```

`benchmarkVersion` **joins** the existing `(model, frameworkVersion, env)`
stamp rather than replacing any part of it — the `env` guard is retained. The
benchmark is itself a variable: scoring formulas, scenario specs, and oracles
all live in this repo, so a benchmark change can move numbers with no framework
or model change at all, and must be held constant within a comparison.

**Consumption.**

- `bench/report/persist.js`'s `cohortKey()` concatenates
  `model | frameworkVersion | benchmarkVersion | env.node | env.os`; every
  persisted record must carry a non-empty `benchmarkVersion` (enforced by the
  `REQUIRED_STAMP` guard and the schema's top-level `required`).
- `bench/report/render.js`'s `deriveCohort()` reports the distinct
  `benchmarkVersions` and flags a `mixed` corpus; `groupCells()` refuses to
  pool a scenario cell whose records span more than one benchmark version —
  it emits **no noise-band** for that cell and labels it **non-inferential**
  (a delta there would confound a benchmark-repo change with a framework/model
  signal).
- `bench/report/compare.js`'s `compareRuns()` annotates which single cohort
  key changed between two runs, or flags the comparison **confounded** when
  more than one changed.
- `bench/report/html.js`'s trend view keys each cohort point on the full stamp
  including `benchmarkVersion`, so records from different benchmark versions
  never collapse into one trend point.

The on-disk layout stays `results/<model-slug>/<frameworkVersion>/` (no
migration); cohort membership is resolved by filtering records on the full
triple, not by the directory tree.

## `routingVerdict` and `routingMismatch` (Epic #66, Story #76)

Every scenario declares a `routing` contract on its `scenario.json`
(`"story"` or `"epic"`) — the delivery route the harness EXPECTS the mandrel
arm to take for that scenario. These two scorecard fields record what was
actually OBSERVED and whether it diverged:

| Field | Type | Description |
| --- | --- | --- |
| `routingVerdict` | `"epic"` \| `"story"` \| `null` | The delivery route Mandrel actually took, observed at collect time: `"epic"` when an Epic lifecycle ledger was found, `"story"` when the standalone single-Story path was recovered from GitHub telemetry (no Epic ledger), or `null` for the control arm / an undetermined mandrel-arm run. |
| `routingMismatch` | boolean (default `false`) | `true` when a mandrel-arm run's OBSERVED `routingVerdict` diverges from the scenario contract's DECLARED `routing`. Such a record measured a different pipeline than the scenario promises. |

**Consumption.** `bench/report/render.js`'s `groupCells` excludes every
`routingMismatch: true` record from the cell's `mandrelRuns` noise-band pool
(they land in `mismatchedRuns` instead) and computes the cell's
`mismatchRate` = `mismatchedRuns.length / (mandrelRuns.length +
mismatchedRuns.length)`. A rate exceeding 25% is flagged (`mismatchFlag:
true`) and rendered as an explicit scope-triage calibration finding — not
silently absorbed into the pool as noise.

## `trap` block (Epic #66, Story #74)

A SEPARATE differential signal, deliberately never folded into the seven
composite `dimensions`. Present only when the scenario declares at least one
trap class (`story-scope`, `epic-scope`); absent (no `trap` key) for every
other scenario, including `hello-world`.

```json
"trap": {
  "classes": [
    { "class": "plaintext-password", "score": 1, "defectPresent": false, "evidence": ["..."] }
  ],
  "cleanRate": 1
}
```

| Field | Type | Description |
| --- | --- | --- |
| `trap.classes` | array (min 1) | One entry per declared trap class this run was scored against. |
| `trap.classes[].class` | string | The planted defect class (e.g. `plaintext-password`, `token-generation`, `idor`, `missing-input-validation`, `hardcoded-secret`). |
| `trap.classes[].score` | number `[0,1]` | `1` = clean (defect absent), `0` = defect present. Higher is better, matching the polarity of every value-side dimension. |
| `trap.classes[].defectPresent` | boolean | `true` ⇒ the delivered code took the planted defect-class shortcut. |
| `trap.classes[].evidence` | string[] (optional) | Human-readable justification lines. Never echoes a captured password or secret value — derived signals only. |
| `trap.cleanRate` | number `[0,1]` | Mean of the run's per-class `score` values. |

**Provenance.** Each declared class has a dedicated oracle module
(`bench/scenarios/<id>/traps/<class>.js`, exporting `evaluate(deliveredTreePath)`)
that source-scans the delivered tree — SEPARATE from the frozen behavioural
suite, which both arms can pass identically while one silently ships the
vulnerable shortcut. Both arms are scanned with the identical oracle, so the
comparison is fair. Oracles live only in this repo (`bench/scenarios/**`,
never overlaid into the sandbox — the #58 git-exclude discipline), and every
oracle ships a discrimination unit test over hand-crafted clean/vulnerable
sample trees (`tests/bench/scenarios/<id>/`).

**Consumption.** `bench/report/render.js`'s `trapAxisRows` /
`renderTrapAxisSection` and `bench/report/html.js`'s trap-axis panel render
per-class scores plus `cleanRate` as distributions — mean, spread
(noise-band width), and worst-case (min) — per arm, in a section clearly
separate from the seven-dimension table.

## `phases[]` block (D-019, Epic #86 Story #94)

Per-phase `claude -p` session envelopes for the **mandrel arm's ordered
two-session run**. Under D-019 (which amends D-008) the mandrel arm no longer
runs as one session: it runs `/plan` (session 1) and then `/deliver`
(session 2) as **separate** headless sessions, each with its own
cost/tokens/wall-clock, so a finding can be attributed to the planning half vs
the delivery half rather than to "Mandrel" at large. The **control arm stays a
single session** and carries **no** `phases` block — a control record is valid
without it.

```json
"phases": [
  { "phase": "plan",    "costUsd": 0.40, "tokens": 40000,  "wallClockMs": 120000 },
  { "phase": "deliver", "costUsd": 1.10, "tokens": 140000, "wallClockMs": 480000 }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `phases` | array (min 1) | Mandrel-arm only. One entry per pipeline phase, in order (`plan`, then `deliver`). Absent for the control arm and for any record with no per-phase split. |
| `phases[].phase` | `"plan"` \| `"deliver"` | Which pipeline phase this session drove. |
| `phases[].costUsd` | number \| `null` | USD cost of this phase's session, or `null` when the envelope reported none. |
| `phases[].tokens` | integer `≥ 0` | Total tokens (input + output + cache) for this phase's session. |
| `phases[].wallClockMs` | number `≥ 0` | This phase session's own `claude -p` duration. Distinct from the record's ledger-derived `dimensions.efficiency.wallClockMs`. |

**Sum invariant.** The run envelope is the SUM of the phase envelopes
(`bench/driver/run-session.js#aggregateEnvelopes`), so the per-phase `costUsd`
and `tokens` sum to `dimensions.efficiency.costUsd` and
`dimensions.efficiency.totalTokens` by construction. (Per-phase `wallClockMs`
is the envelope session duration; the record's `efficiency.wallClockMs` remains
ledger-derived, so those are NOT required to match.)

**Between-session seam (id-discovery + plan snapshot).** After session 1 exits,
`bench/run.js` (via `runSession`'s injected `betweenPhases` hook) recovers the
id(s) the plan session created on the ephemeral repo — the **Epic id** for
epic-routed scenarios (`discoverPlannedEpicId`, the newest `type::epic` created
at/after the run start) or the **standalone Story id** for story-routed ones
(`discoverStandaloneStory` conventions) — over the **sanitized `gh`
environment** (`sanitizeGitHubTokenEnv`, no new credential surface). The
discovered id is threaded into the deliver-session prompt so `/deliver` enters
at the artifact the plan session produced.

## `touch2` block (Epic #86, Story #96)

The **second-touch continuity** block — a SEPARATE top-level scorecard block (a
sibling of `dimensions`, like `trap`/`phases`), never folded into the seven
composite `dimensions`. Present only when the scenario declares a frozen
`changeRequest` in its `scenario.json` (`story-scope`, `epic-scope`) AND the
second touch was scored; absent (no `touch2` key) for `hello-world`, which
declares no change request (the driver skips its second touch).

After touch 1 is scored, `bench/run.js#runTouch2` runs the change request as a
**fresh session against the delivered tree**, with **arm-appropriate
inheritance** (`bench/run.js#prepareTouch2Workspace`): the mandrel arm keeps its
FULL pipeline output (the `.agents/` overlay + tickets/plan state) in place; the
control workspace is reduced to DELIVERED CODE ONLY (a fresh copy with
framework/session artifacts stripped). The second touch is scored with the full
dimension set, its own frozen behavioural suite (`acceptance.touch2.test.js`),
and the phase-scoped regression oracles.

```json
"touch2": {
  "changeRequestId": "password-change",
  "inheritance": "full-pipeline",
  "outcome": 0.9,
  "cost": 0.21,
  "frozenSuitePassed": 4,
  "frozenSuiteTotal": 4,
  "totalTokens": 5000,
  "wallClockMs": 12000,
  "dimensions": { "quality": { "score": 0.9, "frozenSuitePassRate": 1 }, "...": "the full seven-dimension set" },
  "regression": {
    "classes": [{ "class": "regression-hashing", "score": 1, "defectPresent": false }],
    "cleanRate": 1
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `touch2.changeRequestId` | string (optional) | Stable id of the frozen change request (`scenario.json` `changeRequest.id`, e.g. `password-change`, `project-sharing`). |
| `touch2.inheritance` | `"full-pipeline"` \| `"delivered-code-only"` | Arm-appropriate inheritance the second touch ran under: full pipeline (mandrel) or delivered code only (control). |
| `touch2.outcome` | number `[0,1]` \| `null` | Continuity OUTCOME scalar — the second touch's composite quality (`touch2.dimensions.quality.score`). |
| `touch2.cost` | number \| `null` | Continuity COST scalar in USD — the second touch's session cost (`touch2.dimensions.efficiency.costUsd`), or `null` when the envelope reported none. |
| `touch2.frozenSuitePassed` / `frozenSuiteTotal` | integer `≥ 0` | Passing / total frozen touch-2-suite assertions. |
| `touch2.totalTokens` | integer `≥ 0` | Total tokens for the second-touch session. |
| `touch2.wallClockMs` | number `≥ 0` | The second-touch session's wall-clock duration. |
| `touch2.dimensions` | object | The FULL seven-dimension set scored for the second touch — the same shape as touch 1's `dimensions`. |
| `touch2.regression` | object (optional) | The phase-scoped regression verdict (same shape as `trap`), present only when the scenario declares `traps-touch2/` oracles. |

**Phase-scoped regression oracles.** The regression oracles live under a
DEDICATED `bench/scenarios/<id>/traps-touch2/` directory — DISJOINT from the
touch-1 `traps/` directory — and are discovered ONLY by the touch-2 scan
(`bench/scenarios/trap-runner.js#runTrapOracles` with `trapsSubdir:
'traps-touch2'`). This separation is load-bearing: the touch-1 trap scan globs
`traps/` only, so the touch-1 `cleanRate` is provably unaffected by the presence
of touch-2 oracles. The regression classes are *hashing preservation*
(`story-scope`) and *per-user isolation preservation* (`epic-scope`), each with
a discrimination unit test over hand-crafted clean/vulnerable samples. Their
behavioural counterparts (session invalidation; role-based access) are asserted
by the frozen touch-2 suite over HTTP, NOT by a source scan.

**Consumption.** `bench/score/differential.js#computeContinuityDelta` derives
the **continuity delta** — mandrel `touch2.outcome`/`touch2.cost` minus control
— using the same noise-band + real-delta machinery as the dimension differential.
`bench/report/render.js#renderContinuitySection` and `bench/report/html.js`'s
continuity panel render it as its own section (positive outcome delta / negative
cost delta favours Mandrel).

### Plan snapshot layout — `.raw/<run-stamp>/plan/`

Before the deliver session starts, `snapshotPlanArtifacts` freezes the plan
artifacts into the run's provenance directory, so delivery can never
retroactively alter what the plan is scored on. `<run-stamp>` is the same
`<scenario>-<arm>-r<runIndex>` key used for the cost envelope, under the
cohort's `.raw/`.

| Path | Contents |
| --- | --- |
| `.raw/<run-stamp>/plan/epic-<n>.json` | The Epic body (`number`, `title`, `body` incl. the folded tech-spec sections, `labels`) — epic-routed runs only. |
| `.raw/<run-stamp>/plan/story-<n>.json` | Each child Story body (with its inline `acceptance[]` / `verify[]`) for epic-routed runs; the single standalone Story body for story-routed runs. |
| `.raw/<run-stamp>/plan/manifest.json` | `{ routing, epicId, storyNumber, storyNumbers[], capturedAt }` — the routing verdict and the captured ids. |

**Consumption.** `bench/report/render.js`'s `phaseCostRows` /
`renderPhaseCostSection` and `bench/report/html.js`'s per-phase cost panel
render the mandrel arm's `/plan` vs `/deliver` cost per scenario; the control
arm carries no per-phase split, so it is omitted by construction.

## `planQuality` block (Epic #86, Story #95)

The intrinsic PLAN-QUALITY axis — a **top-level** scorecard block (a sibling of
`dimensions`, like `trap`), scored by `bench/score/plan-quality.js` against the
frozen plan snapshot above. It scores the pre-delivery plan the mandrel arm's
`/plan` session produced so a bad OUTCOME can be attributed to the **plan
phase** vs the **deliver phase** (D-019 §3.4), rather than lumped into one
opaque quality number.

**Mandrel-only.** The control arm authors no plan, so `planQuality` is `null`
(or absent) for control records — and, exactly like `planningFidelity` and
`autonomy`, the axis is **deliberately excluded** from the Mandrel-vs-control
differential (`SCALAR_DIMENSIONS` in `bench/score/differential.js`): diffing a
measured mandrel plan against a non-existent control plan is not a meaningful
comparison, so the differential table **never** carries a plan-quality delta
row.

**Composite.** `score = 0.7 · spine + 0.3 · judge`, folding the judge weight
into the spine when the judge is `null` (the same two-oracle convention as
`computeMaintainability` / `computeSecurity`). The spine is the mean of the
three deterministic sub-scores that were measured (a `null` sub-score folds out
of the mean):

| Field | Type | Description |
| --- | --- | --- |
| `planQuality.score` | number `[0,1]` | Composite plan quality. Spine 0.7 + judge 0.3 (judge folds into spine when null). |
| `planQuality.coverage` | number `[0,1]` \| `null` | Fraction of the scenario's FROZEN acceptance criteria (`seed.acceptance`) traceable to a Story AC in the plan snapshot. |
| `planQuality.decompositionSanity` | number `[0,1]` \| `null` | Story count/sizing vs the scenario's machine-readable `storyCountContract` (epic-scope 4-6 Stories; the story-routed rungs a single standalone Story). `null` when no contract was supplied. |
| `planQuality.constraintSurfacing` | number `[0,1]` \| `null` | Fraction of the security-baseline obligations the scenario's trap classes probe that are surfaced in the plan artifacts. `1` for a scenario with no trap obligations (e.g. hello-world). |
| `planQuality.judgeScore` | number `[0,1]` \| `null` | LLM-judge cross-check score, or `null` when the judge did not run (the 0.3 weight then folds into the spine). |
| `planQuality.plannedStoryCount` | integer `≥ 0` | Number of Stories the plan snapshot recorded. |
| `planQuality.warnings` | string[] | Loud-null markers: `plan-quality-decomposition-contract-absent`, `plan-quality-judge-absent`. |
| `planQuality.attribution.classification` | enum \| `null` | The D-019 §3.4 attribution verdict (see below), or `null` when plan quality or outcome was unmeasured. |
| `planQuality.attribution.planGood` / `outcomeGood` / `adhered` | boolean \| `null` | The three threshold crossings (default `0.7`) the classification is derived from. |

**Attribution decision table** (`computeAttribution`, computed per run and
rendered by `render.js`'s `renderAttributionSection`). Crossing the intrinsic
plan quality with the delivered OUTCOME (`dimensions.quality.score`) and
plan-adherence (`dimensions.planningFidelity.score`) is the **Goodhart
backstop** — a plan that games the deterministic spine cannot read as
`working-as-intended` without a matching outcome:

| Outcome | Plan | Adherence | → Classification |
| --- | --- | --- | --- |
| good | good | — | `working-as-intended` |
| good | weak | — | `model-compensating` (good outcome despite a weak plan) |
| weak | good | adhered | `plan-phase-gap` (a good-looking plan was followed yet still failed) |
| weak | good | diverged | `deliver-phase-gap` (delivery diverged from a good plan) |
| weak | weak | — | `plan-phase-gap` |

**Decomposition contract** — each `scenario.json` carries a machine-readable
`storyCountContract` (`{ mode, minStories, maxStories }`), asserted in
`tests/bench/scenarios/scenario-defs.test.js`: `epic-scope` →
`{ mode: "epic", minStories: 4, maxStories: 6 }`; `story-scope` and
`hello-world` → `{ mode: "standalone", minStories: 1, maxStories: 1 }`. This is
the sole source for decomposition sanity — never prose.

## `dimensions.autonomy.guardrail` (Epic #66, Story #77)

```json
"dimensions": {
  "autonomy": {
    "score": 1,
    "hitlStops": 0,
    "blockedEvents": 0,
    "manualRescues": 0,
    "guardrail": { "threshold": 0.99, "met": true }
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `dimensions.autonomy.guardrail.threshold` | number `[0,1]` | Cohort guardrail threshold the score is compared against (default `0.99`). |
| `dimensions.autonomy.guardrail.met` | boolean \| `null` | `true` when `score ≥ threshold`, `false` when below, `null` when the score itself is unmeasured (an undetermined guardrail is never reported as pass or fail). |

Autonomy is reported as this pass/fail guardrail, never as a
Mandrel-vs-control delta (`bench/score/differential.js`'s `SCALAR_DIMENSIONS`
deliberately excludes it) — the bare control arm's zero-intervention baseline
is defined by construction, not measured, so a delta against it was never a
meaningful comparison.

## `warnings` (Epic #66, Story #77 — "loud nulls")

| Field | Type | Description |
| --- | --- | --- |
| `warnings` | string[] | Record-level operator-visible markers, e.g. `standalone-telemetry-absent` (mandrel arm produced neither an Epic ledger nor recovered standalone telemetry — planning fidelity, autonomy, and the overhead split are all genuinely unmeasured). Dimension-level equivalents (`security-signal-absent`, `security-judge-absent`, `maintainability-signal-absent`, `maintainability-judge-absent`) live on `dimensions.security.warnings` / `dimensions.maintainability.warnings`. |

## `rawRefs`

Provenance breadcrumbs (workspace-relative paths) to the on-disk artifacts a
scorecard was derived from — `lifecycleNdjson`, `signalsNdjson[]`,
`costEnvelope`, `acceptanceEvalVerdict` — for traceability and re-scoring,
even though the ephemeral workspace is torn down after each run. The mandrel
arm's plan snapshot (`.raw/<run-stamp>/plan/`, see the `phases[]` section
above) lives alongside these under the same `.raw/<run-stamp>/` directory.

## Finding envelope (Epic #85, Story #91)

The feedback slice ([`../bench/feedback/derive.js`](../bench/feedback/derive.js))
derives DETERMINISTIC, evidence-carrying **findings** from a results corpus and
writes them beside the cohort report as a machine-readable envelope
(`reports/findings-<stamp>.json`) plus a Markdown section for the results-PR
body. It is signal-gated: a finding class with no signal in the corpus derives
ZERO findings — there are no placeholder or always-on findings.

### Envelope shape

| Field | Type | Description |
| --- | --- | --- |
| `schemaVersion` | integer (`1`) | Finding-envelope schema version. |
| `generatedAt` | string \| null | Injected ISO timestamp the envelope was produced at (null when not supplied — the derivation itself is clock-free). |
| `cohort` | object | The target D-014 cohort triple: `{ model, frameworkVersion, benchmarkVersion }`. |
| `previousComparableCohort` | object \| null | The baseline triple the regression class compared against (same `model` + `benchmarkVersion`, immediately-prior `frameworkVersion`), or null when no prior framework version is on record. |
| `method` | `iqr` \| `ci` | Noise-band method used for every band-derived verdict. |
| `counts` | object | Per-class finding counts keyed by the four class names. |
| `findings` | object[] | The derived findings (see below), in stable class + scenario order. |

### Finding shape

| Field | Type | Description |
| --- | --- | --- |
| `fingerprint` | string | Stable 16-hex-char identity (see below). |
| `class` | string | One of `regression`, `standing-cost`, `trap-differential`, `pipeline-calibration`. |
| `scenario` | string \| null | Scenario id, or null for a cross-scenario finding (e.g. difficulty monotonicity). |
| `subject` | string | The specific dimension / metric / trap-defect-class / pipeline signal the finding is about (e.g. `quality`, `overhead-floor`, `plaintext-password`, `routing-mismatch`). |
| `summary` | string | Human-readable one-line description. |
| `cohort` | object | The cohort triple this finding was observed in (mirrors the envelope's `cohort`). |
| `evidence` | object | Class-specific evidence, always including the noise-band terms behind the verdict (centers, `shift`/`delta`, `noiseFloor`, clean-rates, etc.). |
| `links` | object | `{ report, scorecards }` — results-root-relative paths to the cohort report and the cohort scorecard store. |

### The four finding classes

| Class | Signal (gate) | Source |
| --- | --- | --- |
| `regression` | A metric that REGRESSED vs the previous comparable cohort (real-delta rule). | `bench/report/compare.js` over the self-resolved prior-`frameworkVersion` baseline. |
| `standing-cost` | The fixed framework taxes: overhead floor (ceremony with no quality gain), a real above-noise overhead ratio, and difficulty-monotonicity violations. | `bench/score/differential.js`. |
| `trap-differential` | A planted defect class the mandrel arm did not keep clean (per `trap.classes[]` mean clean-rate `< 1`); the control clean-rate travels as evidence. | The scorecard `trap` block. |
| `pipeline-calibration` | `routingMismatch` rate `> 25%` per cell, an unmet autonomy `guardrail.met === false`, or a `standalone-telemetry-absent` warning. | `groupCells` + the `dimensions.autonomy.guardrail` / `warnings` fields. |

### Fingerprint format

The fingerprint is the truncated SHA-1 identity of a finding —
`sha1(class ␟ scenario ␟ subject)` (the three identity fields joined by the
`U+001F` unit-separator), rendered as the first **16 hex characters** (64 bits)
of the digest. A null `scenario` collapses to an empty positional field.

Crucially, the fingerprint **excludes the cohort triple**
(`model` / `frameworkVersion` / `benchmarkVersion`). That is the whole point:
the same finding observed under two different cohorts hashes to the SAME
fingerprint, so recurring findings collide across cohorts into a time-series
rather than reading as a fresh issue every run. The cohort triple still travels
on the finding (and envelope), it is simply not part of the identity key.
Derivation is deterministic, so deriving twice from one corpus yields
byte-identical fingerprints. Contract:
[`../bench/feedback/fingerprint.js`](../bench/feedback/fingerprint.js).
