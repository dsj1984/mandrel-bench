# mandrel-bench

**An internal benchmark that measures the [Mandrel](https://github.com/dsj1984/mandrel)
framework's *value-add* — what its scaffolding buys you versus what it costs —
and tracks that verdict across framework versions and model generations.**

mandrel-bench is a **consumer of Mandrel**, not part of it. It installs a
*pinned, published* `mandrel` version, materializes the framework via
`mandrel sync`, then drives Mandrel's own `/plan`→`/deliver` pipeline (and a
bare-model control) over a set of scenarios, scores each run across five
dimensions, and emits a value-add report. Because the harness is held fixed
while the `mandrel` dependency version varies, it answers the standing
question: **"is Mandrel still worth its tax at the current frontier?"**

> The dependency is **one-directional**: `mandrel-bench` depends on `mandrel`;
> `mandrel` never depends on `mandrel-bench`. If it *measures* the framework,
> it lives here; if it *is* the framework, it lives in
> [mandrel](https://github.com/dsj1984/mandrel).

---

## Why a separate repo

Benchmarking the framework from *inside* the mandrel dev repo has two flaws this
repo exists to fix:

1. **It wouldn't test the real consumer contract.** Mandrel ships as an npm
   package that consumers install and `mandrel sync` into `.agents/`. A
   benchmark run here goes through that exact path, so it measures Mandrel the
   way real projects actually use it.
2. **It would confound harness-version with framework-version.** To compare
   `mandrel@1.70` vs `mandrel@1.71`, you must hold the *measuring instrument*
   constant and vary only the *thing measured*. Here the harness is fixed and
   the framework-under-test is a single pinned dependency
   (`dependencies.mandrel` in `package.json`) — bump it to benchmark a new
   version.

---

## What it measures

Every dimension answers one of two questions: **what does the scaffolding
buy?** (value) or **what does it charge?** (cost). The deliverable is the
value/cost *frontier* — never a single collapsed score (that invites Goodhart
gaming).

| Side | Dimension | Question it answers | Primary signal |
| --- | --- | --- | --- |
| Value | **Quality** | Is the delivered software correct & on-intent? | frozen per-scenario acceptance suite + `acceptance-eval` cross-check |
| Value | **Planning fidelity** | Did the plan match the work actually required? | decomposition accuracy, re-plan count, plan-vs-actual drift |
| Value | **Autonomy** | How little human intervention did it need? | HITL stops, `agent::blocked`, manual rescues |
| Cost | **Efficiency** | What did it cost absolutely? | wall-clock, tokens, dispatches |
| Cost | **Overhead ratio** | Ceremony tax vs. shippable output | ceremony ÷ codegen (tokens & time) |

**Variance is the reporting method**, not a sixth dimension: every score is
reported as a distribution across N runs with a computed **noise-band**, and a
Mandrel-vs-control delta is only called *real* when it clears that band.

### Cross-scenario derived metrics (relationships, not per-run scores)

- **Difficulty monotonicity** — across the scenario ladder, Efficiency must
  *rise* and Overhead ratio must *fall* as difficulty increases. A violation is
  a **calibration warning** (the instrument may be insensitive, or a scenario
  mis-graded).
- **Overhead floor** — the hello-world Mandrel-arm cost minus the control-arm
  cost estimates Mandrel's *fixed* ceremony tax on near-zero work — the most
  direct "ceremony-lite path for trivial scopes" signal. Feeds the report's
  **Recommended improvements** section.

---

## How it works

For each `(scenario × arm × run)`:

1. **Provision** an ephemeral throwaway clone of a scenario's sandbox repo
   (`bench/driver/sandbox.js`) under the OS temp dir. The control arm has its
   `.agents/` stripped so the bare model gets no scaffolding.
2. **Run** a headless Claude Code session (`bench/driver/run-session.js` →
   `claude -p --output-format json`). The **mandrel arm** drives `/plan` then
   `/deliver` (real authoring — never pre-staged plans); the **control arm**
   gets the bare task. The JSON envelope yields the real usage/cost actuals —
   the *only* cost source, measured identically for both arms.
3. **Collect** (`bench/collect/normalize.js`) the run's lifecycle telemetry
   (`temp/epic-<id>/lifecycle.ndjson` + per-Story `signals.ndjson`, written by
   `/deliver`) plus the cost envelope into one per-run record conforming to
   `bench/schemas/scorecard.schema.json`.
4. **Score** (`bench/score/`) the five dimensions, the Mandrel-vs-control
   differential, the noise-band, and the cross-scenario derived metrics.
5. **Report & persist** (`bench/report/`) the value-add report (distributions,
   deltas, scaling view, Recommended improvements), append the stamped
   scorecard (model + framework-version + env) to the longitudinal store under
   `results/`, and surface cross-run deltas.
6. **Tear down** the ephemeral workspace (teardown is path-containment-guarded
   so it can only ever delete the throwaway clone).

The model is **pinned and recorded** on every scorecard; comparisons are only
ever like-model to like-model — this is **not** a model benchmark.

---

## Repository layout

```text
mandrel-bench/
├── bench/
│   ├── metrics/      # five-dimension formulas (README.md) + variance/noise-band
│   ├── schemas/      # scorecard.schema.json (the per-run record contract)
│   ├── driver/       # claude -p run launcher + ephemeral sandbox lifecycle + unattended.md
│   ├── scenarios/    # hello-world/ + crud-db/ defs, frozen oracles, acceptance-eval adapter
│   ├── collect/      # lifecycle + signals + cost-envelope → normalized per-run record
│   ├── score/        # dimensions + Mandrel-vs-control differential + derived metrics
│   ├── report/       # value-add report renderer + stamped persistence + cross-run compare
│   └── fixtures/     # sample scorecard + sample lifecycle ndjson (test fixtures)
├── tests/bench/      # node:test suites mirroring bench/ (pure-logic units)
├── results/          # committed longitudinal scorecard store (the over-time record)
├── docs/
│   └── mandrel-self-benchmark.md   # the design one-pager
└── package.json      # pins `mandrel` — the version under test
```

---

## Status

**Transplanted and present:** the full harness component set (metrics model +
scorecard schema, scenarios + frozen oracles, run driver + sandbox lifecycle,
collector, scoring + control differential + derived metrics, report +
persistence + cross-run compare) with its `node:test` unit suites. This code
was authored and delivered through Mandrel's own `/plan`→`/deliver` (originally
as Epic
[mandrel#4211](https://github.com/dsj1984/mandrel/issues/4211)) and re-homed
here.

**Remaining wiring (the next cycle — ideally planned *with Mandrel itself*):**

- [ ] `npm install` + `mandrel sync` to materialize `.agents/` for the pinned
      version (the `scenarios/acceptance-eval-adapter` cross-check and the
      pipeline drive depend on the materialized `.agents/scripts/`).
- [ ] A top-level run orchestrator (`bench/run.js`) that loops
      `N × scenarios × arms`, calls driver → collect → score → report, and
      writes to `results/`.
- [ ] Adapt the driver's "framework under test" to the *installed* `mandrel`
      version (currently it assumes a sandbox clone of the framework repo).
- [ ] CI for this repo (run the unit suites; the full benchmark is a periodic,
      manually-triggered capability report, not a per-PR gate).

The unit suites under `tests/bench/` that exercise pure logic (variance,
dimensions, differential, collect/normalize, report render/persist/compare,
scorecard-schema) run standalone via `npm test`; the scenario/acceptance-eval
pieces require the materialized `.agents/` from `mandrel sync`.

---

## Running (once wired)

```bash
npm install            # pulls the pinned `mandrel` version under test
npx mandrel sync       # materialize .agents/ for that version
npm test               # run the harness unit suites
# npm run bench        # (future) full N × scenarios × arms capability report
```

To benchmark a different framework version, bump `dependencies.mandrel` in
`package.json`, re-run `npm install && npx mandrel sync`, and re-run the
benchmark; the new scorecards append to `results/` stamped with that version,
and the cross-run comparison surfaces the deltas.

---

## See also

- [Mandrel](https://github.com/dsj1984/mandrel) — the framework under test.
- [`docs/mandrel-self-benchmark.md`](docs/mandrel-self-benchmark.md) — the
  design one-pager (problem, dimensions, scope, non-goals).

## License

MIT
