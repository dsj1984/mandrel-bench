// tests/bench/scenarios/standalone-telemetry-adapter.test.js
//
// Unit tier for bench/scenarios/standalone-telemetry-adapter.js (Story #48).
// Every GitHub read is stubbed through the injected `ghJson` port — no network,
// no `gh` child process. Mirrors the Epic-path ledger-derivation coverage.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectStandaloneTelemetry,
  discoverStandaloneStory,
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
