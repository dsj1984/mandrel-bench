// bench/feedback/markdown.js
//
// Tiny pure formatting leaf for the feedback slice. Internal tooling only —
// never shipped in the distributed `.agents/` bundle.
//
// `joinMarkdownBlocks` is the single home for the block-normalization idiom the
// feedback renderers share (M2): join a list of lines, collapse any run of 3+
// newlines to a blank-line separator, trim trailing whitespace, and end in
// exactly one newline. Pure.

/**
 * Join Markdown lines into one block-normalized document: collapse any run of
 * 3+ newlines to a single blank-line separator, trim the trailing whitespace,
 * and terminate in exactly one newline. Deterministic in its input, so
 * re-rendering the same lines is byte-identical. Pure.
 *
 * @param {string[]} lines
 * @returns {string}
 */
export function joinMarkdownBlocks(lines) {
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
