# mandrel-bench — Architecture

> **Scope.** This is the *technical* architecture (how the harness is built and
> how data flows). For the *product* framing — problem, dimensions, scope, and
> non-goals — see the [README](../README.md). Decisions and their rationale are
> logged in [`decisions.md`](decisions.md).

## 1. What it is

mandrel-bench is a **consumer of the [Mandrel](https://github.com/dsj1984/mandrel)
framework**, not part of it. It pins a *published* `mandrel` version
(`dependencies.mandrel` in `package.json` — the version under test),
materializes it via `mandrel sync`, then drives Mandrel's own
`/plan`→`/deliver` pipeline (and a bare-model control) over a scenario corpus,
scores each run across seven dimensions, and tracks the framework's **value-add
over the bare-model baseline** across versions and models.

The dependency is **one-directional**: `mandrel-bench` depends on `mandrel`;
`mandrel` never depends on `mandrel-bench`.

## 2. Run model

The unit of work is one **run** = one **arm** driven over one **scenario**. The
**control** arm is a single headless Claude Code session; the **mandrel** arm is
an *ordered set of two phase-scoped sessions* (`/plan`, then `/deliver`) whose
per-phase cost envelopes sum to the run total (D-019). On rungs 2–3 both arms
then take a **second touch** — a fresh session running the scenario's frozen
change request against the delivered tree (D-020). For each `(scenario × arm ×
run)`:

```text
provision → run → collect → score → report → teardown
```

1. **provision** (`bench/driver/sandbox.js`) — create a private, ephemeral
   **per-cell** GitHub repo (`gh repo create <BENCH_SANDBOX_OWNER>/bench-sbx-<cohort>-<scenario>-<arm>-<nonce> --private`,
   reserved `bench-sbx-` prefix), seed it from `bench/sandbox-template/`
   (plus an optional per-scenario overlay at `bench/scenarios/<id>/sandbox/`)
   as the baseline commit, then `git clone` a shallow throwaway workspace of
   it under the OS temp dir. Between the cell's serial runs, `main` is
   force-reset to the recorded baseline SHA. For the **control** arm the
   materialized `.agents/` bundle is stripped so the bare model receives no
   scaffolding.
2. **run** (`bench/driver/run-session.js`) — shell out to
   `claude -p --output-format json` (injectable `invokeFn` for tests). The
   **mandrel** arm runs as **two phase-scoped sessions** (D-019): session 1
   drives `/plan`, session 2 drives `/deliver` (real authoring — never
   pre-staged) with an unattended auto-proceed preamble, each carrying its own
   cost envelope. Between them the harness snapshots the authored plan (Epic +
   Story bodies) to `.raw/<runId>/plan/` and scores it as an intrinsic,
   mandrel-only **plan-quality** axis for plan-vs-deliver attribution. The
   **control** arm is a single session that gets the bare task. Each JSON result
   envelope carries the real `usage`/`total_cost_usd` actuals.
3. **collect** (`bench/collect/normalize.js`) — read the run's lifecycle
   telemetry (`temp/epic-<id>/lifecycle.ndjson` + per-Story `signals.ndjson`,
   written by `/deliver`) plus the `claude -p` cost envelope into a single
   per-run record conforming to `bench/schemas/scorecard.schema.json`.
4. **score** (`bench/score/`) — `dimensions.js` computes the seven dimensions
   per the `bench/metrics/README.md` formulas; `differential.js` computes the
   Mandrel-vs-control delta (with the real-delta rule from
   `bench/metrics/variance.js`) plus the two cross-scenario derived metrics.
5. **report & persist** (`bench/report/`) — `render.js` emits the value-add
   report; `persist.js` appends the stamped scorecard to the longitudinal store
   under `results/`; `compare.js` surfaces cross-run deltas.
6. **teardown** (`bench/driver/sandbox.js`) — recursively remove the ephemeral
   local workspace, gated by an `assertInsideRoot` containment check so
   removal can never escape the throwaway root, then `gh repo delete --yes`
   the cell's per-cell repo (best-effort on every failure path — a failed
   delete logs and defers to the janitor rather than failing the cell). Any
   repo a crash leaks behind is swept by `bench/driver/janitor.js`, which
   deletes repos under `BENCH_SANDBOX_OWNER` matching the reserved
   `bench-sbx-` prefix older than a TTL (default 24h); it runs at the start
   of every `bench/run.js` invocation and as a standalone script.

## 3. The two arms

| Arm | Prompt | `.agents/` | Purpose |
| --- | --- | --- | --- |
| **mandrel** | drive `/plan`→`/deliver` (auto-proceed under headless drive) | present (materialized) | the framework under test |
| **control** | the bare task, no scaffolding | stripped | the baseline; value-add is `mandrel − control` |

Both arms are launched by the same driver and costed by the same `claude -p`
envelope, so the overhead comparison is apples-to-apples by construction.

## 4. Dimensions & derived metrics

Seven per-run dimensions, split value vs. cost (full formulas in
`bench/metrics/README.md`):

| Side | Dimension | Signal |
| --- | --- | --- |
| Value | Quality | frozen acceptance suite + `acceptance-eval` cross-check |
| Value | Planning fidelity | decomposition accuracy, re-plan, plan-vs-actual drift (proportional to declared plan size — Epic #66, Story #77) |
| Value | Maintainability | static-analysis spine + LLM judge cross-check |
| Value | Security | static-scanner spine + LLM judge cross-check |
| Cost | Efficiency | wall-clock, tokens, dispatches |
| Cost | Overhead ratio | ceremony ÷ codegen (tokens & time) |

**Autonomy is reported separately, as a guardrail (Epic #66, Story #77).**
It is no longer one of the Mandrel-vs-control delta rows: the bare control
arm's "autonomy" is a defined baseline (1.0, zero interventions by
construction), not a measurement, so diffing it against Mandrel's measured
score was never a meaningful comparison. Instead every record carries
`dimensions.autonomy.guardrail = { threshold, met }` — a pass/fail verdict
against a fixed cohort threshold (default 0.99) — rendered in its own report
section; a drop below threshold is itself a finding.

**Variance is the reporting method**, not an eighth dimension: every score is
a distribution across N runs with a computed **noise-band**; a delta is
"real" only when it clears the band.

**The trap axis is a separate differential signal (Epic #66, Story #74),
never folded into the seven dimensions above.** The `story-scope` and
`epic-scope` rungs each declare one or more adversarial trap classes — planted
defects a dedicated oracle module source-scans the delivered tree for,
independent of the frozen behavioural suite both arms can pass identically.
Reported on the scorecard as `trap: { classes[], cleanRate }` and rendered as
its own section (per-class scores + `cleanRate`, mean/spread/min per arm) in
both the Markdown report and the dashboard. See `bench/metrics/README.md`
§ "Trap axis" and [`data-dictionary.md`](data-dictionary.md) for the field
shape.

**Phase-scoped signals are separate top-level blocks too (Epic #86), never
folded into the dimensions above.** The mandrel arm's two-session split
(D-019) surfaces **per-phase cost envelopes** (`phases[]`, one per `/plan` /
`/deliver` session, summing to `dimensions.efficiency`) and an intrinsic,
mandrel-only **plan-quality** axis (`planQuality`, coverage + decomposition
sanity + constraint surfacing) whose `attribution` block crosses the plan score
with the delivered outcome to attribute a result to the plan phase vs the
deliver phase. The second touch (D-020) records its continuity outcome/cost as
`touch2`, and the headline **continuity delta** (mandrel touch-2 outcome/cost −
control) is derived downstream by `bench/score/differential.js`. Like the trap
axis, all three are mandrel-relevant blocks reported apart from the composite
dimensions — see [`data-dictionary.md`](data-dictionary.md) for the
`phases[]` / `planQuality` / `touch2` field shapes.

**Routing contract enforcement (Epic #66, Story #76).** Each scenario
declares a `routing` contract (`"story"` or `"epic"`); a mandrel-arm record
whose OBSERVED `routingVerdict` diverges from that contract is marked
`routingMismatch: true` and excluded from the cell's noise-band pool, with
the per-cell mismatch rate surfaced explicitly (>25% is itself a scope-triage
calibration finding).

**Cross-scenario derived metrics** (relationships, not per-run scores): the
**difficulty-monotonicity** check (Efficiency ↑ / Overhead ratio ↓ across the
ladder; a violation is a calibration warning) and the **overhead-floor**
estimate (hello-world Mandrel cost − control — the fixed ceremony tax on
near-zero work).

## 5. Data models

- **Scorecard** (`bench/schemas/scorecard.schema.json`, draft 2020-12) — the
  per-run record: `{ runId, timestamp, model, frameworkVersion,
  benchmarkVersion, env, scenario, arm, dimensions{…}, … }`. Validated on emit.
- **Longitudinal store** (`results/`) — an append-only, committed record of
  every scorecard, stamped with model + framework-version + benchmark-version +
  env (the 4-part cohort stamp, D-014). This is the "track over time" substrate;
  `compare.js` reads it for cross-run deltas, pooling only records that match on
  the full cohort key.
- **Cost source** — the `claude -p` envelope only. Mandrel records no token
  actuals (its preflight is estimate-only), so the session envelope is the
  single, identical cost instrument for both arms.

## 6. Scenario corpus

`bench/scenarios/` holds the corpus. Each scenario ships:

- a `scenario.json` task seed shared by both arms — declaring `difficulty`,
  `rung`, `routing` (`"story"` | `"epic"` — the delivery route the harness
  expects Mandrel to take), and `targetN`,
- a **frozen** `acceptance.test.js` oracle — a pure `evaluate(baseUrl)` that
  probes only user-visible behavior and imports nothing from the delivered app,
- wiring through `bench/scenarios/acceptance-eval-adapter.js`, which lifts the
  frozen result into a schema-valid verdict and runs the materialized
  `acceptance-eval` cross-check,
- for `story-scope` and `epic-scope`: one or more `traps/<class>.js` oracle
  modules, each exporting `evaluate(deliveredTreePath)`, plus a discrimination
  unit test over hand-crafted clean/vulnerable sample trees
  (`tests/bench/scenarios/<id>/`). Oracles live only in this repo — never
  overlaid into the sandbox (the #58 git-exclude discipline) — and scenario
  prompts stay terse with no trap hints, so the headroom the trap needs is
  never destroyed by an accidental spoiler.

**The Epic #66 3-rung matrix** (retired the prior `crud-db`/`project-api`
ladder and the single-oracle spike scenario it grew alongside, Story #79):

| Scenario | Difficulty | Routing | Role |
| --- | --- | --- | --- |
| `hello-world` | 1 | story | Instrumentation only — overhead floor + pipeline smoke. Never a value-delta rung; reported under the floor/calibration framing. |
| `story-scope` | 3 | story | The story-routed value rung — persisted-auth API with per-user notes; traps `plaintext-password` + `token-generation`. |
| `epic-scope` | 5 | epic | The epic-routed value rung — multi-user project/task management API sized to decompose into 4–6 Stories; traps `plaintext-password`, `idor`, `missing-input-validation`, `hardcoded-secret`. |

**Every scenario's sandbox gets real, un-stubbed lint/typecheck/test gates**
for both arms (`bench/driver/overlay.js` `buildTargetPackageJson`) — the
former single-scenario special case was generalized (Story #74) so a clean
`/deliver` only auto-merges after the gates genuinely pass.

## 7. Security

- **Two-secret setup contract** — the sandbox lifecycle needs exactly two
  environment variables, validated fail-fast at `bench/run.js` startup
  (before any cost is spent): `BENCH_GITHUB_TOKEN` (a fine-grained PAT or
  machine-account token scoped to repository create/delete + contents +
  issues + pull-requests) and `BENCH_SANDBOX_OWNER` (the account/org
  ephemeral repos are created under). The old standing-repo vars
  (`BENCH_SANDBOX_REPO_URL`/`REPO`/`BASELINE_REF`) are no longer read at all;
  an operator configured only for the old path aborts fail-fast on the absent
  required vars.
- **Reserved-prefix guard on the destructive surface** — `destroyEphemeralRepo`
  and the janitor sweep both refuse to act on any repo name that does not
  start with the reserved `bench-sbx-` prefix; the janitor additionally
  filters by owner and TTL. Nothing else under the operator account may use
  the prefix, which is what makes unattended deletion safe.
- **Sandbox containment** — local teardown is gated by `assertInsideRoot`,
  which rejects any path that is not a proper descendant of the ephemeral
  root (`..`, absolute re-root, root-itself), and refuses non-directory/symlink
  targets. A malformed handle can never escalate into deleting a real repo.
- **No shell injection** — `git`, `gh`, and `claude` are invoked via
  `execFileSync` / `spawnSync` with argument arrays (never a shell string on
  POSIX); the clone uses a `--` separator before the repo URL.
- **Secrets** — `BENCH_GITHUB_TOKEN` is environment-sourced and never logged.
  `sanitizeGitHubTokenEnv` (`bench/driver/sandbox.js`) strips whitespace from
  any ambient `GH_TOKEN`/`GITHUB_TOKEN` AND, when `BENCH_GITHUB_TOKEN` is
  present, writes its value into `GH_TOKEN` — the variable `gh` itself
  resolves first — so it wins over whatever ambient `gh auth login` session
  or broader-scoped token the operator's shell happens to carry. Every `git`
  clone/push and `gh` call this lifecycle makes (provision, seed, reset,
  destroy, the janitor sweep) is passed this sanitized environment; the
  collector logs token *counts*, never values.
- **Private, disposable repos** — ephemeral repos are created `--private` and
  carry only template + benchmark-delivered content; no secrets are ever
  committed to them.

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
| CI | GitHub Actions — `ci` (lint + test) on every PR; `benchmark` (on-demand `workflow_dispatch` cohort run → results PR); `publish-pages` (dashboard to GitHub Pages on results-PR merge) |
| Framework under test | `mandrel` (pinned npm dependency) |
