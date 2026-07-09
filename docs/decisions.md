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
`BENCH_SANDBOX_REPO`, and
`BENCH_SANDBOX_BASELINE_REF` are **retired** — their presence emits a
deprecation warning naming the replacement rather than being silently
accepted (`bench/run.js`'s `RETIRED_SANDBOX_ENV_VARS` shim, exempted from the
reference-sweep regression guard by name).

**Why safe to make destructive repo-deletion unattended.** The `bench-sbx-`
prefix is *reserved* — nothing else under the operator account may use it —
so `destroyEphemeralRepo` and the janitor can refuse any name outside the
prefix and delete freely within it. Existing containment and token-hygiene
primitives (`assertInsideRoot`, `sanitizeGitHubTokenEnv`) are preserved
unchanged for the local working-tree surface.

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
and the README.
