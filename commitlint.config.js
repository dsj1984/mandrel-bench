// Conventional Commits enforcement. Run via the `commit-msg` Husky hook
// (see `.husky/commit-msg`). The `type-enum` mirrors the `changelog-sections`
// in `release-please-config.json` so commitlint and the release tooling agree
// on what counts as a valid type.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'docs',
        'style',
        'chore',
        'test',
        'build',
        'ci',
      ],
    ],
  },
};
