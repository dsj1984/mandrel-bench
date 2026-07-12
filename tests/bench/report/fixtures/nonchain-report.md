# Mandrel Self-Benchmark — Value-Add Report

> Internal tooling (Epic #4211). Each dimension is reported as a
> distribution across N runs, never a point estimate. A Mandrel-vs-bare
> delta is only called **real** when it clears the larger of the two arms’
> noise-band spreads (see `bench/metrics/README.md` § Real-delta rule).

## Cohort

- **Model:** claude-opus-4-8[1m]
- **Framework version:** 1.89.0
- **Benchmark version:** 0.11.0
- **Node:** v24.16.0
- **OS:** darwin
- **Band method:** iqr

## Dimension distributions (Mandrel vs bare control)

### Scenario: `hello-world` (difficulty 1)

n = 2 mandrel / 2 control · band = iqr (`center [low, high]`)

> 🧭 **Floor/calibration rung** — instrumentation, not a value rung. Distributions below are the overhead-floor + monotonicity-curve calibration signal, not a value-delta claim.

> **Mandrel routing: Epic** — all value dimensions derived from the lifecycle ledger.

| Dimension | Mandrel | Control | Δ (M−C) | Noise floor | Verdict |
| --- | --- | --- | --- | --- | --- |
| Quality | 1 [1, 1] | 1 [1, 1] | 0 | 0 | ≈ within noise |
| Planning fidelity | 0.91 [0.9, 0.92] | — | — | — | — n/a |
| Maintainability | 0.9 [0.9, 0.9] | 0.85 [0.85, 0.85] | 0.05 | 0 | ✅ real |
| Security | 1 [1, 1] | 1 [1, 1] | 0 | 0 | ≈ within noise |
| Overhead ratio (tokens) | 6.5 [6, 7] | 0.2 [0.2, 0.2] | 6.3 | 1 | ✅ real |
| Efficiency · wall-clock (ms) | 405000 [400000, 410000] | 122500 [120000, 125000] | 282500 | 10000 | ✅ real |
| Efficiency · total tokens | 91000 [90000, 92000] | 20500 [20000, 21000] | 70500 | 2000 | ✅ real |
| Efficiency · dispatches | 2 [2, 2] | 1 [1, 1] | 1 | 0 | ✅ real |
| Efficiency · cost (USD) | 0.825 [0.8, 0.85] | 0.205 [0.2, 0.21] | 0.62 | 0.05 | ✅ real |

### Scenario: `story-scope` (difficulty 3)

n = 2 mandrel / 2 control · band = iqr (`center [low, high]`)

> **Mandrel routing: standalone Story** — planning-fidelity & autonomy recovered from the Story’s GitHub telemetry (no Epic ledger); overhead-ratio is **n/a** (unmeasurable on the standalone path).

| Dimension | Mandrel | Control | Δ (M−C) | Noise floor | Verdict |
| --- | --- | --- | --- | --- | --- |
| Quality | 0.96 [0.95, 0.97] | 0.825 [0.8, 0.85] | 0.135 | 0.05 | ✅ real |
| Planning fidelity | 0.85 [0.85, 0.85] | — | — | — | — n/a |
| Maintainability | 0.9 [0.9, 0.9] | 0.8 [0.8, 0.8] | 0.1 | 0 | ✅ real |
| Security | 1 [1, 1] | 0.9 [0.9, 0.9] | 0.1 | 0 | ✅ real |
| Overhead ratio (tokens) | 2.9 [2.8, 3] | 0.3 [0.3, 0.3] | 2.6 | 0.2 | ✅ real |
| Efficiency · wall-clock (ms) | 910000 [900000, 920000] | 305000 [300000, 310000] | 605000 | 20000 | ✅ real |
| Efficiency · total tokens | 252500 [250000, 255000] | 61000 [60000, 62000] | 191500 | 5000 | ✅ real |
| Efficiency · dispatches | 3 [3, 3] | 1 [1, 1] | 2 | 0 | ✅ real |
| Efficiency · cost (USD) | 4.1 [4, 4.2] | 0.625 [0.6, 0.65] | 3.475 | 0.2 | ✅ real |

#### Trap axis (differential — separate from the seven dimensions)

Per-class adversarial trap-oracle verdicts the frozen suite is blind to.
Higher is better (1 = clean, 0 = planted defect present).

| Class | Mandrel | Control |
| --- | --- | --- |
| plaintext-password | 1 (spread 0, min 1, n=2) | 0 (spread 0, min 0, n=2) |
| token-generation | 0.75 (spread 0.5, min 0.5, n=2) | 1 (spread 0, min 1, n=2) |
| cleanRate (mean of classes) | 0.875 (spread 0.25, min 0.75, n=2) | 0.5 (spread 0, min 0.5, n=2) |

#### Continuity delta (the second touch — separate from the seven dimensions)

Mandrel-vs-control delta of the FROZEN change request scored against the
delivered tree (mandrel inherits its full pipeline output; control inherits
delivered code only). Positive outcome delta / negative cost delta favour Mandrel.

| Metric | Mandrel | Control | Δ (mandrel − control) | Verdict |
| --- | --- | --- | --- | --- |
| outcome (quality of the 2nd change; higher is better) | 0.85 | 0.65 | 0.2 | real |
| cost (USD for the 2nd change; lower is better) | 1.25 | 1.6 | -0.35 | real |

## Autonomy guardrail (mandrel arm)

Autonomy is a pass/fail GUARDRAIL against a cohort threshold — never a
mandrel-vs-control delta (Epic #66, Story #77): the bare control arm’s
zero-intervention baseline is defined, not measured, so a delta against
it was never a meaningful comparison. A drop below threshold is itself a
finding.

| Scenario | n | Met | Dropped | Unmeasured | Threshold |
| --- | --- | --- | --- | --- | --- |
| `hello-world` | 2 | 2 | 0 | 0 | 0.99 |
| `story-scope` | 2 | 2 | 0 | 0 | 0.99 |

✅ Every measured mandrel-arm run met the guardrail threshold.

## Per-phase cost (mandrel arm)

The mandrel arm runs `/plan` and `/deliver` as two separate headless
sessions (D-019), so cost is attributable to the planning half vs the
delivery half. Mean USD cost per phase across the cell’s mandrel runs; the
control arm is a single session and carries no per-phase split.

| Scenario | n | Plan cost (USD) | Deliver cost (USD) | Total (USD) |
| --- | --- | --- | --- | --- |
| `hello-world` | 2 | 0.31 | 0.515 | 0.825 |
| `story-scope` | 2 | 1.55 | 2.55 | 4.1 |

## Per-difficulty scaling view

As difficulty rises, Efficiency (absolute tokens) must **rise** and the
Overhead ratio must **fall** as ceremony amortizes over more output. A
violation is a calibration warning, not a silent pass.

| Scenario | Difficulty | Tokens (mandrel) | Tokens (control) | Overhead ratio (mandrel) | Overhead ratio (control) |
| --- | --- | --- | --- | --- | --- |
| `hello-world` | 1 | 91000 [90000, 92000] | 20500 [20000, 21000] | 6.5 [6, 7] | 0.2 [0.2, 0.2] |
| `story-scope` | 3 | 252500 [250000, 255000] | 61000 [60000, 62000] | 2.9 [2.8, 3] | 0.3 [0.3, 0.3] |

### Monotonicity (Mandrel arm, calibration guardrail)

- ✅ Monotonicity holds across every adjacent rung (efficiency rises, overhead ratio falls).

## Recommended improvements

### 🔴 High — Add a ceremony-lite path for trivial scopes

- **Evidence:** hello-world overhead floor ≈ 70500 tokens / $0.62 above control (quality gain 0) — a positive floor with no matching quality gain.
- **Action:** Gate the full /plan→/deliver ceremony behind a complexity threshold so trivial scopes skip the planning/decomposition tax that buys no quality here.
