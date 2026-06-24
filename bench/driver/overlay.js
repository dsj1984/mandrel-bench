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
 *     not by what `package.json` declares), and
 *   - a rewritten `.agentrc.json` whose `github.owner/repo` point at the sandbox
 *     repo (so `/deliver` opens issues/branches/PR there, never against this repo).
 *
 * The CONTROL arm is deliberately NOT overlaid — it is the bare-model baseline
 * and must carry no scaffolding (`provisionSandbox` already strips `.agents/`).
 *
 * Every filesystem effect is injectable so the unit tests exercise the full
 * overlay contract without copying 144 MB of `node_modules` or touching disk.
 */

import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * The one scenario whose lint/test/typecheck gates are un-stubbed (Story #57).
 * For every other scenario `buildTargetPackageJson` returns the no-op
 * `node --version` shim unchanged; only this scenario gets real gates so
 * Mandrel's close-validation enforcement actually fires on the mandrel arm —
 * one of the three preconditions the differential-trap spike tests.
 */
export const TRAP_SCENARIO_ID = 'auth-trap';

/**
 * The real `typecheck` gate for the trap scenario: a `node --check` parse sweep
 * over every delivered `.js`/`.mjs`/`.cjs` file. This repo is plain ESM
 * JavaScript with no TypeScript, so a per-file `node --check` IS the typecheck
 * contract (the same rationale as the repo's own root `typecheck` script). It
 * walks `process.cwd()` and skips `node_modules` and dot-dirs (the overlaid
 * `.agents` / `.claude` framework tree), so it parses the DELIVERED code only,
 * never the framework. Emitted as an inline `node -e` program because the
 * overlay copies only the framework tree into the consumer — there is no place
 * to ship an extra helper file, and the delivered tree must stay app-code-only.
 *
 * @type {string}
 */
export const TRAP_NODE_CHECK_SWEEP = [
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
 * to copying {@link DEFAULT_OVERLAY_PATHS}): the clean minimal `package.json`
 * and the sandbox-repointed `.agentrc.json`. These are framework-overlay
 * artifacts, not deliverable app code, so they are git-excluded alongside the
 * copied paths — otherwise the headless agent would stage them and they would
 * contaminate the deliverable diff exactly like `.agents/**` does.
 */
export const REWRITTEN_OVERLAY_ARTIFACTS = Object.freeze([
  'package.json',
  '.agentrc.json',
]);

/**
 * Every overlaid path the deliverable diff must never contain: the copied
 * framework tree plus the rewritten consumer artifacts. This is the exact set
 * written to the sandbox clone's `.git/info/exclude` at overlay time so the
 * pipeline can run with the overlay present while the headless agent's
 * `git add` / commit never picks any of it up.
 *
 * @param {readonly string[]} [overlayPaths=DEFAULT_OVERLAY_PATHS]
 * @returns {string[]} De-duplicated, stable-ordered relative paths.
 */
export function overlayExcludePaths(overlayPaths = DEFAULT_OVERLAY_PATHS) {
  return [...new Set([...overlayPaths, ...REWRITTEN_OVERLAY_ARTIFACTS])];
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
 * @param {object} [deps]
 * @param {(p: string, enc: string) => string} [deps.readFileFn]
 * @param {(p: string, data: string) => void} [deps.appendFileFn]
 * @param {(p: string, opts: object) => void} [deps.mkdirFn]
 * @param {(p: string) => boolean} [deps.existsFn]
 * @param {{ info?: Function, warn?: Function }} [deps.logger]
 * @returns {{ excludeFile: string, added: string[], patterns: string[] }}
 */
export function excludeOverlayFromGit(opts = {}, deps = {}) {
  const { workspacePath, overlayPaths = DEFAULT_OVERLAY_PATHS } = opts;

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
  const patterns = overlayExcludePaths(overlayPaths).map((rel) => `/${rel}`);

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
 * Absolute path of this repo's root (two levels up from `bench/driver/`).
 * Exported so the orchestrator and tests share one anchor.
 *
 * @returns {string}
 */
export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * The clean, minimal consumer `package.json` written into the mandrel-arm
 * clone. It declares no app deps so the scenario app is built into an
 * uncluttered tree; the copied `node_modules` resolves the framework runtime
 * deps regardless of what this file declares.
 *
 * It DOES carry no-op gate scripts BY DEFAULT. The overlay clobbers the
 * clone's `package.json` wholesale, and Mandrel's close-validation runs the
 * gate commands hardcoded to `npm run lint` / `npm test` (and `npm run
 * typecheck`) against whatever `package.json` is present. A scripts-less
 * `package.json` makes the very first close fail on `npm run typecheck` (no
 * such script), forcing the delivery agent into a self-recovery cycle that
 * adds the scripts itself — a sandbox-config artifact that wrongly dings the
 * Autonomy dimension (verified: a run blocked on `failedGate:"typecheck"` then
 * recovered by adding scripts). The crap gate is disabled in the overlaid
 * `.agentrc.json`, so the standalone `test` gate runs `npm test` directly.
 * These no-ops are correct, NOT gaming: for the existing pass/pass scenarios
 * Quality is measured by the frozen acceptance oracle — never by these scripts
 * — so passing them trivially has zero effect on the scored signal; it only
 * removes the harness's own sandbox-config friction.
 *
 * ── Un-stubbed gates for the differential trap scenario (Story #57) ──
 * The trap scenario (`auth-trap`) needs enforcement to actually FIRE for the
 * mandrel arm — that is one of the three preconditions the spike tests
 * (headroom + enforcement-fires + detector). When `scenarioId` is the trap
 * scenario this returns REAL gate scripts that exercise the delivered code on
 * disk, so a clean `/deliver` only auto-merges after lint / test / typecheck
 * genuinely pass — not after `node --version` exits 0:
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
 * framework tree, so the sweep walking `process.cwd()` never parses `.agents`/
 * `.claude` — they are dot-dirs the sweep skips, and `node_modules` is skipped
 * explicitly). They do NOT score the trap — the planted defect is scored by
 * the separate adversarial trap-oracle (`trap-oracle.js`), not by these
 * scripts. Un-stubbing is scoped to this one scenario; every other scenario
 * keeps the no-op shim unchanged (Story #57 Out of Scope: do not un-stub gates
 * for all scenarios).
 *
 * The gate scripts are emitted as inline `node -e` programs rather than a
 * committed helper file because the overlay copies only the framework tree
 * (`DEFAULT_OVERLAY_PATHS`) into the consumer — there is no place to ship an
 * extra script, and the delivered tree must stay app-code-only.
 *
 * @param {object} [opts]
 * @param {string} [opts.scenarioId] — scenario this clone is being built for.
 *   When it is the trap scenario, real gates are emitted; otherwise the no-op
 *   shim is returned (default, unchanged behaviour for every other scenario).
 * @returns {object}
 */
export function buildTargetPackageJson(opts = {}) {
  const { scenarioId } = opts;

  if (scenarioId === TRAP_SCENARIO_ID) {
    return {
      name: 'mandrel-bench-target',
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts: {
        typecheck: TRAP_NODE_CHECK_SWEEP,
        lint: `node -e "process.exit(require('fs').existsSync('biome.json')||require('fs').existsSync('biome.jsonc')?1:0)" && (npx --no-install biome ci . || true) || ${TRAP_NODE_CHECK_SWEEP}`,
        test: 'node --test',
      },
    };
  }

  return {
    name: 'mandrel-bench-target',
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: {
      typecheck: 'node --version',
      lint: 'node --version',
      test: 'node --version',
    },
  };
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
 * @param {string} [opts.scenarioId]   Scenario this clone is being built for.
 *   Threaded into `buildTargetPackageJson` so the differential-trap scenario
 *   gets real gates while every other scenario keeps the no-op shim.
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
    scenarioId,
    sourceRoot = repoRoot(),
    overlayPaths = DEFAULT_OVERLAY_PATHS,
  } = opts;

  if (arm !== 'mandrel' && arm !== 'control') {
    throw new TypeError(
      `overlayFrameworkUnderTest arm must be "mandrel" or "control", got: ${String(arm)}`,
    );
  }
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    throw new TypeError(
      'overlayFrameworkUnderTest requires a non-empty workspacePath',
    );
  }

  // The control arm is the bare baseline: no scaffolding, nothing to overlay.
  if (arm === 'control') {
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

  // Clean minimal consumer package.json (keeps the scenario target uncluttered).
  // For the differential-trap scenario (`scenarioId === TRAP_SCENARIO_ID`) this
  // emits REAL lint/test/typecheck gates so Mandrel's close-validation
  // enforcement fires; every other scenario keeps the no-op shim unchanged.
  writeFile(
    path.join(workspacePath, 'package.json'),
    `${JSON.stringify(buildTargetPackageJson({ scenarioId }), null, 2)}\n`,
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
    { workspacePath, overlayPaths },
    {
      readFileFn: readFile,
      appendFileFn: deps.appendFileFn,
      mkdirFn: deps.mkdirFn,
      existsFn: exists,
      logger,
    },
  );

  return { overlaid: true, arm, copied, agentrc, excluded };
}
