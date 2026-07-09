// bench/driver/sandbox.js
/**
 * Ephemeral sandbox-repo lifecycle for the Mandrel self-benchmark harness
 * (Epic #65 / Story #71 — self-contained sandbox: ephemeral per-cell repos
 * from an in-repo template).
 *
 * The harness must never mutate the live `mandrel` repo (Epic #4211 Non-Goal:
 * "Running against the live `mandrel` repo"). Every benchmark cell gets its
 * OWN private GitHub repo, seeded from `bench/sandbox-template/` (plus an
 * optional per-scenario overlay), used for the cell's N serial runs, and
 * destroyed at teardown — a `create → seed → run(N) → destroy` lifecycle
 * (docs/target-architecture.md §5, decision delta D-013). This replaces the
 * former standing external sandbox repo (retired — see docs/decisions.md
 * D-013), whose `main` was force-reset around every cell and whose content
 * was unversioned — a shared mutable substrate that blocked parallel cells
 * and drifted silently.
 *
 * Lifecycle primitives:
 *   - `sandboxRepoName(opts)` — pure repo-name generator, always prefixed
 *     `bench-sbx-`, length-clamped to GitHub's 100-char limit (the prefix and
 *     nonce are never truncated).
 *   - `createEphemeralRepo(opts, deps)` — `gh repo create <owner>/<name>
 *     --private` via the injected `gh` seam. Refuses any name outside the
 *     reserved `bench-sbx-` prefix.
 *   - `materializeSandboxTemplate(opts, deps)` — copies the baseline template
 *     tree (`bench/sandbox-template/`) into a working tree, layering a
 *     per-scenario seed directory (`bench/scenarios/<id>/sandbox/`) on top
 *     when present.
 *   - `seedFromTemplate(opts, deps)` — materializes the template, commits it,
 *     and pushes it as the ephemeral repo's baseline commit, returning the
 *     baseline SHA recorded on the sandbox handle.
 *   - `destroyEphemeralRepo(opts, deps)` — `gh repo delete --yes`, best-effort
 *     on every failure path (a failed delete logs and defers to the janitor
 *     sweep — a sibling Story — rather than aborting the cell).
 *   - `provisionSandbox(opts)` — `git clone` the (now-seeded) ephemeral repo
 *     into a fresh `mkdtemp` workspace for one run and return a handle
 *     describing it. For the control arm the materialized `.agents/` bundle is
 *     stripped so the bare model receives no Mandrel scaffolding (Tech Spec
 *     #4213: "The control arm clone has **no** `.agents/` scaffolding"). When
 *     called with `repoFullName`/`baselineSha` (the ephemeral-repo path) the
 *     returned handle carries `{ repoFullName, baselineSha, ephemeral: true }`
 *     per the Story #71 binding contract.
 *   - `teardownSandbox(handle)` — recursively remove the workspace, with the
 *     removal path asserted to live strictly inside the configured ephemeral
 *     root before a single byte is deleted.
 *
 * SECURITY (security-baseline + Story #4216 binding contract, extended by
 * Story #71): teardown is scoped strictly to the ephemeral workspace path.
 * `assertInsideRoot` rejects any path that is not a proper descendant of the
 * ephemeral root, so a malformed or adversarial handle can never escalate into
 * an `rm -rf` of a real repository, the home directory, or `/`. Destroying a
 * remote repo is guarded the same way: `createEphemeralRepo` and
 * `destroyEphemeralRepo` both refuse any repo name that does not start with
 * the reserved `bench-sbx-` prefix — nothing else under the operator account
 * may use it, which is what makes unattended deletion safe. The `git`/`gh`
 * binaries are invoked via `execFileSync` with an argument array — never a
 * shell string — so a repo-URL or path value can never be interpreted as a
 * shell command.
 *
 * All external effects (`git`, `gh`, `mkdtemp`, `rm`, `cp`, `existsSync`) are
 * injectable so the unit tests exercise the full lifecycle — including the
 * path-containment guard and the prefix-reservation guard — without cloning,
 * creating, or deleting a real repository.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Canonical prefix for every ephemeral sandbox artifact: BOTH the local
 * `mkdtemp` workspace directory AND the per-cell GitHub repo name share this
 * reserved prefix (Story #71). The prefix is what makes unattended teardown
 * and the janitor sweep (sibling Story) safe — nothing else under the
 * operator account or the OS temp root may use it.
 */
export const SANDBOX_DIR_PREFIX = 'bench-sbx-';

/** GitHub's hard repo-name length ceiling. */
const GITHUB_REPO_NAME_MAX_LENGTH = 100;

/**
 * Default ephemeral root under which all sandbox workspaces are created. Kept
 * as a function (not a const) so each call re-reads `tmpdir()` — the value is
 * environment-dependent and tests override it explicitly.
 *
 * @returns {string}
 */
export function defaultEphemeralRoot() {
  return tmpdir();
}

/**
 * Assert that `target` is a path strictly *inside* `root` (a proper
 * descendant, never `root` itself and never an escape via `..` or an absolute
 * re-root). Returns the resolved absolute target on success.
 *
 * This is the load-bearing safety check for teardown: it runs before any
 * filesystem removal and converts a bad path into a thrown Error rather than a
 * destructive delete. Mirrors `.agents/scripts/lib/path-security.js` but is
 * inlined so the bench tree carries no dependency on the distributed bundle.
 *
 * @param {string} root    Absolute path of the containing ephemeral root.
 * @param {string} target  Path to validate (resolved against `root`).
 * @param {string} label   Human-readable identifier for the error message.
 * @returns {string} The resolved absolute `target`.
 * @throws {Error} when `target` is not strictly inside `root`.
 */
export function assertInsideRoot(root, target, label = 'path') {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('assertInsideRoot requires a non-empty root');
  }
  if (typeof target !== 'string' || target.length === 0) {
    throw new TypeError('assertInsideRoot requires a non-empty target');
  }
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  const escapes = rel === '' || rel.startsWith('..') || path.isAbsolute(rel);
  if (escapes) {
    throw new Error(
      `${label} resolves outside the ephemeral sandbox root ${resolvedRoot}: ${resolvedTarget}`,
    );
  }
  return resolvedTarget;
}

/**
 * @typedef {object} SandboxHandle
 * @property {string} workspacePath  Absolute path to the ephemeral clone root.
 * @property {string} ephemeralRoot  Absolute path of the temp root the clone lives under.
 * @property {string} repoUrl        The sandbox repo URL that was cloned.
 * @property {'mandrel'|'control'} arm  Which benchmark arm this workspace serves.
 * @property {string|null} ref       The branch/ref checked out, or null for default.
 * @property {boolean} agentsStripped Whether `.agents/` was removed (true for the control arm).
 * @property {string|null} repoFullName  `owner/name` of the ephemeral per-cell
 *   repo this workspace was cloned from, or null for the legacy standing-repo
 *   path.
 * @property {string|null} baselineSha   The baseline commit SHA recorded at
 *   seed time (see {@link seedFromTemplate}), or null when not ephemeral.
 * @property {boolean} ephemeral     True when this handle belongs to a
 *   per-cell ephemeral repo (i.e. `repoFullName` was supplied), false for the
 *   legacy standing-repo path.
 */

/**
 * @typedef {object} ProvisionDeps
 * @property {(cmd: string, args: string[], opts: object) => unknown} [execFileFn]
 *   Injected `execFileSync`. Defaults to the real one. Tests stub this so no
 *   real `git clone` runs.
 * @property {(prefix: string) => string} [mkdtempFn]
 *   Injected directory factory. Receives the full `<root>/<prefix>` argument
 *   and returns the created absolute path. Defaults to `mkdtempSync`.
 * @property {(p: string) => boolean} [existsFn]  Injected `existsSync`.
 * @property {(p: string, opts: object) => void} [rmFn]  Injected `rmSync`.
 * @property {{ info?: Function, warn?: Function }} [logger]
 */

/**
 * Provision a fresh ephemeral clone of the configured sandbox repo.
 *
 * @param {object} opts
 * @param {string} opts.repoUrl  Sandbox repo URL or local path to clone.
 * @param {'mandrel'|'control'} [opts.arm='mandrel']  Benchmark arm.
 * @param {string|null} [opts.ref=null]  Branch / ref to check out (default branch when null).
 * @param {string} [opts.ephemeralRoot]  Temp root to clone under. Defaults to `tmpdir()`.
 * @param {number} [opts.depth=1]  `git clone --depth` value (shallow by default).
 * @param {string|null} [opts.repoFullName]  `owner/name` of the ephemeral
 *   per-cell repo this clone belongs to (Story #71). When supplied, the
 *   returned handle sets `ephemeral: true`.
 * @param {string|null} [opts.baselineSha]  The baseline commit SHA recorded
 *   at seed time (see {@link seedFromTemplate}); carried onto the handle.
 * @param {ProvisionDeps} [deps]
 * @returns {SandboxHandle}
 */
export function provisionSandbox(opts = {}, deps = {}) {
  const {
    repoUrl,
    arm = 'mandrel',
    ref = null,
    ephemeralRoot = defaultEphemeralRoot(),
    depth = 1,
    repoFullName = null,
    baselineSha = null,
  } = opts;

  if (typeof repoUrl !== 'string' || repoUrl.length === 0) {
    throw new TypeError('provisionSandbox requires a non-empty repoUrl');
  }
  if (arm !== 'mandrel' && arm !== 'control') {
    throw new TypeError(
      `provisionSandbox arm must be "mandrel" or "control", got: ${String(arm)}`,
    );
  }

  const execFileFn = deps.execFileFn ?? execFileSync;
  const mkdtempFn = deps.mkdtempFn ?? mkdtempSync;
  const existsFn = deps.existsFn ?? existsSync;
  const rmFn = deps.rmFn ?? rmSync;
  const logger = deps.logger;

  const resolvedRoot = path.resolve(ephemeralRoot);
  // mkdtemp appends random chars to the prefix; we pass the full root+prefix.
  const workspacePath = path.resolve(
    mkdtempFn(path.join(resolvedRoot, SANDBOX_DIR_PREFIX)),
  );
  // Defense in depth: the freshly minted workspace must itself sit inside root.
  assertInsideRoot(resolvedRoot, workspacePath, 'sandbox workspace');

  logger?.info?.(
    `[sandbox] Cloning ${repoUrl} → ${workspacePath} (arm=${arm}, depth=${depth})`,
  );

  const cloneArgs = ['clone', '--depth', String(depth)];
  if (ref) {
    cloneArgs.push('--branch', ref);
  }
  cloneArgs.push('--', repoUrl, workspacePath);

  try {
    execFileFn('git', cloneArgs, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5 * 60 * 1000,
    });
  } catch (err) {
    // Clone failed — best-effort clean up the (possibly partial) workspace so a
    // failed provision never leaks a temp directory, then rethrow.
    try {
      const safe = assertInsideRoot(
        resolvedRoot,
        workspacePath,
        'sandbox workspace (failed-clone cleanup)',
      );
      if (existsFn(safe)) {
        rmFn(safe, { recursive: true, force: true });
      }
    } catch {
      // Swallow cleanup errors — the original clone error is what matters.
    }
    throw new Error(
      `[sandbox] git clone failed for ${repoUrl}: ${err?.message ?? err}`,
    );
  }

  let agentsStripped = false;
  if (arm === 'control') {
    // The control arm is the bare-model baseline: it must carry NO Mandrel
    // scaffolding so the overhead ratio is apples-to-apples by construction.
    const agentsPath = assertInsideRoot(
      workspacePath,
      path.join(workspacePath, '.agents'),
      'control-arm .agents bundle',
    );
    if (existsFn(agentsPath)) {
      rmFn(agentsPath, { recursive: true, force: true });
      agentsStripped = true;
      logger?.info?.(
        `[sandbox] Stripped .agents/ for control arm: ${agentsPath}`,
      );
    }
  }

  return {
    workspacePath,
    ephemeralRoot: resolvedRoot,
    repoUrl,
    arm,
    ref,
    agentsStripped,
    repoFullName,
    baselineSha,
    ephemeral: repoFullName != null,
  };
}

// ---------------------------------------------------------------------------
// Ephemeral per-cell repo lifecycle (Story #71): create → seed → destroy.
// `provisionSandbox`/`teardownSandbox` above remain the PER-RUN local
// workspace clone/remove; these three functions are the PER-CELL remote
// GitHub-repo lifecycle that wraps a cell's N serial runs.
// ---------------------------------------------------------------------------

/**
 * Slugify an arbitrary string into a lowercase, dash-separated, GitHub
 * repo-name-safe token: non `[a-z0-9]` runs collapse to a single `-`, and
 * leading/trailing dashes are trimmed. Pure.
 *
 * @param {string} value
 * @returns {string}
 */
function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Generate the ephemeral per-cell repo name: always `bench-sbx-`-prefixed,
 * slug-sanitized, and clamped to GitHub's 100-char repo-name limit. The
 * `cohort`/`scenario`/`arm` slugs are truncated (from the middle segment)
 * before the nonce is ever touched — the prefix and nonce are load-bearing
 * (the prefix for the reservation guarantee, the nonce for collision-freedom)
 * and are NEVER truncated. Pure.
 *
 * @param {object} opts
 * @param {string} [opts.cohort]    Cohort label (e.g. a version/date stamp).
 * @param {string} [opts.scenario]  Scenario id.
 * @param {string} [opts.arm]       Benchmark arm.
 * @param {string} opts.nonce       Collision-freedom token (required, non-empty).
 * @returns {string}
 */
export function sandboxRepoName({ cohort, scenario, arm, nonce } = {}) {
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new TypeError('sandboxRepoName requires a non-empty nonce');
  }
  const nonceSlug = slugify(nonce);
  if (nonceSlug.length === 0) {
    throw new TypeError(
      'sandboxRepoName nonce must contain at least one alphanumeric character',
    );
  }

  const middleParts = [
    slugify(cohort ?? ''),
    slugify(scenario ?? ''),
    slugify(arm ?? ''),
  ].filter(Boolean);
  let middle = middleParts.join('-');

  // Reserve room for the prefix + a separating dash + the nonce; clamp ONLY
  // the middle (cohort/scenario/arm) segment to fit, never the prefix or nonce.
  const fixedLength = SANDBOX_DIR_PREFIX.length + nonceSlug.length + 1;
  const budget = Math.max(0, GITHUB_REPO_NAME_MAX_LENGTH - fixedLength);
  if (middle.length > budget) {
    middle = middle.slice(0, budget).replace(/-+$/, '');
  }

  return middle
    ? `${SANDBOX_DIR_PREFIX}${middle}-${nonceSlug}`
    : `${SANDBOX_DIR_PREFIX}${nonceSlug}`;
}

/**
 * Assert `name` carries the reserved `bench-sbx-` prefix. The prefix
 * reservation is what makes unattended repo creation/deletion safe (security
 * baseline + Story #71 Security & Privacy section) — nothing else under the
 * operator account may use it.
 *
 * @param {string} name
 * @param {string} label
 */
function assertReservedPrefix(name, label) {
  if (typeof name !== 'string' || !name.startsWith(SANDBOX_DIR_PREFIX)) {
    throw new Error(
      `[sandbox] refusing ${label}: repo name is outside the reserved ${SANDBOX_DIR_PREFIX} prefix: ${name}`,
    );
  }
}

/**
 * @typedef {object} EphemeralRepoDeps
 * @property {(args: string[]) => string} [ghFn]  Injected `gh` invoker.
 *   Defaults to {@link defaultGhInvoke}. Tests stub this so no real GitHub API
 *   call runs.
 * @property {{ info?: Function, warn?: Function }} [logger]
 */

/**
 * Create the ephemeral per-cell GitHub repo: `gh repo create <owner>/<name>
 * --private`. Refuses any `name` outside the reserved `bench-sbx-` prefix.
 *
 * @param {{ owner: string, name: string }} opts
 * @param {EphemeralRepoDeps} [deps]
 * @returns {{ repoFullName: string }}
 */
export function createEphemeralRepo({ owner, name } = {}, deps = {}) {
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new TypeError('createEphemeralRepo requires a non-empty owner');
  }
  assertReservedPrefix(name, 'repo creation');

  const ghFn = deps.ghFn ?? defaultGhInvoke;
  const logger = deps.logger;
  const repoFullName = `${owner}/${name}`;

  logger?.info?.(`[sandbox] Creating ephemeral repo ${repoFullName}`);
  ghFn(['repo', 'create', repoFullName, '--private']);

  return { repoFullName };
}

/**
 * Destroy the ephemeral per-cell GitHub repo: `gh repo delete --yes`.
 * Best-effort on every failure path — a failed delete logs and defers to the
 * janitor sweep (sibling Story) rather than throwing, so a teardown failure
 * never masks a run's own result or aborts the batch. The reserved-prefix
 * guard still throws (a repo outside the prefix is refused outright, never
 * "best-effort" swallowed).
 *
 * @param {{ repoFullName: string }} opts
 * @param {EphemeralRepoDeps} [deps]
 * @returns {{ deleted: boolean, repoFullName: string, error?: string }}
 */
export function destroyEphemeralRepo({ repoFullName } = {}, deps = {}) {
  if (typeof repoFullName !== 'string' || repoFullName.length === 0) {
    throw new TypeError(
      'destroyEphemeralRepo requires a non-empty repoFullName',
    );
  }
  const name = repoFullName.split('/').pop();
  assertReservedPrefix(name, 'repo deletion');

  const ghFn = deps.ghFn ?? defaultGhInvoke;
  const logger = deps.logger;

  try {
    ghFn(['repo', 'delete', repoFullName, '--yes']);
    logger?.info?.(`[sandbox] Destroyed ephemeral repo ${repoFullName}`);
    return { deleted: true, repoFullName };
  } catch (err) {
    logger?.warn?.(
      `[sandbox] destroy failed for ${repoFullName} (best-effort, deferring to janitor): ${err?.message ?? err}`,
    );
    return { deleted: false, repoFullName, error: err?.message ?? String(err) };
  }
}

/**
 * Absolute path of the in-repo sandbox template root (`bench/sandbox-template/`).
 * Kept as a function so tests can override it without mutating module state.
 *
 * @returns {string}
 */
export function defaultSandboxTemplateRoot() {
  return path.resolve(__dirname, '..', 'sandbox-template');
}

/**
 * Absolute path of a scenario's optional seed-layer directory
 * (`bench/scenarios/<id>/sandbox/`).
 *
 * @param {string} scenarioId
 * @returns {string}
 */
export function defaultScenarioSandboxDir(scenarioId) {
  return path.resolve(
    __dirname,
    '..',
    'scenarios',
    String(scenarioId),
    'sandbox',
  );
}

/**
 * @typedef {object} MaterializeDeps
 * @property {(p: string) => boolean} [existsFn]  Injected `existsSync`.
 * @property {(p: string, opts: object) => void} [mkdirFn]  Injected `mkdirSync`.
 * @property {(src: string, dest: string) => void} [cpFn]  Injected recursive copy.
 * @property {{ info?: Function, warn?: Function }} [logger]
 */

/**
 * Materialize the sandbox template into a working tree: the baseline template
 * (`templateRoot`) is copied first, then the optional per-scenario seed layer
 * (`scenarioSandboxDir`) is copied ON TOP when it exists — later files win, so
 * a scenario can override a baseline file. Missing `scenarioSandboxDir` is not
 * an error (most scenarios carry no seed layer yet).
 *
 * @param {object} opts
 * @param {string} opts.templateRoot          Baseline template directory.
 * @param {string|null} [opts.scenarioSandboxDir]  Optional per-scenario overlay dir.
 * @param {string} opts.targetDir             Destination working tree.
 * @param {MaterializeDeps} [deps]
 * @returns {{ targetDir: string, templateRoot: string, scenarioSandboxDir: string|null }}
 */
export function materializeSandboxTemplate(
  { templateRoot, scenarioSandboxDir = null, targetDir } = {},
  deps = {},
) {
  if (typeof templateRoot !== 'string' || templateRoot.length === 0) {
    throw new TypeError('materializeSandboxTemplate requires templateRoot');
  }
  if (typeof targetDir !== 'string' || targetDir.length === 0) {
    throw new TypeError('materializeSandboxTemplate requires targetDir');
  }

  const existsFn = deps.existsFn ?? existsSync;
  const mkdirFn = deps.mkdirFn ?? ((p) => mkdirSync(p, { recursive: true }));
  const cpFn =
    deps.cpFn ?? ((src, dest) => cpSync(src, dest, { recursive: true }));
  const logger = deps.logger;

  if (!existsFn(templateRoot)) {
    throw new Error(`[sandbox] template root does not exist: ${templateRoot}`);
  }

  mkdirFn(targetDir);
  cpFn(templateRoot, targetDir);
  logger?.info?.(
    `[sandbox] Materialized baseline template ${templateRoot} → ${targetDir}`,
  );

  let layeredScenarioDir = null;
  if (
    typeof scenarioSandboxDir === 'string' &&
    scenarioSandboxDir.length > 0 &&
    existsFn(scenarioSandboxDir)
  ) {
    cpFn(scenarioSandboxDir, targetDir);
    layeredScenarioDir = scenarioSandboxDir;
    logger?.info?.(
      `[sandbox] Layered per-scenario seed ${scenarioSandboxDir} → ${targetDir}`,
    );
  }

  return { targetDir, templateRoot, scenarioSandboxDir: layeredScenarioDir };
}

/**
 * @typedef {object} SeedDeps
 * @property {(cmd: string, args: string[], opts: object) => unknown} [execFileFn]
 *   Injected `execFileSync`. Defaults to the real one.
 * @property {typeof materializeSandboxTemplate} [materializeFn]  Injected
 *   materializer. Defaults to {@link materializeSandboxTemplate}.
 * @property {MaterializeDeps} [materializeDeps]  Forwarded to `materializeFn`.
 * @property {(repoFullName: string) => string} [repoUrlFn]  Overrides the
 *   `origin` URL derivation (defaults to an `https://github.com/<repoFullName>.git` URL).
 * @property {{ info?: Function, warn?: Function }} [logger]
 */

/**
 * Seed the ephemeral repo's baseline commit: materialize the template into
 * `workspacePath`, `git init` + commit it, push it as `main`, and resolve the
 * baseline commit SHA. The returned `baselineSha` is what
 * {@link resetSandboxBaseline} force-resets `main` back to between a cell's
 * serial runs.
 *
 * @param {object} opts
 * @param {string} opts.repoFullName        `owner/name` of the ephemeral repo.
 * @param {string} opts.workspacePath       Local working tree to seed from.
 * @param {string} [opts.templateRoot]      Defaults to {@link defaultSandboxTemplateRoot}.
 * @param {string|null} [opts.scenarioSandboxDir]  Optional per-scenario overlay dir.
 * @param {SeedDeps} [deps]
 * @returns {{ repoFullName: string, baselineSha: string, repoUrl: string }}
 */
export function seedFromTemplate(
  {
    repoFullName,
    workspacePath,
    templateRoot = defaultSandboxTemplateRoot(),
    scenarioSandboxDir = null,
  } = {},
  deps = {},
) {
  if (typeof repoFullName !== 'string' || repoFullName.length === 0) {
    throw new TypeError('seedFromTemplate requires a non-empty repoFullName');
  }
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    throw new TypeError('seedFromTemplate requires a non-empty workspacePath');
  }

  const execFileFn = deps.execFileFn ?? execFileSync;
  const materialize = deps.materializeFn ?? materializeSandboxTemplate;
  const logger = deps.logger;

  materialize(
    { templateRoot, scenarioSandboxDir, targetDir: workspacePath },
    deps.materializeDeps,
  );

  const git = (args) =>
    execFileFn('git', args, {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

  git(['init', '--initial-branch=main']);
  git(['add', '-A']);
  git([
    'commit',
    '-m',
    'chore: seed ephemeral sandbox from bench/sandbox-template',
  ]);
  const repoUrl = deps.repoUrlFn
    ? deps.repoUrlFn(repoFullName)
    : `https://github.com/${repoFullName}.git`;
  git(['remote', 'add', 'origin', repoUrl]);
  git(['push', '-u', 'origin', 'main']);
  const sha = String(git(['rev-parse', 'HEAD'])).trim();

  logger?.info?.(`[sandbox] Seeded ${repoFullName} baseline @ ${sha}`);
  return { repoFullName, baselineSha: sha, repoUrl };
}

/**
 * Strip whitespace from the GitHub token environment variables so a malformed
 * ambient token can't break a `gh` call. A token with a trailing `\r` (e.g. a
 * `.env` saved with CRLF line endings) makes `gh` fail with
 * `net/http: invalid header field value for "Authorization"`, which silently
 * fails the per-run sandbox reset and lets a run clone an un-reset `main`.
 * GitHub tokens never contain whitespace, so stripping it is always safe.
 * Returns a shallow copy; unset / empty tokens are left untouched so a clean
 * `gh` keyring auth still applies.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {NodeJS.ProcessEnv}
 */
export function sanitizeGitHubTokenEnv(env = process.env) {
  const out = { ...env };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const v = out[key];
    if (typeof v === 'string' && v.length > 0) {
      out[key] = v.replace(/\s/g, '');
    }
  }
  return out;
}

/**
 * Default `gh` invoker for {@link resetSandboxBaseline}: runs `gh <args>` via
 * `execFileSync` (an argument array — never a shell string) with a
 * token-sanitized environment ({@link sanitizeGitHubTokenEnv}). Exported with
 * an injectable `execFileFn` so the sanitization is unit-testable without
 * spawning a real `gh` process.
 *
 * @param {string[]} args  argv passed to `gh`.
 * @param {{ execFileFn?: typeof execFileSync }} [deps]
 * @returns {string} `gh` stdout.
 */
export function defaultGhInvoke(args, { execFileFn = execFileSync } = {}) {
  return execFileFn('gh', args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: sanitizeGitHubTokenEnv(),
  });
}

/**
 * @typedef {object} ResetBaselineDeps
 * @property {(args: string[]) => string} [ghFn]  Injected `gh` invoker. Receives
 *   the argv array and returns stdout. Defaults to {@link defaultGhInvoke},
 *   which runs `execFileSync('gh', …)` with a token-sanitized environment (an
 *   argument array — never a shell string — so an owner/repo value can never be
 *   interpreted as a shell command). Tests stub this so no real GitHub API call
 *   runs.
 * @property {{ info?: Function, warn?: Function }} [logger]
 */

/**
 * Reset the sandbox repo's `main` branch back to a clean baseline commit.
 *
 * The mandrel arm auto-merges each delivery into the sandbox repo's GitHub
 * `main`, so runs accumulate state. To keep runs clean and repeatable, the
 * harness force-resets `main` to the baseline before each run (a defensive
 * secondary check) and after each run (the primary cleanup) — including
 * between a cell's N serial runs in the ephemeral per-cell model (Story #71).
 *
 * Two ways to identify the baseline:
 *   - `opts.sha` — the baseline commit SHA already known (e.g. recorded on the
 *     sandbox handle by {@link seedFromTemplate} at cell-seed time). Skips the
 *     resolve step entirely — a single GitHub API call.
 *   - `opts.baselineRef` (default `'bench-baseline'`) — a branch name resolved
 *     to its SHA via the GitHub API first (the legacy standing-repo path).
 * `sha` takes precedence when both are supplied.
 *
 * Pure with respect to the filesystem — the only side effect is the GitHub API
 * call(s), injectable so the unit tests exercise the full contract without
 * touching a real repo.
 *
 * @param {object} opts
 * @param {string} opts.owner  Sandbox repo owner (org/user).
 * @param {string} opts.repo   Sandbox repo name.
 * @param {string} [opts.baselineRef='bench-baseline']  The clean baseline branch
 *   (resolved via the API); ignored when `sha` is supplied.
 * @param {string} [opts.sha]  A known baseline commit SHA — resets straight to
 *   it, skipping the branch-resolve API call.
 * @param {ResetBaselineDeps} [deps]
 * @returns {{ reset: boolean, sha: string }}
 * @throws {TypeError} when `owner` or `repo` is not a non-empty string.
 */
export function resetSandboxBaseline(
  { owner, repo, baselineRef = 'bench-baseline', sha: providedSha } = {},
  deps = {},
) {
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new TypeError('resetSandboxBaseline requires a non-empty owner');
  }
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new TypeError('resetSandboxBaseline requires a non-empty repo');
  }

  const ghFn = deps.ghFn ?? defaultGhInvoke;
  const logger = deps.logger;

  // 1. Resolve the baseline commit SHA — reuse the caller-supplied SHA
  //    (ephemeral per-cell path, recorded at seed time) when present, else
  //    resolve the baseline branch via the API (legacy standing-repo path).
  let sha = providedSha;
  if (typeof sha !== 'string' || sha.length === 0) {
    const refJson = ghFn([
      'api',
      `repos/${owner}/${repo}/git/ref/heads/${baselineRef}`,
    ]);
    sha = JSON.parse(refJson)?.object?.sha;
    if (typeof sha !== 'string' || sha.length === 0) {
      throw new Error(
        `[sandbox] could not resolve baseline SHA for ${owner}/${repo}@${baselineRef}`,
      );
    }
  }

  // 2. Force-update main to the baseline SHA (rewinds any accumulated state).
  ghFn([
    'api',
    '-X',
    'PATCH',
    `repos/${owner}/${repo}/git/refs/heads/main`,
    '-f',
    `sha=${sha}`,
    '-F',
    'force=true',
  ]);

  const source =
    typeof providedSha === 'string' && providedSha.length > 0
      ? 'recorded baseline SHA'
      : baselineRef;
  logger?.info?.(`[sandbox] Reset ${owner}/${repo}@main → ${source} (${sha})`);

  return { reset: true, sha };
}

/**
 * @typedef {object} TeardownDeps
 * @property {(p: string) => boolean} [existsFn]  Injected `existsSync`.
 * @property {(p: string) => { isDirectory: () => boolean }} [statFn]  Injected `statSync`.
 * @property {(p: string, opts: object) => void} [rmFn]  Injected `rmSync`.
 * @property {{ info?: Function, warn?: Function }} [logger]
 */

/**
 * Tear down an ephemeral sandbox workspace. The removal target is asserted to
 * live strictly inside the handle's `ephemeralRoot` *before* any deletion — a
 * handle whose `workspacePath` is not a descendant of its `ephemeralRoot`
 * throws and removes nothing. This is the strict-scoping guarantee in the
 * Story #4216 binding contract: teardown can only ever delete the throwaway
 * workspace, never a real repo.
 *
 * Idempotent: tearing down an already-removed workspace is a no-op.
 *
 * @param {SandboxHandle} handle
 * @param {TeardownDeps} [deps]
 * @returns {{ removed: boolean, workspacePath: string }}
 */
export function teardownSandbox(handle, deps = {}) {
  if (!handle || typeof handle !== 'object') {
    throw new TypeError('teardownSandbox requires a sandbox handle');
  }
  const { workspacePath, ephemeralRoot } = handle;
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    throw new TypeError('teardownSandbox handle requires workspacePath');
  }
  if (typeof ephemeralRoot !== 'string' || ephemeralRoot.length === 0) {
    throw new TypeError('teardownSandbox handle requires ephemeralRoot');
  }

  const existsFn = deps.existsFn ?? existsSync;
  const statFn = deps.statFn ?? statSync;
  const rmFn = deps.rmFn ?? rmSync;
  const logger = deps.logger;

  // The single safety gate: assert containment before touching the filesystem.
  const safeTarget = assertInsideRoot(
    ephemeralRoot,
    workspacePath,
    'sandbox teardown target',
  );

  if (!existsFn(safeTarget)) {
    logger?.info?.(`[sandbox] Teardown no-op (already gone): ${safeTarget}`);
    return { removed: false, workspacePath: safeTarget };
  }

  // Guard against pointing teardown at a file or a symlink masquerading as the
  // workspace — only ever recursively remove an actual directory.
  const stat = statFn(safeTarget);
  if (!stat.isDirectory()) {
    throw new Error(
      `[sandbox] teardown target is not a directory, refusing to remove: ${safeTarget}`,
    );
  }

  logger?.info?.(`[sandbox] Removing ephemeral workspace: ${safeTarget}`);
  rmFn(safeTarget, { recursive: true, force: true });
  return { removed: true, workspacePath: safeTarget };
}

/**
 * Convenience wrapper: provision a sandbox, run `fn(handle)`, and guarantee
 * teardown even when `fn` throws. The harness uses this so a crashed run can
 * never leak a workspace (Epic AC: "tears down each workspace").
 *
 * @template T
 * @param {object} provisionOpts  Forwarded to `provisionSandbox`.
 * @param {(handle: SandboxHandle) => Promise<T> | T} fn
 * @param {{ provision?: ProvisionDeps, teardown?: TeardownDeps }} [deps]
 * @returns {Promise<T>}
 */
export async function withSandbox(provisionOpts, fn, deps = {}) {
  const handle = provisionSandbox(provisionOpts, deps.provision);
  try {
    return await fn(handle);
  } finally {
    teardownSandbox(handle, deps.teardown);
  }
}
