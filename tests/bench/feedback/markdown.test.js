// tests/bench/feedback/markdown.test.js
//
// Unit tier (pure) for the shared Markdown block-normalization helper
// (bench/feedback/markdown.js) extracted from the triplicated join/collapse/
// trim idiom (audit M2).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { joinMarkdownBlocks } from '../../../bench/feedback/markdown.js';

describe('joinMarkdownBlocks', () => {
  it('collapses runs of 3+ newlines to a single blank-line separator', () => {
    const out = joinMarkdownBlocks(['a', '', '', '', 'b']);
    assert.equal(out, 'a\n\nb\n');
  });

  it('trims trailing whitespace and ends in exactly one newline', () => {
    const out = joinMarkdownBlocks(['heading', '', '']);
    assert.equal(out, 'heading\n');
  });

  it('is idempotent when re-normalizing its own output lines', () => {
    const once = joinMarkdownBlocks(['x', '', '', 'y', '']);
    const twice = joinMarkdownBlocks(once.split('\n'));
    assert.equal(once, twice);
  });
});
