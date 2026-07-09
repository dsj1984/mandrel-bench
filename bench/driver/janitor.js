// bench/driver/janitor.js
/**
 * TTL sweep of leaked `bench-sbx-*` ephemeral sandbox repos (Epic #65 /
 * Story #72 — janitor).
 *
 * Story #71 introduced the ephemeral per-cell repo lifecycle in
 * `bench/driver/sandbox.js`: every benchmark cell creates a private
 * `bench-sbx-`-prefixed GitHub repo and destroys it at teardown
 * (`destroyEphemeralRepo`, best-effort). A crashed run — a killed process, a
 * dropped network connection, an operator `Ctrl-C` — can skip that teardown
 * and leak the repo. This module is the safety net: it lists every repo
 * under the configured owner, deletes the ones that match the reserved
 * `bench-sbx-` prefix AND are older than a TTL (default 24h), and leaves
 * everything else — including younger `bench-sbx-*` repos still mid-cell —
 * strictly alone.
 *
 * Two entry points:
 *   - `sweepLeakedRepos(opts, deps)` — the sweep itself. Called (a) at the
 *     start of every `bench/run.js` invocation (`bench/run.js`'s `main()`)
 *     and (b) standalone via this file's CLI (`node
 *     bench/driver/janitor.js`).
 *   - `main(argv, env, deps)` — the CLI entry: `--dry-run`, `--ttl-hours`,
 *     `--owner`, `--help`.
 *
 * SECURITY: the janitor never widens the destructive surface beyond what
 * `destroyEphemeralRepo` already guards. `filterLeakedRepos` is a pure,
 * unit-testable triple filter — reserved prefix AND owner match AND
 * `createdAt` older than the TTL — so a repo failing ANY leg is never even
 * proposed for deletion, let alone deleted. Deletion itself is delegated to
 * `destroyEphemeralRepo` (`bench/driver/sandbox.js`), which independently
 * re-asserts the reserved-prefix guard and is best-effort: one repo's delete
 * failure is logged and the sweep continues rather than aborting.
 *
 * All external effects (`gh`) are injectable so the unit tests exercise the
 * full prefix/owner/TTL filtering contract and the best-effort continuation
 * semantics without ever listing or deleting a real repository.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultGhInvoke,
  destroyEphemeralRepo,
  SANDBOX_DIR_PREFIX,
} from './sandbox.js';

/** Default sweep TTL in hours — a leaked repo younger than this is left alone. */
export const DEFAULT_TTL_HOURS = 24;

/** Env var that overrides the default TTL (hours). CLI `--ttl-hours` wins over this. */
export const TTL_HOURS_ENV_VAR = 'BENCH_JANITOR_TTL_HOURS';

/**
 * @typedef {object} RepoListing
 * @property {string} name        Repo name (no owner prefix).
 * @property {string|{login:string}} owner  Owner login, either a bare string
 *   or the `{ login }` shape `gh repo list --json owner` emits.
 * @property {string} createdAt   ISO-8601 creation timestamp.
 */

/**
 * @typedef {object} LeakedRepoCandidate
 * @property {string} name           Repo name.
 * @property {string} owner          Owner login.
 * @property {string} createdAt      ISO-8601 creation timestamp.
 * @property {string} repoFullName   `owner/name`.
 * @property {number} ageHours       Age at evaluation time, in hours.
 */

/**
 * Pure triple filter: a repo is a leaked-sweep candidate only when it
 * matches ALL of — the reserved `bench-sbx-` prefix, the configured owner,
 * and a `createdAt` older than `ttlHours`. Any repo failing one leg (a
 * foreign-owner repo, a non-prefixed repo, a repo younger than the TTL, or a
 * malformed listing entry) is silently excluded rather than proposed for
 * deletion — the exclusion is the safety property, not an error condition.
 *
 * @param {object} opts
 * @param {RepoListing[]} [opts.repos]
 * @param {string} opts.owner
 * @param {number} [opts.ttlHours=DEFAULT_TTL_HOURS]
 * @param {Date|string|number} [opts.now]  Evaluation instant. Defaults to `new Date()`.
 * @returns {LeakedRepoCandidate[]}
 */
export function filterLeakedRepos({
  repos = [],
  owner,
  ttlHours = DEFAULT_TTL_HOURS,
  now = new Date(),
} = {}) {
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new TypeError('filterLeakedRepos requires a non-empty owner');
  }
  const ttlMs = Number(ttlHours) * 60 * 60 * 1000;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

  const candidates = [];
  for (const repo of Array.isArray(repos) ? repos : []) {
    const name = repo?.name;
    if (typeof name !== 'string' || !name.startsWith(SANDBOX_DIR_PREFIX)) {
      continue; // non-prefixed repo — never a janitor target.
    }

    const ownerLogin =
      typeof repo?.owner === 'string' ? repo.owner : repo?.owner?.login;
    if (ownerLogin !== owner) {
      continue; // foreign-owner repo — never a janitor target.
    }

    const createdAt = repo?.createdAt ?? repo?.created_at;
    if (typeof createdAt !== 'string' || createdAt.length === 0) {
      continue; // malformed listing entry — skip rather than guess.
    }
    const createdMs = new Date(createdAt).getTime();
    if (!Number.isFinite(createdMs)) {
      continue;
    }

    const ageMs = nowMs - createdMs;
    if (ageMs < ttlMs) {
      continue; // younger than the TTL — still mid-cell, leave it alone.
    }

    candidates.push({
      name,
      owner: ownerLogin,
      createdAt,
      repoFullName: `${ownerLogin}/${name}`,
      ageHours: ageMs / (60 * 60 * 1000),
    });
  }
  return candidates;
}

/**
 * @typedef {object} SweepDeps
 * @property {(args: string[]) => string} [ghFn]  Injected `gh` invoker.
 *   Defaults to {@link defaultGhInvoke} (`bench/driver/sandbox.js`). Tests
 *   stub this so no real `gh repo list`/`gh repo delete` call runs.
 * @property {typeof destroyEphemeralRepo} [destroyFn]  Injected repo-delete
 *   primitive. Defaults to {@link destroyEphemeralRepo}.
 * @property {{ info?: Function, warn?: Function }} [logger]
 */

/**
 * Sweep every `bench-sbx-`-prefixed repo under `owner` older than `ttlHours`.
 *
 * Empty listing is a no-op. `dryRun: true` computes and logs the exact same
 * candidate set the real sweep would delete, but deletes nothing — the
 * candidates are still returned so a caller (or a test) can assert on them.
 * A per-repo delete failure is logged and does NOT abort the sweep — the
 * remaining candidates are still attempted (best-effort continuation,
 * mirroring `destroyEphemeralRepo`'s own best-effort contract).
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {number} [opts.ttlHours=DEFAULT_TTL_HOURS]
 * @param {boolean} [opts.dryRun=false]
 * @param {Date|string|number} [opts.now]  Forwarded to {@link filterLeakedRepos}.
 * @param {SweepDeps} [deps]
 * @returns {{ candidates: LeakedRepoCandidate[], deleted: string[], failed: Array<{repoFullName: string, error: string}>, dryRun: boolean }}
 */
export function sweepLeakedRepos(
  { owner, ttlHours = DEFAULT_TTL_HOURS, dryRun = false, now } = {},
  deps = {},
) {
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new TypeError('sweepLeakedRepos requires a non-empty owner');
  }

  const ghFn = deps.ghFn ?? defaultGhInvoke;
  const destroyFn = deps.destroyFn ?? destroyEphemeralRepo;
  const logger = deps.logger;

  logger?.info?.(
    `[janitor] Sweeping ${SANDBOX_DIR_PREFIX}* repos under ${owner} (ttl=${ttlHours}h, dryRun=${dryRun})`,
  );

  let stdout;
  try {
    stdout = ghFn([
      'repo',
      'list',
      owner,
      '--json',
      'name,owner,createdAt',
      '--limit',
      '1000',
    ]);
  } catch (err) {
    throw new Error(
      `[janitor] failed to list repos for ${owner}: ${err?.message ?? err}`,
    );
  }

  let repos;
  try {
    repos = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `[janitor] could not parse \`gh repo list\` output: ${err?.message ?? err}`,
    );
  }

  const candidates = filterLeakedRepos({
    repos: Array.isArray(repos) ? repos : [],
    owner,
    ttlHours,
    now,
  });

  if (candidates.length === 0) {
    logger?.info?.('[janitor] no leaked repos found — nothing to sweep.');
    return { candidates: [], deleted: [], failed: [], dryRun };
  }

  if (dryRun) {
    for (const c of candidates) {
      logger?.info?.(
        `[janitor] (dry-run) would delete ${c.repoFullName} (created ${c.createdAt}, age ${c.ageHours.toFixed(1)}h)`,
      );
    }
    return { candidates, deleted: [], failed: [], dryRun };
  }

  const deleted = [];
  const failed = [];
  for (const candidate of candidates) {
    try {
      const result = destroyFn(
        { repoFullName: candidate.repoFullName },
        { ghFn, logger },
      );
      if (result?.deleted) {
        deleted.push(candidate.repoFullName);
      } else {
        failed.push({
          repoFullName: candidate.repoFullName,
          error: result?.error ?? 'unknown delete failure',
        });
      }
    } catch (err) {
      // Defensive: destroyEphemeralRepo is itself best-effort and should not
      // throw on a delete failure, but a delete failure for ONE repo must
      // never abort the sweep of the rest regardless of how it surfaces.
      logger?.warn?.(
        `[janitor] delete failed for ${candidate.repoFullName} (continuing sweep): ${err?.message ?? err}`,
      );
      failed.push({
        repoFullName: candidate.repoFullName,
        error: err?.message ?? String(err),
      });
    }
  }

  logger?.info?.(
    `[janitor] swept ${deleted.length} repo(s), ${failed.length} failure(s), ${candidates.length} candidate(s) total.`,
  );

  return { candidates, deleted, failed, dryRun };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP_TEXT = `Usage: node bench/driver/janitor.js [options]

Sweep leaked bench-sbx-* ephemeral sandbox repos older than a TTL.

Options:
  --owner <owner>       GitHub owner/org to sweep. Defaults to $BENCH_SANDBOX_OWNER.
  --ttl-hours <hours>   Delete repos older than this many hours. Defaults to
                         $${TTL_HOURS_ENV_VAR}, or ${DEFAULT_TTL_HOURS} when unset.
  --dry-run             List what would be deleted without deleting anything.
  --help                Print this usage and exit 0 (no env vars required).
`;

/**
 * Parse the janitor CLI's flags. Pure — no env/process access.
 *
 * @param {string[]} argv
 * @returns {{ help: boolean, dryRun: boolean, owner: string|null, ttlHours: number|null }}
 */
export function parseJanitorCliArgs(argv = []) {
  const result = { help: false, dryRun: false, owner: null, ttlHours: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--owner') {
      result.owner = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--ttl-hours') {
      const raw = argv[i + 1];
      result.ttlHours = raw != null ? Number(raw) : null;
      i += 1;
    }
  }
  return result;
}

/**
 * Janitor CLI entry. `--help` prints usage and exits 0 WITHOUT requiring any
 * environment variable — help must always be reachable, even on a
 * completely unconfigured checkout.
 *
 * @param {string[]} [argv]  Defaults to `process.argv.slice(2)`.
 * @param {Record<string, string|undefined>} [env]  Defaults to `process.env`.
 * @param {{ logger?: object }} [deps]
 * @returns {Promise<number>} the process exit code.
 */
export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  deps = {},
) {
  const logger = deps.logger ?? {
    info: (m) => process.stderr.write(`${m}\n`),
    warn: (m) => process.stderr.write(`${m}\n`),
    error: (m) => process.stderr.write(`${m}\n`),
  };

  const args = parseJanitorCliArgs(argv);

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const owner = args.owner ?? env.BENCH_SANDBOX_OWNER;
  if (typeof owner !== 'string' || owner.length === 0) {
    logger.error(
      '[janitor] FATAL: missing owner — pass --owner <owner> or set BENCH_SANDBOX_OWNER.',
    );
    return 1;
  }

  const ttlHours =
    args.ttlHours ??
    (env[TTL_HOURS_ENV_VAR] != null
      ? Number(env[TTL_HOURS_ENV_VAR])
      : DEFAULT_TTL_HOURS);

  try {
    sweepLeakedRepos(
      { owner, ttlHours, dryRun: args.dryRun },
      { logger, ghFn: deps.ghFn, destroyFn: deps.destroyFn },
    );
  } catch (err) {
    logger.error(`[janitor] FATAL: ${err?.message ?? err}`);
    return 1;
  }
  return 0;
}

// Run when invoked directly (not when imported by tests or bench/run.js).
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().then((code) => {
    process.exitCode = code;
  });
}
