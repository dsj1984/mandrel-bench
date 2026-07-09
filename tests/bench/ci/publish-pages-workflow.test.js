// tests/bench/ci/publish-pages-workflow.test.js
//
// Unit tier (pure file read + YAML parse, no network, no GitHub) for the
// GitHub Pages publish workflow (Epic #84, Story #88). Shape-asserts
// .github/workflows/publish-pages.yml against the Story's binding acceptance:
//
//   1. The workflow exists, triggers on push to `main` touching the committed
//      dashboard (results/results.html), and deploys results.html via the
//      standard GitHub Pages deploy actions (configure-pages /
//      upload-pages-artifact / deploy-pages).
//   2. It deploys ONLY the dashboard artifact (results.html) and NEVER the
//      `.raw` provenance tree — the staged publish root is a curated copy of
//      results.html alone, and nothing in the workflow references `.raw`.
//
// These are static shape assertions, not an integration run: they guard the
// workflow's contract (trigger path, least-privilege token, deploy action,
// no-provenance-leak) so a future edit that broadens the trigger, drops the
// deploy step, or rsyncs the whole results/ tree (including .raw) fails here.

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
  'publish-pages.yml',
);

const rawWorkflow = readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = parse(rawWorkflow);

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

describe('publish-pages workflow — shape contract', () => {
  it('parses as valid YAML with a named workflow', () => {
    assert.equal(typeof workflow, 'object');
    assert.ok(workflow !== null, 'workflow must parse to an object');
    assert.equal(typeof workflow.name, 'string');
    assert.ok(workflow.name.length > 0, 'workflow must be named');
  });

  it('triggers on push to main touching the committed dashboard', () => {
    // YAML parses the bare `on:` key as the boolean `true`, so read it either
    // way to stay robust to how the parser keys the trigger block.
    const on = workflow.on ?? workflow[true];
    assert.ok(on, 'workflow must declare triggers');

    const push = on.push;
    assert.ok(push, 'must trigger on push');
    assert.deepEqual(
      push.branches,
      ['main'],
      'push trigger must be scoped to the main branch',
    );
    assert.deepEqual(
      push.paths,
      ['results/results.html'],
      'push trigger must be path-filtered to the committed dashboard only',
    );
  });

  it('requests the least-privilege token GitHub Pages deployment needs', () => {
    const perms = workflow.permissions ?? {};
    assert.equal(perms.pages, 'write', 'needs pages: write to deploy');
    assert.equal(
      perms['id-token'],
      'write',
      'needs id-token: write for the deploy-pages OIDC verification',
    );
  });

  it('deploys via the standard GitHub Pages deploy actions', () => {
    const actions = usedActions(workflow);
    assert.ok(
      actions.includes('actions/configure-pages'),
      'must configure Pages',
    );
    assert.ok(
      actions.includes('actions/upload-pages-artifact'),
      'must upload the Pages artifact',
    );
    assert.ok(
      actions.includes('actions/deploy-pages'),
      'must deploy via actions/deploy-pages',
    );
  });

  it('stages ONLY results.html and NEVER the .raw provenance tree', () => {
    // The staging step copies results/results.html into a curated publish
    // root; the uploaded artifact points at that curated root, not the whole
    // results/ tree.
    const uploadStep = allSteps(workflow).find(
      (step) =>
        (step.uses ?? '').split('@')[0] === 'actions/upload-pages-artifact',
    );
    assert.ok(uploadStep, 'must have an upload-pages-artifact step');
    const uploadPath = uploadStep.with?.path;
    assert.ok(uploadPath, 'upload step must declare a path');
    assert.notEqual(
      uploadPath.replace(/\/+$/, ''),
      'results',
      'must NOT upload the whole results/ tree (that would include .raw)',
    );

    const stageStep = allSteps(workflow).find(
      (step) =>
        typeof step.run === 'string' &&
        step.run.includes('results/results.html'),
    );
    assert.ok(
      stageStep,
      'must have a run step that stages results/results.html',
    );
    assert.ok(
      stageStep.run.includes(uploadPath),
      'the staged output must be what the artifact upload points at',
    );

    // Hard guard: nothing anywhere in the workflow may reference the `.raw`
    // provenance tree — it must never reach the public site.
    assert.ok(
      !rawWorkflow.includes('.raw'),
      'the workflow must never reference the .raw provenance tree',
    );
  });
});
