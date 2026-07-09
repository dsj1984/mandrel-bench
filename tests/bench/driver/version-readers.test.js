// tests/bench/driver/version-readers.test.js
//
// Direct unit coverage for the shared cohort-stamp version readers extracted to
// bench/driver/version-readers.js (Epic #84 audit remediation — M1 + H4). These
// readers stamp the D-014 cohort triple's version fields and, before the
// extraction, were duplicated byte-for-byte in run.js and topup-planner.js with
// zero direct coverage in the CI plan job's default (uninjected) path. Every
// effect is behind an injected FS shim, so these tests touch no real disk.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  readBenchmarkVersion,
  readFrameworkVersion,
} from '../../../bench/driver/version-readers.js';

const MANDREL_PKG = path.join('node_modules', 'mandrel', 'package.json');

test('readFrameworkVersion: reads the pinned node_modules/mandrel/package.json version', () => {
  const v = readFrameworkVersion('/src', {
    existsImpl: (p) => p.endsWith(MANDREL_PKG),
    readFileImpl: (p) => {
      if (p.endsWith(MANDREL_PKG)) return JSON.stringify({ version: '1.90.0' });
      throw new Error(`unexpected read: ${p}`);
    },
  });
  assert.equal(v, '1.90.0');
});

test('readFrameworkVersion: falls back to the consumer dependency spec, stripped of the range operator', () => {
  const v = readFrameworkVersion('/src', {
    existsImpl: () => false,
    readFileImpl: (p) =>
      p.endsWith('package.json')
        ? JSON.stringify({ dependencies: { mandrel: '^1.91.0' } })
        : '{}',
  });
  assert.equal(v, '1.91.0');
});

test('readFrameworkVersion: falls back to "unknown" when neither the dependency nor the spec is readable', () => {
  const v = readFrameworkVersion('/src', {
    existsImpl: () => false,
    readFileImpl: () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(v, 'unknown');
});

test("readBenchmarkVersion: reads THIS repo's own package.json version, NOT the pinned mandrel dependency", () => {
  const v = readBenchmarkVersion('/src', {
    readFileImpl: (p) => {
      if (p.endsWith(MANDREL_PKG)) {
        // The framework-under-test dependency version — must NOT be returned.
        return JSON.stringify({ version: '1.90.0' });
      }
      if (p.endsWith('package.json')) {
        return JSON.stringify({ name: 'mandrel-bench', version: '0.6.0' });
      }
      throw new Error(`unexpected read: ${p}`);
    },
  });
  assert.equal(v, '0.6.0');
});

test('readBenchmarkVersion: falls back to "unknown" when the package.json is unreadable', () => {
  const v = readBenchmarkVersion('/src', {
    readFileImpl: () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(v, 'unknown');
});

test('the two readers source distinct versions from distinct files', () => {
  // The pinned mandrel dep (framework under test) vs THIS repo's own version
  // (the benchmark doing the testing) must never collapse to one value.
  const deps = {
    existsImpl: (p) => p.endsWith(MANDREL_PKG),
    readFileImpl: (p) =>
      p.endsWith(MANDREL_PKG)
        ? JSON.stringify({ version: '1.90.0' })
        : JSON.stringify({ version: '0.6.0' }),
  };
  const framework = readFrameworkVersion('/src', deps);
  const benchmark = readBenchmarkVersion('/src', deps);
  assert.equal(framework, '1.90.0');
  assert.equal(benchmark, '0.6.0');
  assert.notEqual(framework, benchmark);
});
