/**
 * pagination-bounds.js — BEHAVIOURAL trap-oracle for the `epic-scope`
 * scenario's `pagination-bounds` defect class (Story #156).
 *
 * ## Why this class exists
 *
 * The Story #156 trap-axis rebuild retired the entailed input-validation
 * trap (its positive signal — a 400 from a write endpoint — is logically entailed by
 * the frozen suite, so it could never be differential) and replaced it with
 * JUDGMENT-GRADIENT classes: properties a competent 2026 frontier model may
 * or may not think of, on surfaces the frozen suite does not assert. Hostile
 * paging parameters are exactly that. The frozen suite exercises `?page` and
 * `?pageSize` only on the happy path (`?page=1&pageSize=2`); what the app
 * does with `pageSize=0`, `page=-1`, `pageSize=100000`, or `page=abc` is
 * unasserted judgment — and each is a real failure mode (a 500, a nonsense
 * envelope a client cannot page through, or an unbounded result set a caller
 * can use to exhaust the server).
 *
 * ## Decision rule
 *
 * Against a project holding a known number of tasks, the probe issues every
 * hostile query in {@link HOSTILE_QUERIES} and fails the class when any of:
 *
 *   1. a hostile query returns 5xx (the parameter reached something that
 *      threw), or the app stops answering a well-formed query afterwards;
 *   2. a hostile query returns 2xx with a malformed envelope — `items` not an
 *      array, or `total`/`page`/`pageSize` not finite numbers (a `NaN` or
 *      `null` echo is a client-breaking response, not a bound);
 *   3. an absurd `pageSize` is honoured verbatim rather than rejected or
 *      clamped to at most {@link MAX_SANE_PAGE_SIZE};
 *   4. a non-positive `pageSize` is accepted and echoed back as non-positive.
 *
 * Rejecting a hostile value outright (4xx) is always clean — the probe scores
 * the JUDGMENT (reject or clamp), never a specific status code.
 *
 * An app that never boots, or whose task surface cannot be set up, reports
 * `null` (unmeasured). See `bench/scenarios/trap-probe-shared.js`.
 *
 * @module bench/scenarios/epic-scope/traps/pagination-bounds
 */

import {
  authenticate,
  isSuccess,
  measured,
  probeDeliveredApp,
  scenarioDirOf,
  unmeasured,
} from '../../trap-probe-shared.js';

const SCENARIO_DIR = scenarioDirOf(import.meta.url);

/** The epic-scope auth route contract (mirrors the seed prompt). */
export const AUTH_ROUTES = Object.freeze({
  registerPath: '/auth/register',
  loginPath: '/auth/login',
  tokenField: 'token',
});

/** Tasks seeded before paging, so `total` has something to bound. */
export const SEEDED_TASKS = 5;

/**
 * The largest `pageSize` an implementation may honour verbatim. Anything
 * above this must be rejected or clamped — honouring an arbitrary caller-
 * supplied page size is an unbounded-result-set foot-gun.
 */
export const MAX_SANE_PAGE_SIZE = 1000;

/** Hostile paging queries, each a `?…` suffix appended to the tasks path. */
export const HOSTILE_QUERIES = Object.freeze([
  '?page=0',
  '?page=-1',
  '?pageSize=0',
  '?pageSize=-5',
  '?pageSize=100000',
  '?page=abc&pageSize=abc',
]);

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Judge one hostile response. Pure — exposed so the discrimination test can
 * assert the decision rule without a server.
 *
 * @param {string} query — the hostile query string that produced the response.
 * @param {{ status: number, body: unknown }} res
 * @returns {string[]} failure reasons (empty ⇒ this response is clean).
 */
export function judgeHostileResponse(query, res) {
  const reasons = [];
  if (res.status >= 500) {
    reasons.push(`${query} → HTTP ${res.status} (the paging parameter threw)`);
    return reasons;
  }
  if (!isSuccess(res.status)) return reasons; // A rejection is a valid bound.

  const body = res.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.items)) {
    reasons.push(
      `${query} → HTTP ${res.status} with no \`items\` array (a 2xx that a client cannot page through)`,
    );
    return reasons;
  }
  for (const field of ['total', 'page', 'pageSize']) {
    if (!isFiniteNumber(body[field])) {
      reasons.push(
        `${query} → HTTP ${res.status} echoing a non-numeric \`${field}\` (${JSON.stringify(body[field])})`,
      );
    }
  }
  if (isFiniteNumber(body.pageSize)) {
    if (body.pageSize > MAX_SANE_PAGE_SIZE) {
      reasons.push(
        `${query} → an absurd page size was honoured verbatim (pageSize ${body.pageSize} > the ${MAX_SANE_PAGE_SIZE} sanity cap), neither rejected nor clamped`,
      );
    }
    if (body.pageSize <= 0) {
      reasons.push(
        `${query} → a non-positive page size was accepted and echoed back (pageSize ${body.pageSize})`,
      );
    }
  }
  if (isFiniteNumber(body.total) && body.items.length > body.total) {
    reasons.push(
      `${query} → returned ${body.items.length} items for a reported total of ${body.total}`,
    );
  }
  return reasons;
}

/**
 * Drive the hostile-paging probe against a running delivered app.
 *
 * @param {{ request: Function }} client
 * @returns {Promise<object>} a trap verdict.
 */
export async function paginationBoundsProbe(client) {
  const owner = await authenticate(client, AUTH_ROUTES);

  const created = await client.request('/projects', {
    method: 'POST',
    token: owner.token,
    body: { name: 'pagination-probe project' },
  });
  const projectId = created.body?.id;
  if (!isSuccess(created.status) || projectId === undefined) {
    return unmeasured(
      `the owner could not create a project (POST /projects → HTTP ${created.status}), so there is no paged collection to probe`,
    );
  }
  const tasksPath = `/projects/${encodeURIComponent(String(projectId))}/tasks`;

  for (let i = 0; i < SEEDED_TASKS; i += 1) {
    const res = await client.request(tasksPath, {
      method: 'POST',
      token: owner.token,
      body: { title: `pagination-probe task ${i + 1}` },
    });
    if (!isSuccess(res.status)) {
      return unmeasured(
        `the owner could not seed the task collection (POST ${tasksPath} → HTTP ${res.status})`,
      );
    }
  }

  // Baseline: the happy-path paged read must work, or a hostile-query verdict
  // would be measuring a broken route rather than a missing bound.
  const baseline = await client.request(`${tasksPath}?page=1&pageSize=2`, {
    token: owner.token,
  });
  if (!isSuccess(baseline.status) || !Array.isArray(baseline.body?.items)) {
    return unmeasured(
      `the paged task read does not work on the happy path (GET ${tasksPath}?page=1&pageSize=2 → HTTP ${baseline.status})`,
    );
  }

  const reasons = [];
  for (const query of HOSTILE_QUERIES) {
    const res = await client.request(`${tasksPath}${query}`, {
      token: owner.token,
    });
    reasons.push(...judgeHostileResponse(query, res));
  }

  // The app must still be serving well-formed requests afterwards.
  const after = await client.request(`${tasksPath}?page=1&pageSize=2`, {
    token: owner.token,
  });
  if (!isSuccess(after.status)) {
    reasons.push(
      `after the hostile queries the well-formed paged read no longer works (HTTP ${after.status})`,
    );
  }

  if (reasons.length > 0) {
    return measured({
      defectPresent: true,
      evidence: [
        'planted defect DETECTED behaviourally: hostile ?page/?pageSize values are neither rejected nor clamped',
        ...reasons,
      ],
    });
  }
  return measured({
    defectPresent: false,
    evidence: [
      `clean: all ${HOSTILE_QUERIES.length} hostile paging queries were rejected or clamped to a well-formed, bounded envelope, and the happy-path read still works`,
    ],
  });
}

/**
 * Boot the delivered app and probe it for the planted defect — the contract
 * `bench/scenarios/trap-runner.js` calls.
 *
 * @param {string} deliveredTreePath — absolute path to the delivered app tree.
 * @param {object} [ports] — see `probeDeliveredApp`; tests inject `app`.
 * @returns {Promise<{ score: 0|1|null, defectPresent: boolean|null, measured: boolean, evidence: string[] }>}
 */
export function evaluate(deliveredTreePath, ports = {}) {
  return probeDeliveredApp(deliveredTreePath, paginationBoundsProbe, {
    scenarioDir: SCENARIO_DIR,
    ...ports,
  });
}
