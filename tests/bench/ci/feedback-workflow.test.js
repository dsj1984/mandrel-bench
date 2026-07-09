// tests/bench/ci/feedback-workflow.test.js
//
// Unit tier (pure file read + YAML parse, no network, no GitHub) for the
// merge-gated feedback filing pipeline (Epic #85, Story #93; target-architecture
// §7, D-016). Shape-asserts the delivered workflow YAML against the Story's
// binding acceptance:
//
//   1. .github/workflows/feedback-file.yml triggers ONLY on push to `main`
//      touching the results tree (i.e. after a results-PR merge) and invokes
//      bench/feedback/file.js against the merged finding envelopes.
//   2. It NEVER runs on pull_request, and NO OTHER workflow invokes the filer —
//      so an unreviewed cohort can never write to the mandrel repo. This is
//      proven by scanning EVERY workflow file, not just feedback-file.yml.
//   3. The Epic #84 benchmark workflow's aggregate job is wired to invoke the
//      feedback derive CLI (bench/feedback/derive-cli.js), so the results PR
//      embeds the findings section and commits the envelope JSON with the
//      results.
//
// These are static shape assertions read from the delivered YAML at runtime, not
// an integration run: they guard the activation surface so a future edit that
// adds a pull_request trigger, invokes the filer from another workflow, or drops
// the aggregate-job derive wiring fails here.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const FEEDBACK_PATH = path.join(WORKFLOWS_DIR, 'feedback-file.yml');
const BENCHMARK_PATH = path.join(WORKFLOWS_DIR, 'benchmark.yml');

const rawFeedback = readFileSync(FEEDBACK_PATH, 'utf8');
const feedback = parse(rawFeedback);

/** The trigger block, robust to how the parser keys the bare `on:`. */
function triggers(wf) {
  return wf.on ?? wf[true];
}

/** Flatten every job's steps into one array of step objects. */
function allSteps(wf) {
  return Object.values(wf.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

/** Every `.github/workflows/*.yml` file as `{ name, raw }`. */
function allWorkflowFiles() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({
      name: f,
      raw: readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8'),
    }));
}

describe('feedback-file workflow — merge gate', () => {
  it('parses as valid YAML with a named workflow', () => {
    assert.equal(typeof feedback, 'object');
    assert.ok(feedback !== null, 'workflow must parse to an object');
    assert.equal(typeof feedback.name, 'string');
    assert.ok(feedback.name.length > 0, 'workflow must be named');
  });

  it('triggers ONLY on push to main touching the results tree', () => {
    const on = triggers(feedback);
    assert.ok(on, 'workflow must declare triggers');
    assert.ok(on.push, 'workflow must trigger on push');

    const branches = on.push.branches ?? [];
    assert.ok(
      branches.includes('main'),
      'the push trigger must be scoped to the main branch',
    );

    const paths = on.push.paths ?? [];
    assert.ok(
      paths.length > 0,
      'the push trigger must be path-filtered to the results tree',
    );
    assert.ok(
      paths.every((p) => p.includes('results/')),
      'every push path filter must be under the results tree',
    );
    // The gate is a results-PR MERGE: the envelope lands on main under results/.
    assert.ok(
      paths.some((p) => /findings-.*\.json/.test(p)),
      'the push trigger must fire on a merged finding envelope',
    );
  });

  it('NEVER runs on pull_request (an unreviewed cohort cannot write)', () => {
    const on = triggers(feedback);
    assert.ok(
      !Object.hasOwn(on, 'pull_request'),
      'feedback-file.yml must not declare a pull_request trigger',
    );
    assert.ok(
      !Object.hasOwn(on, 'pull_request_target'),
      'feedback-file.yml must not declare a pull_request_target trigger',
    );
    // Belt-and-braces on the raw text: no pull_request event is DECLARED as a
    // trigger key (prose in comments is fine; a `pull_request:` key is not).
    assert.doesNotMatch(
      rawFeedback,
      /^\s*pull_request(_target)?:/m,
      'the raw workflow must not declare a pull_request trigger key',
    );
  });

  it('invokes the filer against the merged envelopes', () => {
    const filerStep = allSteps(feedback).find(
      (step) =>
        typeof step.run === 'string' &&
        step.run.includes('bench/feedback/file.js'),
    );
    assert.ok(
      filerStep,
      'a step must invoke the fingerprint-deduplicated filer',
    );
    assert.match(
      String(filerStep.run),
      /--envelope/,
      'the filer must be invoked against a finding-envelope path',
    );
  });

  it('requests no write scope on this repo (cross-repo write goes elsewhere)', () => {
    // The filer writes to dsj1984/mandrel via its own token; this workflow must
    // stay read-only on THIS repo (least privilege).
    assert.equal(
      feedback.permissions?.contents,
      'read',
      'the workflow must declare contents: read (least privilege)',
    );
  });
});

describe('no other workflow invokes the filer', () => {
  it('bench/feedback/file.js is invoked ONLY by feedback-file.yml', () => {
    const invokers = allWorkflowFiles().filter((wf) =>
      wf.raw.includes('bench/feedback/file.js'),
    );
    assert.deepEqual(
      invokers.map((wf) => wf.name).sort(),
      ['feedback-file.yml'],
      'the filer must be invoked by feedback-file.yml and no other workflow',
    );
  });
});

describe('benchmark aggregate job — derive wiring', () => {
  const benchmark = parse(readFileSync(BENCHMARK_PATH, 'utf8'));

  it('the aggregate job invokes the feedback derive CLI', () => {
    const aggregate = benchmark.jobs?.aggregate;
    assert.ok(aggregate, 'benchmark.yml must declare the aggregate job');
    const deriveStep = (aggregate.steps ?? []).find(
      (step) =>
        typeof step.run === 'string' &&
        step.run.includes('bench/feedback/derive-cli.js'),
    );
    assert.ok(
      deriveStep,
      'the aggregate job must invoke bench/feedback/derive-cli.js so the ' +
        'results PR embeds the findings section and commits the envelope JSON',
    );
  });

  it('the aggregate job still opens the results PR (does not file directly)', () => {
    const aggregate = benchmark.jobs?.aggregate;
    const usesPr = (aggregate.steps ?? []).some(
      (step) =>
        (step.uses ?? '').split('@')[0] === 'peter-evans/create-pull-request',
    );
    assert.ok(usesPr, 'the aggregate job must open a results PR');
    // The aggregate job must NOT run the filer — filing is merge-gated.
    const filesHere = (aggregate.steps ?? []).some(
      (step) =>
        typeof step.run === 'string' &&
        step.run.includes('bench/feedback/file.js'),
    );
    assert.ok(
      !filesHere,
      'the aggregate job must NOT file feedback (filing is merge-gated)',
    );
  });
});
