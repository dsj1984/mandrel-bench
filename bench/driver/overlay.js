// bench/driver/overlay.js
/**
 * Framework-under-test overlay for the Mandrel self-benchmark harness
 * (Epic #2, Story #3). Internal tooling only — never shipped in the
 * distributed `.agents/` bundle, never run against the live repo.
 *
 * The mandrel arm must drive Mandrel's `/plan`→`/deliver` pipeline using the
 * EXACT version under test — this repo's pinned `mandrel` dependency,
 * materialized into `.agents/` here — NOT a clone of the framework source repo
 * (docs/mandrel-self-benchmark.md "What is NOT done" #2). The sandbox repo
 * (`bench/driver/sandbox.js`) provides only the git/GitHub substrate (an issue
 * tracker + a branch/PR surface + an empty working tree); this module turns a
 * freshly-provisioned mandrel-arm clone into a working mandrel *consumer* by
 * overlaying the framework tree onto it.
 *
 * What the overlay copies into the clone (the mandrel arm only):
 *   - `.agents/`        the materialized framework bundle (the version under test),
 *   - `.claude/`        the slash-command definitions + settings `claude -p` reads
 *                       (so `/plan` and `/deliver` exist in the headless session),
 *   - `CLAUDE.md`       the project instruction shim that @-includes .agents,
 *   - `node_modules/`   so the framework scripts' runtime deps (ajv, js-yaml,
 *                       minimatch, … — see `.agents/runtime-deps.json`, which the
 *                       scripts "free-ride" on the consumer's install for) resolve
 *                       inside the clone.
 * It then writes:
 *   - a CLEAN minimal `package.json` so the agent builds the scenario app into an
 *     uncluttered consumer (the copied `node_modules` still resolves the framework
 *     runtime deps by directory presence — node resolution is by on-disk package,
 *     not by what `package.json` declares). Since Story #153 the sandbox baseline
 *     seed already ships this exact file as TRACKED content, so this write is a
 *     byte-identical seed-wins merge rather than a rewrite, and
 *   - a rewritten `.agentrc.json` whose `github.owner/repo` point at the sandbox
 *     repo (so `/deliver` opens issues/branches/PR there, never against this repo).
 * Finally it installs a repo-local `post-checkout` hook so the Story worktrees
 * `/deliver` creates can see the (untracked) overlay — see
 * {@link installWorktreeOverlayHook}.
 *
 * The CONTROL arm is deliberately NOT overlaid — it is the bare-model baseline
 * and must carry no scaffolding (`provisionSandbox` already strips `.agents/`).
 *
 * Every filesystem effect is injectable so the unit tests exercise the full
 * overlay contract without copying 144 MB of `node_modules` or touching disk.
 */

import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { baseArm } from './arms.js';

/**
 * The relative paths copied from this repo (the version under test) into a
 * mandrel-arm clone. `node_modules` is included so the framework scripts'
 * runtime dependencies resolve inside the clone.
 */
export const DEFAULT_OVERLAY_PATHS = Object.freeze([
  '.agents',
  '.claude',
  'CLAUDE.md',
  'node_modules',
]);

/**
 * The real `typecheck` gate written into every scenario's sandbox, for both
 * arms (Epic #66, Story #74 — generalizes the former single-scenario special
 * case): a `node --check` parse sweep over every delivered `.js`/`.mjs`/`.cjs`
 * file. This repo is plain ESM JavaScript with no TypeScript, so a per-file
 * `node --check` IS the typecheck contract (the same rationale as the repo's
 * own root `typecheck` script). It walks `process.cwd()` and skips
 * `node_modules` and dot-dirs (the overlaid `.agents` / `.claude` framework
 * tree, mandrel arm only), so it parses the DELIVERED code only, never the
 * framework. Emitted as an inline `node -e` program because the overlay
 * copies only the framework tree into the consumer — there is no place to
 * ship an extra helper file, and the delivered tree must stay app-code-only.
 *
 * @type {string}
 */
const NODE_CHECK_SWEEP = [
  'node -e "',
  "const{readdirSync}=require('fs');",
  "const{join,extname}=require('path');",
  "const{execFileSync}=require('child_process');",
  "const SKIP=new Set(['node_modules','dist','build','coverage']);",
  "const EXT=new Set(['.js','.mjs','.cjs']);",
  'function walk(d){let out=[];for(const e of readdirSync(d,{withFileTypes:true})){',
  'if(e.isDirectory()){if(SKIP.has(e.name)||e.name.startsWith(\\".\\"))continue;out=out.concat(walk(join(d,e.name)));}',
  'else if(e.isFile()&&EXT.has(extname(e.name)))out.push(join(d,e.name));}return out;}',
  'const files=walk(process.cwd());',
  "for(const f of files){execFileSync(process.execPath,['--check',f],{stdio:'inherit'});}",
  "console.log('node --check passed for '+files.length+' file(s)');",
  '"',
].join('');

/**
 * The rewritten consumer artifacts the overlay clobbers in place (in addition
 * to copying {@link DEFAULT_OVERLAY_PATHS}): the sandbox-repointed
 * `.agentrc.json`. These are framework-overlay artifacts, not deliverable app
 * code, so they are git-excluded alongside the copied paths — otherwise the
 * headless agent would stage them and they would contaminate the deliverable
 * diff exactly like `.agents/**` does.
 *
 * `package.json` used to live here (Story #153 removed it). It is no longer an
 * overlay-only artifact: the sandbox baseline seed now ships a tracked
 * `package.json` carrying the gate scripts
 * (`materializeSandboxTemplate` → {@link buildTargetPackageJson}), so the
 * overlay's write is a seed-wins no-op merge rather than a rewrite. Excluding
 * it collided with every scenario whose contract claims `package.json` as a
 * deliverable — see {@link DELIVERABLE_CLAIMABLE_ARTIFACTS}.
 */
export const REWRITTEN_OVERLAY_ARTIFACTS = Object.freeze(['.agentrc.json']);

/**
 * Overlay-touched artifacts a scenario's own contract may legitimately claim
 * as **deliverables**. Excluding one of these from git is only correct when
 * the scenario does NOT claim it: hello-world's contract requires a
 * `package.json` (its `npm start` app contract and its single-source-file +
 * `package.json` seed prompt), so git-excluding it forced the headless agent
 * into a `git add --force` dance and burned turns that were then charged to
 * the mandrel arm's measured overhead (Story #153).
 */
export const DELIVERABLE_CLAIMABLE_ARTIFACTS = Object.freeze(['package.json']);

/**
 * Whether a scenario's contract claims `package.json` as a deliverable.
 *
 * Two crisp signals, in precedence order:
 *   1. an explicit `deliverables` array on the scenario naming it, and
 *   2. an `app.startCommand` that invokes a package-manager script
 *      (`npm start`, `pnpm run start`, `yarn start`, …) — which is only
 *      satisfiable by a delivered `package.json`.
 *
 * A `null`/absent scenario means "no contract to consult": the baseline seed
 * ships a tracked `package.json` for every scenario, so the safe default is to
 * treat it as claimed and leave it visible to git.
 *
 * @param {object|null} [scenario]  Parsed `scenario.json`.
 * @returns {boolean}
 */
export function scenarioClaimsPackageJson(scenario = null) {
  if (scenario == null) return true;
  if (typeof scenario !== 'object' || Array.isArray(scenario)) return true;

  if (Array.isArray(scenario.deliverables)) {
    if (
      scenario.deliverables.some((d) => String(d).trim() === 'package.json')
    ) {
      return true;
    }
  }

  const startCommand = scenario.app?.startCommand;
  if (typeof startCommand === 'string') {
    if (/^\s*(npm|pnpm|yarn|bun)\b/.test(startCommand)) return true;
  }

  return false;
}

/**
 * Every overlaid path the deliverable diff must never contain: the copied
 * framework tree plus the rewritten consumer artifacts. This is the exact set
 * written to the sandbox clone's `.git/info/exclude` at overlay time so the
 * pipeline can run with the overlay present while the headless agent's
 * `git add` / commit never picks any of it up.
 *
 * A {@link DELIVERABLE_CLAIMABLE_ARTIFACTS} entry is excluded only when the
 * scenario's contract does NOT claim it (Story #153).
 *
 * @param {readonly string[]} [overlayPaths=DEFAULT_OVERLAY_PATHS]
 * @param {{ scenario?: object|null }} [opts]
 * @returns {string[]} De-duplicated, stable-ordered relative paths.
 */
export function overlayExcludePaths(
  overlayPaths = DEFAULT_OVERLAY_PATHS,
  { scenario = null } = {},
) {
  const contractArtifacts = scenarioClaimsPackageJson(scenario)
    ? []
    : DELIVERABLE_CLAIMABLE_ARTIFACTS;
  return [
    ...new Set([
      ...overlayPaths,
      ...REWRITTEN_OVERLAY_ARTIFACTS,
      ...contractArtifacts,
    ]),
  ];
}

/**
 * Append the overlaid paths to a sandbox clone's `.git/info/exclude` so git
 * never stages them. `.git/info/exclude` is the repo-local, uncommitted
 * sibling of `.gitignore` — using it (rather than writing a tracked
 * `.gitignore`) keeps the exclusion invisible to the deliverable diff itself.
 *
 * Idempotent: a sentinel header guards the block, and existing patterns are
 * not duplicated on a re-run. The exclude file (and its parent `.git/info`
 * directory) is created when absent.
 *
 * @param {object} opts
 * @param {string} opts.workspacePath  Absolute path of the provisioned clone.
 * @param {readonly string[]} [opts.overlayPaths=DEFAULT_OVERLAY_PATHS]
 * @param {object|null} [opts.scenario]  Parsed `scenario.json`, consulted for
 *   the deliverable-contract carve-out (see {@link overlayExcludePaths}).
 * @param {object} [deps]
 * @param {(p: string, enc: string) => string} [deps.readFileFn]
 * @param {(p: string, data: string) => void} [deps.appendFileFn]
 * @param {(p: string, opts: object) => void} [deps.mkdirFn]
 * @param {(p: string) => boolean} [deps.existsFn]
 * @param {{ info?: Function, warn?: Function }} [deps.logger]
 * @returns {{ excludeFile: string, added: string[], patterns: string[] }}
 */
export function excludeOverlayFromGit(opts = {}, deps = {}) {
  const {
    workspacePath,
    overlayPaths = DEFAULT_OVERLAY_PATHS,
    scenario = null,
  } = opts;

  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    throw new TypeError(
      'excludeOverlayFromGit requires a non-empty workspacePath',
    );
  }

  const readFile = deps.readFileFn ?? readFileSync;
  const append = deps.appendFileFn ?? appendFileSync;
  const mkdir = deps.mkdirFn ?? mkdirSync;
  const exists = deps.existsFn ?? existsSync;
  const logger = deps.logger;

  const SENTINEL = '# mandrel-bench: framework overlay (never commit)';
  const infoDir = path.join(workspacePath, '.git', 'info');
  const excludeFile = path.join(infoDir, 'exclude');
  // Anchor each pattern to the repo root so `.claude` excludes the directory
  // without also masking an unrelated nested path, and so `CLAUDE.md` /
  // `package.json` only match the root artifact the overlay wrote.
  const patterns = overlayExcludePaths(overlayPaths, { scenario }).map(
    (rel) => `/${rel}`,
  );

  let current = '';
  if (exists(excludeFile)) {
    current = readFile(excludeFile, 'utf8');
  } else if (!exists(infoDir)) {
    mkdir(infoDir, { recursive: true });
  }

  const existingLines = new Set(current.split('\n').map((line) => line.trim()));
  const missing = patterns.filter((p) => !existingLines.has(p));

  if (missing.length === 0) {
    logger?.info?.(`[overlay] git-exclude already current: ${excludeFile}`);
    return { excludeFile, added: [], patterns };
  }

  const needsLeadingNewline = current.length > 0 && !current.endsWith('\n');
  const block = `${needsLeadingNewline ? '\n' : ''}${
    existingLines.has(SENTINEL) ? '' : `${SENTINEL}\n`
  }${missing.join('\n')}\n`;

  append(excludeFile, block);
  logger?.info?.(
    `[overlay] git-excluded ${missing.length} overlay path(s) → ${excludeFile}`,
  );

  return { excludeFile, added: missing, patterns };
}

/**
 * Render the repo-local `post-checkout` hook body that links the clone-root
 * overlay into every newly-created linked worktree.
 *
 * Pure (path list in → shell text out) so the exact script is unit-assertable
 * without touching disk.
 *
 * @param {readonly string[]} linkPaths  Relative overlay paths to link.
 * @returns {string} POSIX `sh` script text.
 */
export function buildWorktreeOverlayHook(linkPaths) {
  const offending = linkPaths.find((rel) => /['\n]/.test(rel));
  if (offending !== undefined) {
    throw new TypeError(
      `buildWorktreeOverlayHook cannot shell-quote overlay path: ${offending}`,
    );
  }
  const words = linkPaths.map((rel) => `'${rel}'`).join(' ');
  return [
    '#!/bin/sh',
    '# mandrel-bench: framework-overlay visibility in linked worktrees (Story #153).',
    '# `git worktree add` materializes a fresh tree that cannot see the clone',
    "# root's UNTRACKED overlay (.agents/, .claude/, node_modules, .agentrc.json),",
    "# so the framework's own gate scripts ('node .agents/scripts/...') are",
    '# unresolvable from inside a Story worktree and agents invent symlink',
    '# workarounds. Link the overlay in once, at checkout time.',
    '#',
    '# Never fails a checkout: every path exits 0.',
    'set -u',
    '',
    'common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0',
    '[ -n "$common_dir" ] || exit 0',
    'clone_root=$(CDPATH= cd -- "$common_dir/.." 2>/dev/null && pwd -P) || exit 0',
    'here=$(pwd -P) || exit 0',
    '',
    '# The main worktree already holds the overlay itself — nothing to link.',
    'if [ "$here" = "$clone_root" ]; then exit 0; fi',
    '',
    `for rel in ${words}; do`,
    '  [ -e "$here/$rel" ] && continue',
    '  [ -e "$clone_root/$rel" ] || continue',
    '  ln -s "$clone_root/$rel" "$here/$rel" 2>/dev/null || true',
    'done',
    '',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * Install the repo-local `post-checkout` hook into a provisioned sandbox clone
 * so `git worktree add` (which Mandrel's `/deliver` runs per Story) yields a
 * worktree that can actually see the framework overlay.
 *
 * Without it the Story worktree is a checkout of TRACKED content only: the
 * overlay lives at the clone root as untracked files, `.agents/scripts/*` does
 * not resolve from inside the worktree, and the `check-baselines` gate fails
 * on an unresolvable script — a bench artifact that burned turns on every
 * mandrel-arm run (Story #153).
 *
 * The linked names are exactly the {@link overlayExcludePaths} set, so the
 * clone's existing `.git/info/exclude` (shared with every linked worktree via
 * the common git dir) already covers them — no new exclusion surface.
 *
 * Idempotent: the hook file is rewritten in place on a re-run.
 *
 * @param {object} opts
 * @param {string} opts.workspacePath  Absolute path of the provisioned clone.
 * @param {readonly string[]} [opts.overlayPaths=DEFAULT_OVERLAY_PATHS]
 * @param {object|null} [opts.scenario]
 * @param {object} [deps]
 * @param {(p: string, opts: object) => void} [deps.mkdirFn]
 * @param {(p: string, data: string) => void} [deps.writeFileFn]
 * @param {(p: string, mode: number) => void} [deps.chmodFn]
 * @param {{ info?: Function, warn?: Function }} [deps.logger]
 * @returns {{ hookPath: string, linkPaths: string[] }}
 */
export function installWorktreeOverlayHook(opts = {}, deps = {}) {
  const {
    workspacePath,
    overlayPaths = DEFAULT_OVERLAY_PATHS,
    scenario = null,
  } = opts;
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    throw new TypeError(
      'installWorktreeOverlayHook requires a non-empty workspacePath',
    );
  }

  const mkdir = deps.mkdirFn ?? mkdirSync;
  const writeFile = deps.writeFileFn ?? writeFileSync;
  const chmod = deps.chmodFn ?? chmodSync;
  const logger = deps.logger;

  const linkPaths = overlayExcludePaths(overlayPaths, { scenario });
  const hooksDir = path.join(workspacePath, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'post-checkout');

  mkdir(hooksDir, { recursive: true });
  writeFile(hookPath, buildWorktreeOverlayHook(linkPaths));
  // Best-effort: a hook that cannot be marked executable is inert (git skips
  // it) and the run degrades to the pre-Story-#153 behaviour — never a reason
  // to abort provisioning. Injected-fs tests write no real file at all.
  try {
    chmod(hookPath, 0o755);
  } catch (err) {
    logger?.warn?.(
      `[overlay] could not chmod +x ${hookPath}: ${err?.message ?? err}`,
    );
  }
  logger?.info?.(
    `[overlay] installed worktree post-checkout hook → ${hookPath}`,
  );

  return { hookPath, linkPaths };
}

/**
 * Absolute path of this repo's root (two levels up from `bench/driver/`).
 * Exported so the orchestrator and tests share one anchor.
 *
 * @returns {string}
 */
export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * The clean, minimal consumer `package.json` written into every scenario's
 * sandbox, for BOTH arms (Epic #66, Story #74). It declares no app deps so
 * the scenario app is built into an uncluttered tree; for the mandrel arm the
 * copied `node_modules` still resolves the framework runtime deps regardless
 * of what this file declares.
 *
 * ── Un-stubbed gates everywhere (generalizes the former single-scenario
 * special case — Story #57 scoped un-stubbing to one scenario; this Story
 * inverts that: `buildTargetPackageJson` is now arm- and scenario-agnostic) ──
 * Every scenario gets REAL gate scripts that exercise the delivered code on
 * disk, so a clean `/deliver` (mandrel arm) only auto-merges after lint /
 * test / typecheck genuinely pass — not after `node --version` exits 0 — and
 * the control arm's delivered tree is measured against the identical gate
 * contract for a fair comparison:
 *
 *   - `typecheck` → a `node --check` sweep over every delivered
 *     `.js`/`.mjs`/`.cjs` file: a real per-file parse gate. This repo is plain
 *     ESM JavaScript with no TypeScript, so `node --check` IS the typecheck
 *     contract (see the repo's own root `typecheck` script rationale).
 *   - `lint`      → the same `node --check` sweep when the delivery shipped no
 *     Biome config, else `biome ci .` — a real static gate either way.
 *   - `test`      → `node --test`: runs whatever tests the delivery authored.
 *     A delivery with no tests still exits 0 (node reports "no test files");
 *     a delivery WITH failing tests blocks the merge — the enforcement we want
 *     to fire.
 *
 * These gates measure the DELIVERED code only (the overlay git-excludes the
 * framework tree for the mandrel arm, so the sweep walking `process.cwd()`
 * never parses `.agents`/`.claude` — they are dot-dirs the sweep skips, and
 * `node_modules` is skipped explicitly). They do NOT score any planted trap —
 * defect classes are scored by the SEPARATE per-class trap-oracle runner
 * (`bench/scenarios/trap-runner.js`), not by these scripts.
 *
 * The gate scripts are emitted as inline `node -e` programs rather than a
 * committed helper file because the mandrel-arm overlay copies only the
 * framework tree (`DEFAULT_OVERLAY_PATHS`) into the consumer — there is no
 * place to ship an extra script, and the delivered tree must stay
 * app-code-only. The control arm never receives the framework tree at all, so
 * the same inline-program shape keeps both arms' `package.json` byte-identical.
 *
 * ── Seed reconciliation (issue #124, brownfield rungs) ── A scenario whose
 * `sandbox/` seed layer ships its OWN `package.json` (e.g. the
 * brownfield-longitudinal Ledgerline app, whose `test`/`start` scripts are
 * part of the frozen instrument) must not have those scripts clobbered by
 * the composed gates. Pass the seed's parsed `package.json` as `existingPkg`
 * and the merge is seed-wins at both levels: the seed's top-level fields
 * override the gate defaults, and within `scripts` every seed-declared
 * script wins while the gate scripts (`lint`/`typecheck`/`test`) fill only
 * the gaps. With no `existingPkg` (every seedless scenario) the output is
 * byte-identical to the historical gate `package.json`.
 *
 * @param {object|null} [existingPkg]  The seed layer's parsed `package.json`,
 *   when the provisioned workspace already carries one. Its fields and
 *   scripts take precedence over the composed gate defaults.
 * @returns {object}
 */
export function buildTargetPackageJson(existingPkg = null) {
  const gatePkg = {
    name: 'mandrel-bench-target',
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: {
      typecheck: NODE_CHECK_SWEEP,
      lint: `if [ -f biome.json ] || [ -f biome.jsonc ]; then npx --no-install biome ci .; else ${NODE_CHECK_SWEEP}; fi`,
      test: 'node --test',
    },
  };
  if (existingPkg == null) return gatePkg;
  if (typeof existingPkg !== 'object' || Array.isArray(existingPkg)) {
    throw new TypeError(
      'buildTargetPackageJson existingPkg must be a package.json object',
    );
  }
  return {
    ...gatePkg,
    ...existingPkg,
    scripts: {
      ...gatePkg.scripts,
      ...(existingPkg.scripts ?? {}),
    },
  };
}

/**
 * Write the gate `package.json` directly into a provisioned sandbox
 * workspace, WITHOUT the framework-tree overlay. This is the CONTROL arm's
 * counterpart to what {@link overlayFrameworkUnderTest} writes for the
 * mandrel arm (Epic #66, Story #74): control never runs Mandrel's pipeline —
 * there is no framework tree to copy and nothing to git-exclude (the control
 * arm's delivered tree is scored directly off disk; this harness never
 * commits on its behalf) — but it still needs the SAME real lint/typecheck/
 * test scripts as the mandrel arm so gate-based signals are measured
 * identically for both arms.
 *
 * When the provisioned workspace already carries a `package.json` — a
 * scenario whose `sandbox/` seed layer ships one (issue #124) — the write is
 * a seed-wins merge via {@link buildTargetPackageJson}: the seed's own
 * scripts (`test`, `start`, …) are preserved and the gate scripts fill only
 * the gaps. A workspace with no `package.json` gets the pure gate file,
 * exactly as before.
 *
 * @param {object} opts
 * @param {string} opts.workspacePath  Absolute path of the provisioned clone.
 * @param {object} [deps]
 * @param {(p: string, data: string) => void} [deps.writeFileFn]
 * @param {(p: string, enc: string) => string} [deps.readFileFn]
 * @param {(p: string) => boolean} [deps.existsFn]
 * @returns {{ workspacePath: string, pkg: object }}
 */
export function writeGatePackageJson(opts = {}, deps = {}) {
  const { workspacePath } = opts;
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    throw new TypeError(
      'writeGatePackageJson requires a non-empty workspacePath',
    );
  }
  const writeFile = deps.writeFileFn ?? writeFileSync;
  const readFile = deps.readFileFn ?? readFileSync;
  const exists = deps.existsFn ?? existsSync;
  const pkgPath = path.join(workspacePath, 'package.json');
  // Seed reconciliation (issue #124): a scenario seed layer's own
  // package.json wins over the composed gate scripts. A malformed seed
  // package.json throws loudly — that is a broken frozen instrument, never
  // something to silently clobber.
  const existingPkg = exists(pkgPath)
    ? JSON.parse(readFile(pkgPath, 'utf8'))
    : null;
  const pkg = buildTargetPackageJson(existingPkg);
  writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return { workspacePath, pkg };
}

/**
 * Absolute path of the SHARED static `CLAUDE.md` fixture the
 * `control-claudemd` arm (arm 3, Ticket #123) seeds into its workspace: a
 * ~2KB generic-engineering-conventions + security-hygiene instruction file
 * with NO scenario-specific answers and NO trap answers, reusable verbatim
 * across every scenario. `(arm3 − control)` isolates the value of ANY static
 * structure from the value of Mandrel's orchestration.
 */
export const STATIC_CLAUDEMD_FIXTURE_PATH = path.join(
  repoRoot(),
  'bench',
  'fixtures',
  'control-claudemd.md',
);

/**
 * Seed the static generic `CLAUDE.md` fixture into a provisioned
 * control-claudemd-arm workspace (arm 3, Ticket #123). Runs AFTER
 * `writeGatePackageJson` on the otherwise-identical control path: the ONLY
 * delta between arm 3 and the control arm is this one file. The fixture is
 * read from the shared path above (injectable for tests) and written verbatim
 * as `<workspace>/CLAUDE.md`.
 *
 * @param {object} opts
 * @param {string} opts.workspacePath  Absolute path of the provisioned clone.
 * @param {string} [opts.fixturePath]  Per-scenario fixture override (issue
 *   #124 review note 3): the caller resolves `scenario.controlClaudeMd` to an
 *   absolute path so arm 3's CLAUDE.md content is scenario-addressable. Wins
 *   over `deps.fixturePath`; absent, the shared generic default applies.
 * @param {object} [deps]
 * @param {(p: string, enc: string) => string} [deps.readFileFn]
 * @param {(p: string, data: string) => void} [deps.writeFileFn]
 * @param {string} [deps.fixturePath]  Override the fixture location (tests).
 * @returns {{ workspacePath: string, claudeMdPath: string, bytes: number }}
 */
export function seedStaticClaudeMd(opts = {}, deps = {}) {
  const { workspacePath } = opts;
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    throw new TypeError(
      'seedStaticClaudeMd requires a non-empty workspacePath',
    );
  }
  const readFile = deps.readFileFn ?? readFileSync;
  const writeFile = deps.writeFileFn ?? writeFileSync;
  const fixturePath =
    opts.fixturePath ?? deps.fixturePath ?? STATIC_CLAUDEMD_FIXTURE_PATH;
  const content = readFile(fixturePath, 'utf8');
  const claudeMdPath = path.join(workspacePath, 'CLAUDE.md');
  writeFile(claudeMdPath, content);
  return { workspacePath, claudeMdPath, bytes: Buffer.byteLength(content) };
}

/**
 * Rewrite a `.agentrc.json` so the pipeline targets the sandbox GitHub repo.
 * Pure: takes the source JSON text and returns the rewritten config object.
 *
 * - `github.owner` / `github.repo` are repointed at the sandbox repo.
 * - `github.projectNumber` is dropped (the sandbox has no project board; a
 *   stale number would make `/deliver`'s project-add step fail).
 * - Everything else (e.g. `delivery.ci.skipForStoryPushes`) is preserved.
 *
 * @param {string} agentrcText  Source `.agentrc.json` contents.
 * @param {{ owner: string, repo: string }} sandbox  Sandbox repo coordinates.
 * @returns {object} The rewritten config.
 */
export function rewriteAgentrc(agentrcText, sandbox) {
  if (typeof agentrcText !== 'string' || agentrcText.length === 0) {
    throw new TypeError('rewriteAgentrc requires non-empty agentrc text');
  }
  if (!sandbox?.owner || !sandbox?.repo) {
    throw new TypeError('rewriteAgentrc requires sandbox { owner, repo }');
  }
  const cfg = JSON.parse(agentrcText);
  const github = {
    ...(cfg.github ?? {}),
    owner: sandbox.owner,
    repo: sandbox.repo,
  };
  delete github.projectNumber;
  return { ...cfg, github };
}

/**
 * Overlay the framework-under-test onto a provisioned mandrel-arm clone.
 *
 * @param {object} opts
 * @param {string} opts.workspacePath  Absolute path of the provisioned clone.
 * @param {'mandrel'|'control'} opts.arm
 * @param {{ owner: string, repo: string }} opts.sandbox  Sandbox repo coordinates.
 * @param {string} [opts.sourceRoot]   Where to copy the framework tree from
 *   (defaults to this repo's root — the version under test).
 * @param {string[]} [opts.overlayPaths]  Relative paths to copy (default
 *   `DEFAULT_OVERLAY_PATHS`).
 * @param {object} [deps]
 * @param {(src: string, dest: string, opts: object) => void} [deps.cpFn]
 * @param {(p: string, data: string) => void} [deps.writeFileFn]
 * @param {(p: string, enc: string) => string} [deps.readFileFn]
 * @param {(p: string) => boolean} [deps.existsFn]
 * @param {(p: string, data: string) => void} [deps.appendFileFn]
 * @param {(p: string, opts: object) => void} [deps.mkdirFn]
 * @param {{ info?: Function, warn?: Function }} [deps.logger]
 * @returns {{ overlaid: boolean, arm: string, copied: string[], agentrc?: object, excluded?: string[] }}
 */
export function overlayFrameworkUnderTest(opts = {}, deps = {}) {
  const {
    workspacePath,
    arm,
    sandbox,
    sourceRoot = repoRoot(),
    overlayPaths = DEFAULT_OVERLAY_PATHS,
    scenario = null,
  } = opts;

  let resolvedBase;
  try {
    resolvedBase = baseArm(arm);
  } catch {
    throw new TypeError(
      `overlayFrameworkUnderTest arm must be a known benchmark arm, got: ${String(arm)}`,
    );
  }
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    throw new TypeError(
      'overlayFrameworkUnderTest requires a non-empty workspacePath',
    );
  }

  // A control-base arm is the bare baseline: no scaffolding, nothing to
  // overlay (arm 3's static CLAUDE.md is seeded separately by
  // `seedStaticClaudeMd`, never by this framework overlay).
  if (resolvedBase === 'control') {
    return { overlaid: false, arm, copied: [] };
  }

  if (!sandbox?.owner || !sandbox?.repo) {
    throw new TypeError(
      'overlayFrameworkUnderTest (mandrel arm) requires sandbox { owner, repo }',
    );
  }

  const cp = deps.cpFn ?? cpSync;
  const writeFile = deps.writeFileFn ?? writeFileSync;
  const readFile = deps.readFileFn ?? readFileSync;
  const exists = deps.existsFn ?? existsSync;
  const logger = deps.logger;

  const copied = [];
  for (const rel of overlayPaths) {
    const src = path.join(sourceRoot, rel);
    if (!exists(src)) {
      logger?.warn?.(`[overlay] source missing, skipping: ${src}`);
      continue;
    }
    const dest = path.join(workspacePath, rel);
    logger?.info?.(`[overlay] ${rel} → ${dest}`);
    // verbatimSymlinks keeps node_modules/.bin shims intact; force overwrites
    // anything the clone already shipped.
    cp(src, dest, { recursive: true, verbatimSymlinks: true, force: true });
    copied.push(rel);
  }

  // Clean minimal consumer package.json (keeps the scenario target
  // uncluttered) carrying REAL lint/test/typecheck gates so Mandrel's
  // close-validation enforcement genuinely fires (Story #74 — generalized
  // from the former single-scenario special case; see buildTargetPackageJson).
  // Delegates to writeGatePackageJson (the control arm's counterpart) rather
  // than re-inlining the serialize+write, so both arms share one write path
  // (Epic #66 audit remediation, H4).
  writeGatePackageJson(
    { workspacePath },
    { writeFileFn: writeFile, readFileFn: readFile, existsFn: exists },
  );

  // Rewrite .agentrc.json to target the sandbox repo.
  const agentrc = rewriteAgentrc(
    readFile(path.join(sourceRoot, '.agentrc.json'), 'utf8'),
    sandbox,
  );
  writeFile(
    path.join(workspacePath, '.agentrc.json'),
    `${JSON.stringify(agentrc, null, 2)}\n`,
  );

  // Git-exclude every overlaid path (the copied framework tree plus the
  // rewritten package.json / .agentrc.json) inside the sandbox clone so the
  // pipeline runs with the overlay present but the headless agent never stages
  // it — keeping the deliverable diff to app code only (Story #56).
  const { added: excluded } = excludeOverlayFromGit(
    { workspacePath, overlayPaths, scenario },
    {
      readFileFn: readFile,
      appendFileFn: deps.appendFileFn,
      mkdirFn: deps.mkdirFn,
      existsFn: exists,
      logger,
    },
  );

  // Make the overlay visible inside the Story worktrees `/deliver` creates
  // (Story #153) — without this the framework's own gate scripts do not
  // resolve from `.worktrees/story-<id>/` and agents burn turns inventing
  // symlink workarounds.
  const { hookPath } = installWorktreeOverlayHook(
    { workspacePath, overlayPaths, scenario },
    {
      mkdirFn: deps.mkdirFn,
      writeFileFn: writeFile,
      chmodFn: deps.chmodFn,
      logger,
    },
  );

  return { overlaid: true, arm, copied, agentrc, excluded, hookPath };
}
