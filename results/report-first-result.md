# Mandrel Self-Benchmark — Value-Add Report

> Internal tooling (Epic #4211). Each dimension is reported as a
> distribution across N runs, never a point estimate. A Mandrel-vs-bare
> delta is only called **real** when it clears the larger of the two arms’
> noise-band spreads (see `bench/metrics/README.md` § Real-delta rule).

## Cohort

- **Model:** claude-opus-4-8
- **Framework version:** 1.70.0
- **Node:** v24.16.0
- **OS:** darwin
- **Band method:** iqr

## Dimension distributions (Mandrel vs bare control)

### Scenario: `hello-world` (difficulty 1)

n = 1 mandrel / 1 control · band = iqr (`center [low, high]`)

| Dimension | Mandrel | Control | Δ (M−C) | Noise floor | Verdict |
| --- | --- | --- | --- | --- | --- |
| Quality | 1 [1, 1] | 1 [1, 1] | 0 | 0 | ≈ within noise |
| Planning fidelity | 1 [1, 1] | — | — | — | — n/a |
| Autonomy | 0.5 [0.5, 0.5] | 1 [1, 1] | -0.5 | 0 | ✅ real |
| Overhead ratio (tokens) | 0.582 [0.582, 0.582] | 0 [0, 0] | 0.582 | 0 | ✅ real |
| Efficiency · wall-clock (ms) | 582891 [582891, 582891] | 20687 [20687, 20687] | 562204 | 0 | ✅ real |
| Efficiency · total tokens | 7657338 [7657338, 7657338] | 89398 [89398, 89398] | 7567940 | 0 | ✅ real |
| Efficiency · dispatches | 1 [1, 1] | 0 [0, 0] | 1 | 0 | ✅ real |
| Efficiency · cost (USD) | 8.607 [8.607, 8.607] | 0.158 [0.158, 0.158] | 8.449 | 0 | ✅ real |

## Per-difficulty scaling view

As difficulty rises, Efficiency (absolute tokens) must **rise** and the
Overhead ratio must **fall** as ceremony amortizes over more output. A
violation is a calibration warning, not a silent pass.

| Scenario | Difficulty | Tokens (mandrel) | Tokens (control) | Overhead ratio (mandrel) | Overhead ratio (control) |
| --- | --- | --- | --- | --- | --- |
| `hello-world` | 1 | 7657338 [7657338, 7657338] | 89398 [89398, 89398] | 0.582 [0.582, 0.582] | 0 [0, 0] |

### Monotonicity (Mandrel arm, calibration guardrail)

- Not enough ladder rungs to evaluate monotonicity (needs ≥ 2 scenarios).

## Recommended improvements

### 🔴 High — Add a ceremony-lite path for trivial scopes

- **Evidence:** hello-world overhead floor ≈ 7567940 tokens / $8.4495 above control (quality gain 0) — a positive floor with no matching quality gain.
- **Action:** Gate the full /plan→/deliver ceremony behind a complexity threshold so trivial scopes skip the planning/decomposition tax that buys no quality here.

### 🟠 Medium — Investigate the Autonomy regression on `hello-world`

- **Evidence:** Mandrel 0.5 vs control 1 (Δ -0.5, noise floor 0) — a real gap in the bare arm’s favour.
- **Action:** The scaffolding is costing a value dimension it should protect. Trace the lifecycle for this scenario to find where the regression enters.
