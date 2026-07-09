// tests/bench/feedback/fingerprint.test.js
//
// Unit tier (pure logic, no I/O) for the finding fingerprint
// (Epic #85, Story #91). Exercises bench/feedback/fingerprint.js against the
// Story's binding acceptance items:
//   - a stable fingerprint per finding (deriving twice yields identical),
//   - the fingerprint EXCLUDES the cohort triple so recurring findings collide
//     across cohorts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeFingerprint,
  fingerprintKey,
} from '../../../bench/feedback/fingerprint.js';

describe('fingerprintKey', () => {
  it('joins class, scenario and subject into a canonical key', () => {
    const key = fingerprintKey({
      findingClass: 'regression',
      scenario: 'story-scope',
      subject: 'quality',
    });
    assert.equal(key, 'regressionstory-scopequality');
  });

  it('collapses a null scenario to an empty positional field', () => {
    const key = fingerprintKey({
      findingClass: 'standing-cost',
      scenario: null,
      subject: 'monotonicity:a->b',
    });
    assert.equal(key, 'standing-costmonotonicity:a->b');
  });
});

describe('computeFingerprint', () => {
  it('is a stable 16-hex-char digest for the same identity fields', () => {
    const a = computeFingerprint({
      findingClass: 'trap-differential',
      scenario: 'epic-scope',
      subject: 'idor',
    });
    const b = computeFingerprint({
      findingClass: 'trap-differential',
      scenario: 'epic-scope',
      subject: 'idor',
    });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  it('differs when any identity field differs', () => {
    const base = {
      findingClass: 'regression',
      scenario: 'story-scope',
      subject: 'quality',
    };
    const byClass = computeFingerprint({
      ...base,
      findingClass: 'standing-cost',
    });
    const byScenario = computeFingerprint({ ...base, scenario: 'epic-scope' });
    const bySubject = computeFingerprint({ ...base, subject: 'security' });
    const original = computeFingerprint(base);
    assert.notEqual(original, byClass);
    assert.notEqual(original, byScenario);
    assert.notEqual(original, bySubject);
  });

  it('excludes the cohort triple — same finding in two cohorts collides', () => {
    // The fingerprint API takes ONLY the three identity fields; a caller in a
    // different cohort passes the identical identity, so the two observations
    // must share one fingerprint (a recurring-finding time-series).
    const cohortA = computeFingerprint({
      findingClass: 'pipeline-calibration',
      scenario: 'epic-scope',
      subject: 'routing-mismatch',
    });
    const cohortB = computeFingerprint({
      findingClass: 'pipeline-calibration',
      scenario: 'epic-scope',
      subject: 'routing-mismatch',
    });
    assert.equal(cohortA, cohortB);
  });
});
