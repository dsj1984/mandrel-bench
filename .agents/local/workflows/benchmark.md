---
description: >-
  End-to-end "run the experiment" command for mandrel-bench. Optionally advances
  the version-under-test (gated confirmation — a bump begins a new cohort), runs
  the benchmark over the chosen scope, renders the value-add report and the
  delta-vs-noise-band, STOPS for operator review of the scorecard, then delegates
  to /git-deliver to commit the results (with version + cohort provenance), push,
  and open a PR to main.
---

# /benchmark [--update] [--scope smoke|full] [--scenarios <csv>] [--n <N>] [--no-pr]

This workflow is the **single source of truth** for running one mandrel-bench
experiment from version-selection to a results PR. It does **not** reimplement
the upgrade or the delivery — it **composes** the two existing workflows around
the one piece of orchestration unique to this repo: the benchmark run itself.

- **Step 1 (update)** delegates to [`/mandrel-update`](../../workflows/mandrel-update.md).
- **Step 2 (run)** drives `npm run bench` ([`bench/run.js`](../../../bench/run.js)).
- **Step 4 (deliver)** delegates to [`/git-deliver`](../../workflows/git-deliver.md).

> **Persona**: `devops-engineer` · **Skills**:
> `core/git-workflow-and-versioning`, `core/debugging-and-error-recovery`
>
> **Consumer-authored — lives in the sanctioned `.agents/local/` zone.** This is
> a mandrel-bench workflow, not part of the Mandrel payload. See
> [Authoring location](#authoring-location) for why it lives here and how it is
> invoked.

---

## Why the bookends are gated, not automatic

The `mandrel` dependency version **is the independent variable** of this
experiment (see [`README.md`](../../../README.md): hold the instrument fixed, vary
only `dependencies.mandrel`). That makes the two outer steps semantically loaded,
so neither runs silently:

| Step | Why it is gated |
| ---- | --------------- |
| **Update** | A version bump **starts a new cohort**. Auto-updating every run would conflate *extend the current cohort at a fixed version* (resume-safe) with *benchmark a new version*, and risks mixing versions in one cohort store. So the update is **opt-in/gated**: detect a newer `mandrel`, surface `X→Y — this begins a new cohort, proceed?`, and act only on explicit approval. |
| **Commit** | Bench runs are **non-deterministic, long, and can partially fail** — the results *are* the product. Auto-PRing whatever fell out can land a degenerate or incomplete cohort on `main`. So the run **checkpoints**: render the value-add delta vs. the noise-band and STOP for operator review before delegating to `/git-deliver`. |

---

## Arguments

```text
/benchmark [--update] [--scope smoke|full] [--scenarios <csv>] [--n <N>] [--no-pr]
```

- `--update` — *pre-approve* the gated update check. Without it, Step 1 still
  checks for a newer published `mandrel`; with it, the `X→Y` confirmation is
  treated as approved (still announced). Either way, **already-latest is a no-op**
  and the run extends the current cohort against the pinned version.
- `--scope smoke|full` — coarse scope preset (default `smoke`):
  - `smoke` → `BENCH_SCENARIOS=hello-world`, `BENCH_N=1`, both arms. A fast
    risk-first sanity pass.
  - `full` → all scenarios (`hello-world,crud-db,project-api`) at the cohort `N`,
    both arms.
- `--scenarios <csv>` — override the scenario set (maps to `BENCH_SCENARIOS`).
- `--n <N>` — override runs-per-cell (maps to `BENCH_N`).
- `--no-pr` — stop after the commit (pass through to `/git-deliver --no-push`-style
  terminal level); do not open a PR.

The run is **resume-safe and cost-bounded**: `bench/run.js` skips cells already
in its checkpoint, and honours `BENCH_MAX_RUNS` / `BENCH_MAX_COST_USD` ceilings
when set. Re-running `/benchmark` after an early stop continues the same batch.

---

## Preconditions

Before Step 1, confirm the sandbox coordinates the runner reads from the
environment are present (see [`bench/run.js`](../../../bench/run.js) `main()`):

- `BENCH_SANDBOX_REPO_URL`, `BENCH_SANDBOX_OWNER`, `BENCH_SANDBOX_REPO` — the
  throwaway sandbox the headless `claude -p` arms deliver into.
- `BENCH_SANDBOX_BASELINE_REF` (default `bench-baseline`) — the clean branch the
  sandbox `main` is reset to before/after each run.
- A `GITHUB_TOKEN` with sandbox access (sanitized before `gh`, per
  [`resetSandboxBaseline`](../../../bench/driver/sandbox.js)).

If any required sandbox coordinate is missing, **STOP** and report it — do not
launch a run against an undefined sandbox.

---

## Phase 1 — Version selection (gated update)

1. Resolve the newest published `mandrel` and compare against the version pinned
   in `package-lock.json`.
2. **Already latest** → announce `mandrel X (latest) — extending current cohort`
   and continue to Phase 2. No cohort boundary is crossed.
3. **Newer available** → announce `mandrel X → Y — this begins a NEW cohort`.
   - Without `--update`: **wait for operator approval** (HITL).
   - With `--update`: treat as approved, but still announce.
   - On approval: delegate to [`/mandrel-update`](../../workflows/mandrel-update.md)
     for the full upgrade wraparound (install → re-materialize `.agents/` →
     reconcile → stage + commit the lockfile bump). Record `Y` as the cohort's
     `frameworkVersion`.
   - On decline: continue against the pinned version (extend current cohort).

> The version moves **only** on explicit invocation of `/mandrel-update`; there
> is no background drift. CI runs `npm ci` against the committed lockfile.

## Phase 2 — Run the benchmark

1. Map the scope flags to the `BENCH_*` environment contract and invoke
   `npm run bench`. The orchestrator stamps `runId`, `timestamp`, `env`, and
   `frameworkVersion`, then loops `N × scenarios × arms`, persists each cohort's
   store, and renders its report + dashboard.
2. Stream progress; on an **early stop** (`result.stopped`), report the reason
   and that re-running resumes the batch. Do **not** proceed to deliver a partial
   cohort without operator acknowledgement.

## Phase 3 — Checkpoint: review the scorecard (HITL STOP)

1. Render the value-add report over the **full cohort store** (resume-safe) and
   surface, per dimension, the Mandrel-vs-control delta **and whether it clears
   the computed noise-band**.
2. Summarize: cohort id, `frameworkVersion`, model, scenarios × arms × N, cells
   completed vs skipped, and any `agent::blocked` / un-merged-PR Autonomy signals.
3. **STOP for operator review.** A degenerate or incomplete cohort must not reach
   `main`. Continue to Phase 4 only on explicit approval.

## Phase 4 — Deliver the results

1. Delegate to [`/git-deliver`](../../workflows/git-deliver.md) with a commit
   subject that preserves the established provenance convention, e.g.
   `feat(results): cohort <id> — mandrel@<version> / <model> (refs #<id>)`.
2. `--no-pr` stops at the commit/push level; otherwise `/git-deliver` opens the
   PR to `main` and arms auto-merge per its own detection.

---

## Verification

- `npm run bench` exited 0 (or stopped cleanly with a recorded resume point).
- The cohort store and report on disk match the rendered summary (no orphan
  cells); `frameworkVersion` matches the version Phase 1 selected.
- The commit subject records cohort + version + model; the PR (when opened)
  targets `main`.
- `npm run lint` and `npm test` pass on the results commit before the PR merges.

---

## Authoring location

This file lives in **`.agents/local/`** — Mandrel's *sanctioned consumer zone*.
The placement is deliberate and load-bearing:

- **`.agents/workflows/` would be pruned.** `mandrel sync` deletes any file in
  the managed `.agents/` tree that has no counterpart in the published payload
  (sync-prune, Story #4046). A consumer workflow placed there is "stale" and is
  removed on the next `mandrel sync` / `mandrel update`. The **`.agents/local/`**
  subtree is the one zone `mandrel sync` never copies into **nor prunes**
  (Story #3498), so consumer-authored material survives upgrades here.
- **`.claude/commands/` is generated and gitignored.** The flat command tree is
  re-derived from `.agents/workflows/` by
  [`sync-claude-commands.js`](../../scripts/sync-claude-commands.js) — which also
  **reaps** any command not backed by a workflow, on every `npm install` (the
  `prepare` hook) and during `mandrel update`'s `sync-commands` step. It is never
  committed. So a hand-placed command there does not survive either.

**Invocation (current).** The projector reads only `.agents/workflows/`, so this
workflow is **not** auto-projected to a literal `/benchmark` slash command today.
Invoke it by **referencing this file** (e.g. "run the benchmark workflow in
`.agents/local/workflows/benchmark.md`") or via the project skill of the same
name.

**Invocation (planned).** The durable fix is an upstream Mandrel change that
teaches `sync-claude-commands.js` to treat `.agents/local/workflows/` as a
second, **prune-exempt** projection source — at which point this file projects to
`/benchmark` and survives updates with no consumer-side script. The change is
tracked upstream at
[dsj1984/mandrel#4243](https://github.com/dsj1984/mandrel/issues/4243). Until it
ships, do **not** add a stopgap copy into `.agents/workflows/` or
`.claude/commands/` — both get reaped.
