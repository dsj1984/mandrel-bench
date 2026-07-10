// tests/bench/ci/benchmark-workflow.test.js
//
// Unit tier (pure file read + YAML parse, no network, no GitHub) for the
// workflow_dispatch benchmark pipeline (Epic #84, Story #90). Shape-asserts
// .github/workflows/benchmark.yml against the Story's binding acceptance:
//
//   1. workflow_dispatch exposes the six inputs (mandrel_version, model,
//      scenarios, target_n, max_cost_usd [default 150], dry_run [default false]).
//   2. Topology is plan → canary → per-cell matrix → aggregate, wired via
//      `needs` so the canary runs the cheapest rung FIRST and a canary failure
//      aborts the paid matrix (the matrix `needs` the canary).
//   3. The per-cell matrix job caps concurrency at 6, fans out one job per
//      deficit cell (matrix sourced from the plan job's output), exports
//      BENCH_MAX_COST_USD carrying its allocated share, and uploads the
//      scorecards + .raw provenance as artifacts.
//   4. The aggregate job merges + renders via bench/report/aggregate-cli.js and
//      OPENS A PULL REQUEST; no job in the workflow pushes to main directly.
//   5. The two required Action secrets (ANTHROPIC_API_KEY, BENCH_GITHUB_TOKEN)
//      are referenced.
//   6. A non-blank mandrel_version input is actually INSTALLED (npm install
//      mandrel@<version> --no-save) in the plan, canary, and cell jobs BEFORE
//      `npx mandrel sync` — so the cohort triple, the scorecard stamps, and the
//      materialized .agents/ bundle all resolve to the version under test, and
//      the input can never again be silently inert. The version reaches run
//      bodies only as a quoted env var (the H1 no-`${{ inputs.* }}`-in-run
//      convention, asserted globally).
//
// These are static shape assertions, not an integration run: they guard the
// workflow's contract so a future edit that drops an input, breaks the
// plan→canary→matrix→aggregate ordering, lifts the per-cell cost ceiling, or
// pushes results straight to main fails here.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  '.github',
  'workflows',
  'benchmark.yml',
);

const rawWorkflow = readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = parse(rawWorkflow);

/** The trigger block, robust to how the parser keys the bare `on:`. */
function triggers(wf) {
  return wf.on ?? wf[true];
}

/** Flatten every job's steps into one array of step objects. */
function allSteps(wf) {
  return Object.values(wf.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

/** The `uses:` slug of every step, action version suffix stripped. */
function usedActions(wf) {
  return allSteps(wf)
    .map((step) => step.uses)
    .filter(Boolean)
    .map((uses) => uses.split('@')[0]);
}

describe('benchmark workflow — shape contract', () => {
  it('parses as valid YAML with a named workflow', () => {
    assert.equal(typeof workflow, 'object');
    assert.ok(workflow !== null, 'workflow must parse to an object');
    assert.equal(typeof workflow.name, 'string');
    assert.ok(workflow.name.length > 0, 'workflow must be named');
  });

  it('is manually dispatched with the six documented inputs', () => {
    const on = triggers(workflow);
    assert.ok(on, 'workflow must declare triggers');
    assert.ok(on.workflow_dispatch, 'must be workflow_dispatch');

    const inputs = on.workflow_dispatch.inputs ?? {};
    for (const name of [
      'mandrel_version',
      'model',
      'scenarios',
      'target_n',
      'max_cost_usd',
      'dry_run',
    ]) {
      assert.ok(
        Object.hasOwn(inputs, name),
        `workflow_dispatch must expose the "${name}" input`,
      );
    }
  });

  it('defaults max_cost_usd to 150 and dry_run to false', () => {
    const inputs = triggers(workflow).workflow_dispatch.inputs;
    assert.equal(
      String(inputs.max_cost_usd.default),
      '150',
      'max_cost_usd must default to 150',
    );
    assert.equal(
      inputs.dry_run.default,
      false,
      'dry_run must default to false',
    );
    assert.equal(
      inputs.dry_run.type,
      'boolean',
      'dry_run must be a boolean input',
    );
  });

  it('wires plan → canary → per-cell matrix → aggregate via needs', () => {
    const jobs = workflow.jobs ?? {};
    for (const id of ['plan', 'canary', 'cell', 'aggregate']) {
      assert.ok(jobs[id], `workflow must declare the "${id}" job`);
    }

    const needs = (id) => {
      const n = jobs[id].needs;
      return Array.isArray(n) ? n : n == null ? [] : [n];
    };

    assert.deepEqual(needs('plan'), [], 'plan is the root job (no needs)');
    assert.ok(needs('canary').includes('plan'), 'canary must run after plan');
    // The matrix needs BOTH plan (for the cell list) and canary (so a canary
    // failure aborts the paid matrix — the cheapest rung gates the spend).
    assert.ok(
      needs('cell').includes('plan') && needs('cell').includes('canary'),
      'the per-cell matrix must need both plan and canary',
    );
    assert.ok(
      needs('aggregate').includes('cell'),
      'aggregate must run after the per-cell matrix',
    );
  });

  it('runs the hello-world rung as the canary smoke', () => {
    const canary = workflow.jobs.canary;
    const runsHelloWorld = (canary.steps ?? []).some(
      (step) => step.env?.BENCH_SCENARIOS === 'hello-world',
    );
    assert.ok(
      runsHelloWorld,
      'the canary must run the hello-world scenario first',
    );
  });

  it('caps the matrix at 6 parallel jobs, one per deficit cell', () => {
    const cell = workflow.jobs.cell;
    assert.ok(cell.strategy, 'the cell job must declare a matrix strategy');
    assert.equal(
      cell.strategy['max-parallel'],
      6,
      'the matrix must cap concurrency at 6',
    );
    // The matrix is sourced from the plan job's computed deficit output, so it
    // fans out exactly one job per deficit cell.
    assert.match(
      String(cell.strategy.matrix),
      /needs\.plan\.outputs\.matrix/,
      'the matrix must be sourced from the plan job deficit output',
    );
  });

  it('exports BENCH_MAX_COST_USD carrying each cell its allocated share', () => {
    const runStep = (workflow.jobs.cell.steps ?? []).find(
      (step) => step.env && 'BENCH_MAX_COST_USD' in step.env,
    );
    assert.ok(
      runStep,
      'a cell step must export BENCH_MAX_COST_USD for the in-loop ceiling',
    );
    assert.match(
      String(runStep.env.BENCH_MAX_COST_USD),
      /matrix\.allocatedCostUsd/,
      'BENCH_MAX_COST_USD must carry the per-cell allocated share',
    );
  });

  it('uploads each cell scorecards and the .raw provenance as artifacts', () => {
    const uploadStep = (workflow.jobs.cell.steps ?? []).find(
      (step) => (step.uses ?? '').split('@')[0] === 'actions/upload-artifact',
    );
    assert.ok(uploadStep, 'the cell job must upload an artifact');
    const uploadPath = String(uploadStep.with?.path ?? '');
    assert.match(
      uploadPath,
      /scorecards\.ndjson/,
      'the artifact must include the scorecards store',
    );
    assert.match(
      uploadPath,
      /\.raw/,
      'the artifact must include the .raw provenance tree',
    );
  });

  it('aggregates via the standalone CLI and opens a results PR', () => {
    const aggregate = workflow.jobs.aggregate;
    const mergeStep = (aggregate.steps ?? []).find(
      (step) =>
        typeof step.run === 'string' &&
        step.run.includes('bench/report/aggregate-cli.js'),
    );
    assert.ok(
      mergeStep,
      'aggregate must invoke the standalone aggregate-cli.js',
    );

    assert.ok(
      usedActions(workflow).includes('peter-evans/create-pull-request'),
      'aggregate must open a pull request (never push to main)',
    );
  });

  it('never pushes to main from any job', () => {
    // Hard guard: no job may push results straight to main. The results PR is
    // the review gate; a raw `git push` to main would orphan the change and
    // bypass review. Assert no step runs a push targeting main.
    for (const step of allSteps(workflow)) {
      if (typeof step.run !== 'string') continue;
      assert.doesNotMatch(
        step.run,
        /git\s+push[^\n]*\bmain\b/,
        'no step may git push to main',
      );
      assert.doesNotMatch(
        step.run,
        /git\s+push\s+origin\s+HEAD:main/,
        'no step may push HEAD to main',
      );
    }
    // And the create-pull-request step must target main as the PR BASE (open a
    // PR against main), not push to it.
    const prStep = allSteps(workflow).find(
      (step) =>
        (step.uses ?? '').split('@')[0] === 'peter-evans/create-pull-request',
    );
    assert.equal(
      prStep.with?.base,
      'main',
      'the PR must be opened against main',
    );
  });

  it('guards every paid job behind has_deficit && dry_run gates; plan always runs', () => {
    // Money-safety gate (H5): a complete cohort (has_deficit=false) or a
    // dry-run must skip every job that can spend, but the plan job itself must
    // ALWAYS run so it can compute the deficit / print the dry-run plan.
    const jobs = workflow.jobs ?? {};
    for (const id of ['canary', 'cell', 'aggregate']) {
      const guard = String(jobs[id].if ?? '');
      assert.match(
        guard,
        /has_deficit == 'true'/,
        `${id} must gate on has_deficit == 'true'`,
      );
      assert.match(
        guard,
        /dry_run != true/,
        `${id} must gate on dry_run != true`,
      );
    }
    assert.ok(
      jobs.plan.if == null,
      'the plan job must carry NO such guard — it always runs',
    );
  });

  it('aggregate runs even if a cell fails (always()), so paid work is not stranded', () => {
    // H3/H5: the aggregate job must use always() so a single failed cell no
    // longer skips aggregation and strands the rest of the cohort with no PR.
    const guard = String(workflow.jobs.aggregate.if ?? '');
    assert.match(
      guard,
      /always\(\)/,
      'aggregate must use always() so one failed cell never strands the rest',
    );
  });

  it('caps each cell at its deficit via BENCH_MAX_RUNS', () => {
    // H2/H5: the cell run step must set BENCH_MAX_RUNS from matrix.deficit so a
    // cell can never re-run the full scenario targetN and overspend.
    const runStep = (workflow.jobs.cell.steps ?? []).find(
      (step) => step.env && 'BENCH_MAX_RUNS' in step.env,
    );
    assert.ok(
      runStep,
      'a cell step must set BENCH_MAX_RUNS to cap new runs at the deficit',
    );
    assert.match(
      String(runStep.env.BENCH_MAX_RUNS),
      /matrix\.deficit/,
      'BENCH_MAX_RUNS must carry the per-cell deficit',
    );
  });

  it('installs a non-blank mandrel_version override in plan, canary, and cell — before mandrel sync', () => {
    // The mandrel_version input was previously declared but never threaded
    // into an install step, so a dispatch setting it silently benchmarked the
    // pinned dependency (the Epic #84 audit's escalated follow-up). Guard the
    // full contract per job: the override step exists, is gated on a non-blank
    // input, installs via a QUOTED env var with --no-save, and precedes
    // `npx mandrel sync` so the materialized bundle matches the version the
    // cohort stamp (node_modules/mandrel/package.json) resolves.
    for (const jobId of ['plan', 'canary', 'cell']) {
      const steps = workflow.jobs[jobId].steps ?? [];
      const overrideIdx = steps.findIndex(
        (step) =>
          typeof step.run === 'string' &&
          /npm install "mandrel@\$MANDREL_VERSION"/.test(step.run),
      );
      assert.ok(
        overrideIdx !== -1,
        `${jobId} must install the mandrel_version override via a quoted $MANDREL_VERSION env var`,
      );
      const override = steps[overrideIdx];
      assert.match(
        String(override.if ?? ''),
        /inputs\.mandrel_version\s*!=\s*''/,
        `${jobId}'s override step must be gated on a non-blank mandrel_version input`,
      );
      assert.match(
        String(override.env?.MANDREL_VERSION ?? ''),
        /inputs\.mandrel_version/,
        `${jobId}'s override step must source MANDREL_VERSION from the input via env`,
      );
      assert.match(
        override.run,
        /--no-save/,
        `${jobId}'s override install must be --no-save (never mutate the lockfile)`,
      );
      const syncIdx = steps.findIndex(
        (step) =>
          typeof step.run === 'string' && step.run.includes('npx mandrel sync'),
      );
      assert.ok(
        syncIdx !== -1 && overrideIdx < syncIdx,
        `${jobId} must install the override BEFORE npx mandrel sync`,
      );
    }
  });

  it('never interpolates a dispatch input into a run body (H1 injection guard)', () => {
    // Inputs reach run bodies only as quoted env vars; an Actions-expression
    // interpolation of an input inside a run: block is a shell-injection
    // surface. This codifies the H1 convention every step in this workflow
    // follows.
    for (const step of allSteps(workflow)) {
      if (typeof step.run !== 'string') continue;
      // Match a REAL interpolation (`${{ inputs.model }}`), not the shell
      // comment that documents the convention (`${{ inputs.* }}`).
      assert.doesNotMatch(
        step.run,
        /\$\{\{\s*inputs\.[a-zA-Z_]/,
        `run body of step "${step.name ?? step.run.slice(0, 40)}" must not interpolate inputs`,
      );
    }
  });

  it('references the two required Action secrets', () => {
    assert.match(
      rawWorkflow,
      /secrets\.ANTHROPIC_API_KEY/,
      'must reference the ANTHROPIC_API_KEY secret',
    );
    assert.match(
      rawWorkflow,
      /secrets\.BENCH_GITHUB_TOKEN/,
      'must reference the BENCH_GITHUB_TOKEN secret',
    );
  });
});
