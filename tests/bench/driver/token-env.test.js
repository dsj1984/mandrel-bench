// tests/bench/driver/token-env.test.js
//
// Unit tier (pure, no child process, no network) for the neutral GitHub-token
// env leaf (bench/driver/token-env.js). Pins the DELIBERATELY DIFFERENT
// credential preferences of the two bindings (audit M8/M10):
//   - sanitizeGitHubTokenEnv  — the SANDBOX binding: BENCH_GITHUB_TOKEN wins.
//   - sanitizeFeedbackTokenEnv — the FILER binding: FEEDBACK_GITHUB_TOKEN →
//     GH_TOKEN, NEVER BENCH_GITHUB_TOKEN — so the cross-repo filer can never
//     silently authenticate with the destructive sandbox PAT.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  sanitizeFeedbackTokenEnv,
  sanitizeGitHubTokenEnv,
} from '../../../bench/driver/token-env.js';

describe('sanitizeGitHubTokenEnv — sandbox binding (BENCH wins)', () => {
  it('BENCH_GITHUB_TOKEN overrides an ambient GH_TOKEN', () => {
    const out = sanitizeGitHubTokenEnv({
      GH_TOKEN: 'gho_ambient',
      BENCH_GITHUB_TOKEN: 'ghp_bench',
    });
    assert.equal(out.GH_TOKEN, 'ghp_bench');
  });

  it('strips whitespace from the token keys', () => {
    const out = sanitizeGitHubTokenEnv({
      GH_TOKEN: 'gho_x\n',
      GITHUB_TOKEN: 'ghp_y \t',
    });
    assert.equal(out.GH_TOKEN, 'gho_x');
    assert.equal(out.GITHUB_TOKEN, 'ghp_y');
  });

  it('leaves an unset / empty token untouched (keyring auth)', () => {
    const out = sanitizeGitHubTokenEnv({ PATH: '/bin', GITHUB_TOKEN: '' });
    assert.equal(out.GITHUB_TOKEN, '');
    assert.equal('GH_TOKEN' in out, false);
  });
});

describe('sanitizeFeedbackTokenEnv — filer binding (FEEDBACK, never BENCH)', () => {
  it('binds FEEDBACK_GITHUB_TOKEN into GH_TOKEN', () => {
    const out = sanitizeFeedbackTokenEnv({
      FEEDBACK_GITHUB_TOKEN: 'ghp_feedback\r',
    });
    assert.equal(out.GH_TOKEN, 'ghp_feedback');
  });

  it('NEVER inherits BENCH_GITHUB_TOKEN (the destructive sandbox PAT)', () => {
    // Both the destructive sandbox PAT and the feedback token are exported: the
    // filer must authenticate with the FEEDBACK token, never the BENCH one.
    const out = sanitizeFeedbackTokenEnv({
      BENCH_GITHUB_TOKEN: 'ghp_destructive',
      FEEDBACK_GITHUB_TOKEN: 'ghp_feedback',
    });
    assert.equal(out.GH_TOKEN, 'ghp_feedback');
    assert.notEqual(out.GH_TOKEN, 'ghp_destructive');
  });

  it('falls back to an already-set GH_TOKEN when no feedback token is set', () => {
    const out = sanitizeFeedbackTokenEnv({
      GH_TOKEN: 'gho_prebound\n',
      BENCH_GITHUB_TOKEN: 'ghp_destructive',
    });
    // GH_TOKEN kept (whitespace-stripped); BENCH_GITHUB_TOKEN ignored.
    assert.equal(out.GH_TOKEN, 'gho_prebound');
  });

  it('leaves GH_TOKEN unset when neither a feedback nor an ambient token exists', () => {
    const out = sanitizeFeedbackTokenEnv({ PATH: '/bin' });
    assert.equal('GH_TOKEN' in out, false);
  });
});
