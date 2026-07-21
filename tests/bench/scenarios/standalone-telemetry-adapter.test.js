// tests/bench/scenarios/standalone-telemetry-adapter.test.js
//
// Unit tier for bench/scenarios/standalone-telemetry-adapter.js (Story #48).
// Every GitHub read is stubbed through the injected `ghJson` port — no network,
// no `gh` child process. Mirrors the Epic-path ledger-derivation coverage.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectMultiStoryTelemetry,
  collectStandaloneTelemetry,
  discoverStandaloneStory,
  discoverStories,
} from '../../../bench/scenarios/standalone-telemetry-adapter.js';

const OWNER = 'dsj1984';
const REPO = 'bench-sbx-c1-hw-mandrel-a1b2';

/**
 * Build a `ghJson` stub that routes by the gh subcommand + selector. Each route
 * is a function of the args returning the parsed-JSON value.
 */
function makeGh(routes) {
  return (args) => {
    const key = `${args[0]} ${args[1]}`; // e.g. "issue list", "issue view", "pr list"
    const route = routes[key];
    if (!route)
      throw new Error(`unstubbed gh route: ${key} (${args.join(' ')})`);
    return typeof route === 'function' ? route(args) : route;
  };
}

describe('discoverStandaloneStory', () => {
  it('returns the newest type::story created at/after run start', () => {
    const ghJson = makeGh({
      'issue list': [
        { number: 70, createdAt: '2026-06-19T12:10:00Z' }, // before run
        { number: 72, createdAt: '2026-06-19T14:20:00Z' }, // this run
      ],
    });
    const n = discoverStandaloneStory(
      { owner: OWNER, repo: REPO, sinceIso: '2026-06-19T14:00:00Z' },
      { ghJson },
    );
    assert.equal(n, 72);
  });

  it('ignores Stories created before run start (sequential-run isolation)', () => {
    const ghJson = makeGh({
      'issue list': [{ number: 70, createdAt: '2026-06-19T12:10:00Z' }],
    });
    const n = discoverStandaloneStory(
      { owner: OWNER, repo: REPO, sinceIso: '2026-06-19T14:00:00Z' },
      { ghJson },
    );
    assert.equal(n, null);
  });

  it('returns null (not a throw) when gh fails', () => {
    const ghJson = () => {
      throw new Error('gh exploded');
    };
    const n = discoverStandaloneStory(
      { owner: OWNER, repo: REPO, sinceIso: '2026-06-19T14:00:00Z' },
      { ghJson },
    );
    assert.equal(n, null);
  });
});

describe('collectStandaloneTelemetry', () => {
  const cleanRoutes = {
    'issue view': {
      number: 72,
      state: 'CLOSED',
      createdAt: '2026-06-19T14:00:00Z',
      closedAt: '2026-06-19T14:38:00Z',
      labels: [{ name: 'type::story' }, { name: 'agent::done' }],
      comments: [
        {
          body: '<!-- ap:structured-comment type="story-init" -->\n"standalone": true',
        },
        { body: '✅ merge confirmed; flipped to agent::done.' },
      ],
    },
    'pr list': [
      {
        number: 73,
        mergedAt: '2026-06-19T14:38:33Z',
        files: [{ path: 'src/server.js' }, { path: 'src/store.js' }],
      },
    ],
  };

  it('measures a clean standalone delivery (planned=delivered=1, autonomy clean)', () => {
    const t = collectStandaloneTelemetry(
      { owner: OWNER, repo: REPO, storyNumber: 72 },
      { ghJson: makeGh(cleanRoutes) },
    );
    assert.equal(t.routingVerdict, 'story');
    assert.equal(t.planning.plannedStoryCount, 1);
    assert.equal(t.planning.deliveredStoryCount, 1);
    assert.equal(t.planning.rePlanCount, 0);
    assert.deepEqual(t.planning.actualPaths, ['src/server.js', 'src/store.js']);
    assert.deepEqual(t.autonomy, {
      hitlStops: 0,
      blockedEvents: 0,
      manualRescues: 0,
      gateRetries: 0,
    });
  });

  describe('phases (Epic #66, Story #77 — overhead phase-split)', () => {
    it('returns createdAt/closedAt/prMergedAt and a derived codegenMs', () => {
      const t = collectStandaloneTelemetry(
        { owner: OWNER, repo: REPO, storyNumber: 72 },
        { ghJson: makeGh(cleanRoutes) },
      );
      assert.equal(t.phases.createdAt, '2026-06-19T14:00:00Z');
      assert.equal(t.phases.closedAt, '2026-06-19T14:38:00Z');
      assert.equal(t.phases.prMergedAt, '2026-06-19T14:38:33Z');
      // 14:38:00 − 14:00:00 = 38 minutes
      assert.equal(t.phases.codegenMs, 38 * 60 * 1000);
    });

    it('codegenMs is null when createdAt or closedAt cannot be parsed', () => {
      const t = collectStandaloneTelemetry(
        { owner: OWNER, repo: REPO, storyNumber: 72 },
        {
          ghJson: makeGh({
            ...cleanRoutes,
            'issue view': { ...cleanRoutes['issue view'], closedAt: null },
          }),
        },
      );
      assert.equal(t.phases.codegenMs, null);
      assert.equal(t.phases.closedAt, null);
    });

    it('clamps a negative span (clock skew) to 0 rather than going negative', () => {
      const t = collectStandaloneTelemetry(
        { owner: OWNER, repo: REPO, storyNumber: 72 },
        {
          ghJson: makeGh({
            ...cleanRoutes,
            'issue view': {
              ...cleanRoutes['issue view'],
              createdAt: '2026-06-19T15:00:00Z', // after closedAt
            },
          }),
        },
      );
      assert.equal(t.phases.codegenMs, 0);
    });
  });

  it('scores deliveredStoryCount 0 when the PR never merged', () => {
    const t = collectStandaloneTelemetry(
      { owner: OWNER, repo: REPO, storyNumber: 72 },
      {
        ghJson: makeGh({
          ...cleanRoutes,
          'pr list': [{ number: 73, mergedAt: null, files: [] }],
        }),
      },
    );
    assert.equal(t.planning.deliveredStoryCount, 0);
  });

  it('scores deliveredStoryCount 0 when the issue is not agent::done', () => {
    const t = collectStandaloneTelemetry(
      { owner: OWNER, repo: REPO, storyNumber: 72 },
      {
        ghJson: makeGh({
          ...cleanRoutes,
          'issue view': {
            number: 72,
            state: 'OPEN',
            labels: [{ name: 'type::story' }, { name: 'agent::blocked' }],
            comments: [],
          },
        }),
      },
    );
    assert.equal(t.planning.deliveredStoryCount, 0);
    // agent::blocked is an autonomy intervention → autonomy < 1
    assert.equal(t.autonomy.blockedEvents, 1);
  });

  it('counts blocked / intervention / hitl-stop structured comments as autonomy hits', () => {
    const t = collectStandaloneTelemetry(
      { owner: OWNER, repo: REPO, storyNumber: 72 },
      {
        ghJson: makeGh({
          ...cleanRoutes,
          'issue view': {
            number: 72,
            state: 'CLOSED',
            labels: [{ name: 'agent::done' }],
            comments: [
              { body: '<!-- ap:structured-comment type="story-blocked" -->' },
              { body: '<!-- ap:structured-comment type="intervention" -->' },
              { body: '<!-- ap:structured-comment type="hitl-stop" -->' },
            ],
          },
        }),
      },
    );
    assert.equal(t.autonomy.blockedEvents, 1);
    assert.equal(t.autonomy.manualRescues, 1);
    assert.equal(t.autonomy.hitlStops, 1);
  });

  it('does NOT count a bare `agent::blocked` mention in a delivery-summary comment (Ticket #121, item 3)', () => {
    const t = collectStandaloneTelemetry(
      { owner: OWNER, repo: REPO, storyNumber: 72 },
      {
        ghJson: makeGh({
          ...cleanRoutes,
          'issue view': {
            number: 72,
            state: 'CLOSED',
            labels: [{ name: 'type::story' }, { name: 'agent::done' }],
            comments: [
              // A prose delivery summary that merely mentions the label — the
              // old bare-substring BLOCKED_RE scored this as an intervention,
              // pinning every standalone cell at blockedEvents=1 → autonomy 0.50.
              {
                body: 'Delivery complete. The run never transitioned to agent::blocked and needed no intervention.',
              },
            ],
          },
        }),
      },
    );
    assert.equal(t.autonomy.blockedEvents, 0);
    assert.equal(t.autonomy.gateRetries, 0);
  });

  it('returns null when the issue cannot be read', () => {
    const t = collectStandaloneTelemetry(
      { owner: OWNER, repo: REPO, storyNumber: 72 },
      {
        ghJson: makeGh({
          'issue view': () => {
            throw new Error('not found');
          },
        }),
      },
    );
    assert.equal(t, null);
  });
});

// ---------------------------------------------------------------------------
// Multi-Story path (v2 Epic collapse)
// ---------------------------------------------------------------------------

/**
 * Build a `ghJson` stub for the multi-Story path, where `issue view` and
 * `pr list` are called once PER STORY. Routes on the story number carried in
 * the args (the issue number for `issue view`, the `story-<n>` head branch for
 * `pr list`) so each Story can return a distinct fixture.
 *
 * @param {{ issues: Record<number, object>, prs: Record<number, object[]>, list?: object[] }} spec
 */
function makeMultiGh({ issues, prs, list }) {
  return (args) => {
    const key = `${args[0]} ${args[1]}`;
    if (key === 'issue list') {
      if (!list) throw new Error('unstubbed gh route: issue list');
      return list;
    }
    if (key === 'issue view') {
      const n = Number(args[2]);
      if (!(n in issues)) throw new Error(`unstubbed issue view: ${n}`);
      return issues[n];
    }
    if (key === 'pr list') {
      const headIdx = args.indexOf('--head');
      const n = Number(String(args[headIdx + 1]).replace('story-', ''));
      return prs[n] ?? [];
    }
    throw new Error(`unstubbed gh route: ${key}`);
  };
}

describe('discoverStories (multi-Story path)', () => {
  it('returns EVERY type::story created at/after run start, ascending', () => {
    const ghJson = makeMultiGh({
      issues: {},
      prs: {},
      list: [
        { number: 70, createdAt: '2026-06-19T12:10:00Z' }, // before run
        { number: 74, createdAt: '2026-06-19T14:22:00Z' },
        { number: 72, createdAt: '2026-06-19T14:20:00Z' },
        { number: 73, createdAt: '2026-06-19T14:21:00Z' },
      ],
    });
    const ns = discoverStories(
      { owner: OWNER, repo: REPO, sinceIso: '2026-06-19T14:00:00Z' },
      { ghJson },
    );
    // This is the whole point: the single-Story discovery would return only 74.
    assert.deepEqual(ns, [72, 73, 74]);
  });

  it('returns [] (not a throw) when gh fails', () => {
    const ns = discoverStories(
      { owner: OWNER, repo: REPO, sinceIso: '2026-06-19T14:00:00Z' },
      {
        ghJson: () => {
          throw new Error('gh exploded');
        },
      },
    );
    assert.deepEqual(ns, []);
  });

  it('returns [] when no Story is fresh enough', () => {
    const ns = discoverStories(
      { owner: OWNER, repo: REPO, sinceIso: '2026-06-19T14:00:00Z' },
      {
        ghJson: makeMultiGh({
          issues: {},
          prs: {},
          list: [{ number: 70, createdAt: '2026-06-19T12:10:00Z' }],
        }),
      },
    );
    assert.deepEqual(ns, []);
  });
});

describe('collectMultiStoryTelemetry', () => {
  /** Three Stories, all cleanly delivered. */
  const threeClean = {
    issues: {
      72: {
        number: 72,
        state: 'CLOSED',
        createdAt: '2026-06-19T14:00:00Z',
        closedAt: '2026-06-19T14:10:00Z',
        labels: [{ name: 'type::story' }, { name: 'agent::done' }],
        comments: [],
      },
      73: {
        number: 73,
        state: 'CLOSED',
        createdAt: '2026-06-19T14:10:00Z',
        closedAt: '2026-06-19T14:25:00Z',
        labels: [{ name: 'type::story' }, { name: 'agent::done' }],
        comments: [],
      },
      74: {
        number: 74,
        state: 'CLOSED',
        createdAt: '2026-06-19T14:25:00Z',
        closedAt: '2026-06-19T14:40:00Z',
        labels: [{ name: 'type::story' }, { name: 'agent::done' }],
        comments: [],
      },
    },
    prs: {
      72: [
        {
          number: 90,
          mergedAt: '2026-06-19T14:10:30Z',
          files: [{ path: 'src/auth.js' }],
        },
      ],
      73: [
        {
          number: 91,
          mergedAt: '2026-06-19T14:25:30Z',
          files: [{ path: 'src/projects.js' }, { path: 'src/auth.js' }],
        },
      ],
      74: [
        {
          number: 92,
          mergedAt: '2026-06-19T14:40:30Z',
          files: [{ path: 'src/tasks.js' }],
        },
      ],
    },
  };

  it('counts the REAL planned story count, not a hardcoded 1', () => {
    const t = collectMultiStoryTelemetry(
      { owner: OWNER, repo: REPO, storyNumbers: [72, 73, 74] },
      { ghJson: makeMultiGh(threeClean) },
    );
    // The regression this whole path exists to prevent: the single-Story
    // adapter hardcodes plannedStoryCount: 1, which would score a 4-6
    // decomposition contract at 0.5 forever while looking like a measurement.
    assert.equal(t.planning.plannedStoryCount, 3);
    assert.equal(t.planning.deliveredStoryCount, 3);
    assert.equal(t.routingVerdict, 'multi-story');
  });

  it('unions actualPaths across Stories without duplicating shared files', () => {
    const t = collectMultiStoryTelemetry(
      { owner: OWNER, repo: REPO, storyNumbers: [72, 73, 74] },
      { ghJson: makeMultiGh(threeClean) },
    );
    assert.deepEqual(t.planning.actualPaths, [
      'src/auth.js',
      'src/projects.js',
      'src/tasks.js',
    ]);
  });

  it('sums autonomy counters across Stories', () => {
    const withHits = {
      ...threeClean,
      issues: {
        ...threeClean.issues,
        73: {
          ...threeClean.issues[73],
          labels: [{ name: 'type::story' }, { name: 'agent::blocked' }],
          state: 'OPEN',
          comments: [
            { body: '<!-- ap:structured-comment type="intervention" -->' },
          ],
        },
        74: {
          ...threeClean.issues[74],
          comments: [
            { body: '<!-- ap:structured-comment type="story-blocked" -->' },
            { body: '<!-- ap:structured-comment type="re-plan" -->' },
          ],
        },
      },
    };
    const t = collectMultiStoryTelemetry(
      { owner: OWNER, repo: REPO, storyNumbers: [72, 73, 74] },
      { ghJson: makeMultiGh(withHits) },
    );
    assert.equal(t.autonomy.blockedEvents, 2); // #73 label + #74 structured
    assert.equal(t.autonomy.manualRescues, 1);
    assert.equal(t.planning.rePlanCount, 1);
    // #73 never reached agent::done → only 2 of 3 delivered.
    assert.equal(t.planning.deliveredStoryCount, 2);
  });

  it('spans phases from the earliest createdAt to the latest closedAt and sums codegen', () => {
    const t = collectMultiStoryTelemetry(
      { owner: OWNER, repo: REPO, storyNumbers: [72, 73, 74] },
      { ghJson: makeMultiGh(threeClean) },
    );
    assert.equal(t.phases.createdAt, '2026-06-19T14:00:00Z');
    assert.equal(t.phases.closedAt, '2026-06-19T14:40:00Z');
    assert.equal(t.phases.prMergedAt, '2026-06-19T14:40:30Z');
    // 10 + 15 + 15 minutes of per-Story implementation window.
    assert.equal(t.phases.codegenMs, 40 * 60 * 1000);
  });

  it('still measures the Stories it CAN read when one is unreadable', () => {
    const partial = {
      ...threeClean,
      issues: { 72: threeClean.issues[72], 74: threeClean.issues[74] },
    };
    const t = collectMultiStoryTelemetry(
      { owner: OWNER, repo: REPO, storyNumbers: [72, 73, 74] },
      { ghJson: makeMultiGh(partial) },
    );
    // plannedStoryCount reflects what the PLAN opened (3) even though only 2
    // Stories could be read — dropping to 2 would silently forgive a Story
    // that vanished.
    assert.equal(t.planning.plannedStoryCount, 3);
    assert.equal(t.planning.deliveredStoryCount, 2);
    assert.equal(t.unreadableStoryCount, 1);
  });

  it('returns null when no Story number is supplied', () => {
    const t = collectMultiStoryTelemetry(
      { owner: OWNER, repo: REPO, storyNumbers: [] },
      { ghJson: makeMultiGh(threeClean) },
    );
    assert.equal(t, null);
  });

  it('returns null when NO Story can be read (nothing measured, never a fake 0)', () => {
    const t = collectMultiStoryTelemetry(
      { owner: OWNER, repo: REPO, storyNumbers: [72, 73] },
      { ghJson: makeMultiGh({ issues: {}, prs: {} }) },
    );
    assert.equal(t, null);
  });
});
