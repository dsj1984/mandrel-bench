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

1. **Provision** a private, ephemeral **per-cell** GitHub repo
   (`bench/driver/sandbox.js`), named `bench-sbx-<cohort>-<scenario>-<arm>-<nonce>`
   and seeded from `bench/sandbox-template/` (plus an optional per-scenario
   overlay), then clone it under the OS temp dir. The control arm has its
   `.agents/` stripped so the bare model gets no scaffolding. Crash-leaked
   repos are swept by a `bench-sbx-` prefix + TTL janitor
   (`bench/driver/janitor.js`) at the start of every invocation.
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
6. **Tear down** the ephemeral workspace and delete the cell's private repo
   (`gh repo delete`, best-effort on failure paths); local teardown remains
   path-containment-guarded so it can only ever delete the throwaway clone.

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
│   ├── scenarios/    # hello-world/ + story-scope/ + epic-scope/ defs, frozen oracles, trap oracles
│   ├── collect/      # lifecycle + signals + cost-envelope → normalized per-run record
│   ├── score/        # dimensions + Mandrel-vs-control differential + derived metrics
│   ├── report/       # value-add report renderer + stamped persistence + cross-run compare
│   └── fixtures/     # sample scorecard + sample lifecycle ndjson (test fixtures)
├── tests/bench/      # node:test suites mirroring bench/ (pure-logic units)
├── results/          # committed longitudinal scorecard store (the over-time record)
├── docs/             # architecture.md (run model) + decisions.md (rationale)
└── package.json      # pins `mandrel` — the version under test
```

---

## Published dashboard

The longitudinal dashboard is published to **GitHub Pages** so it is publicly
readable without cloning the repo (decision D-021):

- **Live URL:** <https://dsj1984.github.io/mandrel-bench/>

Publishing is automated by
[`.github/workflows/publish-pages.yml`](.github/workflows/publish-pages.yml).
The workflow fires on a push to `main` that touches the committed dashboard
(`results/results.html`) — i.e. when a results PR merges — and deploys via the
standard `actions/deploy-pages` flow. It stages and uploads **only**
`results/results.html` (served as the site's `index.html`); the per-cohort
`.raw/` provenance tree (lifecycle ledgers, cost envelopes, per-Story signals)
is **never** copied to the public site.

**One-time repo enablement.** GitHub Pages must be switched to the Actions
source once, by a repo admin: **Settings → Pages → Build and deployment →
Source → "GitHub Actions"**. No branch or `/docs` folder selection is needed —
the workflow owns the artifact. After that, every results-PR merge republishes
the dashboard automatically.

---

## Status

**Wired and exercised end to end.** The full component set (metrics model +
scorecard schema, scenarios + frozen oracles, run driver + sandbox lifecycle,
collector, scoring + control differential + derived metrics, report +
persistence + cross-run compare) is tied together by a top-level **orchestrator
(`bench/run.js`)**, a **framework-under-test overlay (`bench/driver/overlay.js`)**,
and an **app-runner (`bench/driver/app-runner.js`)**, all with `node:test` unit
suites.

The **first benchmark result** has landed — `hello-world`, both arms, N=1 on
`mandrel@1.70.0` / `claude-opus-4-8`. The mandrel arm drove `/plan`→`/deliver`
fully headless and unattended against a throwaway sandbox repo (that early
cohort predates the ephemeral per-cell lifecycle — see
[`docs/decisions.md`](docs/decisions.md) D-013 for the retirement of the old
standing sandbox repo it used); see [`results/`](results/) for the scorecards
and the value-add report.

**Done this cycle:**

- [x] A top-level run orchestrator (`bench/run.js`) that loops
      `N × scenarios × arms`, runs overlay → driver → app-runner → collect →
      score → report, and writes to `results/`.
- [x] The driver's "framework under test" is the *installed* `mandrel` version:
      `overlay.js` copies this repo's materialized `.agents/` (+ `node_modules`)
      into the mandrel-arm clone and repoints it at the sandbox repo.
- [x] An app-runner that starts the delivered app and probes it for the frozen
      Quality oracle.
- [x] The first live N=1 smoke result, persisted to `results/`.

**Still open (deferred, separately planned):**

- [ ] Scale to N≈8–10 across the `story-scope`/`epic-scope` rungs for a
      statistically meaningful verdict (the N=1 result is non-inferential —
      see [`results/`](results/)).
- [ ] CI for this repo (run the unit suites; the full benchmark is a periodic,
      manually-triggered capability report, not a per-PR gate).
- [ ] A first-class `/plan` headless flag and an auto-merge gate that does not
      block a clean trivial run (both surfaced as findings by the first result).

The unit suites under `tests/bench/` run standalone via `npm test`; the
scenario/acceptance-eval pieces additionally use the materialized `.agents/`.

---

## Running

```bash
npm install            # pulls the pinned `mandrel` version under test
npm test               # run the harness unit suites

# Full capability run (real claude -p sessions against ephemeral per-cell
# sandbox repos, created/destroyed automatically — see "Sandbox setup" below):
BENCH_GITHUB_TOKEN=<token> BENCH_SANDBOX_OWNER=<owner> \
BENCH_ARMS=control,mandrel BENCH_SCENARIOS=hello-world BENCH_N=1 \
npm run bench
```

To benchmark a different framework version, bump `dependencies.mandrel` in
`package.json`, re-run `npm install && npx mandrel sync`, and re-run the
benchmark; the new scorecards append to `results/` stamped with that version,
and the cross-run comparison surfaces the deltas.

### Sandbox setup

The sandbox lifecycle is fully self-contained — no standing repo to
provision by hand. Two secrets are all it takes:

| Var | Required | Meaning |
| --- | --- | --- |
| `BENCH_GITHUB_TOKEN` | yes | a fine-grained PAT (or machine-account token) with repository create/delete + contents + issues + pull-requests scopes; used to create and tear down the per-cell `bench-sbx-*` repos |
| `BENCH_SANDBOX_OWNER` | yes | the account/org the ephemeral repos are created under |
| `BENCH_JANITOR_TTL_HOURS` | no | overrides the janitor sweep's TTL (hours); defaults to 24 |

Each cell provisions one private repo (`bench-sbx-<cohort>-<scenario>-<arm>-<nonce>`,
seeded from `bench/sandbox-template/`) and deletes it at teardown; a
`bench-sbx-` prefix + TTL janitor sweeps anything a crash leaks behind. See
[`docs/architecture.md`](docs/architecture.md) §2 and
[`docs/decisions.md`](docs/decisions.md) D-013 for the full design.

`BENCH_SANDBOX_REPO_URL`, `BENCH_SANDBOX_REPO`, and `BENCH_SANDBOX_BASELINE_REF`
are **retired** — setting any of them emits a deprecation warning naming its
replacement; they are no longer read.

**Least privilege.** A fine-grained PAT can't be pre-scoped to repos that
don't exist yet, so in practice `BENCH_GITHUB_TOKEN` carries delete authority
over every repo under `BENCH_SANDBOX_OWNER` — only the in-process reserved
`bench-sbx-` prefix guard (`createEphemeralRepo`/`destroyEphemeralRepo`/the
janitor all refuse any other name) bounds the blast radius, not the token's
own scoping. Use a dedicated machine account or org that owns nothing else of
value, rather than a personal account's token.

#### Standalone janitor sweep

The `bench-sbx-` prefix + TTL sweep also runs on its own, outside a benchmark
invocation:

```bash
npm run janitor -- --dry-run              # list what would be deleted
npm run janitor -- --ttl-hours 12         # override the default 24h TTL
npm run janitor -- --owner someone-else   # override BENCH_SANDBOX_OWNER
npm run janitor -- --help                 # usage — no env vars required
```

Flags: `--dry-run`, `--ttl-hours <hours>`, `--owner <owner>`, `--help`. With no
flags it reads `BENCH_SANDBOX_OWNER` and `BENCH_JANITOR_TTL_HOURS` (or the
24h default) the same way the sweep embedded in `npm run bench` does.

#### Sandbox retirement (operator runbook)

The benchmark no longer depends on a standing external sandbox repo. If your
account still has the old pre-ephemeral-lifecycle sandbox repo around, it is
safe to **archive** (or delete) it once you've confirmed a local run succeeds
against the ephemeral per-cell lifecycle above — nothing in this repo
references it anymore.

### Benchmark CI (`workflow_dispatch`)

The full cohort can also run in CI, unattended, from a single manual dispatch:
**Actions → Benchmark → Run workflow**
([`.github/workflows/benchmark.yml`](.github/workflows/benchmark.yml)). One
invocation runs the whole pipeline — plan → canary → per-cell matrix →
aggregate — and lands the results as a reviewable pull request. A complete
cohort is a near-zero-cost no-op: the plan job spends only on the deficit.

**Topology.** `plan` runs the top-up planner
([`bench/driver/topup-planner.js`](bench/driver/topup-planner.js)) to compute
the per-cell deficit and its cost allocation; `canary` runs the cheapest rung
(`hello-world`) end-to-end **first** as a smoke test — a canary failure aborts
the invocation before any expensive cell runs; the per-cell `matrix` fans out
one job per deficit cell (max 6 in parallel), each exporting its
`BENCH_MAX_COST_USD` share so the in-loop stop enforces the per-cell ceiling
and uploading its scorecards + `.raw` provenance as artifacts; `aggregate`
downloads every cell's artifacts, merges them into `results/` (append-only
NDJSON) and renders the cohort report + `results.html` via the standalone
[`bench/report/aggregate-cli.js`](bench/report/aggregate-cli.js) — with **no**
run — then **opens a pull request**. No job pushes to `main` directly.

**The results PR replaces the interactive STOP gates.** The local
[`/benchmark`](#running) flow pauses for an operator to review the scorecard
before committing; in CI there is no interactive pause — the aggregate job's
pull request **is** the review gate. Inspect the rendered scorecard and the
delta-vs-noise-band in the PR, then merge to publish (which also fires
`publish-pages`).

**Inputs** (all optional; blanks fall back to the pinned/declared defaults):

| Input | Default | Meaning |
| --- | --- | --- |
| `mandrel_version` | pinned dependency | Framework version under test for this cohort. |
| `model` | bench default | Model id for the cohort stamp (e.g. `claude-opus-4-8`). |
| `scenarios` | the 3-rung corpus | Comma-separated scenario ids to benchmark. |
| `target_n` | each scenario's `targetN` | Uniform per-scenario run-count override. |
| `max_cost_usd` | `150` | USD ceiling allocated across the deficit cells. |
| `dry_run` | `false` | Plan only — print the deficit plan and skip every paid cell. |

**Required Action secrets** (Settings → Secrets and variables → Actions):

| Secret | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | the model credential the benchmarked sessions call with. |
| `BENCH_GITHUB_TOKEN` | token with repo create/delete + contents + issues + pull-requests scopes — used both for the ephemeral per-cell sandboxes and to open the results PR. |

### Merge-gated feedback loop

The benchmark's signal reaches the framework backlog automatically, but **only
after a human reviews it**. The aggregate job derives the cohort's findings
([`bench/feedback/derive-cli.js`](bench/feedback/derive-cli.js)) — regressions,
standing costs, trap differentials, pipeline-calibration gaps — and does two
things with them: it **commits the finding-envelope JSON** into the results tree
alongside the scorecards, and it **embeds the findings section in the results-PR
body**. Merging the results PR lands the envelope on `main`, which fires a
separate on-merge workflow
([`.github/workflows/feedback-file.yml`](.github/workflows/feedback-file.yml))
that files the findings onto the [Mandrel](https://github.com/dsj1984/mandrel)
repo, fingerprint-deduplicated.

**Why the merge gate.** `feedback-file.yml` triggers **only** on a push to
`main` that touches a finding envelope under the results tree — i.e. after a
results-PR merge. It **never** runs on `pull_request`, so an unreviewed cohort
can never write to the Mandrel repo. That merge gate, plus per-(fingerprint ×
cohort) dedup in the filer, is the anti-spam design: a first sighting opens a
fresh issue; a recurrence appends a dated cohort comment to the existing issue;
an already-recorded cohort writes nothing.

**Token scope.** Filing issues on `dsj1984/mandrel` is a **cross-repo** write,
so the workflow's own `GITHUB_TOKEN` is not enough. Provide a
`FEEDBACK_GITHUB_TOKEN` secret — a token with `issues:write` on
`dsj1984/mandrel`. If that scope is absent or insufficient the filer **degrades
loudly** (a prominent warning naming the missing scope) and **exits 0**, so a
missing token never fails CI.

**Label contract.** Every filed issue carries `bench-feedback` (the label the
filer lists + matches against on later runs) plus `meta::framework-gap` (the
routing label). The `bench-feedback` label **must exist on `dsj1984/mandrel`**
for the list-and-match dedup to work — create it there once.

**D-009 fallback.** Because the findings are **always** embedded in the
results-PR body, the loop degrades gracefully to the prior "findings live in the
PR, filed by hand" behaviour (decision D-009, which D-016 supersedes) whenever
the cross-repo token is unavailable — no signal is ever lost, it just isn't
auto-filed.

---

## See also

- [Mandrel](https://github.com/dsj1984/mandrel) — the framework under test.
- [`docs/architecture.md`](docs/architecture.md) — technical architecture (run
  model, components, data flow, security).
- [`docs/decisions.md`](docs/decisions.md) — the decision log and rationale.
- [`results/`](results/) — the scorecard store and value-add reports.
- [Published dashboard](https://dsj1984.github.io/mandrel-bench/) — the
  longitudinal scorecard dashboard on GitHub Pages.

## Development

- **Node** `>=22.22.1 <25`. `npm install` pulls the pinned `mandrel` and
  activates the Husky hooks (via the `prepare` script).
- **Lint / format:** `npm run lint` (Biome + markdownlint), `npm run format`
  (Biome write).
- **Test:** `npm test` (node:test). The pure-logic units run standalone; the
  scenario / acceptance-eval suites additionally need `npx mandrel sync` to
  materialize `.agents/` for the pinned version.
- **Hooks** (Husky): `pre-commit` → lint-staged, `commit-msg` → commitlint
  (Conventional Commits), `pre-push` → `npm test`.
- **Releases:** [release-please](https://github.com/googleapis/release-please)
  versions + changelogs on `main` (tags `vX.Y.Z`); **not** published to npm.
- **CI:** GitHub Actions — `lint` + `test` on every PR to `main`.
- **Benchmark CI:** GitHub Actions — `benchmark` runs the full cohort pipeline
  from a manual `workflow_dispatch` and opens a results PR (see
  [Benchmark CI](#benchmark-ci-workflow_dispatch)).
- **Pages:** GitHub Actions — `publish-pages` deploys `results/results.html` to
  GitHub Pages on every results-PR merge to `main` (see
  [Published dashboard](#published-dashboard)).

## License

MIT
