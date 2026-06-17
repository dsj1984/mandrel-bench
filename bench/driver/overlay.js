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

import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
 * clone. It carries no scripts or declared deps so the scenario app is built
 * into an uncluttered tree; the copied `node_modules` resolves the framework
 * runtime deps regardless of what this file declares.
 *
 * @returns {object}
 */
export function buildTargetPackageJson() {
  return {
    name: 'mandrel-bench-target',
    version: '0.0.0',
    private: true,
    type: 'module',
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
 * @param {string} [opts.sourceRoot]   Where to copy the framework tree from
 *   (defaults to this repo's root — the version under test).
 * @param {string[]} [opts.overlayPaths]  Relative paths to copy (default
 *   `DEFAULT_OVERLAY_PATHS`).
 * @param {object} [deps]
 * @param {(src: string, dest: string, opts: object) => void} [deps.cpFn]
 * @param {(p: string, data: string) => void} [deps.writeFileFn]
 * @param {(p: string, enc: string) => string} [deps.readFileFn]
 * @param {(p: string) => boolean} [deps.existsFn]
 * @param {{ info?: Function, warn?: Function }} [deps.logger]
 * @returns {{ overlaid: boolean, arm: string, copied: string[], agentrc?: object }}
 */
export function overlayFrameworkUnderTest(opts = {}, deps = {}) {
  const {
    workspacePath,
    arm,
    sandbox,
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
  writeFile(
    path.join(workspacePath, 'package.json'),
    `${JSON.stringify(buildTargetPackageJson(), null, 2)}\n`,
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

  return { overlaid: true, arm, copied, agentrc };
}
