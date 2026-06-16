# Mandrel Self-Benchmark Harness

## Context

*How might we measure whether Mandrel's scaffolding earns its cost — and keep
measuring it as models and the agentic ecosystem move underneath us?*

Today every change to `instructions.md`, the decomposer prompt, sizing
heuristics, personas, skills, and gates is evaluated by vibes and dogfooding.
There is no instrument that says whether a change made the framework *better*
or merely *different* — and, as frontier models improve, no way to tell
whether Mandrel's scaffolding is still buying more than it costs. This harness
is that instrument: it drives Mandrel's own `/plan`→`/deliver` pipeline (and a
bare-model control) over a small scenario set, scores each run across five
dimensions, and tracks the framework's **value-add over raw model capability**
across versions and model generations.

Key bets, to validate early:

- **Telemetry already exists.** Run timings, dispatch counts, `agent::blocked`,
  and heartbeats are written to `temp/epic-<id>/lifecycle.ndjson` plus
  per-Story `signals.ndjson`; no new framework instrumentation is needed for
  Efficiency/Autonomy.
- **Cost comes from the driver, not the framework.** Mandrel records no token
  actuals — but `claude -p --output-format json` returns real usage/cost,
  measured identically for both arms (apples-to-apples by construction).
  Precedent: `security-review.js` already shells out to `claude --print` and
  parses the JSON envelope.
- **The risk to retire first.** Mandrel's `/plan` and `/deliver` carry
  human-in-the-loop STOP gates (one-pager confirm, spec review, decomposition
  diff gates, the auto-merge-else-operator-merge step). A headless `claude -p`
  orchestrator has no human to satisfy them — so the harness must prove the
  pipeline can run **unattended**, or it stalls at the first gate.

## Goal

A periodically-run **capability report** that, for each scenario, produces a
five-dimension scorecard for the Mandrel arm and a **value-add delta** against
a bare-model control — reported as distributions across N runs on a pinned,
recorded model. Re-baselined when a new model lands, it answers the standing
question *"is Mandrel still worth its tax at the current frontier?"* and feeds
concrete framework improvements. It lives as a separate consumer of published
`mandrel` — never shipped in the distributed `.agents/` bundle.

The five dimensions, split by what scaffolding **buys** vs. what it **charges**:

| Side | Dimension | Question it answers | Primary signal |
| --- | --- | --- | --- |
| Value | Quality | Is the output correct & on-intent? | frozen acceptance suite (spine) + acceptance-eval (judge cross-check) |
| Value | Planning fidelity | Did the plan match reality? | decomposition accuracy, re-plan count, plan-vs-actual drift |
| Value | Autonomy | How little human intervention? | HITL stops, `agent::blocked`, manual rescues |
| Cost | Efficiency | What did it cost absolutely? | wall-clock, tokens, dispatches |
| Cost | Overhead ratio | Ceremony tax vs. shippable output | ceremony ÷ codegen (tokens & time) |

Variance is the **reporting method** for all five (every score a distribution,
never a point), not a sixth dimension.

## Non-Goals

- **A single composite score** — *(Goodhart; we report the value/cost frontier,
  never collapse it to a scalar that would get gamed).*
- **A live per-PR CI gate** — *(periodic cadence; low-N-per-PR can't clear the
  variance band — a cheap gate is a possible later add, not the thesis).*
- **A model benchmark** — *(the model is pinned and recorded; we measure the
  framework's value-add at a fixed model, not which model wins).*
- **Pre-staged plans** — *(planning fidelity is a measured dimension; supplying
  the plan would grade our own homework, so we drive the real authoring even
  though inject-artifact flags exist).*
- **New Mandrel-internal cost instrumentation** — *(cost is read from the
  `claude -p` envelope, identical for both arms).*
- **Running against the live `mandrel` repo** — *(all churn lands in a
  dedicated sandbox repo on ephemeral clones).*
- **Real-Epic replays, ladder breadth beyond the two scenarios, and
  feedback-loop automation** — *(additive fidelity/polish; the synthetic
  two-scenario set plus a human-read report deliver all three stated intents.
  Recommendations are surfaced in the report — see Scope — but not auto-filed
  as tickets).*

## Scope

v1 is one coherent deliverable. **Author the metrics model + scorecard JSON
schema first**, then build the unattended headless driver that, in a dedicated
sandbox GitHub repo on a fresh ephemeral clone, runs `/plan`→`/deliver`
(Mandrel arm) and a bare-model control over **two scenarios** — `hello-world`
(the overhead floor + end-to-end smoke) and a **CRUD+DB app** (which exercises
decomposition, multi-wave delivery, planning fidelity, and autonomy at depth).
Each scenario × arm runs at **N≈8–10**. The harness sources timings/autonomy
from `lifecycle.ndjson` and cost from the `claude -p` envelope, scores Quality
via each scenario's frozen acceptance suite plus an acceptance-eval
cross-check, **persists every scorecard** stamped with model +
framework-version + env, and emits a **value-add report**: all five dimensions
as distributions, the Mandrel-vs-bare delta, and the computed noise-band so a
delta is only called real when it clears it. Each run workspace is torn down
after.

The report **ends with a clearly-delineated "Recommended improvements"
section** — actionable, evidence-linked, ranked framework recommendations
derived from the scored deltas (e.g. *"hello-world overhead ratio is 4.2× with
no quality gain → consider a ceremony-lite path for trivial scopes"*). A human
reads and decides; the harness never auto-files tickets.

The report also computes two **cross-scenario derived metrics** (relationships
across the ladder, not scored per-run dimensions): a **difficulty-monotonicity**
check — Efficiency must rise and Overhead ratio must fall from hello-world to
the CRUD+DB rung, flagged as a calibration warning when it doesn't — and an
**overhead-floor** estimate (hello-world Mandrel cost minus the control), the
fixed ceremony tax on near-zero work that feeds Recommended improvements. With
two scenarios v1 gets the check and the floor; characterizing the full scaling
curve needs ≥3 rungs (deferred).

Beyond v1 (additive, separately planned): real-Epic replays for ground-truth
fidelity; broader ladder rungs (auth + multi-feature); a long-horizon trend
dashboard; and — only if wanted later — feedback-loop automation.

## Acceptance Criteria

- [ ] A committed metrics model defines all five dimensions, each with an
      explicit reproducible formula, plus the variance/noise-band method, under
      the internal tooling tree.
- [ ] A scorecard JSON schema exists and validates a real emitted scorecard.
- [ ] The harness drives **unattended** headless `/plan`→`/deliver` runs for
      **both** scenarios in the sandbox repo and tears down each workspace.
- [ ] A **bare-model control** run exists for both scenarios, costed by the same
      `claude -p` instrument.
- [ ] Each scenario × arm runs at **N≈8–10**; the report renders every
      dimension as a **distribution** (not a point) and computes the noise-band.
- [ ] The report shows the **Mandrel-vs-bare value-add delta** across all five
      dimensions and flags which deltas clear the band.
- [ ] The report contains an explicit, clearly-delineated **"Recommended
      improvements"** section listing actionable, evidence-linked framework
      recommendations derived from the run's findings.
- [ ] Scorecards are **persisted** stamped with model + framework-version + env,
      and a **cross-run comparison** surfaces deltas between two stored runs.
- [ ] Quality is scored by a **frozen** per-scenario acceptance suite + an
      acceptance-eval cross-check; timings come from `lifecycle.ndjson`, cost
      from the `claude -p` envelope — no new Mandrel-internal instrumentation.
- [ ] The harness lives outside the distributed `.agents/` bundle and never runs
      against the live `mandrel` repo.

## Open Questions

- **Unattended-mode mechanism** (resolve first): do `/plan` and `/deliver`
  auto-proceed under headless drive, or does the harness need a
  non-interactive/auto-approve mode for the HITL STOP gates? This is the
  make-or-break item. *(Resolved during the Epic #4211 build: yellow — `/deliver`
  is headless-drivable via `--yes`; `/plan` has no headless flag, mitigated by a
  prompt-level auto-proceed directive + a `meta::framework-gap` follow-up.)*
- **N for the variance baseline** — start ~8–10 on hello-world; finalize after
  observing the noise band.
- **Real-Epic replay fairness** — when replaying a historical Epic, judge
  against how it shipped *then* (its era's model/framework) or only use its spec
  as input and score the fresh output?
- **Sandbox provisioning** — dedicated bench repo + scoped token; rate-limit
  pacing strategy.

---

> **Provenance.** This one-pager was authored in Mandrel's `/plan` ideation
> flow and originally drove the in-repo Epic
> [mandrel#4211](https://github.com/dsj1984/mandrel/issues/4211). The harness was
> subsequently **re-homed to this separate `mandrel-bench` repo** (a consumer of
> published `mandrel`) so the benchmark holds its harness fixed while varying the
> pinned framework version under test. See the [README](../README.md) for the
> current run model and status.
