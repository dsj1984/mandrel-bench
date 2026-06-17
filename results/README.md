# Benchmark results — longitudinal scorecard store

This directory is the committed, append-only record of every benchmark run.

- **`scorecards.ndjson`** — one stamped scorecard per `(scenario × arm × run)`
  (model + framework version + env), conforming to
  `bench/schemas/scorecard.schema.json`.
- **`report-*.md`** — the rendered value-add report for a cohort.
- **`.raw/<runId>/`** — provenance copied out of each run's ephemeral workspace
  before teardown: the lifecycle ledger, per-Story signals, and the `claude -p`
  cost envelope the scorecard was derived from.

## First result — `hello-world`, N=1 (2026-06-16)

The inaugural run: `mandrel@1.70.0` on `claude-opus-4-8`, both arms, one run
each. It retired the make-or-break risk — the mandrel arm drove
`/plan`→`/deliver` **fully headless and unattended** against the
`mandrel-bench-sandbox` repo (PRD/Tech Spec authored, one Story decomposed,
delivered, and an integration PR opened).

> **N=1 is non-inferential.** Every "distribution" is a single point
> (`[x, x]`) and every delta trivially "clears" a zero noise band. This run
> validates the end-to-end pipeline and the measurement plumbing — it is **not**
> a statistically meaningful verdict. A real verdict needs N≈8–10 (deferred).

Headline (see `report-first-result.md`): on this trivial scope Mandrel bought
**no quality gain** (both arms 1.0) at **~54× the cost** ($8.61 vs $0.16) and a
**0.58 overhead ratio**, and showed a real **autonomy** cost (0.5 vs 1.0) — the
auto-merge gate blocked (`epic.merge.blocked`) and left the PR for an operator.
The report's top recommendation — *a ceremony-lite path for trivial scopes* — is
exactly the signal the harness exists to produce.
