# Mandrel Self-Benchmark — Value-Add Report

> Internal tooling (Epic #4211). Each dimension is reported as a
> distribution across N runs, never a point estimate. A Mandrel-vs-bare
> delta is only called **real** when it clears the larger of the two arms’
> noise-band spreads (see `bench/metrics/README.md` § Real-delta rule).

## Cohort

- **Model:** claude-opus-4-8
- **Framework version:** 1.72.0
- **Node:** v24.16.0
- **OS:** darwin
- **Band method:** iqr

## Dimension distributions (Mandrel vs bare control)

### Scenario: `hello-world` (difficulty 1)

n = 8 mandrel / 8 control · band = iqr (`center [low, high]`)

| Dimension | Mandrel | Control | Δ (M−C) | Noise floor | Verdict |
| --- | --- | --- | --- | --- | --- |
| Quality | 1 [1, 1] | 1 [1, 1] | 0 | 0 | ≈ within noise |
| Planning fidelity | 1 [1, 1] | — | — | — | — n/a |
| Autonomy | 1 [1, 1] | 1 [1, 1] | 0 | 0 | ≈ within noise |
| Overhead ratio (tokens) | 0 [0, 0] | 0 [0, 0] | 0 | 0 | ≈ within noise |
| Efficiency · wall-clock (ms) | 428795 [328827, 643089] | 37601 [30587, 39576] | 391194 | 314262 | ✅ real |
| Efficiency · total tokens | 3141691 [1252549.875, 4655856.875] | 180784.5 [155649, 235804] | 2960906.5 | 3403307 | ≈ within noise |
| Efficiency · dispatches | 0 [0, 0] | 0 [0, 0] | 0 | 0 | ≈ within noise |
| Efficiency · cost (USD) | 3.478 [2.612, 4.572] | 0.265 [0.251, 0.305] | 3.214 | 1.96 | ✅ real |

### Scenario: `crud-db` (difficulty 2)

n = 8 mandrel / 8 control · band = iqr (`center [low, high]`)

| Dimension | Mandrel | Control | Δ (M−C) | Noise floor | Verdict |
| --- | --- | --- | --- | --- | --- |
| Quality | 1 [1, 1] | 1 [1, 1] | 0 | 0 | ≈ within noise |
| Planning fidelity | 1 [1, 1] | — | — | — | — n/a |
| Autonomy | 1 [1, 1] | 1 [1, 1] | 0 | 0 | ≈ within noise |
| Overhead ratio (tokens) | 0.466 [0.228, 0.948] | 0 [0, 0] | 0.466 | 0.72 | ≈ within noise |
| Efficiency · wall-clock (ms) | 946395 [663299, 1300047] | 127851 [95210, 155775] | 818544 | 636748 | ✅ real |
| Efficiency · total tokens | 10669838.5 [9480579, 15060728.125] | 509844.5 [378683.75, 602148] | 10159994 | 5580149.125 | ✅ real |
| Efficiency · dispatches | 2 [1.375, 2] | 0 [0, 0] | 2 | 0.625 | ✅ real |
| Efficiency · cost (USD) | 13.076 [10.603, 16.563] | 0.689 [0.561, 0.782] | 12.387 | 5.959 | ✅ real |

## Per-difficulty scaling view

As difficulty rises, Efficiency (absolute tokens) must **rise** and the
Overhead ratio must **fall** as ceremony amortizes over more output. A
violation is a calibration warning, not a silent pass.

| Scenario | Difficulty | Tokens (mandrel) | Tokens (control) | Overhead ratio (mandrel) | Overhead ratio (control) |
| --- | --- | --- | --- | --- | --- |
| `hello-world` | 1 | 3141691 [1252550, 4655857] | 180785 [155649, 235804] | 0 [0, 0] | 0 [0, 0] |
| `crud-db` | 2 | 10669839 [9480579, 15060728] | 509845 [378684, 602148] | 0.466 [0.228, 0.948] | 0 [0, 0] |

### Monotonicity (Mandrel arm, calibration guardrail)

- ⚠️ **Calibration warning — monotonicity violated.** The instrument may be
  insensitive or a scenario mis-graded for difficulty:
  - [calibration] overheadRatio.tokenRatio did not fall: hello-world=0 ≤ crud-db=0.4656288389396879

## Recommended improvements

### 🔴 High — Add a ceremony-lite path for trivial scopes

- **Evidence:** hello-world overhead floor ≈ 2960907 tokens / $3.2137 above control (quality gain 0) — a positive floor with no matching quality gain.
- **Action:** Gate the full /plan→/deliver ceremony behind a complexity threshold so trivial scopes skip the planning/decomposition tax that buys no quality here.

### 🔴 High — Recalibrate the difficulty ladder or the instrument

- **Evidence:** [calibration] overheadRatio.tokenRatio did not fall: hello-world=0 ≤ crud-db=0.4656288389396879
- **Action:** Efficiency did not rise and/or overhead ratio did not fall across the ladder. Re-grade the scenario difficulties or widen the gap between rungs so the instrument is sensitive to scaling.
