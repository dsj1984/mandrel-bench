# mandrel-bench — Architecture

> **Scope.** This is the *technical* architecture (how the harness is built and
> how data flows). For the *product* framing — problem, dimensions, scope, and
> non-goals — see [`mandrel-self-benchmark.md`](mandrel-self-benchmark.md), the
> originating design one-pager. Decisions and their rationale are logged in
> [`decisions.md`](decisions.md).

## 1. What it is

mandrel-bench is a **consumer of the [Mandrel](https://github.com/dsj1984/mandrel)
framework**, not part of it. It pins a *published* `mandrel` version
(`dependencies.mandrel` in `package.json` — the version under test),
materializes it via `mandrel sync`, then drives Mandrel's own
`/plan`→`/deliver` pipeline (and a bare-model control) over a scenario corpus,
scores each run across five dimensions, and tracks the framework's **value-add
over the bare-model baseline** across versions and models.

The dependency is **one-directional**: `mandrel-bench` depends on `mandrel`;
`mandrel` never depends on `mandrel-bench`.

## 2. Run model

The unit of work is one **run** = one headless Claude Code session driving one
**arm** over one **scenario**. For each `(scenario × arm × run)`:

```text
provision → run → collect → score → report → teardown
```

1. **provision** (`bench/driver/sandbox.js`) — `git clone` an ephemeral,
   shallow throwaway workspace under the OS temp dir. For the **control** arm
   the materialized `.agents/` bundle is stripped so the bare model receives no
   scaffolding.
2. **run** (`bench/driver/run-session.js`) — shell out to
   `claude -p --output-format json` (injectable `invokeFn` for tests). The
   **mandrel** arm prompt drives `/plan` then `/deliver` (real authoring — never
   pre-staged) with an unattended auto-proceed preamble; the **control** arm
   gets the bare task. The JSON result envelope carries the real
   `usage`/`total_cost_usd` actuals.
3. **collect** (`bench/collect/normalize.js`) — read the run's lifecycle
   telemetry (`temp/epic-<id>/lifecycle.ndjson` + per-Story `signals.ndjson`,
   written by `/deliver`) plus the `claude -p` cost envelope into a single
   per-run record conforming to `bench/schemas/scorecard.schema.json`.
4. **score** (`bench/score/`) — `dimensions.js` computes the five dimensions
   per the `bench/metrics/README.md` formulas; `differential.js` computes the
   Mandrel-vs-control delta (with the real-delta rule from
   `bench/metrics/variance.js`) plus the two cross-scenario derived metrics.
5. **report & persist** (`bench/report/`) — `render.js` emits the value-add
   report; `persist.js` appends the stamped scorecard to the longitudinal store
   under `results/`; `compare.js` surfaces cross-run deltas.
6. **teardown** (`bench/driver/sandbox.js`) — recursively remove the ephemeral
   workspace, gated by an `assertInsideRoot` containment check so removal can
   never escape the throwaway root.

## 3. The two arms

| Arm | Prompt | `.agents/` | Purpose |
| --- | --- | --- | --- |
| **mandrel** | drive `/plan`→`/deliver` (auto-proceed under headless drive) | present (materialized) | the framework under test |
| **control** | the bare task, no scaffolding | stripped | the baseline; value-add is `mandrel − control` |

Both arms are launched by the same driver and costed by the same `claude -p`
envelope, so the overhead comparison is apples-to-apples by construction.

## 4. Dimensions & derived metrics

Five per-run dimensions, split value vs. cost (full formulas in
`bench/metrics/README.md`):

| Side | Dimension | Signal |
| --- | --- | --- |
| Value | Quality | frozen acceptance suite + `acceptance-eval` cross-check |
| Value | Planning fidelity | decomposition accuracy, re-plan, plan-vs-actual drift |
| Value | Autonomy | HITL stops, `agent::blocked`, manual rescues |
| Cost | Efficiency | wall-clock, tokens, dispatches |
| Cost | Overhead ratio | ceremony ÷ codegen (tokens & time) |

**Variance is the reporting method**, not a sixth dimension: every score is a
distribution across N runs with a computed **noise-band**; a delta is "real"
only when it clears the band.

**Cross-scenario derived metrics** (relationships, not per-run scores): the
**difficulty-monotonicity** check (Efficiency ↑ / Overhead ratio ↓ across the
ladder; a violation is a calibration warning) and the **overhead-floor**
estimate (hello-world Mandrel cost − control — the fixed ceremony tax on
near-zero work).

## 5. Data models

- **Scorecard** (`bench/schemas/scorecard.schema.json`, draft 2020-12) — the
  per-run record: `{ runId, timestamp, model, frameworkVersion, env, scenario,
  arm, dimensions{…}, … }`. Validated on emit.
- **Longitudinal store** (`results/`) — an append-only, committed record of
  every scorecard, stamped with model + framework-version + env. This is the
  "track over time" substrate; `compare.js` reads it for cross-run deltas.
- **Cost source** — the `claude -p` envelope only. Mandrel records no token
  actuals (its preflight is estimate-only), so the session envelope is the
  single, identical cost instrument for both arms.

## 6. Scenario corpus

`bench/scenarios/` holds the corpus. Each scenario ships:

- a `scenario.json` task seed shared by both arms,
- a **frozen** `acceptance.test.js` oracle — a pure `evaluate(baseUrl)` that
  probes only user-visible behavior and imports nothing from the delivered app,
- wiring through `bench/scenarios/acceptance-eval-adapter.js`, which lifts the
  frozen result into a schema-valid verdict and runs the materialized
  `acceptance-eval` cross-check.

v1 corpus: `hello-world` (the overhead floor + smoke) and `crud-db` (exercises
decomposition, multi-wave delivery, planning fidelity, autonomy at depth).

## 7. Security

- **Sandbox containment** — teardown is gated by `assertInsideRoot`, which
  rejects any path that is not a proper descendant of the ephemeral root
  (`..`, absolute re-root, root-itself), and refuses non-directory/symlink
  targets. A malformed handle can never escalate into deleting a real repo.
- **No shell injection** — `git` and `claude` are invoked via `execFileSync` /
  `spawnSync` with argument arrays (never a shell string on POSIX); the clone
  uses a `--` separator before the repo URL.
- **Secrets** — the sandbox token is environment-sourced and never logged; the
  collector logs token *counts*, never values.

## 8. Version-under-test model

The harness is held **fixed** while the framework varies. To benchmark a new
Mandrel version: bump `dependencies.mandrel` in `package.json`, re-run
`npm install && npx mandrel sync`, re-run the benchmark. New scorecards append
to `results/` stamped with that version, and `compare.js` surfaces the deltas.
This is why the benchmark is a *separate* repo (see
[`decisions.md`](decisions.md), D-002): co-locating it with the framework
source would confound harness-version with framework-version.

## 9. Tech stack

| Area | Choice |
| --- | --- |
| Language | JavaScript (ESM), Node `>=22.22.1 <25` |
| Tests | `node:test` (the repo is non-BDD) |
| Lint / format | Biome + markdownlint |
| Hooks | Husky + lint-staged + commitlint |
| Versioning | release-please (version + changelog; not published to npm) |
| CI | GitHub Actions (lint + test) |
| Framework under test | `mandrel` (pinned npm dependency) |
