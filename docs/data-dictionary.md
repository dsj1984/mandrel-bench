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
even though the ephemeral workspace is torn down after each run.

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
