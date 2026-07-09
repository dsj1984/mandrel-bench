# Benchmark results — longitudinal scorecard store

This directory is the committed, append-only record of every benchmark run.

## Layout — per-cohort subdirectories

Results are organized into per-cohort subdirectories keyed by the two dimensions
a human navigates by — **model**, then **framework version** — so the
longitudinal history is browsable over time rather than piled into one flat
file:

```text
results/
  README.md
  results.html                          ← generated aggregate dashboard (all cohorts)
  <model-slug>/<frameworkVersion>/
    scorecards.ndjson                   ← per-cohort append-only store
    reports/report-<stamp>.md           ← per-run rendered Markdown reports
    .raw/<runId>/...                    ← provenance
```

- **`<model-slug>`** is the slugified `model.id` (e.g. `claude-opus-4-8[1m]` →
  `claude-opus-4-8-1m`), so a model id with path-hostile characters is always a
  safe directory name. The full cohort key still includes `env` (node/os) — the
  directory tree intentionally branches only on model + version for navigability,
  while every NDJSON record carries the complete `env` for in-dashboard
  grouping/filtering.
- **`<model-slug>/<frameworkVersion>/scorecards.ndjson`** — one stamped scorecard
  per `(scenario × arm × run)` for that cohort, conforming to
  `bench/schemas/scorecard.schema.json`. Append-only and idempotent: a run only
  ever appends to its cohort store.
- **`<model-slug>/<frameworkVersion>/reports/report-*.md`** — the rendered
  value-add report for that cohort.
- **`<model-slug>/<frameworkVersion>/.raw/<runId>/`** — provenance copied out of
  each run's ephemeral workspace before teardown: the lifecycle ledger, per-Story
  signals, and the `claude -p` cost envelope the scorecard was derived from.

## Dashboard — `results.html`

`results/results.html` is a **generated**, self-contained dashboard for browsing
the whole longitudinal corpus across every cohort. It has **zero runtime
dependencies** — the scorecard corpus is inlined as JSON, the trend chart is
inline SVG, and sort/filter/modal are vanilla JS — so it works offline and is
byte-for-byte diffable. It shows:

- an **over-versions trend chart** of the headline metrics (quality,
  maintainability, security, autonomy, efficiency total-tokens & cost, overhead
  ratio). The **x-axis is the framework version** (one aggregated point per
  cohort, oldest first); each point is the median across that cohort's runs with
  an inter-quartile whisker, one line per arm (the line breaks across a model
  change). A **Model** filter narrows to one model, and every metric carries an
  interpretation caption (value/cost side, range, which direction is better,
  what "good" looks like) plus a delta-vs-control badge for the latest cohort;
- a **sortable, filterable index table** of every run (timestamp, scenario, arm,
  model, framework version, the seven dimension headlines, and env); and
- an **in-page modal** (click any row) with the full per-dimension breakdown and
  links to that run's `.raw/` artifacts and Markdown report.

The seven dimensions shown on the dashboard are:

| Dimension           | Side  | Range  | Better |
| ------------------- | ----- | ------ | ------ |
| Quality             | value | [0, 1] | higher |
| Maintainability     | value | [0, 1] | higher |
| Security            | value | [0, 1] | higher |
| Planning fidelity   | value | [0, 1] | higher |
| Autonomy            | value | (0, 1] | higher |
| Efficiency (tokens) | cost  | ≥ 0    | lower  |
| Overhead ratio      | cost  | ≥ 0    | lower  |

**Maintainability** (added Epic #32) measures how readable and low-complexity
the delivered output is: objective spine from static-analysis signals (linter
density, cyclomatic complexity, maintainability index) weighted 0.7, plus an
LLM judge cross-check against the `engineer`/`refactorer` persona rubric at
0.3 (folded into the spine when null). It is most likely to diverge between
arms on the `epic-scope` breadth rung (the 3-rung matrix's flagship
Epic-routed scenario), where decomposition quality and code-structure choices
separate.

**Security** (added Epic #32) measures how free of vulnerabilities the
delivered output is: objective spine from security-scanner signals
(critical/high-severity findings, secret detection) weighted 0.7, plus an LLM
judge cross-check against the `security-baseline.md` MUSTs at 0.3. It is most
likely to diverge on auth-bearing scenarios where the bare control visibly
misses Mandrel's inviolable security baseline (edge input-validation, password
hashing, `httpOnly` token storage, server-side auth checks, rate-limiting).

Both judge cross-checks share a single batched judge call per run.

It is regenerated from the full aggregated corpus at the end of every
`bench/run.js` run (it is **not** hand-edited). To regenerate it without a fresh
benchmark run, aggregate the on-disk corpus and re-render:

```js
import { aggregateScorecards } from '../bench/report/aggregate.js';
import { renderDashboard } from '../bench/report/html.js';
import { writeFileSync } from 'node:fs';

const corpus = aggregateScorecards({ resultsDir: 'results' });
writeFileSync('results/results.html', renderDashboard({ scorecards: corpus }));
```

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

Headline (see
`claude-opus-4-8/1.70.0/reports/report-first-result.md`): on this trivial scope
Mandrel bought
**no quality gain** (both arms 1.0) at **~54× the cost** ($8.61 vs $0.16) and a
**0.58 overhead ratio**, and showed a real **autonomy** cost (0.5 vs 1.0) — the
auto-merge gate blocked (`epic.merge.blocked`) and left the PR for an operator.
The report's top recommendation — *a ceremony-lite path for trivial scopes* — is
exactly the signal the harness exists to produce.
