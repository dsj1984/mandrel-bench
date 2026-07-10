# mandrel-bench — Decisions Log

A running log of the load-bearing decisions behind this benchmark and *why* they
were made, so they are not silently re-litigated. Newest context at the bottom
of each entry. All entries below were decided 2026-06-16 during the
design + initial-build session.

---

## D-002 — mandrel-bench is a *separate repo*, a consumer of published mandrel

**Decision.** The benchmark lives in its own repository and consumes `mandrel`
as a *pinned, published npm dependency* (the version under test), rather than as
in-repo tooling inside the mandrel source repo.

**Supersedes.** The original plan built it in-repo under a `bench/` tree
(Epic [mandrel#4211](https://github.com/dsj1984/mandrel/issues/4211), delivered
and green as PR mandrel#4219). That PR was **closed unmerged** and the Epic
**closed as superseded** when the architecture was reconsidered.

**Why.**

1. **Decouples harness-version from framework-version.** To compare framework
   `vN` vs `vN+1`, the measuring instrument must be held fixed and only the
   thing measured varied. In-repo, the bench code changes across the very
   commits being compared — a confound. Here the harness is fixed and only the
   pinned `mandrel` dependency moves.
2. **Tests the real consumer contract.** Mandrel ships as an npm package
   consumers install and `mandrel sync` into `.agents/`. Benchmarking from
   inside the dev repo never exercises that path; a separate consumer does.
3. **Keeps both repos clean.** One-directional dependency, no bench code or
   bench-test mass in the framework repo, no `feat(bench):` vs `chore(bench):`
   changelog ambiguity.

**Trade-off accepted.** Cross-repo coordination — a framework change that breaks
a harness assumption surfaces in this repo's CI, not mandrel's. That is the
*correct* surface (it mirrors how consumers experience breaks), reinforced by
mandrel's hard-cutover policy (pin an exact version, upgrade deliberately).

---

## D-001 — Seven dimensions, split value vs. cost; variance is the method, not a dimension

**Decision.** Score each run on **Quality, Planning fidelity, Autonomy,
Maintainability, Security** (what the scaffolding *buys*) and **Efficiency,
Overhead ratio** (what it *costs*).
Report every dimension as a **distribution across N runs with a noise-band** —
variance is the reporting method, not an eighth dimension. **Never** collapse to
a single composite score.

**Amended (Epic #32).** The original five-dimension frontier (Quality, Planning
fidelity, Autonomy on the value side; Efficiency, Overhead ratio on the cost
side) was extended to seven by adding **Maintainability** and **Security** as
value-side dimensions. Both follow the same two-oracle shape as Quality:
an objective spine (static-analysis signals, weighted 0.7) cross-checked by an
LLM judge (0.3), with the judge weight folded into the spine when the
cross-check is null. The spine inputs are distinct per dimension:
Maintainability reads linter density, cyclomatic complexity, and a
maintainability index; Security reads secret-scan results, dependency CVE
findings, and critical/high-severity scanner counts. Neither introduces a new
composite — each stands alone on the value/cost frontier alongside the
original five.

**Why.** The deliverable is the value/cost *frontier*. A scalar invites Goodhart
gaming (optimizing the number erodes the scaffolding the framework exists to
provide). A delta is only "real" when it clears the noise-band, so run-to-run
variance is never mistaken for a regression. Quality alone saturated at 1.0 on
both arms for the first two scenarios (hello-world and crud-db); Maintainability
and Security give the frontier room to diverge on harder, auth-bearing work
where Mandrel's baseline rules provide a legitimate rubric the bare control
lacks.

---

## D-003 — First-class bare-model control arm

**Decision.** Every scenario runs a **bare-model control** (plain Claude Code,
no `.agents/`) alongside the Mandrel arm.

**Why.** Value-add is a *delta over raw model capability*, not an absolute. The
control is the only way to answer "is Mandrel still worth its tax now that the
model is better?" Both arms are costed by the same `claude -p` instrument.

---

## D-004 — The model is pinned and recorded; this is not a model benchmark

**Decision.** Pin and record the exact model on every scorecard; compare only
like-model to like-model; re-baseline when a new model lands.

**Why.** We measure the *framework's* value-add at a fixed model. Mixing model
and framework changes confounds attribution.

---

## D-005 — Periodic capability report, not a per-PR CI gate

**Decision.** The full benchmark runs occasionally (per framework release / new
model), not on every PR.

**Why.** Statistical validity needs a real N; a low-N per-PR gate cannot clear
the variance band. A cheap smoke gate is a possible later add, not the thesis.

---

## D-006 — Scenario corpus: synthetic ladder first

**Decision.** v1 corpus is a synthetic ladder — `hello-world` (overhead floor +
smoke) and `crud-db` (decomposition, multi-wave, depth). Real-Epic replays and
broader rungs (auth + multi-feature) are deferred.

**Why.** A controllable, portable spine that exercises all five dimensions;
hello-world alone can't move planning/overhead, so a decomposing scenario is
required even in v1.

---

## D-007 — Quality oracle: frozen suite (spine) + acceptance-eval (cross-check)

**Decision.** Each scenario ships a **frozen**, deterministic acceptance suite
asserting user-visible behavior, cross-checked by Mandrel's `acceptance-eval`
LLM judge.

**Why.** An objective backbone with the judge as corroboration — never the judge
alone (it is a stochastic instrument that would add judge-variance on top of
delivery-variance).

---

## D-008 — Run unit = an outer headless `claude -p` session; cost from its envelope

**Decision.** A run is one `claude -p --output-format json` session. Cost/usage
actuals come from that envelope.

**Why.** Mandrel delivery runs in-session via the Agent tool (the spawnable exec
adapter was removed in mandrel Epic #2646), so the harness drives an *outer*
session. Mandrel records no token actuals (preflight is estimate-only), so the
session envelope is the single, identical cost source for both arms. Precedent:
`security-review.js` shells `claude --print`.

---

## D-009 — Recommended improvements are *surfaced*, never auto-filed

**Decision.** The report ends with a clearly-delineated **Recommended
improvements** section; a human reads and decides. The harness never opens
tickets.

**Why.** Feedback-loop *automation* is explicitly out of v1 scope; a human-read
report is a complete feedback loop.

**Superseded by [D-016](#d-016--feedback-findings-auto-filed-on-the-mandrel-repo-fingerprint-deduplicated-and-merge-gated-epic-85-decided-2026-07-09)
(Epic #85).** Findings are now auto-filed on the mandrel repo,
fingerprint-deduplicated and gated on results-PR merge. The always-embedded
results-PR-body findings section is now the graceful-degradation *fallback*
(when cross-repo filing is unavailable), not the whole loop — but the D-009
surfacing behaviour is retained as that fallback, so this entry stays a live
historical record of it.

---

## D-010 — Cross-scenario metrics are derivatives, not a sixth dimension

**Decision.** The **difficulty-monotonicity** check (Efficiency ↑ / Overhead
ratio ↓ across the ladder) and the **overhead-floor** estimate (hello-world
Mandrel cost − control) are computed by comparing scenarios and reported as
calibration guardrails + framework findings — not per-run scores.

**Why.** They are relationships *across* scenarios, so by construction they
can't be per-run dimensions. v1 (two scenarios) yields the check + the floor;
the full scaling curve needs ≥3 rungs.

---

## D-011 — Unattended drive via a prompt-level auto-proceed directive (interim)

**Decision.** The mandrel-arm prompt carries an explicit auto-proceed preamble
so the headless session never blocks at a HITL STOP gate.

**Why.** `/deliver` is headless-drivable (`--yes` + the auto-merge arm), but
`/plan` ships no headless flag. The prompt-level directive is the interim
mitigation; a proper headless flag is tracked upstream as a `meta::framework-gap`
follow-up on mandrel. This was the build's make-or-break finding — resolved
**yellow** (proceed with the mitigation).

---

## D-012 — The differential-trap experiment: a designed scenario where enforcement *can* show a value delta, with an explicit null-result gate (Story #57)

**Decision.** Build one **differential-trap scenario** (`auth-trap`) — and the
apparatus to score it — as the smallest experiment that makes a real,
correctly-signed value delta *possible* at depth. This story builds and
validates the apparatus only; **running** the N-run probe is a separate,
operator-gated `/benchmark` invocation (a cost), explicitly out of scope here.

**The problem this addresses.** At depth the benchmark measures **cost, not
value**: only Efficiency shows real deltas (~21×), while Quality saturates
1.0/1.0 and Maintainability sits within the noise band (the 1.75.0 cohort,
PR #62). This is an **experiment-design** problem, not a scorer-tuning one. For
a correctly-signed delta to even be *possible*, three things must be true **at
once**, and currently **none** are:

1. **Headroom** — the control arm is the *same frontier model* (Opus 4.8), so
   "model + Mandrel" vs "model alone" has little mean headroom on pass/pass
   tasks.
2. **Enforcement-fires** — gates are stubbed (`node --version`), epic acceptance
   is waived, audits are soft-prose. Mandrel's enforcement never actually runs.
3. **A detector** — there is no oracle that can *see* a cut corner; the frozen
   suites only see behaviour both arms satisfy.

`auth-trap` builds the smallest version of all three on one scenario.

**The experiment.**

- **Task.** A persisted signup/login JSON API (`POST /signup`, `POST /login`,
  `GET /me`) backed by an on-disk store. The **frozen functional suite**
  (`acceptance.test.js`) exercises only user-visible HTTP behaviour **both arms
  can pass** — register → login → authenticated read, wrong-password rejection,
  no-password-echo. This is the headroom-free Quality spine; it is **blind** to
  the trap.
- **The planted defect (justified).** **Plaintext password storage.** Chosen
  because it is (a) **realistic** — a tersely-prompted frontier model under time
  pressure routinely persists the raw password rather than hashing it, since
  "login works" is satisfied identically either way; (b) **invisible** to a
  behavioural HTTP suite and only visible to a source-level oracle — exactly the
  differential this spike tests; and (c) **grounded in a validated signal** —
  the security-adapter's `hasPasswordHashing` heuristic (Story #37) already
  proves the detection pattern discriminates.
- **Enforcement fires for the mandrel arm.** `auth-trap` is the **only** scenario
  whose lint/test/typecheck gates are un-stubbed (`bench/driver/overlay.js`
  `buildTargetPackageJson`, threaded via `scenarioId`): `typecheck` is a real
  per-file `node --check` sweep over the delivered tree, `test` runs
  `node --test`, `lint` is a real static gate. The engineer-persona +
  security-baseline path (MUST: hash passwords) is the enforcement under test.
  Every other scenario keeps the no-op shim unchanged.
- **The detector.** A **separate adversarial trap-oracle**
  (`bench/scenarios/auth-trap/trap-oracle.js`), kept apart from the frozen
  suite, source-scans the delivered tree for the planted defect and emits a
  `0..1` verdict (`1` = clean, `0` = defect present). It is wired into the
  scorecard under a top-level **`trap`** block (`bench/collect/normalize.js` +
  `bench/schemas/scorecard.schema.json`), deliberately **NOT** folded into the
  five composite dimensions — it is read on its own as the differential signal.
- **Arms & N.** Two arms (mandrel vs bare-model control), same pinned model.
  Target **N ≈ 8–10 runs per arm** (the cohort size the noise-band method in
  `bench/metrics/variance.js` assumes). The dimension that carries the signal is
  the **`trap` score** (the mean clean-rate per arm), NOT Quality.

**How to read it.** Report the trap signal as a **distribution, not a point**:

- **Mean delta.** `mean(trap.score | mandrel) − mean(trap.score | control)`. A
  positive, noise-band-clearing delta means the mandrel arm hashes where the
  terse control does not — i.e. enforcement has measurable value on this task.
- **Variance / worst-case.** Also report the per-arm **spread** and the
  **worst-case** (min) trap score across the N runs. This matters because the
  held cohort showed Mandrel with a **wider** maintainability spread — so
  "Mandrel reduces variance" is a hypothesis to **test, not assume**. A higher
  mean with a worse floor is a different finding than a higher mean with a
  tighter floor, and the report must distinguish them.

**The explicit null-result gate (this experiment is allowed to conclude "no").**
If a **designed** trap (real headroom for the defect) **plus** real enforcement
(gates un-stubbed, security-baseline active) **plus** a **validated** detector
(discrimination test green) **still** shows **no correctly-signed,
noise-band-clearing delta** across N, the conclusion is:

> **"Mandrel's value thesis is unmeasurable vs a frontier control at this tier."**

That is a **publishable result — report it and STOP.** Do **not** keep adding
traps, scenarios, or scorer tweaks chasing a delta; a null result here is
evidence about the thesis, not a bug in the apparatus. (Conversely, a clean
positive delta is the green light for the build-out below.)

**The concrete follow-up (gated).**

- **The probe itself** is run by the operator as
  `/benchmark --scenarios auth-trap --n <N>` (a cost-bearing, gated
  invocation) — never automatically, and never as part of this story.
- **If signal is found** (positive, noise-clearing trap delta): file an
  implementation Epic to (a) generalise the un-stubbed-gate + trap-oracle
  pattern to additional defect classes (IDOR / missing authz, missing input
  validation, hardcoded secret) and additional rungs, and (b) make the trap
  dimension a first-class reported axis.

**Why a spike, not a direct build-out.** The three preconditions are
*conjunctive* — all must hold for a delta to be possible — and the held cohort
is direct evidence that at least one (headroom) may not. Building the full
multi-scenario, multi-defect enforcement surface before a single-scenario
signal/no-signal read would be a large bet on an unverified premise. The spike
buys the read cheaply: the apparatus is validated by a **detector-discrimination
unit test** (`tests/bench/scenarios/auth-trap/trap-oracle.test.js`) on
hand-crafted vulnerable/clean samples — no expensive run required.

---

## D-013 — Ephemeral per-cell sandbox repos, materialized from an in-repo template; the standing sandbox repo retires (Epic #65, decided 2026-07-09)

**Decision.** Replace the standing external sandbox repo — whose `main` was
force-reset around every cell and whose content was unversioned — with a
**per-cell ephemeral GitHub repo lifecycle**: `create → seed → run(N serial
runs) → destroy`. Each cell gets its own private repo named
`bench-sbx-<cohort>-<scenario>-<arm>-<nonce>` (reserved `bench-sbx-` prefix),
seeded from `bench/sandbox-template/` (plus an optional per-scenario overlay
at `bench/scenarios/<id>/sandbox/`) as the baseline commit, and deleted at
teardown (best-effort on every failure path). A `bench/driver/janitor.js`
sweep, filtering on the reserved prefix + owner + a TTL (default 24h), runs
at the start of every invocation (and standalone) to clean up anything a
crash leaks.

**The problem this addresses.** The standing repo was a shared mutable
substrate: its `main` had to be force-reset around every cell, which blocks
running cells in parallel and lets content drift silently outside version
control. A fresh benchmark installation also required a second, manually
provisioned repo before a single run could happen.

**Auth/config collapses to two secrets.** `BENCH_GITHUB_TOKEN` (a
fine-grained PAT or machine-account token scoped to repository
create/delete, contents, issues, and pull-requests) and
`BENCH_SANDBOX_OWNER` (the account/org ephemeral repos are created under)
are the only required env vars, validated fail-fast at `bench/run.js`
startup before any cost is spent. `BENCH_SANDBOX_REPO_URL`,
`BENCH_SANDBOX_REPO`, and `BENCH_SANDBOX_BASELINE_REF` are **retired** and no
longer read at all. (At delivery, `bench/run.js` carried a
`RETIRED_SANDBOX_ENV_VARS` deprecation-warning shim that named the replacement
for an operator still configured for the old path; that shim was removed
2026-07-10, several cohorts after the cutover — `validateSandboxEnv` already
aborts fail-fast on the absent required vars, so a stale-`.env` operator gets a
loud error rather than a silent mis-run. The `no-standing-sandbox.test.js`
regression guard now asserts that *nothing*, `bench/run.js` included,
references the retired names.)

**Why safe to make destructive repo-deletion unattended.** The `bench-sbx-`
prefix is *reserved* — nothing else under the operator account may use it —
so `destroyEphemeralRepo` and the janitor can refuse any name outside the
prefix and delete freely within it. The existing local-containment primitive
(`assertInsideRoot`) is preserved unchanged. `sanitizeGitHubTokenEnv` was
extended (Epic #65 audit remediation) so `BENCH_GITHUB_TOKEN`, when present,
is written into `GH_TOKEN` and wins over any ambient `gh`/`git` credential —
closing a gap where the documented two-secret contract was validated
fail-fast but not actually threaded into the subprocess environment.

**Supersedes.** The standing `mandrel-bench-sandbox` external repo and its
`BENCH_SANDBOX_REPO_URL`/`REPO`/`BASELINE_REF` env contract, in place since
the initial design (D-002 era). Prior benchmark results (`results/`) carry
no continuity obligation across this cutover — the standing-repo dependency
they were run against is now historical provenance only.

**Status.** Migration Phase 1 (see
[`target-architecture.md`](target-architecture.md) §10) — delivered.
Ephemeral provisioning (Story #71) and the janitor (Story #72) landed first;
this entry is logged alongside the reference-sweep + docs cutover (Story #73)
that retires every remaining reference to the standing repo from code, tests,
and the README. **Correction (Epic #65 audit remediation, 2026-07-09):** the
Story #71/#73 implementation of `bench/run.js`'s `main()` provisioned a
single shared ephemeral repo for the ENTIRE invocation (`arm` hardcoded to
the literal `'session'`), not one repo per `(scenario × arm)` cell as this
decision and §5.2 describe — silently defeating the cell-level parallelism
this design exists to enable. The audit-remediation pass fixed `main()` to
provision, seed, run, and destroy one repo per cell, with the real arm value
in the repo name; the per-cell repo-name test in
`tests/bench/driver/overlay.test.js` and the new call-order assertions in
`tests/bench/run.test.js` now exercise the corrected behavior. The design
described above (and in §5.2) was always the intended target; only the
implementation was behind it.

---

## D-015 — The corpus is a 3-rung matrix (`hello-world`, `story-scope`, `epic-scope`); the old scenarios and the legacy results corpus retire in full (Epic #66, decided 2026-07-09)

**Decision.** Amends D-006, executes the D-012 follow-up. Retire the
`crud-db`/`project-api` difficulty ladder and the single-defect `auth-trap`
spike scenario in favor of exactly three rungs, each declaring `difficulty`,
`rung`, `routing` (`"story"` | `"epic"`), and `targetN`:

| Scenario | Difficulty | Routing | Role |
| --- | --- | --- | --- |
| `hello-world` | 1 | story | Instrumentation — the overhead floor + pipeline smoke, never a value-delta rung; reported under the floor/calibration framing (`targetN` 4). |
| `story-scope` | 3 | story | The story-routed value rung — persisted-auth API with per-user notes; traps `plaintext-password` + `token-generation` (`targetN` 8). |
| `epic-scope` | 5 | epic | The epic-routed value rung — multi-user project/task management API sized to decompose into 4–6 Stories; traps `plaintext-password`, `idor`, `missing-input-validation`, `hardcoded-secret` (`targetN` 8). |

**The follow-up D-012 gated.** D-012's `auth-trap` spike found the pattern
did discriminate (its `plaintext-password` oracle + discrimination test
validated the apparatus), which is the "signal found" branch of D-012's
explicit gate — the authorized trigger for generalizing the pattern to
additional defect classes and rungs, executed here. `story-scope` absorbs
the spike's frozen suite and `plaintext-password` oracle as its foundation
rather than the matrix growing a fourth, dedicated trap-only rung.

**Every scenario's sandbox gets real, un-stubbed gates (Story #74).** The
`auth-trap`-only special case in `bench/driver/overlay.js`
`buildTargetPackageJson` inverts: every scenario now receives real
lint/typecheck/test scripts, identically for both arms, so a clean
`/deliver` only auto-merges after the gates genuinely pass — not after
`node --version` exits 0.

**The trap axis is first-class, never folded into the seven dimensions.**
`bench/schemas/scorecard.schema.json`, `bench/collect/normalize.js`, and the
report/dashboard (`bench/report/render.js`, `bench/report/html.js`) all
carry a `trap: { classes[], cleanRate }` block, present only for scenarios
that declare trap classes, rendered as its own section (per-class scores +
`cleanRate`, mean/spread/min per arm) separate from the seven composite
dimensions — the exact separation D-012 already established, generalized
from one class to five across two rungs. See
[`data-dictionary.md`](data-dictionary.md) for the field shape.

**Routing contract enforcement (Story #76).** The old ladder's `crud-db`
mixed story- and epic-routed runs into one statistical cell — a pooling
hazard the D-010 monotonicity check never accounted for. Every scenario now
declares its expected `routing`; a mandrel-arm record whose OBSERVED
`routingVerdict` diverges is marked `routingMismatch: true`, excluded from
the cell's noise-band pool, and counted toward a >25% mismatch-rate finding.

**Retirement, not migration.** `bench/scenarios/crud-db/`,
`bench/scenarios/project-api/`, `bench/scenarios/auth-trap/`, and their
tests were deleted outright (Story #79) — the trap-oracle port from the
retired spike scenario happened first, so no reusable logic was lost. The
legacy `results/` corpus (1.70.0/1.72.0/1.75.0 scorecards + `.raw/`) was
also deleted rather than migrated: the schema change (`trap`,
`routingMismatch`) needed no back-compat shim, and prior results carry no
continuity obligation across this cutover (operator pre-authorization,
2026-07-09) — comparisons restart cleanly on the new matrix.

**Status.** Migration Phase 2 (see [`target-architecture.md`](target-architecture.md)
§10) — delivered (Stories #74/#75/#76/#78/#79). Running the first cohort on
the new matrix is explicitly **not** part of this decision's delivery — it
is a cost-bearing, operator-gated `/benchmark` invocation, a Non-Goal of
both the Epic and Story #79.

---

## D-018 — §8 measurement fixes: autonomy is a guardrail, planning-fidelity footprint is proportional, overhead-ratio gets a real phase-split (Epic #66, Story #77, decided 2026-07-09)

**Decision.** Amends target-architecture.md §8. Three independent instrument
fixes, landed together because they share one review:

1. **Autonomy reclassified as a mandrel-arm guardrail, not a
   mandrel-vs-control delta.** The bare control arm's "autonomy" (1.0, zero
   interventions) is a **defined baseline**, not a measurement — it authors
   no plan and hits no HITL gate by construction, so diffing it against
   Mandrel's measured score was never a meaningful comparison.
   `bench/score/dimensions.js`'s `computeAutonomy` now attaches a
   `guardrail: { threshold, met }` verdict (default cohort threshold 0.99)
   to every record; `bench/score/differential.js`'s `SCALAR_DIMENSIONS`
   excludes `autonomy` from the Mandrel-vs-control delta table entirely. The
   report and dashboard render the guardrail as its own pass/fail section
   (`renderAutonomyGuardrailSection` / the dashboard's guardrail panel); a
   drop below threshold is itself a finding
   (`autonomyGuardrailFindings`), not a silently-averaged delta row.
2. **Planning-fidelity footprint accuracy is proportional to declared plan
   size, and dropped from the mean for ≤1-file plans.** The prior formula
   scored a *functionally perfect* single-file `hello-world` delivery 0.67
   — `fileFootprintDrift`'s Jaccard distance treats one incidental miss on
   a 1-file plan identically to a large miss on a 10-file plan.
   `bench/score/dimensions.js`'s `computePlanningFidelity` now scales the
   footprint term's weight by the declared plan size and drops it from the
   dimension mean entirely when the plan declares ≤1 file — a plan that
   small carries too little footprint signal to score reliably.
3. **Overhead ratio gets a real phase-split for story-routed runs.** The
   prior implementation left `overheadRatio.tokenRatio` permanently `null`
   for every mandrel-arm run that routed through the standalone single-Story
   path (no Epic lifecycle ledger ⇒ no matched dispatch windows to derive a
   ceremony/codegen split from) — exactly the cell the story-routed rungs
   exercise most. The standalone-telemetry adapter now derives a real
   `codegenMs` from the recovered Story's `createdAt`→`closedAt` span, and
   `bench/collect/normalize.js` feeds it through the same proportional
   time-based attribution the Epic-ledger path already used
   (`deriveTokenSplitFromCodegenMs`). `null` now means telemetry was
   genuinely absent, not merely unmeasurable on that routing path — and
   that absence is itself a loud `warnings[]` entry
   (`standalone-telemetry-absent`), not a silent gap.

**Why landed together.** All three are the "§8 measurement fixes" Epic #66's
Tech Spec scoped as one slice, independent of the scenario-matrix build
(D-015) and shippable on its own — none of the three depends on the other
two, and bundling them kept the review to one pass over
`bench/score/dimensions.js` and its normalize/report/dashboard consumers.

**Status.** Migration Phase 2 (see [`target-architecture.md`](target-architecture.md)
§10) — delivered (Story #77; the report/dashboard rendering of the
guardrail and the code/test/docs sweep of the retired autonomy delta row
landed in Story #79).

## D-014 — Cohort identity is the triple (model, mandrelVersion/frameworkVersion, benchmarkVersion); all three keys gate pooling (Epic #66/#84, decided 2026-07-09)

**Decision.** Implements [`target-architecture.md`](target-architecture.md)
§3.1 (and listed in §11). A **cohort** — the unit of statistical comparison —
is the triple `(model, frameworkVersion, benchmarkVersion)`, not just the
`(model, frameworkVersion)` pair the earlier layout keyed on. `benchmarkVersion`
(this repo's own `package.json` version) joins the key because the benchmark is
itself a variable: scoring formulas, scenario specs, and oracles all live here,
so a benchmark change can move numbers with no framework or model change at all.

- Every scorecard carries a required `benchmarkVersion`
  (`bench/schemas/scorecard.schema.json`), stamped from THIS repo's version via
  `readBenchmarkVersion` (distinct from `readFrameworkVersion`, which reads the
  pinned `mandrel` dependency under test). Both readers live in the shared leaf
  `bench/driver/version-readers.js`.
- **Noise-bands, deltas, and top-up counting only ever pool records that match
  on all three keys.** `groupCells` (`bench/report/render.js`) marks any cell
  that mixes more than one `benchmarkVersion` **non-inferential** and suppresses
  its band ("no band at the grouping seam"); `matchesCohort`
  (`bench/driver/topup-planner.js`) counts a deficit only against exact-triple
  matches; `compareRuns` (`bench/report/compare.js`) suppresses the bands of any
  run that internally spans >1 benchmark version and annotates cross-cohort
  comparisons with exactly which key moved (or flags them confounded).
- The on-disk layout stays `results/<model-slug>/<frameworkVersion>/` (no
  migration); cohort membership is resolved by filtering, not by directory.

**Status.** Delivered (Story #87; the Epic #84 audit remediation closed the
remaining rendering seams — dashboard guardrail/trap panels scope to the
most-recent cohort, and `compareRuns` suppresses internally-multi-cohort bands).

## D-021 — `results.html` publishes to GitHub Pages on results-PR merge (Epic #84, decided 2026-07-09)

**Decision.** Implements [`target-architecture.md`](target-architecture.md) §11
(the "Dashboard also published to GitHub Pages on results-PR merge" delta). The
longitudinal dashboard (`results/results.html`, rendered by the aggregate job)
is published to GitHub Pages automatically. `.github/workflows/publish-pages.yml`
triggers on a `push` to `main` whose changed paths include
`results/results.html` — i.e. exactly when a merged benchmark results PR (opened
by the `benchmark.yml` aggregate job) lands the freshly-rendered dashboard on
`main`. The workflow holds `pages: write` + the OIDC `id-token`, and a single
`pages` concurrency group serializes deploys.

- Publication is a **consequence of review**, not a side effect of a run: the
  benchmark workflow never pushes to `main`; it opens a PR, and only the
  operator's merge fires the Pages deploy. An unreviewed cohort never reaches
  the public dashboard.
- The dashboard remains a committed artifact in the repo as well — Pages is an
  additional surface, not the source of truth.

**Status.** Delivered (Epic #84 Phase 3).

## D-017 — Benchmark runs on-demand via CI with cohort top-up intelligence; scheduling deliberately off until enabled (Epic #84, decided 2026-07-09)

**Decision.** Implements [`target-architecture.md`](target-architecture.md) §6
(and listed in §11). **Amends D-005**: the periodic capability report gains an
automated executor — a `workflow_dispatch`-only GitHub Actions workflow
(`.github/workflows/benchmark.yml`) — while remaining on-demand: no `schedule:`
trigger is enabled, and adding one later is a deliberate one-line change, never
drift.

- **Topology.** `plan` (per-cell deficit + cost allocation) → `canary`
  (hello-world runs first as an end-to-end smoke; a failure aborts the
  invocation before any expensive cell spends) → per-deficit-cell `matrix`
  (max-parallel 6, one ephemeral sandbox repo per cell per D-013) →
  `aggregate` (merge artifacts append-only into `results/`, render report +
  dashboard, derive feedback findings, **open a results PR**). No job pushes
  to `main`; results-PR review replaces the local `/benchmark` STOP gates in
  CI (the interactive gates remain for local runs).
- **Top-up intelligence.** `bench/driver/topup-planner.js` computes, per
  `(scenario × arm)` cell, `deficit = max(0, targetN − validRuns)` where a
  record counts only when schema-valid, exact-cohort-triple-matched (D-014),
  and not `routingMismatch`. A complete cohort reports `cohortComplete` and
  the invocation is a near-zero-cost no-op — the "has this combination
  already been benchmarked?" check. Partial cohorts fill only the deficit.
- **Cost enforcement.** `max_cost_usd` (default 150) is allocated
  **proportionally** across deficit cells from observed per-run cost history
  (static per-scenario fallback); each cell job additionally carries the
  in-loop `BENCH_MAX_COST_USD` stop and a `BENCH_MAX_RUNS` cap at exactly its
  deficit. `--dry-run` prints the deficit plan and runs nothing.
- **CI is a caller of the same harness**, not a fork: local operation
  (`npm run bench`, `/benchmark`) is unchanged, and per-scenario `targetN`
  (8/8/4) governs both, with `BENCH_N`/`target_n` as an explicit override.

**Status.** Delivered (Epic #84 Phase 3). The first end-to-end CI cohort —
including the zero-cost no-op rerun that proves top-up — is an operator-gated,
cost-bearing dispatch still to run. *(This entry was backfilled during the
2026-07-09 post-delivery documentation review; the delivery itself logged
D-014 and D-021 but omitted D-017.)*

## D-016 — Feedback findings auto-filed on the mandrel repo, fingerprint-deduplicated and merge-gated (Epic #85, decided 2026-07-09)

**Decision.** Implements [`target-architecture.md`](target-architecture.md) §7
(and listed in §11). The report's "Recommended improvements" section stops being
a dead end (supersedes [D-009](#d-009--recommended-improvements-are-surfaced-never-auto-filed)):
a `bench/feedback/` stage runs after aggregation and turns a results corpus into
deterministic, evidence-carrying **findings** that are auto-filed as issues on
`dsj1984/mandrel`.

- **Four signal-gated finding classes** (`bench/feedback/derive.js`), each
  deriving ZERO findings when its signal is absent (no placeholder records):
  regression (a metric outside the noise band vs the *previous comparable
  cohort* — same model + benchmark version, prior framework version), standing
  cost (overhead floor, above-noise overhead ratio, difficulty-monotonicity
  violations), trap differential (a planted defect class the mandrel arm did not
  keep clean), and pipeline calibration (routing-mismatch rate, unmet autonomy
  guardrail, standalone-telemetry-absent).
- **Stable fingerprint** (`class + scenario + subject`, `bench/feedback/
  fingerprint.js`) embedded as an HTML-comment marker in the issue body. The
  fingerprint EXCLUDES the cohort triple, so the same finding under a later
  cohort collides onto one fingerprint. The filer (`bench/feedback/file.js`)
  LISTS the repo's open `bench-feedback` issues and matches the marker
  CLIENT-SIDE (never GitHub issue search, which does not index HTML-comment
  text): **hit → append a dated cohort comment**; **miss → open a new issue**
  (labels `bench-feedback` + `meta::framework-gap`); an already-recorded
  (fingerprint × cohort) is a **no-op**, so a re-run writes nothing.
- **Merge-gated.** The benchmark aggregate job derives the findings, commits the
  envelope JSON with the cohort results, and opens a results PR that EMBEDS the
  findings section; only MERGING that PR (a push to `main` under the results
  tree) fires the filer (`.github/workflows/feedback-file.yml`). It never runs
  on `pull_request`, so an unreviewed cohort can never write to the mandrel
  repo. Dedup-by-fingerprint plus merge-gating is the anti-spam design.
- **Graceful degradation (retains D-009).** The findings are ALWAYS embedded in
  the results-PR body, and the cross-repo filer degrades LOUDLY + exits 0 when
  its `FEEDBACK_GITHUB_TOKEN` is absent or underscoped — so a misconfigured
  secret never fails a merge; the loop simply falls back to the D-009
  surfacing behaviour. The filer binds explicitly to `FEEDBACK_GITHUB_TOKEN`
  and never the destructive sandbox PAT.

**Status.** Delivered (Epic #85). The Phase-4 audit-remediation pass pinned the
aggregate job's derive step to the run-under-test cohort triple (so the loop
survives once `main` holds more than one cohort), single-sourced the
routing-mismatch threshold, and wrapped the filer's LIST call in the same
graceful-degradation guard as its writes. The post-Epic-#86 wiring pass
(2026-07-10) added the fifth (`attribution`) finding class and the `phase::*`
routing tag per target-architecture §7.2: every finding now carries a
`phaseTag`, and a freshly-filed issue also carries the matching `phase::plan` /
`phase::deliver` / `phase::artifacts` label (falling back loudly to a body-only
tag when the target repo does not define the label).

## D-019 — Mandrel-arm runs split into phase-scoped `/plan` + `/deliver` sessions, with an intrinsic plan-quality axis for phase attribution (Epic #86, decided 2026-07-09)

**Decision.** Implements [`target-architecture.md`](target-architecture.md) §3.4
(and listed in §11). **Amends D-008**: a mandrel-arm run is no longer
one opaque session but an **ordered set of phase-scoped sessions** whose cost is
their sum. This lets the feedback loop (§7) route a finding to the half of
Mandrel that owns it — `/plan` vs `/deliver` — rather than to "Mandrel" at large,
which plan-adherence alone cannot do (it cannot tell a bad plan faithfully
executed from a good plan botched in delivery).

- **Two sessions per mandrel-arm run.** Session 1 runs `/plan` to completion,
  session 2 runs `/deliver`. This is faithful to Mandrel's own design — state
  lives in tickets, so a fresh `/deliver` session is the canonical consumer
  experience, not an artificial split. Each session carries its own `claude -p`
  envelope, giving **per-phase cost, tokens, and wall-clock** that sum to the
  run totals (`scorecard.phases[]`). The control arm stays a single session and
  carries no `phases` block.
- **The plan snapshot.** Between the two sessions the harness snapshots the plan
  artifacts (Epic body + tech-spec sections, Story bodies with their inline
  `acceptance[]`/`verify[]`) into `.raw/<runId>/plan/`, so delivery can never
  retroactively alter what the plan is scored on.
- **Intrinsic plan quality (a mandrel-only axis, like planning fidelity).** The
  snapshot is scored against the scenario's frozen spec BEFORE any code exists:
  **coverage** (every frozen acceptance criterion traceable to a Story AC),
  **decomposition sanity** (story count/sizing vs the scenario's machine-readable
  `storyCountContract`), and **constraint surfacing** (do the plan artifacts
  carry the security-baseline obligations the scenario's traps probe?). Two-oracle
  shape per D-007: a 0.7 deterministic spine + a 0.3 LLM-judge cross-check
  (judge weight folds into the spine when the judge is null). It is DELIBERATELY
  excluded from the Mandrel-vs-control differential — the control arm authors no
  plan, so its plan-quality is null.
- **Attribution decision table.** The plan score is crossed with the delivered
  OUTCOME (frozen quality) and plan-adherence into one of four classes —
  `working-as-intended`, `deliver-phase-gap`, `plan-phase-gap`,
  `model-compensating` — and rendered as a mandrel-arm attribution table.
  Crossing all three inputs is the Goodhart backstop: a plan that games the spine
  cannot read as working-as-intended without a matching outcome.

**Status.** Delivered (Epic #86 Phase 5). The Phase-5 audit-remediation pass
wired the plan-quality axis end to end (it had been built + unit-tested but never
populated on a real run): the between-session plan snapshot now flows into
`scorecard.planQuality`, and `buildScorecard` stamps the attribution
classification from the delivered dimensions.

## D-020 — A second-touch evolution phase on rungs 2–3, with a continuity delta as the persistence measurement (Epic #86, decided 2026-07-09)

**Decision.** Implements [`target-architecture.md`](target-architecture.md) §4.5
(and listed in §11). One-shot greenfield delivery is where a frontier model needs
scaffolding least, yet Mandrel's central thesis (docs, ADRs, tickets,
decomposition discipline) is about making the **next** change cheaper and safer.
No one-shot benchmark can observe that, so `story-scope` and `epic-scope` runs get
a second, measured touch.

- **Mechanics.** After touch 1 is scored, a **fresh session** (no conversational
  carry-over) receives the scenario's frozen **change request** against the
  delivered tree. The mandrel arm inherits everything its pipeline produced (code,
  docs, tickets, `.agents/`); the control arm is reduced to exactly the code it
  delivered. Same arm, same model, new session — the inheritance *is* the
  treatment.
- **Change requests are part of the frozen scenario spec**, versioned with it and
  crossing a trap surface — story-scope: password change + session invalidation
  (must preserve hashing, must actually invalidate the pre-change session);
  epic-scope: project sharing with role-based access (must extend per-user
  isolation to roles, not bypass it).
- **Scoring.** Touch 2 carries the full dimension set, its own frozen behavioural
  suite, and phase-scoped **regression traps** (`traps-touch2/`, discovered
  separately from the touch-1 `traps/` scan), reported under `scorecard.touch2`
  apart from touch 1. The headline is the **continuity delta**: mandrel touch-2
  outcome/cost minus control touch-2 outcome/cost — the first measurement here
  that can see the value of Mandrel's persistent artifacts. A mandrel touch-2 that
  its inherited artifacts did NOT help surfaces as an `artifact-continuity-gap`
  (`phase::artifacts`) finding — ceremony paid in touch 1 that did not pay out in
  touch 2.
- `hello-world` is exempt (instrumentation rung). Touch 2 roughly doubles rung 2–3
  cell cost; that is the price of measuring the actual thesis, and that spend is
  counted against the run's cost ceiling.

**Status.** Delivered (Epic #86 Phase 5). The Phase-5 audit-remediation pass
folded the touch-2 session spend into the `BENCH_MAX_COST_USD` accumulators
(previously only touch-1 counted), added discrimination tests for the touch-2
acceptance oracles, and cleaned up the control arm's reduced touch-2 workspace.
