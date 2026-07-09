// bench/feedback/file.js
//
// Fingerprint-deduplicated issue filer for the Mandrel self-benchmark feedback
// loop (Epic #85, Story #92). Internal tooling only — never shipped in the
// distributed `.agents/` bundle, never run against the live repo except through
// this deliberate, deduplicated write path.
//
// This is the LAST stage of the Phase-4 feedback loop. Story #91 derived
// evidence-carrying findings from a results corpus and persisted them as a
// finding-envelope JSON (bench/feedback/derive-cli.js); THIS module consumes
// that envelope and mechanically turns each finding into a routable write onto
// the `dsj1984/mandrel` repo — a fresh issue on a first sighting, or a dated
// cohort comment on a recurrence — so the benchmark's signal reaches the
// framework backlog without ever spamming it.
//
// Dedup identity: every finding carries a STABLE 16-hex fingerprint
// (bench/feedback/fingerprint.js) that EXCLUDES the cohort triple, so the same
// finding seen under a later cohort collides onto one fingerprint. The filer
// stamps that fingerprint as an HTML-comment MARKER in the issue body, then, on
// a later run, matches it by LISTING the repo's open `bench-feedback` issues and
// scanning their bodies CLIENT-SIDE.
//
// CRITICAL — why LIST + client-side match, NOT GitHub issue search: the GitHub
// search tokenizer does not index HTML-comment text, so a `search`-based lookup
// for the marker (`gh search issues '<!-- bench-feedback:fp=… -->'`) matches
// NOTHING against a real repo even though it passes a naive mocked test. That is
// the exact bug Epic #85's pre-mortem flagged. We therefore fetch the candidate
// issues with `gh issue list --json body` and do the marker match in JS.
//
// Idempotency is per (fingerprint × cohort): a fingerprint hit whose thread
// (issue body OR any comment) already carries THIS cohort's marker is a no-op,
// so re-running the filer against an already-filed cohort writes nothing.
//
// SECURITY (mirrors bench/driver/sandbox.js): every `gh` invocation goes through
// an INJECTABLE port that runs `execFileSync('gh', argsArray, …)` with a
// token-sanitized environment — an argument ARRAY, never a shell string, so a
// finding subject, cohort value, or issue body can never be interpreted as a
// shell command. The port is injectable so the entire unit suite exercises the
// hit/miss/no-op/dry-run/degradation paths against a mocked port with NO live
// GitHub call.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { defaultCliLogger, runIfMain } from '../driver/cli-shell.js';
import { sanitizeFeedbackTokenEnv } from '../driver/token-env.js';
import { cohortTripleKey } from './derive.js';

/** The repo the feedback loop files against. */
export const DEFAULT_FEEDBACK_REPO = 'dsj1984/mandrel';

/** The label every feedback issue carries (the LIST filter + the create label). */
export const FEEDBACK_LABEL = 'bench-feedback';

/** The routing label a freshly-filed feedback issue also carries. */
export const FRAMEWORK_GAP_LABEL = 'meta::framework-gap';

/** Default `gh issue list --limit` ceiling for the candidate scan. */
const DEFAULT_LIST_LIMIT = 100;

/**
 * The stable per-finding IDENTITY marker embedded in a filed issue's body. It is
 * an HTML comment (invisible in rendered Markdown) carrying the finding's
 * cohort-independent fingerprint, so a later run can recognize the thread by
 * scanning issue bodies CLIENT-SIDE. Pure.
 *
 * @param {string} fingerprint  The finding's 16-hex fingerprint.
 * @returns {string}
 */
export function fingerprintMarker(fingerprint) {
  return `<!-- bench-feedback:fp=${fingerprint} -->`;
}

/**
 * The per-(fingerprint × cohort) marker. Present in the issue body on first
 * filing and appended in every recurrence comment, it is the idempotency key:
 * if a thread already carries this marker, the same cohort has already been
 * recorded and the filer no-ops. Pure.
 *
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} cohort
 * @returns {string}
 */
export function cohortMarker(cohort) {
  return `<!-- bench-feedback:cohort=${cohortTripleKey(cohort)} -->`;
}

/**
 * Default `gh` port: runs `gh <args>` via `execFileSync` (an argument array —
 * NEVER a shell string) with a token-sanitized environment. It binds
 * EXPLICITLY to the feedback credential ({@link sanitizeFeedbackTokenEnv}:
 * FEEDBACK_GITHUB_TOKEN → GH_TOKEN, else an already-set GH_TOKEN) and never
 * inherits the sandbox's BENCH_GITHUB_TOKEN-wins preference, so the cross-repo
 * filer can never silently authenticate with the destructive sandbox PAT (M8).
 * Exported with an injectable `execFileFn` so the binding is unit-testable
 * without spawning a real `gh` process.
 *
 * @param {string[]} args  argv passed to `gh`.
 * @param {{ execFileFn?: typeof execFileSync }} [deps]
 * @returns {string} `gh` stdout.
 */
export function defaultGhPort(args, { execFileFn = execFileSync } = {}) {
  return execFileFn('gh', args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: sanitizeFeedbackTokenEnv(),
  });
}

/**
 * Classify a thrown `gh` error as a cross-repo-write PERMISSION/scope failure —
 * the specific "the token cannot write issues on the target repo" degradation
 * the Story treats as non-fatal. Reads both the error message and any captured
 * `stderr` (`execFileSync` puts `gh`'s diagnostics there). Pure.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isScopeError(err) {
  const parts = [];
  if (err && typeof err === 'object') {
    if ('message' in err) parts.push(String(err.message ?? ''));
    if ('stderr' in err) parts.push(String(err.stderr ?? ''));
  } else {
    parts.push(String(err ?? ''));
  }
  const text = parts.join('\n');
  return /HTTP 403|\b403\b|Resource not accessible|does not have (?:the )?(?:correct )?permission|not have permission|must have (?:admin|write|push)|requires? .*scope|forbidden|SAML enforcement/i.test(
    text,
  );
}

/**
 * The human-readable name of the scope the degradation warning names when a
 * cross-repo write is refused.
 */
const MISSING_SCOPE_LABEL =
  'cross-repo issue write (the `repo` / `issues:write` scope on the target repo)';

/**
 * Render the ISSUE BODY for a first-sighting finding. Carries both markers (the
 * fingerprint identity + this cohort's marker), the cohort triple, the finding
 * summary, the noise-band evidence, and the report/scorecard links. Pure —
 * deterministic in its inputs. Deterministic ordering keeps re-derived bodies
 * byte-identical.
 *
 * @param {object} finding  One envelope finding.
 * @param {object} envelope  The finding envelope (for `method`).
 * @returns {string}
 */
export function renderFindingBody(finding, envelope) {
  const { cohort } = finding;
  const lines = [
    fingerprintMarker(finding.fingerprint),
    cohortMarker(cohort),
    '',
    `## ${finding.class} — ${finding.subject}`,
    '',
    finding.summary,
    '',
    '### Cohort',
    '',
    `- model: \`${cohort.model}\``,
    `- framework version: \`${cohort.frameworkVersion}\``,
    `- benchmark version: \`${cohort.benchmarkVersion}\``,
    `- fingerprint: \`${finding.fingerprint}\``,
    `- noise-band method: \`${envelope?.method ?? 'iqr'}\``,
    '',
    '### Noise-band evidence',
    '',
    '```json',
    JSON.stringify(finding.evidence ?? {}, null, 2),
    '```',
    '',
  ];

  const linkParts = renderLinkLines(finding.links);
  if (linkParts.length > 0) {
    lines.push('### Links', '', ...linkParts, '');
  }

  lines.push(
    '---',
    '',
    'Filed by the mandrel-bench feedback loop (`bench/feedback/file.js`). ' +
      'Recurrences of this finding under a later cohort append a comment below ' +
      'rather than opening a new issue.',
    '',
  );

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/**
 * Render the RECURRENCE COMMENT for a fingerprint hit under a not-yet-recorded
 * cohort. Leads with this cohort's marker (so the next run recognizes the cohort
 * as recorded) and carries the new cohort's numbers. Pure.
 *
 * @param {object} finding
 * @param {object} envelope
 * @returns {string}
 */
export function renderCohortComment(finding, envelope) {
  const { cohort } = finding;
  const lines = [
    cohortMarker(cohort),
    '',
    `### Recurred — cohort \`${cohortTripleKey(cohort)}\``,
    '',
    `Model **${cohort.model}** · framework \`${cohort.frameworkVersion}\` · ` +
      `benchmark \`${cohort.benchmarkVersion}\`.`,
    '',
    finding.summary,
    '',
    '```json',
    JSON.stringify(finding.evidence ?? {}, null, 2),
    '```',
    '',
  ];

  const linkParts = renderLinkLines(finding.links);
  if (linkParts.length > 0) {
    lines.push(...linkParts, '');
  }
  lines.push(`Noise-band method: \`${envelope?.method ?? 'iqr'}\`.`, '');

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/**
 * The issue TITLE for a first-sighting finding. Pure.
 *
 * @param {object} finding
 * @returns {string}
 */
export function renderFindingTitle(finding) {
  const where = finding.scenario ? ` · ${finding.scenario}` : '';
  return `[bench-feedback] ${finding.class}: ${finding.subject}${where} (${finding.fingerprint})`;
}

/**
 * Render the `- [report](…) · [scorecards](…)` link lines for a finding, or an
 * empty array when the finding carries neither link. Pure.
 *
 * @param {{ report: string|null, scorecards: string|null }} [links]
 * @returns {string[]}
 */
function renderLinkLines(links) {
  const parts = [];
  if (links?.report) parts.push(`[report](${links.report})`);
  if (links?.scorecards) parts.push(`[scorecards](${links.scorecards})`);
  return parts.length > 0 ? [`- ${parts.join(' · ')}`] : [];
}

/**
 * LIST the target repo's open `bench-feedback` issues, returning the parsed
 * array of `{ number, title, body }`. This is the client-side-match seam: we
 * pull candidate issues (NOT a marker search) and scan their bodies in JS.
 *
 * @param {(args: string[]) => string} gh  The injected gh port.
 * @param {{ repo: string, label: string, limit: number }} opts
 * @returns {Array<{ number: number, title: string, body: string }>}
 */
export function listFeedbackIssues(gh, { repo, label, limit }) {
  const out = gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--label',
    label,
    '--state',
    'open',
    '--json',
    'number,title,body',
    '--limit',
    String(limit),
  ]);
  const parsed = JSON.parse(out || '[]');
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Fetch a single issue's full thread — its body plus every comment body — so the
 * cohort-idempotency check can scan the whole thread, not just the issue body.
 *
 * @param {(args: string[]) => string} gh
 * @param {{ repo: string, number: number }} opts
 * @returns {{ body: string, comments: Array<{ body: string }> }}
 */
export function fetchIssueThread(gh, { repo, number }) {
  const out = gh([
    'issue',
    'view',
    String(number),
    '--repo',
    repo,
    '--json',
    'body,comments',
  ]);
  const parsed = JSON.parse(out || '{}');
  return {
    body: typeof parsed.body === 'string' ? parsed.body : '',
    comments: Array.isArray(parsed.comments) ? parsed.comments : [],
  };
}

/**
 * Whether a fetched thread already carries `marker` anywhere — the issue body or
 * any comment body. The idempotency predicate. Pure.
 *
 * @param {{ body: string, comments: Array<{ body: string }> }} thread
 * @param {string} marker
 * @returns {boolean}
 */
export function threadHasMarker(thread, marker) {
  if (typeof thread?.body === 'string' && thread.body.includes(marker)) {
    return true;
  }
  for (const comment of thread?.comments ?? []) {
    if (typeof comment?.body === 'string' && comment.body.includes(marker)) {
      return true;
    }
  }
  return false;
}

/**
 * File one finding: comment-on-hit, create-on-miss, no-op when this cohort is
 * already recorded on the hit thread. Returns the action taken. Throws only on a
 * scope error (surfaced to the caller, which degrades gracefully).
 *
 * @param {object} finding
 * @param {object} envelope
 * @param {object} ctx
 * @param {(args: string[]) => string} ctx.gh
 * @param {string} ctx.repo
 * @param {Array<{ number: number, body: string }>} ctx.openIssues
 * @param {{ info: Function, warn: Function }} ctx.logger
 * @returns {{ action: 'created'|'commented'|'noop', fingerprint: string, cohort: string, issue: number|null }}
 */
function fileOneFinding(finding, envelope, { gh, repo, openIssues, logger }) {
  const fpMarker = fingerprintMarker(finding.fingerprint);
  const cMarker = cohortMarker(finding.cohort);
  const cohortKey = cohortTripleKey(finding.cohort);

  // CLIENT-SIDE match: scan the listed issue bodies for the fingerprint marker.
  const hit = openIssues.find(
    (issue) => typeof issue.body === 'string' && issue.body.includes(fpMarker),
  );

  if (!hit) {
    // Miss → file a fresh, labeled issue carrying the finding body + markers.
    const title = renderFindingTitle(finding);
    const body = renderFindingBody(finding, envelope);
    const created = gh([
      'issue',
      'create',
      '--repo',
      repo,
      '--title',
      title,
      '--body',
      body,
      '--label',
      FEEDBACK_LABEL,
      '--label',
      FRAMEWORK_GAP_LABEL,
    ]);
    logger.info(
      `[file] created issue for ${finding.fingerprint} (${cohortKey}): ${String(created).trim()}`,
    );
    return {
      action: 'created',
      fingerprint: finding.fingerprint,
      cohort: cohortKey,
      issue: hit?.number ?? null,
    };
  }

  // Hit → fetch the full thread and check whether THIS cohort is already
  // recorded (body or any comment). If so, no-op (idempotent per fp × cohort).
  const thread = fetchIssueThread(gh, { repo, number: hit.number });
  if (threadHasMarker(thread, cMarker)) {
    logger.info(
      `[file] no-op: #${hit.number} already carries cohort ${cohortKey} for ${finding.fingerprint}`,
    );
    return {
      action: 'noop',
      fingerprint: finding.fingerprint,
      cohort: cohortKey,
      issue: hit.number,
    };
  }

  const body = renderCohortComment(finding, envelope);
  gh(['issue', 'comment', String(hit.number), '--repo', repo, '--body', body]);
  logger.info(
    `[file] commented recurrence on #${hit.number} for ${finding.fingerprint} (${cohortKey})`,
  );
  return {
    action: 'commented',
    fingerprint: finding.fingerprint,
    cohort: cohortKey,
    issue: hit.number,
  };
}

/**
 * File every finding in an envelope onto the target repo, deduplicated by
 * fingerprint marker (comment-on-hit, create-on-miss, no-op on an
 * already-recorded cohort). In `--dry-run` mode it prints the intended per-
 * finding actions and makes NO gh calls at all (not even the LIST). When a
 * cross-repo write is refused for lack of scope, it logs a loud non-fatal
 * degradation warning naming the missing scope and returns `degraded: true`
 * (the CLI exits 0).
 *
 * @param {object} opts
 * @param {object} opts.envelope  A `deriveFindings` envelope.
 * @param {string} [opts.repo=DEFAULT_FEEDBACK_REPO]
 * @param {string} [opts.label=FEEDBACK_LABEL]
 * @param {number} [opts.limit=DEFAULT_LIST_LIMIT]
 * @param {boolean} [opts.dryRun=false]
 * @param {object} [deps]
 * @param {(args: string[]) => string} [deps.gh]  The gh port (injected in tests).
 * @param {{ info: Function, warn: Function }} [deps.logger]
 * @returns {{ repo: string, dryRun: boolean, degraded: boolean, actions: object[] }}
 */
export function fileFindings(
  {
    envelope,
    repo = DEFAULT_FEEDBACK_REPO,
    label = FEEDBACK_LABEL,
    limit = DEFAULT_LIST_LIMIT,
    dryRun = false,
  } = {},
  deps = {},
) {
  if (!envelope || typeof envelope !== 'object') {
    throw new TypeError('fileFindings: an envelope object is required');
  }
  const findings = Array.isArray(envelope.findings) ? envelope.findings : [];
  const gh = deps.gh ?? defaultGhPort;
  const logger = deps.logger ?? defaultCliLogger();

  // Dry-run: describe the intended actions WITHOUT any gh call (not even LIST).
  if (dryRun) {
    const actions = findings.map((f) => {
      const cohortKey = cohortTripleKey(f.cohort);
      logger.info(
        `[file] (dry-run) would file ${f.fingerprint} (${cohortKey}) on ${repo}: ` +
          'comment if an existing bench-feedback issue carries this fingerprint ' +
          'marker (and this cohort is not yet recorded), else create a new ' +
          `\`${FEEDBACK_LABEL}\` + \`${FRAMEWORK_GAP_LABEL}\` issue.`,
      );
      return {
        action: 'planned',
        fingerprint: f.fingerprint,
        cohort: cohortKey,
        issue: null,
      };
    });
    return { repo, dryRun: true, degraded: false, actions };
  }

  if (findings.length === 0) {
    logger.info(`[file] envelope carries no findings — nothing to file.`);
    return { repo, dryRun: false, degraded: false, actions: [] };
  }

  const openIssues = listFeedbackIssues(gh, { repo, label, limit });
  const actions = [];
  for (const finding of findings) {
    try {
      actions.push(
        fileOneFinding(finding, envelope, { gh, repo, openIssues, logger }),
      );
    } catch (err) {
      if (isScopeError(err)) {
        logger.warn(
          `[file] ⚠️  DEGRADED: the GitHub token lacks ${MISSING_SCOPE_LABEL} ` +
            `on ${repo}. Skipping all remaining feedback writes. Grant that ` +
            `scope to file findings. (underlying error: ${err?.message ?? err})`,
        );
        return { repo, dryRun: false, degraded: true, actions };
      }
      throw err;
    }
  }

  return { repo, dryRun: false, degraded: false, actions };
}

/**
 * Parse the file CLI args.
 *
 * @param {string[]} [argv]
 * @returns {object}
 */
export function parseFileCliArgs(argv = []) {
  const result = {
    help: false,
    envelope: null,
    repo: DEFAULT_FEEDBACK_REPO,
    label: FEEDBACK_LABEL,
    limit: DEFAULT_LIST_LIMIT,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--envelope') {
      result.envelope = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--repo') {
      result.repo = argv[i + 1] ?? DEFAULT_FEEDBACK_REPO;
      i += 1;
    } else if (arg === '--label') {
      result.label = argv[i + 1] ?? FEEDBACK_LABEL;
      i += 1;
    } else if (arg === '--limit') {
      const n = Number.parseInt(argv[i + 1] ?? '', 10);
      result.limit = Number.isFinite(n) && n > 0 ? n : DEFAULT_LIST_LIMIT;
      i += 1;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    }
  }
  return result;
}

const HELP_TEXT = `Usage: node bench/feedback/file.js --envelope <path> [options]

Consume a persisted finding-envelope JSON (bench/feedback/derive-cli.js output)
and file each finding onto a GitHub repo, deduplicated by fingerprint marker:
comment-on-hit, create-on-miss, no-op when the (fingerprint × cohort) is already
recorded. Never uses GitHub issue SEARCH for the markers — it LISTS the repo's
open feedback issues and matches the fingerprint marker CLIENT-SIDE.

Options:
  --envelope <path>   Persisted finding-envelope JSON (required unless --help).
  --repo <owner/name> Target repo (default: ${DEFAULT_FEEDBACK_REPO}).
  --label <label>     Feedback label to list/apply (default: ${FEEDBACK_LABEL}).
  --limit <n>         gh issue list --limit ceiling (default: ${DEFAULT_LIST_LIMIT}).
  --dry-run           Print intended actions and make NO gh calls.
  -h, --help          Print this help and exit 0.
`;

/**
 * File CLI entry. Reads the envelope JSON, files its findings, and prints a JSON
 * summary. Every effect (fs read, gh) is behind an injectable port so the unit
 * suite exercises it with no real disk and NO live GitHub call.
 *
 * @param {string[]} [argv]
 * @param {Record<string, string|undefined>} [env]
 * @param {object} [deps]
 * @returns {Promise<number>}  The process exit code.
 */
export async function main(
  argv = process.argv.slice(2),
  _env = process.env,
  deps = {},
) {
  const logger = deps.logger ?? defaultCliLogger();
  const write = deps.write ?? ((s) => process.stdout.write(s));
  const readFile = deps.readFileImpl ?? ((p) => readFileSync(p, 'utf-8'));
  const args = parseFileCliArgs(argv);

  if (args.help) {
    write(HELP_TEXT);
    return 0;
  }

  if (!args.envelope) {
    logger.error('[file] FATAL: --envelope <path> is required');
    return 1;
  }

  let envelope;
  try {
    envelope = JSON.parse(readFile(args.envelope));
  } catch (err) {
    logger.error(
      `[file] FATAL: could not read/parse envelope ${args.envelope}: ${err?.message ?? err}`,
    );
    return 1;
  }

  let result;
  try {
    result = fileFindings(
      {
        envelope,
        repo: args.repo,
        label: args.label,
        limit: args.limit,
        dryRun: args.dryRun,
      },
      { gh: deps.gh, logger },
    );
  } catch (err) {
    logger.error(`[file] FATAL: ${err?.message ?? err}`);
    return 1;
  }

  write(`${JSON.stringify(result, null, 2)}\n`);
  // A degradation is NON-FATAL: exit 0 so a scope-limited token never fails CI.
  return 0;
}

// Run when invoked directly (not when imported by tests).
runIfMain(import.meta.url, () => {
  main().then((code) => {
    process.exitCode = code;
  });
});
