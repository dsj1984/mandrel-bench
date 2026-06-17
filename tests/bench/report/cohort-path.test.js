// tests/bench/report/cohort-path.test.js
//
// Unit tier (pure logic, no I/O) for the cohort-directory derivation helper
// (Epic #2, Story #17). Exercises bench/report/cohort-path.js against the
// Story's binding acceptance item:
//   "A cohort path helper derives the per-cohort directory
//    (<model-slug>/<frameworkVersion>/) from a scorecard's stamp, slugifying
//    model.id into a filesystem-safe segment; pure and unit-tested, including a
//    model id containing [1m]-style characters."

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  cohortDir,
  cohortSegments,
  sanitizeFrameworkVersion,
  slugifyModelId,
} from '../../../bench/report/cohort-path.js';

describe('slugifyModelId', () => {
  it('lowercases and hyphenates a plain model id', () => {
    assert.equal(slugifyModelId('claude-opus-4-8'), 'claude-opus-4-8');
  });

  it('folds a [1m]-style bracketed suffix into a safe segment', () => {
    // The binding acceptance example.
    assert.equal(slugifyModelId('claude-opus-4-8[1m]'), 'claude-opus-4-8-1m');
  });

  it('collapses any run of hostile characters to a single hyphen', () => {
    assert.equal(slugifyModelId('Model / Name [v2!!]'), 'model-name-v2');
  });

  it('never produces an empty / dot segment', () => {
    assert.equal(slugifyModelId(''), 'unknown-model');
    assert.equal(slugifyModelId(undefined), 'unknown-model');
    assert.equal(slugifyModelId('[]'), 'unknown-model');
    assert.equal(slugifyModelId(42), 'unknown-model');
  });

  it('result is always a filesystem-safe single segment', () => {
    const slug = slugifyModelId('a/b\\c:d[1m]');
    assert.ok(!slug.includes('/'));
    assert.ok(!slug.includes('\\'));
    assert.ok(!slug.includes(':'));
    assert.match(slug, /^[a-z0-9-]+$/);
  });
});

describe('sanitizeFrameworkVersion', () => {
  it('passes a SemVer through unchanged', () => {
    assert.equal(sanitizeFrameworkVersion('1.70.0'), '1.70.0');
  });

  it('strips path separators (no slash survives → safe single segment)', () => {
    const safe = sanitizeFrameworkVersion('1.70.0/x');
    assert.equal(safe, '1.70.0-x');
    assert.ok(!safe.includes('/'));
  });

  it('falls back to unknown-version on empty / non-string', () => {
    assert.equal(sanitizeFrameworkVersion(''), 'unknown-version');
    assert.equal(sanitizeFrameworkVersion(null), 'unknown-version');
  });
});

describe('cohortSegments / cohortDir', () => {
  const sc = {
    model: { id: 'claude-opus-4-8[1m]' },
    frameworkVersion: '1.70.0',
  };

  it('derives both segments from a scorecard stamp', () => {
    assert.deepEqual(cohortSegments(sc), {
      modelSlug: 'claude-opus-4-8-1m',
      frameworkVersion: '1.70.0',
    });
  });

  it('joins the cohort dir under the results root', () => {
    assert.equal(
      cohortDir({ resultsDir: '/results', scorecard: sc }),
      path.join('/results', 'claude-opus-4-8-1m', '1.70.0'),
    );
  });

  it('handles a missing stamp without throwing', () => {
    assert.equal(
      cohortDir({ resultsDir: '/r', scorecard: {} }),
      path.join('/r', 'unknown-model', 'unknown-version'),
    );
  });

  it('requires a resultsDir', () => {
    assert.throws(() => cohortDir({ scorecard: sc }), /resultsDir is required/);
  });
});
