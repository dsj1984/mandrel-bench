# mandrel-bench — Target Architecture

> **Status: target spec (not yet implemented).** This document describes the
> architecture mandrel-bench is converging on, decided 2026-07-07. The current
> implementation is described in [`architecture.md`](architecture.md); this
> document supersedes it where the two disagree. Decision deltas against
> [`decisions.md`](decisions.md) are listed in [§11](#11-decision-deltas);
> each becomes a numbered decision entry when its phase lands.

## 1. Intent

The benchmark exists to answer three questions, in priority order:

1. **Demonstrate value (or the lack of it).** Quantify Mandrel's value-add
   over a bare Claude Code control across a value/cost frontier — including
   the honest null result ("the value thesis is unmeasurable vs a frontier
   control at this tier", D-012) if that is what the data says.
2. **Monitor over time.** Detect improvement or regression across Mandrel
   releases, Claude model/API releases, and benchmark releases — each a tracked
   variable, never confounded.
3. **Feed Mandrel's own development.** Every cohort report mechanically
   produces actionable, deduplicated feedback issues on the Mandrel repo —
   each attributed to the pipeline phase that owns it (`/plan`, `/deliver`,
   or the persistent artifacts) — so the benchmark is a standing
   optimization loop for the framework's target dimensions, not a
   scoreboard.

## 2. Design principles (held invariant)

These carry forward unchanged from the current design:

- **Separate consumer repo** (D-002). The harness pins a *published*
  `mandrel` npm version; the instrument is held fixed while the framework
  varies.
- **Bare-model control arm** (D-003). Value-add is always a delta over the
  same pinned model with no scaffolding.
- **Seven dimensions, value vs. cost, never a composite** (D-001).
  Quality, Planning fidelity, Autonomy, Maintainability, Security (value);
  Efficiency, Overhead ratio (cost).
- **Variance is the method** (D-001). Every score is a distribution across N
  runs with a noise-band; a delta is "real" only when
  `|Δcenter| > max(spread_mandrel, spread_control)`.
- **Frozen oracles with LLM cross-checks** (D-007). Deterministic spine,
  judge as corroboration, never judge alone.
- **One cost instrument** (D-008). Both arms are costed by the outer
  `claude -p` JSON envelope.
- **The null-result gate** (D-012). A designed experiment that still shows no
  noise-clearing delta is a publishable finding, not a bug to tune away.

## 3. The experiment model

### 3.1 Cohort identity is a triple

A **cohort** is the unit of statistical comparison:

```text
cohort = (model, mandrelVersion, benchmarkVersion)
```

`benchmarkVersion` (this repo's `package.json` version, managed by
release-please) joins the key because the benchmark is itself a variable:
scoring formulas, scenario specs, and oracles all live here, and a benchmark
change can move numbers with no framework or model change at all.

- Every scorecard gains a required `benchmarkVersion` field
  (`bench/schemas/scorecard.schema.json`).
- The on-disk layout stays `results/<model-slug>/<mandrelVersion>/` (no
  migration); cohort membership is resolved by filtering records on the full
  triple.
- Noise-bands, deltas, and top-up counting **only ever pool records that
  match on all three keys.** Reports label the benchmark version and flag
  any corpus that mixes benchmark versions as **non-inferential**.
- Cross-cohort comparisons (the longitudinal trend view) annotate which key
  changed between the cohorts being compared, so a movement is always
  attributable to exactly one variable — or explicitly flagged as confounded.

### 3.2 The matrix: 3 scenarios × 2 arms × N runs

| Cell | Arm | Scenario |
| --- | --- | --- |
| 1 | control (native Claude Code) | `hello-world` |
| 2 | control | `story-scope` |
| 3 | control | `epic-scope` |
| 4 | mandrel | `hello-world` |
| 5 | mandrel | `story-scope` |
| 6 | mandrel | `epic-scope` |

Target N is **per scenario**, declared in `scenario.json` (`targetN`) and
overridable per invocation: **8** for `story-scope` and `epic-scope` (what
the noise-band method assumes for an inferential cell) and **4** for
`hello-world`, which is instrumentation rather than a value rung (§4.1) —
its floor estimate needs a coarse band, not an inferential one. A cohort is
**complete** when all 6 cells hold ≥ their target N of valid runs.

### 3.3 Routing is part of the scenario contract

Each scenario declares its **expected Mandrel routing** in `scenario.json`
(`routing: "story" | "epic"`; hello-world may be either but must be
consistent). The observed `routingVerdict` is checked against it:

- A mandrel-arm run whose routing diverges from the contract is recorded but
  marked `routingMismatch: true` and **excluded from the cell's noise-band**
  (it measured a different pipeline). Top-up treats it as a deficit.
- Persistent mismatch (> 25% of a cell's runs) is itself a finding — a
  scope-triage calibration signal fed back to Mandrel (§7) — not something
  the harness papers over by re-prompting.

This closes the current comparability hazard where `crud-db` runs mixed
story/epic routing within one cell.

### 3.4 Phase-scoped sessions: separating `/plan` from `/deliver`

The benchmark must answer not just "is Mandrel worth it?" but "**which half
needs work?**" — the feedback loop (§7) has to route a finding to the plan
pipeline or the deliver pipeline, not to "Mandrel" at large. Plan-adherence
(the existing planning-fidelity dimension) cannot do this alone: it can't
distinguish a bad plan faithfully executed from a good plan botched in
delivery.

- **Two sessions per mandrel-arm run.** The mandrel arm executes as two
  consecutive headless sessions: session 1 runs `/plan` to completion,
  session 2 runs `/deliver`. This is faithful to Mandrel's own design —
  state lives in tickets, so a fresh `/deliver` session is the canonical
  consumer experience, not an artificial split. Each session has its own
  `claude -p` envelope, giving **per-phase cost, tokens, and wall-clock**
  (amends D-008: a mandrel-arm run is an *ordered set* of phase-scoped
  sessions whose cost is the sum; the control arm stays a single session).
- **The plan snapshot.** Between the sessions the harness snapshots the plan
  artifacts (Epic body, Story bodies with `acceptance[]`/`verify[]`, tech
  spec) into `.raw/<runId>/plan/`. Delivery can never retroactively alter
  what the plan is scored on.
- **Intrinsic plan quality (a mandrel-only axis, like planning fidelity).**
  The snapshot is scored against the scenario's frozen spec before a single
  line of code exists:
  - **Coverage** — every frozen acceptance criterion traceable to a Story
    AC (deterministic structure matching, judge cross-check).
  - **Decomposition sanity** — story count and sizing vs the scenario's
    routing contract and Mandrel's own sizing rules.
  - **Constraint surfacing** — do the plan artifacts carry the
    security-baseline obligations the scenario's traps probe (hashing,
    authz, input validation, env-sourced secrets)?
  - Two-oracle shape per D-007: deterministic spine 0.7, LLM judge 0.3.
- **Attribution.** Plan quality (intrinsic) crossed with outcome (delivered
  dimensions + traps) and plan-adherence gives the feedback loop a decision
  table:

  | Plan quality | Outcome | Reading |
  | --- | --- | --- |
  | good | good | working as intended |
  | good | bad | **deliver-phase gap** — the plan required it; delivery + gates missed it |
  | bad | bad | **plan-phase gap** — the obligation never surfaced downstream |
  | bad | good | model compensating — the ceremony wasn't load-bearing; a finding in itself |

  Trap outcomes make this concrete: a plaintext-password defect under a
  plan that never mentioned hashing files as `phase::plan`; the same defect
  under a plan that required hashing files as `phase::deliver`.

## 4. Scenario corpus

The synthetic ladder (D-006) survives, rebuilt as three rungs. Two design
rules apply to **all** rungs:

- **Real gates everywhere.** The per-scenario `package.json` written into the
  sandbox carries *un-stubbed* lint / typecheck / test scripts (the current
  auth-trap treatment generalized). Mandrel's enforcement must actually fire
  to be measurable; the control arm sees the same scripts, so the substrate
  is identical.
- **Planted pressure, separated detectors.** Story and Epic rungs carry
  **trap defect classes** — realistic corners a tersely-prompted frontier
  model cuts that a behavioral suite cannot see. Each trap has a dedicated
  adversarial **trap-oracle** (source-level scan, validated by a
  discrimination unit test on hand-crafted clean/vulnerable samples) living
  in `bench/scenarios/<id>/` — in the harness repo, never in the sandbox, so
  neither arm can read its own detector. The frozen `acceptance.test.js`
  stays blind to every trap by construction.

### 4.1 `hello-world` — the overhead floor (rung 1)

Unchanged in spirit: minimal Node ESM HTTP server, `GET /` → 200
`"Hello, World!"`. No traps, no decomposition surface.

This rung is **instrumentation, not a value rung** — it is deliberately too
simple to show value, and that is its job. It exists for three reasons, none
of which the other rungs can serve:

1. **The overhead-floor estimate** (D-010): `mandrel − control` cost at
   near-zero work *is* the measurement of Mandrel's fixed ceremony tax — the
   number the "is the tax shrinking across releases?" trend is built on.
2. **The cheap end of the monotonicity curve.** The difficulty-ladder
   calibration check needs a rung where overhead *should* dominate.
3. **Canary.** The CI planner runs the hello-world cells **first**; a
   structural failure there (harness bug, auth problem, `claude` CLI drift)
   aborts the invocation before any ~$23 epic-scope run is spent.

Accordingly it runs at reduced `targetN` (4), costs ~$4/mandrel run, and its
Quality saturating at 1.0 on both arms is expected, not a defect. Reports
present it under the floor/calibration framing, never in the value-delta
tables.

### 4.2 `story-scope` — one realistic capability slice (rung 2)

A single Story-sized capability with genuine security surface, absorbing
the current `auth-trap` spike (D-012) as its foundation:

- **Task shape.** A persisted authentication + protected-resource JSON API:
  `POST /signup`, `POST /login` (token issue), `GET /me`, plus one small
  authenticated resource (e.g. per-user notes list) — enough surface to be
  realistic, small enough to deterministically clear scope-triage as a
  **single standalone Story** (`routing: "story"`).
- **Traps** (each with its own oracle, scored separately):
  - `plaintext-password` — the validated defect class from D-012.
  - `token-generation` — predictable / non-random session tokens.
- **Frozen suite**: behavior both arms can pass (register → login →
  authenticated read, wrong-password rejection, no password echo).
- Telemetry comes from the standalone-Story path (the
  `standalone-telemetry-adapter` + `routingVerdict` machinery), so planning
  fidelity, autonomy, and overhead ratio are all measured at this rung.

`crud-db` and `auth-trap` retire as separate scenarios; `crud-db`'s
persistence pressure is inherited by the on-disk store requirement here and
by the Epic rung.

### 4.3 `epic-scope` — the frontier stressor (rung 3)

The scenario that must let Mandrel's value dimensions *diverge*. It is
deliberately engineered so that all three D-012 preconditions — headroom,
enforcement-fires, detector — hold at once:

- **Task shape.** A multi-user project/task management API (evolving
  `project-api`): register/login with bearer auth, project CRUD, task CRUD
  with pagination + filtering, cross-resource relations, cascade delete,
  persistence across restart — **plus** cross-cutting constraints that force
  real decomposition: per-user data isolation, input validation on every
  write, a consistent error envelope, and a config surface with a secret
  (API signing key) that must come from the environment. Sized to decompose
  into **4–6 Stories** (`routing: "epic"`), ~20–25 frozen acceptance
  criteria.
- **Traps** (the multi-class build-out D-012 gated on a positive signal):
  - `plaintext-password` (carried from rung 2 — cross-rung comparability),
  - `idor` — missing per-user authorization on object reads/writes (user A
    can fetch user B's project by id),
  - `missing-input-validation` — unvalidated write bodies reaching the
    store,
  - `hardcoded-secret` — the signing key inlined instead of
    environment-sourced.
- **Why this stresses Mandrel specifically.** Each trap maps to a MUST in
  Mandrel's security-baseline / engineer-persona rules, and the cross-cutting
  constraints map to planning-fidelity and gate enforcement. A bare control
  under a terse prompt has documented headroom to cut every one of these
  corners; a scaffolded arm has a rulebook and gates that should catch them.
  If the trap deltas are still flat here, the null result is earned.

### 4.4 Trap scoring: a first-class axis

The `trap` scorecard block becomes a first-class reported axis (executing
D-012's gated follow-up):

```json
"trap": {
  "classes": [
    { "class": "plaintext-password", "score": 1, "defectPresent": false },
    { "class": "idor", "score": 0, "defectPresent": true }
  ],
  "cleanRate": 0.5
}
```

- Reported per class **and** as a per-run `cleanRate`, as a distribution
  across N with mean, spread, and **worst-case (min)** per arm — a higher
  mean with a worse floor is a different finding than a higher mean with a
  tighter floor (D-012's variance-hypothesis discipline).
- Still **never folded** into the seven dimensions. The headline differential
  reads: *value dimensions + trap axis vs. the efficiency/overhead cost.*

### 4.5 The second touch: an evolution phase (rungs 2–3)

One-shot greenfield delivery is where a frontier model needs scaffolding
least — and Mandrel's central thesis (docs, ADRs, tickets, decomposition
discipline) is about making the **next** change cheaper and safer. No
one-shot benchmark can observe that. So `story-scope` and `epic-scope` runs
get a second, measured touch:

- **Mechanics.** After touch 1 is scored, a **fresh session** (no
  conversational carry-over) receives the scenario's frozen **change
  request** against the delivered tree. The mandrel arm inherits everything
  its pipeline produced (code, docs, tickets, `.agents/`); the control arm
  inherits exactly the code it delivered. Same arm, same model, new session
  — the inheritance *is* the treatment.
- **Change requests are part of the frozen scenario spec**, versioned with
  it: realistic, touching the delivered core, and crossing a trap surface.
  Illustrative shapes — story-scope: "add password change + session
  invalidation" (must preserve hashing, must actually invalidate tokens);
  epic-scope: "add project sharing with role-based access" (must extend
  per-user isolation to roles, not bypass it).
- **Scoring.** Touch 2 carries the full dimension set, its own frozen
  suite, and **regression traps** (did the change preserve touch-1 security
  properties?), reported separately from touch 1. The headline is the
  **continuity delta**: mandrel touch-2 outcome/cost minus control touch-2
  outcome/cost — the first measurement in this benchmark that can see the
  value of Mandrel's persistent artifacts.
- **Attribution tie-in (§3.4).** A mandrel arm whose fresh touch-2 session
  is *not* helped by its inherited docs/tickets files as an
  artifact-quality finding (`phase::artifacts`) — the ceremony was paid for
  in touch 1 but didn't pay out in touch 2.
- `hello-world` is exempt (instrumentation rung). Touch 2 roughly doubles
  rung 2–3 cell cost; that is the price of measuring the actual thesis.

## 5. Self-contained sandbox: ephemeral repos from an in-repo template

The standing `mandrel-bench-sandbox` repo retires. Everything a run needs
now lives in this repository.

### 5.1 Template

`bench/sandbox-template/` holds the sandbox working-tree content (baseline
README, `.gitignore`, any seed files a scenario declares). Scenario-specific
seed content, if any, layers from `bench/scenarios/<id>/sandbox/`. The
template is versioned with the scenarios and the harness — one repo, one
review surface, one version stamp (the `benchmarkVersion` cohort key covers
sandbox-content changes automatically).

### 5.2 Lifecycle (per cell)

```text
create → seed → run(N serial runs) → destroy
```

1. **create** — `gh repo create <owner>/bench-sbx-<cohort>-<scenario>-<arm>-<nonce> --private`
   under the bench operator account/org.
2. **seed** — init from `bench/sandbox-template/` (+ scenario layer), push as
   the baseline commit, record its SHA.
3. **run** — each of the cell's N runs clones the ephemeral repo, executes,
   and force-resets `main` to the baseline SHA between runs (the existing
   reset primitive, now scoped to a repo nobody else shares). Issues/PRs
   accumulate only within the cell and die with the repo.
4. **destroy** — `gh repo delete` in teardown, best-effort even on failure
   paths.

**Repo-per-cell** (not per-run) balances API churn against isolation: a cell
is one statistical unit, its runs are serial anyway, and 6 repos per
invocation is trivially inside GitHub rate limits.

### 5.3 Janitor

Crashes leak repos. A `bench/driver/janitor.js` sweep runs at the start of
every invocation (and as a standalone script): list repos matching the
`bench-sbx-*` prefix older than a TTL (default 24h), delete them. The prefix
is reserved — nothing else under the operator account may use it, which is
what makes unattended deletion safe.

### 5.4 Auth & config

- A dedicated fine-grained PAT (or GitHub App) with repository
  create/delete + contents + issues + pull-requests scopes, exposed as
  `BENCH_GITHUB_TOKEN` (CI secret / local `.env`).
- `BENCH_SANDBOX_REPO_URL/OWNER/REPO/BASELINE_REF` env vars retire.
  `BENCH_SANDBOX_OWNER` (account to create repos under) replaces them.
- `overlay.js`'s `.agentrc.json` rewrite now points at the ephemeral repo's
  coordinates (mechanism unchanged, target dynamic).

### 5.5 What this buys

- **Self-containment** — a fresh clone of mandrel-bench + two secrets
  (`ANTHROPIC_API_KEY`, `BENCH_GITHUB_TOKEN`) is a complete benchmark
  installation. Nothing to keep in sync, no standing state to corrupt.
- **Parallelism** — cells no longer share a `main`, so the CI matrix (§6)
  can run all 6 cells concurrently. This is what makes CI wall-clock fit.
- **Fidelity preserved** — Mandrel still round-trips a *real* GitHub repo
  (issues, labels, branches, auto-merge PRs), so measured overhead still
  includes real API latency. (A local Gitea stand-in was considered and
  rejected for exactly this reason, plus `gh`-compatibility risk.)

## 6. Automation: on-demand CI with top-up intelligence

### 6.1 Trigger model

**`workflow_dispatch` only, for now.** Inputs (all optional):

| Input | Default | Meaning |
| --- | --- | --- |
| `mandrel_version` | pinned in `package.json` | bump-and-benchmark a specific release |
| `model` | current default (e.g. `claude-opus-4-8`) | cohort's model key |
| `scenarios` | all three | subset for probes |
| `target_n` | per-scenario `targetN` (§3.2) | override per-cell target |
| `max_cost_usd` | 150 | per-invocation ceiling |
| `dry_run` | false | plan only — print the deficit and estimated cost, run nothing |

The workflow is written so that adding a weekly `schedule:` trigger later is
a one-line change — the top-up planner already makes an unchanged-cohort run
a near-zero-cost no-op — but scheduling stays **off** until deliberately
enabled. A `repository_dispatch` hook from the mandrel repo's release
workflow is a natural later add for release-triggered runs; same property.

### 6.2 The top-up planner

The first job resolves the cohort triple, reads `results/`, and computes the
**deficit**: for each of the 6 cells, `max(0, target_n − validRuns)` where
valid = schema-valid, routing-contract-matched records for the exact triple.

- Complete cohort → the run reports "cohort complete, nothing to do" and
  exits (cost ≈ $0). This is the "has this combination already been
  benchmarked?" intelligence.
- Partial cohort (a prior run hit its cost ceiling, or a crash) → only the
  missing runs execute. The existing append-only checkpoint/resume design
  already makes this safe; the planner lifts it from run-level to
  cohort-level.
- New mandrel version, new model, or new benchmark version → the triple is
  new, the deficit is the full matrix, and a fresh cohort fills.

### 6.3 Execution topology

```text
plan (deficit per cell)
  └─► matrix job per cell with deficit > 0   [max-parallel: 6]
        create sandbox repo → run deficit runs serially → destroy
        upload scorecards + .raw provenance as artifacts
  └─► aggregate (needs: all cells)
        merge artifacts into results/ (append-only NDJSON concat)
        render cohort report + regenerate results.html
        run feedback stage (§7)
        open results PR
  └─► publish (on results-PR merge to main)
        deploy results.html to GitHub Pages
        file feedback issues (§7)
```

- Per-cell wall-clock at N=8: epic-scope mandrel ≈ 8 × ~31 min ≈ 4.2 h —
  inside the 6 h job limit. If a beefier epic-scope scenario approaches the
  limit, the matrix shards by run-index range (`runs 1–4`, `runs 5–8`)
  within a cell; scorecard merging is unaffected (append-only).
- Cost enforcement: the planner allocates `max_cost_usd` across cells from
  observed per-run cost history (falling back to static estimates); each
  cell job also carries the existing `BENCH_MAX_COST_USD` in-loop stop.
- Runner needs: Node 22+, `claude` CLI, `gh`, the two secrets. Local
  operation (`npm run bench`, `/benchmark`) remains fully supported — CI is
  a caller of the same harness, not a fork of it.

### 6.4 HITL moves to the PR

The `/benchmark` workflow's mid-run STOP gates are for interactive use. In
CI, results land as a **pull request** (scorecards + report + dashboard +
feedback summary); review of the scorecard *is* PR review. Nothing reaches
`main` — and no feedback issue is filed (§7) — until the PR merges.

Estimated full-cohort cost at current prices: **$500–750** — dominated by
epic-scope mandrel runs (~$23 for touch 1 today; the beefed-up scenario and
the second touch (§4.5) roughly double the rung 2–3 cells). Re-estimate
after the first cohort on the new matrix and tune `max_cost_usd` defaults;
per-phase envelopes (§3.4) make the estimate decomposable by stage.

## 7. The feedback loop: auto-filed issues on mandrel

The report's "Recommended improvements" section stops being a dead end
(supersedes D-009). A `bench/feedback/` stage runs after aggregation:

### 7.1 Finding classes

1. **Regressions** — a dimension delta vs. the *previous comparable cohort*
   (same model + benchmark version, prior mandrel version) that is outside the noise
   band in the unfavorable direction.
2. **Standing costs** — overhead-floor findings (ceremony tax at
   hello-world), overhead-ratio at depth, monotonicity violations.
3. **Trap differentials** — per defect class: a control-arm clean-rate
   advantage (enforcement is *hurting*), or a mandrel clean-rate that fails
   to clear the band (enforcement isn't paying for itself on that class).
4. **Pipeline calibration** — routing-contract mismatch rates (§3.3),
   autonomy losses (`agent::blocked`, manual rescues), telemetry gaps.
5. **Attribution & continuity findings** — plan-phase vs deliver-phase gaps
   from the §3.4 decision table, and touch-2 artifact-quality findings
   (§4.5): ceremony paid in touch 1 that failed to pay out in touch 2.

### 7.2 Mechanics

- Each finding gets a stable **fingerprint**
  (`class + scenario + dimension/defect-class`) embedded as an HTML marker
  in the issue body.
- The stage searches `dsj1984/mandrel` open issues labeled
  `bench-feedback` for the fingerprint: **hit → append a comment** with the
  new cohort's numbers (a time-series on the issue); **miss → file a new
  issue** with the finding, the cohort triple, links to the scorecards/report
  lines, and the noise-band evidence.
- Labels: `bench-feedback` + `meta::framework-gap` (or the mandrel-side
  taxonomy in force), **plus a phase tag** — `phase::plan`,
  `phase::deliver`, or `phase::artifacts` — derived from the §3.4
  attribution table and the §4.5 continuity read, so a finding routes to
  the half of Mandrel that owns it and Mandrel's own `/plan` flow can
  triage it like any other intake.
- **Gated on results-PR merge** (a GitHub Action on merge, or a
  `--file-feedback` step in the PR flow): an unreviewed cohort never writes
  to the mandrel repo. Dedup-by-fingerprint plus merge-gating is the
  anti-spam design.
- Findings are *also* always embedded in the results PR body, so the loop
  degrades gracefully to D-009 behavior if the token lacks cross-repo write.

## 8. Measurement standards review

Dimension-by-dimension verdict on whether each measurement is a meaningful
standard, and what changes:

| Dimension | Verdict | Target-state change |
| --- | --- | --- |
| **Quality** | Sound but saturating — expected at frontier tier. | Unchanged formula. Explicitly documented as a *floor check* (both arms must pass), not the differential signal. The differential lives in the trap axis. |
| **Planning fidelity** | Right signals, one noisy input: `fileFootprintDrift` penalizes single-file scenarios absurdly (hello-world scores 0.67 on a perfect delivery). | Footprint accuracy becomes proportional to plan size and is dropped from the mean when the plan declares ≤ 1 file. Control arm stays `null` (not comparable) — reported as mandrel-only calibration, not a delta. |
| **Autonomy** | Weak as a *value* signal (control trivially scores 1 — it has no gates to get stuck at). | Reclassified in reporting as a **guardrail**: mandrel-arm autonomy must stay ≥ threshold (default 0.99 across the cohort); any drop is a finding (§7 class 4). No longer presented as a mandrel-vs-control delta. |
| **Maintainability** | Sound two-oracle shape; proportional penalties landed (#59). | Unchanged. Judge cross-check should actually run in CI (it is frequently `null` today — wire the judge into the CI path). |
| **Security** | Sound shape, historically mis-scoped (fixed by overlay git-exclude, #58/#59). | Unchanged formula. The `null`-score path (no signals collected) must become a loud warning, not a silent n/a. Overlaps with the trap axis are fine: security scores the *general* posture, traps score *specific planted defects*. |
| **Efficiency** | The strongest current signal; vector shape is correct. | Unchanged. Never collapsed. |
| **Overhead ratio** | The flagship cost metric, but frequently `null` exactly where it matters (standalone routing → no lifecycle phase-split). | The standalone-telemetry adapter must yield a phase-split for story-routed runs (ceremony = plan/issue/PR phases, codegen = implementation phase, derived from Story telemetry timestamps + the session envelope). `null` only when telemetry is genuinely absent — which is itself a §7 class-4 finding. |
| **Trap axis** (new) | — | First-class reported axis per §4.4: per-class + clean-rate distributions with mean / spread / worst-case per arm. |
| **Plan quality** (new) | — | Mandrel-only intrinsic axis per §3.4: coverage, decomposition sanity, constraint surfacing, scored on the pre-delivery plan snapshot. Exists to attribute findings to `/plan` vs `/deliver`, not to compare against control. |
| **Continuity delta** (new) | — | Touch-2 differential per §4.5: outcome/cost of a fresh session extending the delivered system, mandrel-artifacts-inherited vs code-only. The direct measurement of Mandrel's persistence thesis. |

Cross-scenario derivatives (D-010) survive: the monotonicity check gains the
routing-contract guard so it stops warning on structurally-incomparable
cells; the overhead-floor estimate is unchanged and feeds §7 class 2.

## 9. Current state → target state

The delta at a glance, mapped to the migration phase that closes each gap
(current state as of benchmark 0.4.0 / mandrel 1.75.0):

| Area | Current | Target | Phase |
| --- | --- | --- | --- |
| Sandbox substrate | ✅ **Delivered** (Stories #71/#72/#73, D-013). Ephemeral per-cell repos (`bench-sbx-<cohort>-<scenario>-<arm>-<nonce>`) from in-repo `bench/sandbox-template/`; `bench-sbx-` prefix + TTL janitor sweep; standing `mandrel-bench-sandbox` repo retired and every code/test/README reference swept | Ephemeral per-cell repos from in-repo `bench/sandbox-template/`; janitor sweep; standing repo retired | 1 |
| Scenario corpus | ✅ **Delivered** (Stories #74/#75/#78/#79, D-015). 3 rungs: `hello-world` (instrumentation), `story-scope`, `epic-scope`; `crud-db`/`project-api`/`auth-trap` retired from the working tree | 3 rungs: `hello-world` (instrumentation), `story-scope`, `epic-scope`; old rungs 2–4 absorbed and retired | 2 |
| Quality gates | ✅ **Delivered** (Story #74). Un-stubbed lint/typecheck/test scripts on every scenario's sandbox `package.json`, identical for both arms — the former single-scenario special case was inverted, not extended | Un-stubbed lint/typecheck/test on every rung, both arms | 2 |
| Trap scoring | ✅ **Delivered** (Stories #74/#75/#78, D-015). Per-class oracle modules on `story-scope` (2 classes) and `epic-scope` (4 classes), each with a discrimination unit test; `trap` block first-class in the schema, the Markdown report, and `results.html` | Multi-class traps on rungs 2–3 with per-class oracles; trap axis first-class in schema, report, dashboard | 2 |
| Routing comparability | ✅ **Delivered** (Story #76). `routing` contract on every scenario; a mandrel-arm record whose observed `routingVerdict` diverges is marked `routingMismatch: true`, excluded from the cell's noise-band pool, and counted toward a >25% mismatch-rate finding | Routing contract per scenario; mismatches excluded from bands and counted as findings | 2 |
| Planning fidelity | ✅ **Delivered** (Story #77, D-018). Footprint accuracy proportional to declared plan size; dropped from the dimension mean for ≤1-file plans | Footprint proportional to plan size; dropped for ≤ 1-file plans | 2 |
| Autonomy | ✅ **Delivered** (Story #77/#79, D-018). Reported as a mandrel-arm guardrail (`dimensions.autonomy.guardrail = { threshold, met }`, default 0.99) in its own report/dashboard section; excluded from the Mandrel-vs-control delta table (`SCALAR_DIMENSIONS`) | Guardrail: mandrel-arm threshold, drops become findings | 2 |
| Overhead ratio | ✅ **Delivered** (Story #77, D-018). Phase-split derived from the standalone-Story telemetry adapter's `createdAt`→`closedAt` span when the mandrel arm routed through the standalone path; `null` only when telemetry is genuinely absent (itself a loud `warnings[]` entry) | Phase-split derived from standalone-Story telemetry; `null` only when telemetry absent | 2 |
| Cohort identity | `(model, mandrelVersion)`; benchmark version untracked | Triple `(model, mandrelVersion, benchmarkVersion)`; pooling filters on all three | 3 |
| Run automation | Local-only (`npm run bench` / `/benchmark`); CI lints and unit-tests the harness | `workflow_dispatch` CI with top-up planner, parallel per-cell matrix, results PR | 3 |
| HITL | Interactive STOP gates inside `/benchmark` | Results-PR review is the gate in CI; interactive gates remain for local runs | 3 |
| Per-cell N | Uniform `BENCH_N` | Per-scenario `targetN` (8/8/4); hello-world runs first as canary | 3 |
| Feedback loop | "Recommended improvements" prose in the report; never filed (D-009) | Auto-filed, fingerprint-deduplicated issues on the mandrel repo, gated on results-PR merge | 4 |
| Phase attribution | One session per run; `/plan` and `/deliver` indistinguishable in cost and outcome | Phase-scoped sessions with per-phase envelopes; plan snapshot + plan-quality axis; phase-tagged feedback | 5 |
| Continuity value | Unmeasured — one-shot greenfield only | Second-touch change requests on rungs 2–3; continuity delta + regression traps | 5 |
| Dashboard | `results.html` committed to the repo only | Also published to GitHub Pages on results-PR merge | 3 |

## 10. Migration plan

Phased so every phase leaves the benchmark runnable and each is an
Epic-sized unit for `/plan`:

1. **Phase 1 — Self-contained sandbox.** ✅ **Delivered** (Stories #71, #72,
   #73). `bench/sandbox-template/`, ephemeral repo lifecycle in `sandbox.js`,
   janitor, config/env migration, retire the standing sandbox repo. *Exit: a
   full local run with no reference to `mandrel-bench-sandbox`.* — met; the
   reference sweep (Story #73) is grep-enforced by
   `tests/bench/driver/no-standing-sandbox.test.js` plus a CI-checkable
   `git grep` in the Story's own `verify[]`.

   **Implementation deltas discovered during delivery:**
   - The retired env vars (`BENCH_SANDBOX_REPO_URL`/`REPO`/`BASELINE_REF`)
     are not simply removed — `bench/run.js` keeps a small
     `RETIRED_SANDBOX_ENV_VARS` deprecation-warning shim so an operator
     still configured for the old standing-repo path gets a named-replacement
     warning instead of silent misconfiguration. That shim is the sole
     permitted post-retirement reference to the old env-var names and is
     explicitly exempted by the Story #73 regression-guard test.
   - `overlay.js`'s `.agentrc.json` rewrite (`rewriteAgentrc`) needed no
     mechanism change — it already took `{ owner, repo }` as a parameter, so
     repointing it at the ephemeral repo's dynamic coordinates was a
     call-site change only, not a rewrite of the overlay itself.
   - **Correction (Epic #65 audit remediation, 2026-07-09):** the Story
     #71/#73 delivery had `bench/run.js`'s `main()` provision exactly ONE
     shared `bench-sbx-*` repo for the whole invocation (arm hardcoded to the
     literal `'session'`), reused/reset across every cell — contradicting
     §5.2's per-cell lifecycle below and silently defeating the cell-level
     parallelism §5.5 describes. This is now fixed: `main()` provisions,
     seeds, runs, and destroys one repo per `(scenario × arm)` cell, with the
     real arm value in the repo name (see `docs/decisions.md` D-013's
     correction note). The design in §5.2/§5.5 was always the intended
     target; the "Delivered" marks above now reflect a genuinely matching
     implementation.
2. **Phase 2 — Scenario matrix + measurement fixes.** ✅ **Delivered**
   (Stories #74–#79; D-015, D-018). `story-scope` and `epic-scope` built
   (absorbing the retired `auth-trap`/`crud-db`/`project-api` scenarios),
   un-stubbed gates generalized to every scenario, multi-class trap oracles +
   discrimination tests landed, routing contracts enforced in pooling, the
   trap axis rendered as a first-class report/dashboard section, and the §8
   measurement fixes (planning-fidelity proportionality, autonomy guardrail,
   overhead-ratio phase-split, loud nulls) landed. The old scenarios and the
   legacy `results/` corpus were retired from the working tree (Story #79).

   **Implementation deltas vs. the original plan:**
   - **The exit criterion below was narrowed by explicit operator decision.**
     The original exit bar ("one full local cohort on the new matrix") is
     NOT met by this delivery — running the first cohort is a cost-bearing,
     operator-gated `/benchmark` invocation, explicitly carved out as a
     Non-Goal of both the Epic and Story #79. What ships here is the code,
     schema, report/dashboard rendering, and docs; the first live cohort run
     is a follow-up the operator triggers separately.
   - **"Restarts cleanly under the triple key" was aspirational, not
     accurate.** The `(model, mandrelVersion, benchmarkVersion)` triple
     cohort key (D-014) is Phase 3 scope, not delivered here. Comparisons
     restart cleanly for a simpler reason: the legacy `results/` corpus
     (1.70.0/1.72.0/1.75.0 scorecards + `.raw/`) was deleted outright rather
     than migrated, on an explicit pre-authorization from the operator
     (2026-07-09) that prior results carry no continuity obligation across
     this cutover — the schema change (`trap`, `routingMismatch`) needed no
     back-compat shim as a result.
   - **Trap classes attach directly to the two value rungs**, not to a
     separate spike scenario as the pre-Epic-#66 corpus did — `story-scope`
     absorbed the retired single-defect spike's frozen suite and
     `plaintext-password` oracle as its foundation rather than the matrix
     growing a fourth, dedicated trap-only rung.
3. **Phase 3 — CI automation.** The `workflow_dispatch` workflow, top-up
   planner, matrix topology, artifact aggregation, results-PR flow,
   `benchmarkVersion` in schema + cohort filtering, GitHub Pages publish on
   merge. *Exit: a cohort produced end-to-end by CI with a zero-cost no-op
   rerun proving top-up, and the dashboard live on Pages.*
4. **Phase 4 — Feedback loop.** `bench/feedback/`, fingerprinting, dedup,
   merge-gated filing on the mandrel repo. *Exit: a real cohort files (or
   comment-updates) at least one issue class end-to-end.*
5. **Phase 5 — Phase attribution + second touch.** Split mandrel-arm runs
   into phase-scoped sessions with the plan snapshot and plan-quality axis
   (§3.4); frozen change requests, touch-2 scoring with regression traps,
   and the continuity delta (§4.5); phase tags in the feedback stage.
   *Exit: a cohort whose report shows per-phase cost, plan-quality scores,
   and touch-2 continuity deltas, and whose feedback filings carry
   `phase::*` tags.*

Phases 1 and 2 are independent enough to plan together; 3 depends on 1
(parallel cells need per-cell repos); 4 depends on 3 (feedback fires from
the CI aggregate stage); 5 depends on 2 and enriches 4 — feedback v1 runs
without attribution, then gains phase tags when 5 lands.

## 11. Decision deltas

To be logged in `decisions.md` as each phase lands:

| New | Supersedes / amends | Substance |
| --- | --- | --- |
| D-013 | new | Ephemeral per-cell sandbox repos materialized from an in-repo template; standing sandbox repo retired. |
| D-014 | amends D-004 | Cohort identity is the triple `(model, mandrelVersion, benchmarkVersion)`; pooling and comparison filter on all three. |
| D-015 | amends D-006, executes D-012 follow-up | Corpus is the 3-rung matrix (`hello-world`, `story-scope`, `epic-scope`); traps and un-stubbed gates are folded into rungs 2–3; trap axis is first-class; `crud-db` / `project-api` / `auth-trap` retired. |
| D-016 | supersedes D-009 | Feedback findings are auto-filed on the mandrel repo, fingerprint-deduplicated and gated on results-PR merge. |
| D-017 | amends D-005 | Benchmark runs on-demand via CI with cohort top-up intelligence; scheduling deliberately off until enabled. |
| D-018 | amends §8 | Autonomy reclassified as a guardrail; planning-fidelity footprint fix; overhead-ratio phase-split from standalone telemetry. |
| D-019 | amends D-008 | Mandrel-arm run = ordered phase-scoped sessions (`/plan`, `/deliver`) with per-phase cost envelopes; plan artifacts snapshotted and scored as an intrinsic plan-quality axis for phase attribution. |
| D-020 | new | Second-touch evolution phase on rungs 2–3: frozen change requests executed by fresh sessions, artifact inheritance as the treatment, continuity delta + regression traps. |
| D-021 | new | `results.html` publishes to GitHub Pages on results-PR merge. |

## 12. Risks & open questions

- **Trap contamination.** Trap oracles and defect descriptions must never
  reach the sandbox or either arm's prompt (they live only in this repo,
  which is never overlaid — the git-exclude overlay discipline from #58
  already enforces the boundary). Scenario prompts must stay *terse and
  natural*; a prompt that hints "remember to hash passwords" destroys the
  headroom the trap needs.
- **Epic-scope cost creep.** A 4–6 Story epic with real gates will exceed
  the current ~$23/run. If a full cohort passes ~$600, revisit `target_n`
  for the epic cell (an N=6 epic cell with honest wider bands may beat an
  unaffordable N=8).
- **The null result remains live.** Even the designed epic-scope stressor
  may show flat trap deltas at frontier tier. D-012's gate carries forward
  verbatim: report it and stop; do not iterate traps chasing a signal.
- **Model matrix.** Cohorts are per-model; nothing schedules multi-model
  sweeps. When a new Claude model releases, a manual dispatch with
  `model: <new>` starts its cohort. Whether older-model cohorts are ever
  topped up is an operator call — the planner makes either cheap.
- **Repo-creation permissions.** Fine-grained PATs gate `delete_repo`
  broadly; if scoping proves awkward, fall back to a dedicated machine
  account whose *entire* namespace is disposable, making the janitor's
  prefix rule trivially safe.
- **Plan-rubric Goodhart.** The constraint-surfacing input (§3.4) must not
  reward checkbox prose ("we will hash passwords") over genuinely
  load-bearing plans. Mitigations: it carries low standalone weight, the
  judge cross-checks substance, and attribution always crosses plan score
  with *outcome* — the rubric alone never files a finding.
- **Touch-2 identity discipline.** The change requests are frozen spec; any
  edit to them is a benchmark-version change (new cohorts), never a tweak
  within one. Regression-trap oracles need their own discrimination tests,
  same as touch-1 oracles.

**Considered and deferred** (revisit deliberately, not by drift):

- **Cross-tier cost-parity arm** — mandrel+Sonnet vs control+Opus vs
  control+Sonnet: "does scaffolding lift a cheaper model to frontier-grade
  output?" The natural next attack on the D-012 headroom problem if trap
  and continuity deltas stay flat at same-tier. Cheap per run; adds cells,
  not apparatus — the cohort model already supports it (a cohort per
  model).
- **Adaptive N / sequential stopping** — end a cell early once the delta
  verdict is decidable either way. Worth designing only after per-cell cost
  history is rich enough to justify the statistical care (peeking bias).
