// bench/feedback/derive-cli.js
//
// Standalone finding-derivation entrypoint for the Mandrel self-benchmark
// harness (Epic #85, Story #91). Internal tooling only — never shipped in the
// distributed `.agents/` bundle, never run against the live repo.
//
// This is the seam the Epic #84 CI aggregate job
// (.github/workflows/benchmark.yml) calls AFTER it has merged a cohort's
// scorecards into the results tree and rendered its report. It:
//
//   1. reads the results tree into one flat corpus (bench/report/aggregate.js),
//   2. resolves the TARGET cohort triple (from --model / --framework-version /
//      --benchmark-version, or auto-selects when the tree holds exactly one),
//   3. derives the four Phase-4 finding classes for that cohort
//      (bench/feedback/derive.js) — each carrying the cohort triple, noise-band
//      evidence, a stable fingerprint, and report/scorecard links, and
//   4. writes TWO outputs beside the cohort report:
//        a. a machine-readable finding-envelope JSON (for the filing engine),
//        b. a Markdown findings section (for embedding in the results-PR body).
//
// It imports NONE of bench/run.js, so it can derive findings from a results tree
// but can never launch a benchmark session. Every filesystem touch is behind an
// injectable port, so the whole CLI is exercised by the unit suite with no real
// disk and no network.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  defaultCliLogger,
  runIfMain,
  sanitizeIdent,
} from '../driver/cli-shell.js';
import { aggregateScorecards } from '../report/aggregate.js';
import { cohortSegments } from '../report/cohort-path.js';
import {
  cohortTripleKey,
  cohortTriplesOf,
  deriveFindings,
  renderFindingsMarkdown,
} from './derive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the single target cohort triple from the corpus, narrowed by whatever
 * cohort fields the caller pinned. Returns `{ triple }` on a unique match, or
 * `{ error }` when the selection is empty or ambiguous — the caller turns an
 * error into a non-zero exit. Pure.
 *
 * @param {object} args
 * @param {Array<object>} args.corpus
 * @param {string|null} args.model
 * @param {string|null} args.frameworkVersion
 * @param {string|null} args.benchmarkVersion
 * @returns {{ triple: object }|{ error: string }}
 */
export function resolveTargetCohort({
  corpus,
  model,
  frameworkVersion,
  benchmarkVersion,
}) {
  const triples = cohortTriplesOf(corpus);
  if (triples.length === 0) {
    return { error: 'no scorecards found in the results tree' };
  }
  const matches = triples.filter(
    (t) =>
      (model == null || t.model === model) &&
      (frameworkVersion == null || t.frameworkVersion === frameworkVersion) &&
      (benchmarkVersion == null || t.benchmarkVersion === benchmarkVersion),
  );
  if (matches.length === 1) return { triple: matches[0] };
  if (matches.length === 0) {
    return {
      error:
        'no cohort matches the requested (model, framework-version, ' +
        'benchmark-version) selection',
    };
  }
  const keys = matches.map((t) => cohortTripleKey(t)).sort();
  return {
    error:
      `the results tree holds ${matches.length} cohorts (${keys.join('; ')}); ` +
      'pin --model / --framework-version / --benchmark-version to select one',
  };
}

/**
 * Compute the results-root-RELATIVE report + scorecard links for a cohort. The
 * links are relative so they resolve correctly wherever the results tree is
 * checked out (e.g. inside the results PR). Pure.
 *
 * @param {object} args
 * @param {{ model: string, frameworkVersion: string }} args.triple
 * @param {string} args.stamp
 * @returns {{ report: string, scorecards: string }}
 */
export function cohortLinks({ triple, stamp }) {
  const { modelSlug, frameworkVersion } = cohortSegments({
    model: { id: triple.model },
    frameworkVersion: triple.frameworkVersion,
  });
  const base = path.posix.join(modelSlug, frameworkVersion);
  return {
    report: path.posix.join(base, 'reports', `report-${stamp}.md`),
    scorecards: path.posix.join(base, 'scorecards.ndjson'),
  };
}

/**
 * Parse the derive CLI args.
 *
 * @param {string[]} [argv]
 * @returns {object}
 */
export function parseDeriveCliArgs(argv = []) {
  const result = {
    help: false,
    resultsDir: null,
    stamp: null,
    model: null,
    frameworkVersion: null,
    benchmarkVersion: null,
    envelopeOut: null,
    prBodyOut: null,
    method: 'iqr',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--results-dir') {
      result.resultsDir = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--stamp') {
      result.stamp = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--model') {
      result.model = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--framework-version') {
      result.frameworkVersion = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--benchmark-version') {
      result.benchmarkVersion = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--envelope-out') {
      result.envelopeOut = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--pr-body-out') {
      result.prBodyOut = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--method') {
      result.method = argv[i + 1] ?? 'iqr';
      i += 1;
    }
  }
  return result;
}

const HELP_TEXT = `Usage: node bench/feedback/derive-cli.js [options]

Derive the four Phase-4 feedback finding classes for one cohort from a results
tree, then write a machine-readable finding-envelope JSON and a Markdown findings
section beside the cohort report. Never invokes a benchmark run.

Options:
  --results-dir <path>         Results-tree root (default: <repo>/results).
  --stamp <id>                 Report/output-filename stamp (default: the CI run
                               id, else a UTC timestamp).
  --model <id>                 Pin the target cohort's model id.
  --framework-version <ver>    Pin the target cohort's framework version.
  --benchmark-version <ver>    Pin the target cohort's benchmark version.
  --envelope-out <path>        Finding-envelope JSON path (default: beside the
                               cohort report at reports/findings-<stamp>.json).
  --pr-body-out <path>         Markdown findings-section path (default: beside
                               the cohort report at reports/findings-<stamp>.md).
  --method <iqr|ci>            Noise-band method (default: iqr).
  -h, --help                   Print this help and exit 0.
`;

/**
 * Derive CLI entry. Reads the results tree, resolves the target cohort, derives
 * findings, writes the envelope + PR-body Markdown, and prints a JSON summary —
 * every effect behind an injectable port, so no real run is launched and the
 * unit suite exercises it with no disk.
 *
 * @param {string[]} [argv]
 * @param {Record<string, string|undefined>} [env]
 * @param {object} [deps]
 * @returns {Promise<number>}  The process exit code.
 */
export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  deps = {},
) {
  const logger = deps.logger ?? defaultCliLogger();
  const write = deps.write ?? ((s) => process.stdout.write(s));
  const now = deps.now ?? (() => new Date().toISOString());
  const writeFile = deps.writeFileImpl ?? writeFileSync;
  const mkdir = deps.mkdirImpl ?? ((p) => mkdirSync(p, { recursive: true }));
  const args = parseDeriveCliArgs(argv);

  if (args.help) {
    write(HELP_TEXT);
    return 0;
  }

  const sourceRoot = deps.sourceRoot ?? path.resolve(__dirname, '..', '..');
  const resultsDir =
    args.resultsDir ?? deps.resultsDir ?? path.join(sourceRoot, 'results');
  const generatedAt = now();
  const stamp = sanitizeIdent(args.stamp ?? env.GITHUB_RUN_ID ?? generatedAt);

  let summary;
  try {
    const corpus = aggregateScorecards({ resultsDir }, deps.aggregateDeps);
    const resolved = resolveTargetCohort({
      corpus,
      model: args.model,
      frameworkVersion: args.frameworkVersion,
      benchmarkVersion: args.benchmarkVersion,
    });
    if (resolved.error) {
      logger.error(`[derive-cli] FATAL: ${resolved.error}`);
      return 1;
    }
    const cohort = resolved.triple;

    const links = cohortLinks({ triple: cohort, stamp });
    const envelope = deriveFindings({
      corpus,
      cohort,
      method: args.method,
      links,
      generatedAt,
    });
    const markdown = renderFindingsMarkdown(envelope);

    const { modelSlug, frameworkVersion } = cohortSegments({
      model: { id: cohort.model },
      frameworkVersion: cohort.frameworkVersion,
    });
    const reportsDir = path.join(
      resultsDir,
      modelSlug,
      frameworkVersion,
      'reports',
    );
    const envelopePath =
      args.envelopeOut ?? path.join(reportsDir, `findings-${stamp}.json`);
    const prBodyPath =
      args.prBodyOut ?? path.join(reportsDir, `findings-${stamp}.md`);

    mkdir(path.dirname(envelopePath));
    writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`);
    mkdir(path.dirname(prBodyPath));
    writeFile(prBodyPath, markdown);

    logger.info(
      `[derive-cli] derived ${envelope.findings.length} finding(s) for cohort ` +
        `${cohortTripleKey(cohort)} → ${envelopePath}`,
    );

    summary = {
      resultsDir,
      stamp,
      cohort,
      previousComparableCohort: envelope.previousComparableCohort,
      counts: envelope.counts,
      findingCount: envelope.findings.length,
      envelopePath,
      prBodyPath,
    };
  } catch (err) {
    logger.error(`[derive-cli] FATAL: ${err?.message ?? err}`);
    return 1;
  }

  write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

// Run when invoked directly (not when imported by tests).
runIfMain(import.meta.url, () => {
  main().then((code) => {
    process.exitCode = code;
  });
});
