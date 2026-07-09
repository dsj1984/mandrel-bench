// tests/bench/driver/janitor.test.js
/**
 * Unit tests for bench/driver/janitor.js — Story #72.
 *
 * Verifies the TTL sweep of leaked `bench-sbx-*` ephemeral sandbox repos:
 *   - the triple filter (prefix AND owner AND TTL) admits only genuine
 *     leaked repos, excluding younger repos, foreign-owner repos, and
 *     non-prefixed repos,
 *   - an empty listing is a no-op,
 *   - a delete failure for one repo is logged and does NOT abort the sweep
 *     of the remaining candidates,
 *   - `--dry-run` lists candidates without deleting anything,
 *   - `node bench/driver/janitor.js --help` prints usage and exits 0
 *     without requiring any env var,
 *   - the default TTL is 24h, overridable via `--ttl-hours` / env var.
 *
 * Every `gh` effect is INJECTED — no real `gh repo list`/`gh repo delete`
 * call runs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_TTL_HOURS,
  filterLeakedRepos,
  main,
  parseJanitorCliArgs,
  sweepLeakedRepos,
  TTL_HOURS_ENV_VAR,
} from '../../../bench/driver/janitor.js';

const OWNER = 'dsj1984';
const NOW = new Date('2026-07-09T12:00:00.000Z');

function hoursAgo(h) {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();
}

function makeLogger() {
  const messages = { info: [], warn: [], error: [] };
  return {
    logger: {
      info: (m) => messages.info.push(m),
      warn: (m) => messages.warn.push(m),
      error: (m) => messages.error.push(m),
    },
    messages,
  };
}

// ---------------------------------------------------------------------------
// filterLeakedRepos — the pure triple filter
// ---------------------------------------------------------------------------

test('filterLeakedRepos: admits a prefixed, owner-matched, TTL-expired repo', () => {
  const repos = [
    {
      name: 'bench-sbx-c1-hw-mandrel-a1b2',
      owner: OWNER,
      createdAt: hoursAgo(30),
    },
  ];
  const candidates = filterLeakedRepos({ repos, owner: OWNER, now: NOW });
  assert.equal(candidates.length, 1);
  assert.equal(
    candidates[0].repoFullName,
    `${OWNER}/bench-sbx-c1-hw-mandrel-a1b2`,
  );
  assert.ok(candidates[0].ageHours > 24);
});

test('filterLeakedRepos: excludes a repo younger than the TTL', () => {
  const repos = [
    {
      name: 'bench-sbx-c1-hw-mandrel-a1b2',
      owner: OWNER,
      createdAt: hoursAgo(1),
    },
  ];
  const candidates = filterLeakedRepos({ repos, owner: OWNER, now: NOW });
  assert.equal(candidates.length, 0);
});

test('filterLeakedRepos: excludes a foreign-owner repo even when prefixed and expired', () => {
  const repos = [
    {
      name: 'bench-sbx-c1-hw-mandrel-a1b2',
      owner: 'someone-else',
      createdAt: hoursAgo(48),
    },
  ];
  const candidates = filterLeakedRepos({ repos, owner: OWNER, now: NOW });
  assert.equal(candidates.length, 0);
});

test('filterLeakedRepos: excludes a non-prefixed repo even when owner-matched and old', () => {
  const repos = [
    { name: 'some-other-repo', owner: OWNER, createdAt: hoursAgo(999) },
  ];
  const candidates = filterLeakedRepos({ repos, owner: OWNER, now: NOW });
  assert.equal(candidates.length, 0);
});

test('filterLeakedRepos: accepts the gh CLI object-owner shape ({ login })', () => {
  const repos = [
    {
      name: 'bench-sbx-c1-hw-mandrel-a1b2',
      owner: { login: OWNER },
      createdAt: hoursAgo(48),
    },
  ];
  const candidates = filterLeakedRepos({ repos, owner: OWNER, now: NOW });
  assert.equal(candidates.length, 1);
});

test('filterLeakedRepos: TTL boundary — exactly at the TTL is expired (>=), one second under is not', () => {
  const atBoundary = filterLeakedRepos({
    repos: [{ name: 'bench-sbx-x', owner: OWNER, createdAt: hoursAgo(24) }],
    owner: OWNER,
    ttlHours: 24,
    now: NOW,
  });
  assert.equal(atBoundary.length, 1);

  const underBoundary = filterLeakedRepos({
    repos: [{ name: 'bench-sbx-x', owner: OWNER, createdAt: hoursAgo(23.999) }],
    owner: OWNER,
    ttlHours: 24,
    now: NOW,
  });
  assert.equal(underBoundary.length, 0);
});

test('filterLeakedRepos: default TTL is 24h', () => {
  assert.equal(DEFAULT_TTL_HOURS, 24);
});

test('filterLeakedRepos: an empty listing yields no candidates', () => {
  assert.deepEqual(
    filterLeakedRepos({ repos: [], owner: OWNER, now: NOW }),
    [],
  );
  assert.deepEqual(filterLeakedRepos({ owner: OWNER, now: NOW }), []);
});

test('filterLeakedRepos: skips a malformed entry (missing/invalid createdAt) rather than guessing', () => {
  const repos = [
    { name: 'bench-sbx-bad', owner: OWNER, createdAt: 'not-a-date' },
    { name: 'bench-sbx-missing', owner: OWNER },
  ];
  const candidates = filterLeakedRepos({ repos, owner: OWNER, now: NOW });
  assert.equal(candidates.length, 0);
});

test('filterLeakedRepos: requires a non-empty owner', () => {
  assert.throws(() => filterLeakedRepos({ repos: [] }), /non-empty owner/);
});

// ---------------------------------------------------------------------------
// sweepLeakedRepos
// ---------------------------------------------------------------------------

function listingGhFn(repos) {
  const calls = [];
  const ghFn = (args) => {
    calls.push(args);
    return JSON.stringify(repos);
  };
  return { ghFn, calls };
}

test('sweepLeakedRepos: deletes every candidate, leaves young/foreign/non-prefixed repos alone', () => {
  const repos = [
    { name: 'bench-sbx-old', owner: OWNER, createdAt: hoursAgo(48) }, // delete
    { name: 'bench-sbx-young', owner: OWNER, createdAt: hoursAgo(1) }, // too young
    { name: 'bench-sbx-foreign', owner: 'other', createdAt: hoursAgo(999) }, // foreign owner
    { name: 'unrelated-repo', owner: OWNER, createdAt: hoursAgo(999) }, // non-prefixed
  ];
  const { ghFn } = listingGhFn(repos);
  const destroyCalls = [];
  const destroyFn = ({ repoFullName }) => {
    destroyCalls.push(repoFullName);
    return { deleted: true, repoFullName };
  };
  const { logger } = makeLogger();

  const result = sweepLeakedRepos(
    { owner: OWNER, now: NOW },
    { ghFn, destroyFn, logger },
  );

  assert.deepEqual(destroyCalls, [`${OWNER}/bench-sbx-old`]);
  assert.deepEqual(result.deleted, [`${OWNER}/bench-sbx-old`]);
  assert.equal(result.failed.length, 0);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.dryRun, false);
});

test('sweepLeakedRepos: an empty listing is a no-op', () => {
  const { ghFn } = listingGhFn([]);
  let destroyCalled = false;
  const destroyFn = () => {
    destroyCalled = true;
    return { deleted: true };
  };
  const result = sweepLeakedRepos(
    { owner: OWNER, now: NOW },
    { ghFn, destroyFn },
  );
  assert.equal(destroyCalled, false);
  assert.deepEqual(result, {
    candidates: [],
    deleted: [],
    failed: [],
    dryRun: false,
  });
});

test('sweepLeakedRepos: a delete failure for one repo is logged and does not abort the sweep', () => {
  const repos = [
    { name: 'bench-sbx-a', owner: OWNER, createdAt: hoursAgo(48) },
    { name: 'bench-sbx-b', owner: OWNER, createdAt: hoursAgo(48) },
    { name: 'bench-sbx-c', owner: OWNER, createdAt: hoursAgo(48) },
  ];
  const { ghFn } = listingGhFn(repos);
  const destroyCalls = [];
  const destroyFn = ({ repoFullName }) => {
    destroyCalls.push(repoFullName);
    if (repoFullName.endsWith('bench-sbx-b')) {
      throw new Error('gh: repo delete failed (rate limited)');
    }
    return { deleted: true, repoFullName };
  };
  const { logger, messages } = makeLogger();

  const result = sweepLeakedRepos(
    { owner: OWNER, now: NOW },
    { ghFn, destroyFn, logger },
  );

  // All three were attempted — the middle failure did not short-circuit.
  assert.deepEqual(destroyCalls, [
    `${OWNER}/bench-sbx-a`,
    `${OWNER}/bench-sbx-b`,
    `${OWNER}/bench-sbx-c`,
  ]);
  assert.deepEqual(result.deleted, [
    `${OWNER}/bench-sbx-a`,
    `${OWNER}/bench-sbx-c`,
  ]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].repoFullName, `${OWNER}/bench-sbx-b`);
  assert.match(result.failed[0].error, /rate limited/);
  assert.ok(messages.warn.some((w) => w.includes('bench-sbx-b')));
});

test('sweepLeakedRepos: also treats a non-throwing { deleted: false } result as a failure, without aborting', () => {
  const repos = [
    { name: 'bench-sbx-a', owner: OWNER, createdAt: hoursAgo(48) },
    { name: 'bench-sbx-b', owner: OWNER, createdAt: hoursAgo(48) },
  ];
  const { ghFn } = listingGhFn(repos);
  const destroyFn = ({ repoFullName }) => {
    if (repoFullName.endsWith('bench-sbx-a')) {
      return { deleted: false, repoFullName, error: 'permission denied' };
    }
    return { deleted: true, repoFullName };
  };
  const result = sweepLeakedRepos(
    { owner: OWNER, now: NOW },
    { ghFn, destroyFn },
  );
  assert.deepEqual(result.deleted, [`${OWNER}/bench-sbx-b`]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].error, 'permission denied');
});

test('sweepLeakedRepos: --dry-run mode lists candidates without deleting anything', () => {
  const repos = [
    { name: 'bench-sbx-old', owner: OWNER, createdAt: hoursAgo(48) },
  ];
  const { ghFn } = listingGhFn(repos);
  let destroyCalled = false;
  const destroyFn = () => {
    destroyCalled = true;
    return { deleted: true };
  };
  const { logger, messages } = makeLogger();

  const result = sweepLeakedRepos(
    { owner: OWNER, dryRun: true, now: NOW },
    { ghFn, destroyFn, logger },
  );

  assert.equal(destroyCalled, false);
  assert.deepEqual(result.deleted, []);
  assert.equal(result.dryRun, true);
  assert.equal(result.candidates.length, 1);
  assert.ok(
    messages.info.some(
      (m) => m.includes('dry-run') && m.includes('bench-sbx-old'),
    ),
  );
});

test('sweepLeakedRepos: ttlHours override widens/narrows the sweep window', () => {
  const repos = [
    { name: 'bench-sbx-mid', owner: OWNER, createdAt: hoursAgo(10) },
  ];
  const { ghFn } = listingGhFn(repos);
  const destroyFn = ({ repoFullName }) => ({ deleted: true, repoFullName });

  // Default 24h TTL: 10h old is not expired.
  const withDefault = sweepLeakedRepos(
    { owner: OWNER, now: NOW },
    { ghFn, destroyFn },
  );
  assert.equal(withDefault.candidates.length, 0);

  // 5h TTL override: 10h old IS expired.
  const withOverride = sweepLeakedRepos(
    { owner: OWNER, ttlHours: 5, now: NOW },
    { ghFn, destroyFn },
  );
  assert.equal(withOverride.candidates.length, 1);
});

test('sweepLeakedRepos: requires a non-empty owner', () => {
  assert.throws(() => sweepLeakedRepos({}), /non-empty owner/);
});

test('sweepLeakedRepos: surfaces a gh-list failure as a thrown, informative error', () => {
  const ghFn = () => {
    throw new Error('gh: not authenticated');
  };
  assert.throws(
    () => sweepLeakedRepos({ owner: OWNER }, { ghFn }),
    /failed to list repos.*not authenticated/,
  );
});

// ---------------------------------------------------------------------------
// CLI — parseJanitorCliArgs / main
// ---------------------------------------------------------------------------

test('parseJanitorCliArgs: parses --help, --dry-run, --owner, --ttl-hours', () => {
  assert.deepEqual(parseJanitorCliArgs(['--help']), {
    help: true,
    dryRun: false,
    owner: null,
    ttlHours: null,
  });
  assert.deepEqual(
    parseJanitorCliArgs(['--owner', 'acme', '--ttl-hours', '48', '--dry-run']),
    { help: false, dryRun: true, owner: 'acme', ttlHours: 48 },
  );
});

test('main(): --help prints usage and exits 0 without requiring any env var', async () => {
  const { logger } = makeLogger();
  const originalWrite = process.stdout.write;
  let printed = '';
  process.stdout.write = (chunk) => {
    printed += chunk;
    return true;
  };
  let code;
  try {
    code = await main(['--help'], {}, { logger });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(code, 0);
  assert.match(printed, /Usage: node bench\/driver\/janitor\.js/);
});

test('main(): missing owner (no --owner, no BENCH_SANDBOX_OWNER) exits non-zero with a clear message', async () => {
  const { logger, messages } = makeLogger();
  const code = await main([], {}, { logger });
  assert.equal(code, 1);
  assert.match(messages.error[0], /owner/);
});

test('main(): sweeps using BENCH_SANDBOX_OWNER and the default TTL when no flags are given', async () => {
  const repos = [
    { name: 'bench-sbx-old', owner: OWNER, createdAt: hoursAgo(48) },
  ];
  const { ghFn } = listingGhFn(repos);
  const destroyCalls = [];
  const destroyFn = ({ repoFullName }) => {
    destroyCalls.push(repoFullName);
    return { deleted: true, repoFullName };
  };
  const { logger } = makeLogger();

  const code = await main(
    [],
    { BENCH_SANDBOX_OWNER: OWNER },
    { logger, ghFn, destroyFn },
  );
  assert.equal(code, 0);
  assert.deepEqual(destroyCalls, [`${OWNER}/bench-sbx-old`]);
});

test('main(): the env-var TTL override is honored when no --ttl-hours flag is given', async () => {
  const repos = [
    { name: 'bench-sbx-mid', owner: OWNER, createdAt: hoursAgo(10) },
  ];
  const { ghFn } = listingGhFn(repos);
  const destroyCalls = [];
  const destroyFn = ({ repoFullName }) => {
    destroyCalls.push(repoFullName);
    return { deleted: true, repoFullName };
  };
  const { logger } = makeLogger();

  const code = await main(
    [],
    { BENCH_SANDBOX_OWNER: OWNER, [TTL_HOURS_ENV_VAR]: '5' },
    { logger, ghFn, destroyFn },
  );
  assert.equal(code, 0);
  assert.deepEqual(destroyCalls, [`${OWNER}/bench-sbx-mid`]);
});

test('main(): --ttl-hours flag takes precedence over the env var', async () => {
  const repos = [
    { name: 'bench-sbx-mid', owner: OWNER, createdAt: hoursAgo(10) },
  ];
  const { ghFn } = listingGhFn(repos);
  let destroyCalled = false;
  const destroyFn = () => {
    destroyCalled = true;
    return { deleted: true };
  };
  const { logger } = makeLogger();

  const code = await main(
    ['--ttl-hours', '24'],
    { BENCH_SANDBOX_OWNER: OWNER, [TTL_HOURS_ENV_VAR]: '5' },
    { logger, ghFn, destroyFn },
  );
  assert.equal(code, 0);
  assert.equal(destroyCalled, false); // 10h old, 24h flag TTL wins over 5h env var — not expired.
});

test('main(): --dry-run deletes nothing and exits 0', async () => {
  const repos = [
    { name: 'bench-sbx-old', owner: OWNER, createdAt: hoursAgo(48) },
  ];
  const { ghFn } = listingGhFn(repos);
  let destroyCalled = false;
  const destroyFn = () => {
    destroyCalled = true;
    return { deleted: true };
  };
  const { logger } = makeLogger();

  const code = await main(
    ['--dry-run'],
    { BENCH_SANDBOX_OWNER: OWNER },
    { logger, ghFn, destroyFn },
  );
  assert.equal(code, 0);
  assert.equal(destroyCalled, false);
});

test('main(): a gh-list failure exits non-zero with a FATAL message', async () => {
  const ghFn = () => {
    throw new Error('gh: rate limited');
  };
  const { logger, messages } = makeLogger();
  const code = await main([], { BENCH_SANDBOX_OWNER: OWNER }, { logger, ghFn });
  assert.equal(code, 1);
  assert.match(messages.error[0], /FATAL/);
});
