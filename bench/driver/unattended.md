# Unattended headless drive — how the pipeline's HITL gates auto-proceed

> **Scope.** This document satisfies the Story #4216 acceptance item: *document
> the mechanism by which the pipeline HITL stop gates auto-proceed under
> headless drive, or record the blocker when they cannot.* It is the
> make-or-break risk for the whole harness (Epic #4211): a headless
> `claude -p` orchestrator has no human at the keyboard, so if Mandrel's
> `/plan` → `/deliver` pipeline blocks at its first STOP gate, every
> downstream slice stalls.
>
> **As of `mandrel` 2.33.0 the answer is no longer mixed.** `--yes` is a
> first-class headless control on **both** `/plan` and `/deliver` — "runner-set,
> never operator-typed", meaning *nobody is at the keyboard* — and it
> auto-proceeds every operator-confirmation gate on both. The residual risk is
> no longer a missing flag; it is the set of gates that deliberately **fail
> closed** under `--yes` rather than auto-proceeding. Those are recorded below.
> This stays intentionally honest — the harness measures *Autonomy* as a scored
> dimension, so a gate that stops a run is itself a finding.
>
> *(History: through `mandrel` 1.x, `/plan` shipped no headless flag and the
> driver papered over its gates with a prompt directive alone. That gap is
> closed; the directive is retained as belt-and-braces, not as the lever.)*

The driver in [`run-session.js`](./run-session.js) launches the pipeline via
`claude -p --output-format json` (see `buildArmPrompt` / `buildClaudeArgs`).
Two complementary mechanisms keep the run unattended: **per-command
non-interactive flags** (deterministic, where they exist) and a **prompt-level
auto-proceed directive** (behavioral, covering the rest).

---

## Inventory of HITL STOP gates in the pipeline

Re-derived from the live workflow definitions in the materialized bundle
(`.agents/workflows/plan.md`, `.agents/workflows/deliver.md`,
`.agents/workflows/helpers/deliver-light.md`) as of `mandrel` 2.33.0
(2026-08-07). The Epic tier is retired — `helpers/deliver-epic.md` no longer
ships, and the Epic review / `maxTickets` decomposition / Phase-8.5 auto-merge
gates it carried are gone with it.

| # | Gate | Where | Native unattended control | Verdict |
| - | ---- | ----- | ------------------------- | ------- |
| 1 | Plan-intent confirm + duplicate-candidate review | `/plan` Gate #1 | **`--yes`** auto-proceeds | **solved (flag)** |
| 2 | Pre-persist approval | `/plan` Gate #2 — raised **only** under `--force-review` | **`--yes`** auto-proceeds; driver never passes `--force-review` | **solved (flag + not raised)** |
| 3 | Free-form operator questions on HITL unknowns | `/plan` interrogation | under `--yes` they are never asked — each lands in Key Assumptions as a decision-made-by-default | **solved (flag)** |
| 4 | Sequencing confirmation (N>1 Stories) | `/deliver` step 2 | **`--yes`** suppresses it | **solved (flag)** |
| 5 | Bare-invocation "which Story?" prompt | `/deliver` with no argument | n/a — the driver always passes ids or prose | **not reached** |
| 6 | Light-path over-scope stop | `helpers/deliver-light.md` suitability gate | under `--yes` **fails closed** to an `escalated` terminal envelope that ends the session | **deliberate stop — recorded, not papered over** |

**Deterministic gates still fail closed under `--yes`** (`plan.md` § Delivery
hand-off). `--yes` answers *operator questions*; it never waives a close
gate, a failing check, or the light path's suitability verdict. Row 6 is the
one the bench actually meets, and the harness classifies it rather than
retrying — see `deliveryPath` in [`../run.js`](../run.js).

---

## Mechanism 1 — native non-interactive flags (deterministic)

Gates 1–4 are all suppressed by the **same** flag; no behavioral coaxing
needed.

### `--yes` on both `/plan` and `/deliver` (gates #1–#4)

Both workflows carry the identical contract:

> `--yes` is **runner-set, never operator-typed**: cron, `/loop` and headless
> dispatch set it to mean *nobody is at the keyboard*.

(`.agents/workflows/plan.md` § Saying what you want;
`.agents/workflows/deliver.md` § Saying what you want.) A headless benchmark
`claude -p` session is exactly that dispatch, which is why the driver's prompts
append `--yes` to every `/plan` and `/deliver` invocation they instruct — see
`buildMandrelPlanPrompt` / `buildMandrelDeliverPrompt` in
[`run-session.js`](./run-session.js).

Because `/plan` and `/deliver` are **slash commands typed by the host LLM**,
not processes the driver spawns, the flag necessarily travels in the prompt
text rather than in `buildClaudeArgs`. A harness run that wants to *measure* a
confirmation gate rather than skip it drops `--yes` from the prompt builder.

### Entry forms carry no flags at all

Neither workflow takes an entry flag — the mode is derived from the **shape**
of what was typed, and the workflow fills in the underlying CLI flag itself
(`plan-context.js --seed | --seed-file | --tickets | --amends`):

| Typed | `/plan` mode | `/deliver` shape |
| --- | --- | --- |
| quoted prose | seed (ideation) | prompt → unplanned light path |
| bare id | tickets, or **amends** when the Story is already `agent::done` | ids → planned path |

This is why the driver emits `/plan "<task>" --yes` and `/plan <id> --yes` and
never an `--idea` / `--amends` operator flag. `.agents/docs/SDLC.md` § Phase 1
pins the entry contract; `node .agents/scripts/plan-context.js --help` is the
executable check.

---

## Mechanism 2 — prompt-level auto-proceed directive (behavioral)

`--yes` now covers gates #1–#4 deterministically, so this directive is
**belt-and-braces rather than the lever** — it catches any confirmation the
workflow prose raises that the flag does not name. The driver bakes it into
every Mandrel-arm prompt (`MANDREL_UNATTENDED_PREAMBLE` in `run-session.js`):

> *You are operating Mandrel's pipeline non-interactively under a headless
> benchmark driver. There is no human at the keyboard. At every
> human-in-the-loop STOP / confirmation gate (one-pager confirm, spec review,
> decomposition diff gate, and the auto-merge-else-operator-merge step), treat
> the absence of an operator as implicit approval and proceed with the best
> available interpretation — never block waiting for input.*

This works because each gate is executed by the host LLM following the
workflow prose, not by a hard `read()` from a TTY. The framework's own
non-interactive sub-agent contract already establishes this pattern: Story
delivery sub-agents run with no input channel mid-run and are instructed to
pick the narrowest reasonable interpretation rather than ask
(`helpers/deliver-story.md` → *Non-interactive execution contract*). The
driver's directive extends that same contract up to the top-level `/plan` and
`/deliver` gates.

### Why the directive is still worth carrying

`--yes` is defined against the gates the workflows *name*. The directive covers
the rest: a clarifying question the host LLM invents on its own, or a
confirmation introduced by a workflow revision before this doc catches up.
It costs nothing and fails safe — where `--yes` already answers a gate, the
directive is redundant rather than conflicting.

---

## Recorded blocker (residual risk)

`--yes` closes the flag gap, but it does not make a run unstoppable. The honest
residual risks, recorded here per the acceptance contract:

1. **`--yes` travels in prompt text, so it depends on the host LLM typing it.**
   `/plan` and `/deliver` are slash commands the model invokes; the driver
   cannot inject the flag out-of-band. A model that paraphrases the instructed
   invocation without the flag lands on the attended path and stalls at the
   first confirmation. **Mitigation today:** every prompt builder states the
   exact invocation verbatim, and the `run-session` tests pin those strings
   (`tests/bench/driver/run-session.test.js`) so a silent reword fails CI.
2. **The light path's over-scope stop is terminal by design.** Under `--yes`
   the suitability gate fails closed to an `escalated` terminal envelope rather
   than asking — the run ends without delivering. This is correct behaviour,
   not a harness defect: the `mandrel-light` arm exists to measure where that
   ceiling sits. The harness records which path each cell took and never counts
   an escalation as a light win (`deliveryPath` in [`../run.js`](../run.js)).
3. **Tool-permission prompts are not auto-approved by the prompt.** A blocking
   permission prompt is a harness condition, not a gate the directive covers.
   Because every run executes inside a throwaway sandbox clone
   ([`sandbox.js`](./sandbox.js)), callers that need a broader autorun posture
   should pass `extraArgs: ['--permission-mode', 'bypassPermissions']` (or the
   equivalent the host CLI exposes) explicitly. The driver deliberately leaves
   the default permission surface minimal rather than baking in a dangerous
   default.
4. **A stalled run must be detected, not assumed.** `claude -p` runs under a
   hard `timeoutMs` ceiling (default 1h, `DEFAULT_SESSION_TIMEOUT_MS`). A run
   that blocks on an un-mitigated gate exhausts the timeout and surfaces as a
   non-zero exit / empty envelope — `runSession` throws rather than returning a
   silent zero-cost record. The downstream telemetry slice additionally reads
   `lifecycle.ndjson` heartbeats to distinguish a live-but-slow run from a dead
   one.

### Follow-up framework ask — **resolved upstream**

The ask recorded here for #4216 was a first-class `--yes` / `--non-interactive`
flag on `/plan`, matching what `/deliver --yes` already did. The framework
shipped it: as of `mandrel` 2.33.0 `--yes` is defined identically on both
workflows as the runner-set *nobody is at the keyboard* signal, and the gate
inventory above is derived from that contract rather than working around its
absence. No `meta::framework-gap` filing is outstanding.
