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

## D-001 — Five dimensions, split value vs. cost; variance is the method, not a dimension

**Decision.** Score each run on **Quality, Planning fidelity, Autonomy** (what
the scaffolding *buys*) and **Efficiency, Overhead ratio** (what it *costs*).
Report every dimension as a **distribution across N runs with a noise-band** —
variance is the reporting method, not a sixth dimension. **Never** collapse to a
single composite score.

**Why.** The deliverable is the value/cost *frontier*. A scalar invites Goodhart
gaming (optimizing the number erodes the scaffolding the framework exists to
provide). A delta is only "real" when it clears the noise-band, so run-to-run
variance is never mistaken for a regression.

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
