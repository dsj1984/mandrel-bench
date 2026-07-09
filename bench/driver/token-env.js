// bench/driver/token-env.js
//
// Leaf util: sanitize the GitHub token environment handed to a `gh` subprocess.
// Internal tooling only — never shipped in the distributed `.agents/` bundle.
//
// This is a NEUTRAL leaf (no sandbox / filer / I-O imports) so both the driver
// sandbox lifecycle (bench/driver/sandbox.js) and the feedback filer
// (bench/feedback/file.js) can bind their own token WITHOUT the filer's load
// graph pulling in the 900-line sandbox module (M10). It exposes two bindings
// with DELIBERATELY DIFFERENT credential preferences (M8):
//
//   - sanitizeGitHubTokenEnv  — the SANDBOX binding: BENCH_GITHUB_TOKEN (the
//     harness's own destructive-scope PAT) WINS over any ambient GH_TOKEN. This
//     is what the ephemeral per-cell sandbox repo lifecycle needs.
//   - sanitizeFeedbackTokenEnv — the FILER binding: FEEDBACK_GITHUB_TOKEN →
//     GH_TOKEN (falling back to an already-set GH_TOKEN), and NEVER inheriting
//     BENCH_GITHUB_TOKEN — so the cross-repo issue filer can never silently use
//     the destructive sandbox PAT for issue writes, even if it happens to be
//     exported in the same environment.
//
// A trailing `\r` on a token (e.g. a `.env` saved with CRLF line endings) makes
// `gh` fail with `net/http: invalid header field value for "Authorization"`, so
// both bindings whitespace-strip the token keys before `gh` ever sees them.
// GitHub tokens never contain whitespace, so stripping it is always safe.

/** The token env keys `gh` reads for auth (in its own precedence order). */
const GH_TOKEN_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'];

/**
 * Strip all whitespace from the `gh`-read token keys in-place on a copied env.
 *
 * @param {Record<string, string|undefined>} out
 * @returns {void}
 */
function stripTokenWhitespace(out) {
  for (const key of GH_TOKEN_KEYS) {
    const v = out[key];
    if (typeof v === 'string' && v.length > 0) {
      out[key] = v.replace(/\s/g, '');
    }
  }
}

/**
 * SANDBOX binding. Returns a shallow copy of `env` with the token keys
 * whitespace-stripped; when `BENCH_GITHUB_TOKEN` (the harness's own credential —
 * README / `.env.example` / docs/architecture.md §7) is present it WINS: its
 * whitespace-stripped value is written into `GH_TOKEN`, taking precedence over
 * whatever ambient `GH_TOKEN`/`GITHUB_TOKEN` the operator's shell or `gh auth
 * login` session carries. Without this, `gh` silently falls back to that ambient
 * session, which may be broader-scoped than the operator intended for this
 * harness (Epic #65 audit remediation). Unset / empty tokens are left untouched
 * so a clean `gh` keyring auth still applies when `BENCH_GITHUB_TOKEN` is unset.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {NodeJS.ProcessEnv}
 */
export function sanitizeGitHubTokenEnv(env = process.env) {
  const out = { ...env };
  stripTokenWhitespace(out);
  const benchToken = out.BENCH_GITHUB_TOKEN;
  if (typeof benchToken === 'string' && benchToken.length > 0) {
    out.GH_TOKEN = benchToken.replace(/\s/g, '');
  }
  return out;
}

/**
 * FILER binding (M8). Returns a shallow copy of `env` with the token keys
 * whitespace-stripped and `GH_TOKEN` bound EXPLICITLY to the feedback
 * credential: when `FEEDBACK_GITHUB_TOKEN` is present and non-empty its
 * whitespace-stripped value is written into `GH_TOKEN`; otherwise an
 * already-set `GH_TOKEN` is kept as-is. It DELIBERATELY does not consult
 * `BENCH_GITHUB_TOKEN`, so the cross-repo issue filer can never silently
 * authenticate with the destructive sandbox PAT. Unset / empty tokens are left
 * untouched so a clean `gh` keyring auth still applies when no feedback token is
 * configured (the graceful-degradation path).
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {NodeJS.ProcessEnv}
 */
export function sanitizeFeedbackTokenEnv(env = process.env) {
  const out = { ...env };
  stripTokenWhitespace(out);
  const feedbackToken = out.FEEDBACK_GITHUB_TOKEN;
  if (typeof feedbackToken === 'string' && feedbackToken.length > 0) {
    out.GH_TOKEN = feedbackToken.replace(/\s/g, '');
  }
  return out;
}
