/**
 * dimension-judge-adapter.js — single batched LLM-judge cross-check for the
 * Maintainability and Security dimensions (Epic #32, Story #41).
 *
 * Issuing one judge call per dimension would double the LLM cost for every
 * benchmark run. This adapter issues ONE batched call that returns scores for
 * both dimensions together, matching the design contract in the Tech Spec
 * (§ Architecture: "one batched LLM-judge call per run").
 *
 * Return contract
 * ---------------
 *   { maintainability: number, security: number }  — both ∈ [0, 1]
 *   null                                           — judge did not run
 *
 * A null result is the expected value for the control arm (no acceptance
 * criteria, judge disabled) and for any run where the judgeTransport throws.
 * Callers — `computeMaintainability` and `computeSecurity` in
 * `bench/score/dimensions.js` — fold the 0.3 judge weight into the objective
 * spine when `judgeScore === null`, matching the Quality dimension's behaviour.
 *
 * Transport injection
 * -------------------
 * The function accepts a `judgeTransport` dependency so callers and tests can
 * substitute any function that implements the same call-and-return contract
 * without touching the real LLM or the signals ledger:
 *
 *   judgeTransport(prompt: string, opts: object): Promise<object | null>
 *
 * When `judgeTransport` is omitted, the production default reuses the
 * in-process `runAcceptanceEval` pattern from `acceptance-eval-adapter.js`,
 * constructing a synthetic verdict that the gate normalises into a 0.3-weight
 * score. The gate is always called with `emitSignal: false` so a benchmark
 * probe never writes to the live signals ledger.
 *
 * @module bench/scenarios/dimension-judge-adapter
 */

import fsDefault from 'node:fs';
import pathMod from 'node:path';

/** Directories skipped when collecting the delivered-source excerpt. */
const EXCERPT_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
]);

/** File extensions included in the delivered-source excerpt. */
const EXCERPT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.json',
]);

/** Filenames excluded from the excerpt (huge, low-signal). */
const EXCERPT_SKIP_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

/**
 * Recursively collect delivered-source file paths under `dir`, skipping hidden
 * directories (the overlaid framework tree — `.agents` / `.claude` / `.git`),
 * dependency/build output, and lockfiles, so the excerpt measures the delivered
 * app rather than the framework (the same confound the security scanner avoids).
 *
 * @param {string} dir
 * @param {Pick<typeof fsDefault, 'readdirSync'>} fsImpl
 * @param {string[]} out
 */
function collectExcerptFiles(dir, fsImpl, out) {
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (EXCERPT_SKIP_DIRS.has(entry.name)) continue;
    const full = pathMod.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectExcerptFiles(full, fsImpl, out);
    } else if (entry.isFile()) {
      if (EXCERPT_SKIP_FILES.has(entry.name)) continue;
      if (EXCERPT_EXTENSIONS.has(pathMod.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
}

/**
 * Collect a bounded, deterministic excerpt of the delivered source tree for the
 * dimension judge (Ticket #122, item 4). Files are read in sorted-path order
 * and concatenated with a per-file header until `maxChars` is reached, so the
 * judge has an independent observation of the code without any risk of blowing
 * the prompt on a large tree. All I/O runs through an injected `fsImpl` so the
 * unit test exercises it without touching disk.
 *
 * @param {string} workspacePath — absolute path of the delivered workspace.
 * @param {object} [ports]
 * @param {Pick<typeof fsDefault, 'readdirSync'|'readFileSync'>} [ports.fsImpl]
 * @param {number} [ports.maxChars]  Character bound (default DEFAULT_SOURCE_EXCERPT_MAX_CHARS).
 * @returns {string} the bounded excerpt (empty string when nothing is readable).
 */
export function collectSourceExcerpt(workspacePath, ports = {}) {
  const fsImpl = ports.fsImpl ?? fsDefault;
  const maxChars =
    typeof ports.maxChars === 'number' && ports.maxChars > 0
      ? ports.maxChars
      : DEFAULT_SOURCE_EXCERPT_MAX_CHARS;
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    return '';
  }
  const files = [];
  collectExcerptFiles(workspacePath, fsImpl, files);
  files.sort();
  let out = '';
  for (const fp of files) {
    if (out.length >= maxChars) break;
    let text;
    try {
      text = fsImpl.readFileSync(fp, 'utf8');
    } catch {
      continue;
    }
    if (typeof text !== 'string') continue;
    const rel = pathMod.relative(workspacePath, fp) || pathMod.basename(fp);
    const header = `\n// ===== ${rel} =====\n`;
    const budget = maxChars - out.length;
    if (budget <= header.length) break;
    out += header + text.slice(0, budget - header.length);
  }
  return out.trim();
}

/**
 * Clamp `v` into [0, 1]. Returns 0 for non-finite inputs.
 *
 * @param {unknown} v
 * @returns {number}
 */
function clamp01(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Default upper bound on the delivered-source excerpt fed to the judge, in
 * characters. Bounds the prompt so a large delivered tree can never blow the
 * judge call's context; ~16 KB is enough for the judge to independently
 * observe the shape of a small scenario app.
 */
export const DEFAULT_SOURCE_EXCERPT_MAX_CHARS = 16000;

/**
 * Build the batched judge prompt from collected sub-signals AND a bounded
 * excerpt of the delivered source tree.
 *
 * The prompt is structured so a compact LLM response can be parsed without
 * ambiguity: it requests exactly two JSON fields (`maintainability` and
 * `security`), each a float in [0, 1], and no surrounding prose.
 *
 * **Independent observation (Ticket #122, item 4).** Feeding the judge only
 * the spine's own sub-signal JSON gave it ZERO independent observation — it
 * re-scored the booleans the spine already computed, producing a near-constant
 * 0.28–0.35 (it even "graded" hello-world on password-hashing MUSTs). A bounded
 * excerpt of the delivered source (or diff) is now included so the judge has
 * something observable to correlate its score with. The excerpt is
 * size-bounded by the caller (see `buildSourceExcerpt`); an empty/absent
 * excerpt simply omits the section (back-compat with callers that pass none).
 *
 * @param {object} args
 * @param {object} args.maintainabilitySignals  — output of collectMaintainabilitySignals.
 * @param {object} args.securitySignals         — output of collectSecuritySignals.
 * @param {string} [args.sourceExcerpt]         — bounded delivered-source excerpt.
 * @param {string} [args.rubric]                — optional rubric override (tests).
 * @returns {string} The judge prompt string.
 */
export function buildJudgePrompt({
  maintainabilitySignals,
  securitySignals,
  sourceExcerpt,
  rubric,
}) {
  const defaultRubric = [
    'You are an independent code-quality judge for the Mandrel self-benchmark.',
    'Rate the following workspace on two dimensions based on the provided',
    'static sub-signals AND the delivered source excerpt below (your own',
    'independent observation of the code — do not merely restate the signals).',
    'Your output MUST be a single JSON object with exactly two keys:',
    '"maintainability" and "security", each a float in [0, 1].',
    'Do not include any prose, explanation, or extra keys.',
    '',
    'Rubric:',
    '  maintainability — 1.0 is exemplary (low lint density, full test pyramid,',
    '    low complexity, zero dead code, rich docs); 0.0 is unmaintainable.',
    '  security — 1.0 means all security-baseline MUSTs are present with no',
    '    detected secrets or known vulnerabilities; 0.0 is critically insecure.',
  ].join('\n');

  const mSigs = JSON.stringify(maintainabilitySignals ?? {}, null, 2);
  const sSigs = JSON.stringify(securitySignals ?? {}, null, 2);

  const excerpt =
    typeof sourceExcerpt === 'string' && sourceExcerpt.trim().length > 0
      ? sourceExcerpt
      : null;

  return [
    rubric ?? defaultRubric,
    '',
    '## Maintainability sub-signals',
    '```json',
    mSigs,
    '```',
    '',
    '## Security sub-signals',
    '```json',
    sSigs,
    '```',
    ...(excerpt
      ? [
          '',
          '## Delivered source (bounded excerpt — your independent observation)',
          '```',
          excerpt,
          '```',
        ]
      : []),
    '',
    'Respond with only the JSON object, e.g.:',
    '{"maintainability": 0.85, "security": 0.72}',
  ].join('\n');
}

/**
 * Parse a judge response string into `{ maintainability, security }`.
 *
 * Tolerates surrounding prose by scanning for the first balanced `{…}` block
 * that contains both required keys.
 *
 * @param {string | object | null | undefined} raw
 * @returns {{ maintainability: number, security: number } | null}
 */
export function parseJudgeResponse(raw) {
  if (raw === null || raw === undefined) return null;

  // If the transport already returned an object, use it directly.
  if (typeof raw === 'object') {
    const m = raw.maintainability;
    const s = raw.security;
    if (
      typeof m === 'number' &&
      Number.isFinite(m) &&
      typeof s === 'number' &&
      Number.isFinite(s)
    ) {
      return { maintainability: clamp01(m), security: clamp01(s) };
    }
    return null;
  }

  if (typeof raw !== 'string' || raw.length === 0) return null;

  // Try the simplest path first: the whole string is valid JSON.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const m = parsed.maintainability;
      const s = parsed.security;
      if (typeof m === 'number' && typeof s === 'number') {
        return { maintainability: clamp01(m), security: clamp01(s) };
      }
    }
  } catch {
    // fall through to scan
  }

  // Scan for the last balanced JSON object in the string (tolerates prose).
  const start = raw.lastIndexOf('\n{');
  const candidate = start >= 0 ? raw.slice(start + 1) : null;
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        const m = parsed.maintainability;
        const s = parsed.security;
        if (typeof m === 'number' && typeof s === 'number') {
          return { maintainability: clamp01(m), security: clamp01(s) };
        }
      }
    } catch {
      // fall through
    }
  }

  // Last resort: scan from first `{` to last `}`.
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open >= 0 && close > open) {
    try {
      const parsed = JSON.parse(raw.slice(open, close + 1));
      if (parsed && typeof parsed === 'object') {
        const m = parsed.maintainability;
        const s = parsed.security;
        if (typeof m === 'number' && typeof s === 'number') {
          return { maintainability: clamp01(m), security: clamp01(s) };
        }
      }
    } catch {
      // fall through
    }
  }

  return null;
}

/**
 * No-op default judge transport.
 *
 * The production harness wires a real LLM transport here (e.g. `claude -p`
 * via the existing usage-envelope pattern). The default stub returns null so
 * that the adapter gracefully degrades — the 0.3 judge weight folds into the
 * objective spine — when no transport is injected (e.g. the control arm or
 * environments without a model API key).
 *
 * @returns {Promise<null>}
 */
async function defaultJudgeTransport(_prompt, _opts) {
  return null;
}

/**
 * Run the single batched LLM-judge cross-check for the Maintainability and
 * Security dimensions.
 *
 * Issues ONE judge call (not one per dimension) and returns the two cross-check
 * scores together. A null return value means the judge did not run; callers
 * fold the 0.3 judge weight into their objective spine in that case.
 *
 * @param {object} args
 * @param {object} args.maintainabilitySignals
 *   Sub-signals from `collectMaintainabilitySignals` (maintainability-adapter).
 * @param {object} args.securitySignals
 *   Sub-signals from `collectSecuritySignals` (security-adapter).
 * @param {string} [args.sourceExcerpt]
 *   Bounded excerpt of the delivered source tree so the judge has an
 *   independent observation to score against (Ticket #122, item 4). Omitted /
 *   empty ⇒ the excerpt section is left off the prompt.
 * @param {object} [deps]
 *   Injectable dependencies for testing.
 * @param {(prompt: string, opts?: object) => Promise<object | string | null>} [deps.judgeTransport]
 *   Async function that calls the judge and returns its response. Defaults to a
 *   no-op that returns null (judge-disabled path, control arm).
 * @param {(args: object) => string} [deps.buildPromptFn]
 *   Prompt builder — injectable for unit tests that verify prompt structure.
 * @param {(raw: unknown) => object | null} [deps.parseResponseFn]
 *   Response parser — injectable for unit tests.
 * @returns {Promise<{ maintainability: number, security: number } | null>}
 */
export async function runDimensionJudge(
  { maintainabilitySignals, securitySignals, sourceExcerpt },
  deps = {},
) {
  const judgeTransport = deps.judgeTransport ?? defaultJudgeTransport;
  const buildPromptFn = deps.buildPromptFn ?? buildJudgePrompt;
  const parseResponseFn = deps.parseResponseFn ?? parseJudgeResponse;

  const prompt = buildPromptFn({
    maintainabilitySignals,
    securitySignals,
    sourceExcerpt,
  });

  let raw;
  try {
    raw = await judgeTransport(prompt, { emitSignal: false });
  } catch {
    // Any transport failure is treated as "judge did not run".
    return null;
  }

  // A transport that returns null/undefined signals "did not run".
  if (raw === null || raw === undefined) return null;

  const scores = parseResponseFn(raw);
  return scores; // null when parsing fails — treated as "did not run"
}
