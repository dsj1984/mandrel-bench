/**
 * FROZEN acceptance oracle — `epic-scope` scenario (Story #184; evolves the
 * Epic #66/Story #78 suite).
 *
 * The objective Quality spine for the DECOMPOSITION value rung. The delivered
 * artifact is a COMPOSED system of four units sharing one on-disk store — a
 * store+migrations unit, an HTTP API, a background report worker, and an
 * admin CLI — and this oracle verifies the composition across all four seams
 * while importing nothing from the delivered source. It has no knowledge of
 * the app's storage engine, token-signing mechanism, ownership-check
 * implementation, or file layout. Its observation channels are exactly the
 * system's own operator-visible boundaries:
 *
 *   - HTTP against the running app (auth, projects, tasks, export jobs) —
 *     the same boundary the Epic #66 suite used;
 *   - the app-runner's real `restart` hook (persistence across a restart);
 *   - `npm run admin -- …` / `npm run migrate` executed IN the delivered
 *     workspace (the CLI and migration seams), via the `workspacePath` the
 *     harness threads into `deps` — the CLI's stdout and exit codes are the
 *     observed surface, never the delivered source.
 *
 * The worker seam is verified over HTTP: a report job must be CREATED
 * unfinished (the create response carries a status that is not yet
 * "completed") and must then COMPLETE within a bounded polling window with a
 * report whose task counts match what the suite created — which is only
 * possible when something besides the request handler finishes the job.
 *
 * This suite stays deliberately blind to the planted defects under
 * `../traps/`. Whether the persisted password is hashed, whether an
 * ownership check guards the id-addressed task routes this suite does not
 * sample, whether hostile paging parameters are bounded, whether a deleted
 * project's tasks are genuinely gone, whether a tampered bearer credential
 * is refused, or whether the token-signing key is read from the environment
 * versus inlined, is **invisible** at the boundaries above in the common
 * case — that is the whole point of the trap axis, and it is scored by the
 * SEPARATE adversarial trap-oracles, never here.
 *
 * Determinism notes:
 *   - Each run signs up unique, run-stamped usernames so the round-trip
 *     never collides with users left by a prior run against a reused store.
 *   - The round-trip is sequential and self-contained; the one bounded wait
 *     (the export-job poll) has an injectable clock/sleep so the unit face
 *     runs instantly.
 *   - CLI probes assert DELTAS (stats before vs after one HTTP write), so a
 *     store carrying prior data still scores deterministically.
 *
 * Two faces, mirroring the other oracles: a pure {@link evaluate} the
 * harness calls directly, and a skip-unless-`BENCH_APP_BASE_URL`
 * `node --test` case for standalone runs against a live app (the standalone
 * face reads the workspace for the CLI seams from `BENCH_APP_WORKSPACE`).
 *
 * @module bench/scenarios/epic-scope/acceptance.test
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

/** Stable scenario identifier this oracle scores. */
export const SCENARIO_ID = 'epic-scope';

/** Ceiling for one `npm run …` CLI invocation in the delivered workspace. */
export const CLI_TIMEOUT_MS = 60 * 1000;

/** Default ceiling for the export-job poll (the worker seam's bounded wait). */
export const EXPORT_POLL_TIMEOUT_MS = 20 * 1000;

/** Default interval between export-job polls. */
export const EXPORT_POLL_INTERVAL_MS = 500;

/**
 * Frozen acceptance criteria, in scenario-seed order.
 *
 * @type {ReadonlyArray<string>}
 */
export const CRITERIA = Object.freeze([
  'POST /auth/register with valid credentials responds 2xx with { id, username } and persists the user',
  'POST /auth/register with a duplicate username, or with missing or empty fields, is rejected with a 4xx status',
  'POST /auth/login with valid credentials responds 2xx with a bearer token',
  'POST /auth/login with an unknown username or wrong password is rejected as unauthenticated (401/403)',
  'Requests to a protected endpoint without a token, or with an invalid token, are rejected as unauthenticated (401/403)',
  'POST /projects with a valid name responds 2xx with the created project (id, name, ownerId, createdAt)',
  'POST /projects with an empty name is rejected with a 4xx status',
  "GET /projects returns a JSON array containing only the authenticated user's own projects, never another user's projects",
  'GET /projects/:id returns the matching project when owned by the authenticated user, and a 4xx (never the project) for an unknown id',
  'GET /projects/:id for a project owned by a different user is denied (403/404) without leaking the project',
  'DELETE /projects/:id removes the project and all its tasks (2xx); a subsequent GET no longer returns it',
  'DELETE /projects/:id for a project owned by a different user is denied (403/404) and leaves the project intact',
  'POST /projects/:projectId/tasks with a valid title responds 2xx with the task (id, title, projectId, createdAt, done: false)',
  'POST /projects/:projectId/tasks with a missing or empty title is rejected with a 4xx status',
  "POST /projects/:projectId/tasks against another user's project is denied (403/404)",
  'GET /projects/:projectId/tasks returns a paginated response { items, total, page, pageSize } respecting ?page and ?pageSize',
  'GET /projects/:projectId/tasks with a ?done=true or ?done=false filter returns only tasks matching that done value',
  'PATCH /projects/:projectId/tasks/:taskId updates title and/or done and returns the updated task',
  'DELETE /projects/:projectId/tasks/:taskId removes the task (2xx); the task list no longer includes it',
  'POST /projects/:projectId/exports responds 2xx with a job record carrying an id and a status that is not yet "completed", without the finished report',
  'GET /projects/:projectId/exports/:exportId reaches status "completed" within the polling window, with a report whose name and task counts (total, done) match the project',
  "POST /projects/:projectId/exports against another user's project is denied (403/404), and one user's export job is not readable by another user",
  'npm run admin -- stats prints a JSON object whose users, projects, and tasks counts reflect the data created over HTTP',
  'After npm run admin -- deactivate-user <username>, POST /auth/login for that user is rejected (401/403) while other users still log in',
  'npm run migrate exits 0, exits 0 again when re-run, and leaves existing data intact',
  'A syntactically malformed JSON request body is rejected with a 4xx status and the server keeps serving subsequent requests (no crash, no silent accept)',
  'Data for users, projects, tasks, and completed export jobs persists across a server restart',
]);

/**
 * Tolerant status matchers (prompt-realism cutover). The seed prompt states
 * GOALS rather than an exact status-code contract, so the oracle accepts any
 * status a competent engineer would defensibly choose for each semantic
 * outcome — while still failing hard on the outcomes themselves (a
 * cross-user leak, a wrong-password login, a crash).
 */
const isSuccess = (st) => st >= 200 && st < 300;
const isClientError = (st) => st >= 400 && st < 500;
const isAuthReject = (st) => st === 401 || st === 403;
const isDenied = (st) => st === 403 || st === 404;

/**
 * Join a base URL and a path without producing a double slash.
 *
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * A small result accumulator that records one criterion verdict and keeps
 * the criteria in scenario order regardless of probe ordering.
 */
class CriteriaLedger {
  constructor() {
    /** @type {Map<number, { index: number, criterion: string, met: boolean, evidence: string }>} */
    this.byIndex = new Map();
  }

  /**
   * @param {number} index
   * @param {boolean} met
   * @param {string} evidence
   */
  record(index, met, evidence) {
    this.byIndex.set(index, {
      index,
      criterion: CRITERIA[index],
      met: Boolean(met),
      evidence,
    });
  }

  /**
   * Any criterion never explicitly recorded (e.g. a probe threw before it
   * could run) is reported as unmet with the supplied reason, so the
   * harness always receives a complete, ordered criteria list.
   *
   * @param {string} reason
   * @returns {Array<{ index: number, criterion: string, met: boolean, evidence: string }>}
   */
  finalize(reason) {
    const out = [];
    for (let i = 0; i < CRITERIA.length; i += 1) {
      out.push(
        this.byIndex.get(i) ?? {
          index: i,
          criterion: CRITERIA[i],
          met: false,
          evidence: reason,
        },
      );
    }
    return out;
  }
}

/**
 * Best-effort JSON parse that never throws.
 *
 * @param {Response} res
 * @returns {Promise<unknown>}
 */
async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * Default CLI executor: run `npm <npmArgs…>` synchronously in the delivered
 * workspace. Injectable so the unit face never spawns a process.
 *
 * @param {string[]} npmArgs
 * @param {{ cwd: string, timeoutMs: number }} opts
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function defaultExecImpl(npmArgs, { cwd, timeoutMs }) {
  const res = spawnSync('npm', npmArgs, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: res.status,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
  };
}

/**
 * Extract the LAST JSON object from a blob of CLI stdout (npm may prepend
 * its own banner lines). Returns the parsed object or null.
 *
 * @param {string} text
 * @returns {object|null}
 */
export function parseLastJsonObject(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  // Fast path: a line that parses whole.
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // keep scanning
    }
  }
  // Slow path: widest brace-to-brace slice (a pretty-printed object).
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(text.slice(first, last + 1));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * Run the frozen multi-seam platform oracle against a running app instance.
 *
 * Drives a sequential auth → project → task round-trip for two independent
 * users (A and B) so cross-user isolation can be probed at every
 * id-addressed surface; then the export-job (worker seam), admin-CLI, and
 * migration probes; then cascade delete, a malformed-input robustness probe,
 * and persistence across a real restart. Never throws on an assertion
 * failure: a failed or unreachable endpoint becomes a `met: false` criterion
 * with concrete evidence.
 *
 * @param {string} baseUrl — base URL of the delivered app.
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl] — injectable fetch (tests).
 * @param {() => string} [deps.uniqueSuffix] — injectable unique-username
 *   source (tests); defaults to a timestamp+random token.
 * @param {(() => Promise<unknown>)|null} [deps.restart] — the app-runner's real
 *   restart hook (Ticket #122, item 5). When present, the persistence
 *   criterion tests survival across an ACTUAL server restart; when absent
 *   (the standalone `node --test` face has no process control) it degrades to
 *   an in-process re-login signal.
 * @param {string|null} [deps.workspacePath] — absolute path of the delivered
 *   workspace, threaded by the harness (bench/run.js) so the admin-CLI and
 *   migration seams can be exercised with `npm run …`. When absent AND no
 *   `execImpl` is injected, the CLI/migration criteria record unmet with an
 *   explicit no-workspace-access evidence line.
 * @param {(npmArgs: string[], opts: { cwd: string, timeoutMs: number }) => { status: number|null, stdout: string, stderr: string }} [deps.execImpl]
 *   — injectable `npm` executor (tests). Defaults to a real `spawnSync`.
 * @param {number} [deps.exportPollTimeoutMs]
 * @param {number} [deps.exportPollIntervalMs]
 * @param {(ms: number) => Promise<void>} [deps.sleepFn]
 * @returns {Promise<{
 *   scenario: string,
 *   passed: boolean,
 *   criteria: Array<{ index: number, criterion: string, met: boolean, evidence: string }>,
 * }>}
 */
export async function evaluate(
  baseUrl,
  {
    fetchImpl = fetch,
    uniqueSuffix = () =>
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    restart = null,
    workspacePath = null,
    execImpl = null,
    exportPollTimeoutMs = EXPORT_POLL_TIMEOUT_MS,
    exportPollIntervalMs = EXPORT_POLL_INTERVAL_MS,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new TypeError(
      'evaluate(baseUrl): baseUrl must be a non-empty string',
    );
  }

  const ledger = new CriteriaLedger();
  const suffixA = uniqueSuffix();
  const suffixB = uniqueSuffix();
  const usernameA = `bench-user-a-${suffixA}`;
  const passwordA = `bench-pass-a-${suffixA}`;
  const usernameB = `bench-user-b-${suffixB}`;
  const passwordB = `bench-pass-b-${suffixB}`;

  const jsonHeaders = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  const post = (body) => ({
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
  const authHeaders = (token) => ({
    headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
  });

  /**
   * Run one `npm <args…>` CLI invocation in the delivered workspace, or
   * report why the seam cannot be observed. Never throws.
   *
   * @param {string[]} npmArgs
   * @returns {{ ok: boolean, status: number|null, stdout: string, detail: string }}
   */
  const runCli = (npmArgs) => {
    const exec = execImpl ?? (workspacePath ? defaultExecImpl : null);
    if (!exec) {
      return {
        ok: false,
        status: null,
        stdout: '',
        detail:
          'no workspace access (deps.workspacePath not provided), so the CLI seam could not be observed',
      };
    }
    try {
      const res = exec(npmArgs, {
        cwd: workspacePath ?? '',
        timeoutMs: CLI_TIMEOUT_MS,
      });
      const status = typeof res?.status === 'number' ? res.status : null;
      return {
        ok: status === 0,
        status,
        stdout: typeof res?.stdout === 'string' ? res.stdout : '',
        detail: `npm ${npmArgs.join(' ')} → exit ${status}`,
      };
    } catch (err) {
      return {
        ok: false,
        status: null,
        stdout: '',
        detail: `npm ${npmArgs.join(' ')} could not run: ${err?.message ?? err}`,
      };
    }
  };

  try {
    // ---- Criterion 0 — POST /auth/register (valid, user A) → 2xx ---------
    {
      const res = await fetchImpl(
        joinUrl(baseUrl, '/auth/register'),
        post({ username: usernameA, password: passwordA }),
      );
      const payload = await safeJson(res);
      const hasId =
        payload != null && typeof payload === 'object' && 'id' in payload;
      const usernameOk =
        payload != null &&
        typeof payload === 'object' &&
        payload.username === usernameA;
      ledger.record(
        0,
        isSuccess(res.status) && hasId && usernameOk,
        `POST /auth/register (A) → HTTP ${res.status}; id=${hasId}; username match=${usernameOk}`,
      );
    }

    // ---- Criterion 1 — duplicate + missing/empty fields → 4xx -------------
    {
      const dupRes = await fetchImpl(
        joinUrl(baseUrl, '/auth/register'),
        post({ username: usernameA, password: passwordA }),
      );
      await safeJson(dupRes);
      const emptyRes = await fetchImpl(
        joinUrl(baseUrl, '/auth/register'),
        post({ username: '', password: '' }),
      );
      await safeJson(emptyRes);
      ledger.record(
        1,
        isClientError(dupRes.status) && isClientError(emptyRes.status),
        `POST /auth/register duplicate → HTTP ${dupRes.status}; empty fields → HTTP ${emptyRes.status} (both expected a 4xx rejection)`,
      );
    }

    // ---- Criterion 2 — POST /auth/login (valid, user A) → 2xx { token } --
    let tokenA;
    {
      const res = await fetchImpl(
        joinUrl(baseUrl, '/auth/login'),
        post({ username: usernameA, password: passwordA }),
      );
      const payload = await safeJson(res);
      const hasToken =
        payload != null &&
        typeof payload === 'object' &&
        typeof payload.token === 'string' &&
        payload.token.length > 0;
      if (hasToken) tokenA = payload.token;
      ledger.record(
        2,
        isSuccess(res.status) && hasToken,
        `POST /auth/login (A) → HTTP ${res.status}; token present=${hasToken}`,
      );
    }

    // ---- Criterion 3 — unknown username / wrong password → 401/403 --------
    {
      const wrongRes = await fetchImpl(
        joinUrl(baseUrl, '/auth/login'),
        post({ username: usernameA, password: `${passwordA}-WRONG` }),
      );
      await safeJson(wrongRes);
      const unknownRes = await fetchImpl(
        joinUrl(baseUrl, '/auth/login'),
        post({ username: `no-such-${usernameA}`, password: passwordA }),
      );
      await safeJson(unknownRes);
      ledger.record(
        3,
        isAuthReject(wrongRes.status) && isAuthReject(unknownRes.status),
        `wrong password → HTTP ${wrongRes.status} (expected 401/403); unknown user → HTTP ${unknownRes.status} (expected 401/403)`,
      );
    }

    // ---- Criterion 4 — protected endpoint, no token / invalid token -------
    {
      const noneRes = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      await safeJson(noneRes);
      const badRes = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        method: 'GET',
        headers: { ...jsonHeaders, authorization: 'Bearer invalid-token-xyz' },
      });
      await safeJson(badRes);
      ledger.record(
        4,
        isAuthReject(noneRes.status) && isAuthReject(badRes.status),
        `GET /projects (no token) → HTTP ${noneRes.status}; (invalid token) → HTTP ${badRes.status} (both expected 401/403)`,
      );
    }

    // ---- Register + log in user B (for isolation probes below) -----------
    let tokenB;
    {
      const regRes = await fetchImpl(
        joinUrl(baseUrl, '/auth/register'),
        post({ username: usernameB, password: passwordB }),
      );
      await safeJson(regRes);
      const loginRes = await fetchImpl(
        joinUrl(baseUrl, '/auth/login'),
        post({ username: usernameB, password: passwordB }),
      );
      const loginPayload = await safeJson(loginRes);
      if (
        isSuccess(regRes.status) &&
        isSuccess(loginRes.status) &&
        loginPayload != null &&
        typeof loginPayload === 'object' &&
        typeof loginPayload.token === 'string'
      ) {
        tokenB = loginPayload.token;
      }
    }

    const useTokenA = tokenA ?? '';
    const useTokenB = tokenB ?? '';

    // ---- Criterion 5 — POST /projects (valid, A) → 2xx --------------------
    let projectA1; // used later for the delete/cascade probe
    {
      const name = `bench-project-a1-${suffixA}`;
      const res = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        ...post({ name }),
        ...authHeaders(useTokenA),
        method: 'POST',
      });
      const payload = await safeJson(res);
      const hasShape =
        payload != null &&
        typeof payload === 'object' &&
        'id' in payload &&
        'name' in payload &&
        'ownerId' in payload &&
        'createdAt' in payload;
      if (hasShape) projectA1 = payload.id;
      ledger.record(
        5,
        isSuccess(res.status) && hasShape && payload?.name === name,
        `POST /projects (A) → HTTP ${res.status}; shape=${hasShape}; name match=${payload?.name === name}`,
      );
    }

    // ---- Criterion 6 — POST /projects (empty name) → 4xx ------------------
    {
      const res = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        ...post({ name: '' }),
        ...authHeaders(useTokenA),
        method: 'POST',
      });
      await safeJson(res);
      ledger.record(
        6,
        isClientError(res.status),
        `POST /projects empty name → HTTP ${res.status} (expected a 4xx rejection)`,
      );
    }

    // A second project for A, kept alive for the task/export probes below.
    let projectA2;
    const projectA2Name = `bench-project-a2-${suffixA}`;
    {
      const res = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        ...post({ name: projectA2Name }),
        ...authHeaders(useTokenA),
        method: 'POST',
      });
      const payload = await safeJson(res);
      if (
        isSuccess(res.status) &&
        payload != null &&
        typeof payload === 'object'
      ) {
        projectA2 = payload.id;
      }
    }

    // A project owned by B, used for every cross-user isolation probe.
    let projectB1;
    {
      const name = `bench-project-b1-${suffixB}`;
      const res = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        ...post({ name }),
        ...authHeaders(useTokenB),
        method: 'POST',
      });
      const payload = await safeJson(res);
      if (
        isSuccess(res.status) &&
        payload != null &&
        typeof payload === 'object'
      ) {
        projectB1 = payload.id;
      }
    }

    // ---- Criterion 7 — GET /projects (A) → only A's own projects ---------
    {
      const res = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        method: 'GET',
        ...authHeaders(useTokenA),
      });
      const payload = await safeJson(res);
      const isArray = Array.isArray(payload);
      const containsOwn =
        isArray &&
        [projectA1, projectA2].every(
          (id) => id === undefined || payload.some((p) => p?.id === id),
        );
      const leaksOther =
        isArray &&
        projectB1 !== undefined &&
        payload.some((p) => p?.id === projectB1);
      ledger.record(
        7,
        isSuccess(res.status) && isArray && containsOwn && !leaksOther,
        `GET /projects (A) → HTTP ${res.status}; array=${isArray}; contains own=${containsOwn}; leaks B's project=${leaksOther}`,
      );
    }

    // ---- Criterion 8 — GET /projects/:id (hit + miss) ---------------------
    {
      let hitOk = false;
      let evidence = 'no project id was created, so the read probe was skipped';
      if (projectA1 !== undefined) {
        const res = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectA1))}`,
          ),
          { method: 'GET', ...authHeaders(useTokenA) },
        );
        const payload = await safeJson(res);
        hitOk =
          isSuccess(res.status) &&
          payload != null &&
          typeof payload === 'object' &&
          payload.id === projectA1;
        evidence = `GET /projects/${projectA1} (own) → HTTP ${res.status}`;
      }
      const missRes = await fetchImpl(
        joinUrl(baseUrl, '/projects/00000000-nonexistent-id'),
        { method: 'GET', ...authHeaders(useTokenA) },
      );
      await safeJson(missRes);
      const missOk = isClientError(missRes.status);
      ledger.record(
        8,
        hitOk && missOk,
        `${evidence}; GET unknown project → HTTP ${missRes.status} (expected a 4xx)`,
      );
    }

    // ---- Criterion 9 — GET /projects/:id owned by B, as A → denied --------
    {
      let evidence =
        'no B project was created, so the isolation read probe was skipped';
      let ok = false;
      if (projectB1 !== undefined) {
        const res = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectB1))}`,
          ),
          { method: 'GET', ...authHeaders(useTokenA) },
        );
        const payload = await safeJson(res);
        const leaked =
          payload != null &&
          typeof payload === 'object' &&
          payload.id === projectB1;
        ok = isDenied(res.status) && !leaked;
        evidence = `GET /projects/${projectB1} (owned by B) as A → HTTP ${res.status} (expected 403/404); leaked=${leaked}`;
      }
      ledger.record(9, ok, evidence);
    }

    // ---- Criterion 12 — POST task (valid, A, projectA2) → 2xx ------------
    let taskA1;
    if (projectA2 === undefined) {
      ledger.record(
        12,
        false,
        'no project id was created, so the task create probe was skipped',
      );
    } else {
      const title = `bench-task-a1-${suffixA}`;
      const res = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks`,
        ),
        { ...post({ title }), ...authHeaders(useTokenA), method: 'POST' },
      );
      const payload = await safeJson(res);
      const hasShape =
        payload != null &&
        typeof payload === 'object' &&
        'id' in payload &&
        'title' in payload &&
        'projectId' in payload &&
        'createdAt' in payload &&
        payload.done === false;
      if (hasShape) taskA1 = payload.id;
      ledger.record(
        12,
        isSuccess(res.status) && hasShape && payload?.title === title,
        `POST task (A) → HTTP ${res.status}; shape=${hasShape}; title match=${payload?.title === title}`,
      );
    }

    // ---- Criterion 13 — missing/empty title → 4xx -------------------------
    if (projectA2 === undefined) {
      ledger.record(13, false, 'no project id, skipped empty-title probe');
    } else {
      const res = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks`,
        ),
        { ...post({ title: '' }), ...authHeaders(useTokenA), method: 'POST' },
      );
      await safeJson(res);
      ledger.record(
        13,
        isClientError(res.status),
        `POST task empty title → HTTP ${res.status} (expected a 4xx rejection)`,
      );
    }

    // ---- Criterion 14 — POST task against a project owned by B, as A ------
    {
      let evidence =
        'no B project was created, so the isolation create probe was skipped';
      let ok = false;
      if (projectB1 !== undefined) {
        const res = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectB1))}/tasks`,
          ),
          {
            ...post({ title: `bench-cross-user-${suffixA}` }),
            ...authHeaders(useTokenA),
            method: 'POST',
          },
        );
        await safeJson(res);
        ok = isDenied(res.status);
        evidence = `POST task under B's project as A → HTTP ${res.status} (expected 403/404)`;
      }
      ledger.record(14, ok, evidence);
    }

    // A few more tasks under projectA2 to exercise pagination + filtering.
    const extraTaskIds = [];
    if (projectA2 !== undefined) {
      for (let i = 0; i < 3; i += 1) {
        const res = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectA2))}/tasks`,
          ),
          {
            ...post({ title: `bench-task-extra-${suffixA}-${i}` }),
            ...authHeaders(useTokenA),
            method: 'POST',
          },
        );
        const payload = await safeJson(res);
        if (
          isSuccess(res.status) &&
          payload != null &&
          typeof payload === 'object'
        ) {
          extraTaskIds.push(payload.id);
        }
      }
    }

    // ---- Criterion 15 — pagination shape ----------------------------------
    if (projectA2 === undefined) {
      ledger.record(15, false, 'no project id, skipped pagination probe');
    } else {
      const res = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks?page=1&pageSize=2`,
        ),
        { method: 'GET', ...authHeaders(useTokenA) },
      );
      const payload = await safeJson(res);
      const hasPaginatedShape =
        payload != null &&
        typeof payload === 'object' &&
        Array.isArray(payload.items) &&
        typeof payload.total === 'number' &&
        typeof payload.page === 'number' &&
        typeof payload.pageSize === 'number';
      const respectsPageSize =
        hasPaginatedShape &&
        payload.items.length <= 2 &&
        payload.pageSize === 2;
      ledger.record(
        15,
        isSuccess(res.status) && hasPaginatedShape && respectsPageSize,
        `GET tasks?page=1&pageSize=2 → HTTP ${res.status}; paginatedShape=${hasPaginatedShape}; respectsPageSize=${respectsPageSize}`,
      );
    }

    // ---- Criterion 17 — PATCH task (execute before the filter probe) -----
    let patchedOk = false;
    if (projectA2 === undefined || taskA1 === undefined) {
      ledger.record(17, false, 'no task id, skipped PATCH probe');
    } else {
      const updatedTitle = `bench-patched-${suffixA}`;
      const res = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks/${encodeURIComponent(String(taskA1))}`,
        ),
        {
          method: 'PATCH',
          ...authHeaders(useTokenA),
          body: JSON.stringify({ title: updatedTitle, done: true }),
        },
      );
      const payload = await safeJson(res);
      patchedOk =
        isSuccess(res.status) &&
        payload != null &&
        typeof payload === 'object' &&
        payload.title === updatedTitle &&
        payload.done === true;
      ledger.record(
        17,
        patchedOk,
        `PATCH task → HTTP ${res.status}; title updated=${payload?.title === updatedTitle}; done updated=${payload?.done === true}`,
      );
    }

    // ---- Criterion 16 — ?done filter --------------------------------------
    if (projectA2 === undefined) {
      ledger.record(16, false, 'no project id, skipped done-filter probe');
    } else {
      const doneRes = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks?done=true`,
        ),
        { method: 'GET', ...authHeaders(useTokenA) },
      );
      const donePayload = await safeJson(doneRes);
      const doneItems = Array.isArray(donePayload?.items)
        ? donePayload.items
        : [];
      const allDone = doneItems.every((t) => t?.done === true);
      const includesPatched =
        !patchedOk ||
        taskA1 === undefined ||
        doneItems.some((t) => t?.id === taskA1);

      const notDoneRes = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks?done=false`,
        ),
        { method: 'GET', ...authHeaders(useTokenA) },
      );
      const notDonePayload = await safeJson(notDoneRes);
      const notDoneItems = Array.isArray(notDonePayload?.items)
        ? notDonePayload.items
        : [];
      const noneDone = notDoneItems.every((t) => t?.done === false);
      const excludesPatched =
        !patchedOk ||
        taskA1 === undefined ||
        !notDoneItems.some((t) => t?.id === taskA1);

      ledger.record(
        16,
        isSuccess(doneRes.status) &&
          isSuccess(notDoneRes.status) &&
          allDone &&
          noneDone &&
          includesPatched &&
          excludesPatched,
        `GET tasks?done=true → HTTP ${doneRes.status} (allDone=${allDone}, includesPatched=${includesPatched}); GET tasks?done=false → HTTP ${notDoneRes.status} (noneDone=${noneDone}, excludesPatched=${excludesPatched})`,
      );
    }

    // ---- Criterion 18 — DELETE task ---------------------------------------
    if (projectA2 === undefined || extraTaskIds[0] === undefined) {
      ledger.record(18, false, 'no extra task id, skipped DELETE task probe');
    } else {
      const targetTaskId = extraTaskIds[0];
      const delRes = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks/${encodeURIComponent(String(targetTaskId))}`,
        ),
        { method: 'DELETE', ...authHeaders(useTokenA) },
      );
      const listRes = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks`,
        ),
        { method: 'GET', ...authHeaders(useTokenA) },
      );
      const listPayload = await safeJson(listRes);
      const items = Array.isArray(listPayload?.items) ? listPayload.items : [];
      const stillPresent = items.some((t) => t?.id === targetTaskId);
      ledger.record(
        18,
        isSuccess(delRes.status) && !stillPresent,
        `DELETE task → HTTP ${delRes.status} (expected 2xx); still in list=${stillPresent}`,
      );
    }

    // =======================================================================
    // WORKER SEAM — report jobs (criteria 19-21). Task mutations on projectA2
    // are complete above, so the expected report counts are stable from here.
    // =======================================================================

    let exportId; // the completed job, re-checked after the restart (crit 26)
    let exportCompleted = false;
    if (projectA2 === undefined) {
      ledger.record(19, false, 'no project id, skipped export create probe');
      ledger.record(20, false, 'no project id, skipped export poll probe');
    } else {
      const exportsPath = `/projects/${encodeURIComponent(String(projectA2))}/exports`;

      // ---- Criterion 19 — POST exports → 2xx job record, not yet finished -
      {
        const res = await fetchImpl(joinUrl(baseUrl, exportsPath), {
          ...post({}),
          ...authHeaders(useTokenA),
          method: 'POST',
        });
        const payload = await safeJson(res);
        const hasId =
          payload != null && typeof payload === 'object' && 'id' in payload;
        const status =
          payload != null && typeof payload === 'object'
            ? payload.status
            : undefined;
        const unfinished = typeof status === 'string' && status !== 'completed';
        const noReportYet =
          payload == null ||
          typeof payload !== 'object' ||
          payload.report == null;
        if (hasId) exportId = payload.id;
        ledger.record(
          19,
          isSuccess(res.status) && hasId && unfinished && noReportYet,
          `POST ${exportsPath} → HTTP ${res.status}; id=${hasId}; status="${status}" (expected a not-yet-completed status); report withheld=${noReportYet}`,
        );
      }

      // ---- Criterion 20 — poll until "completed"; report matches ----------
      if (exportId === undefined) {
        ledger.record(
          20,
          false,
          'no export job id was returned, so the completion poll was skipped',
        );
      } else {
        // The expected counts come from the app's own task list at poll time.
        const totalRes = await fetchImpl(
          joinUrl(baseUrl, `${exportsPath.replace(/\/exports$/, '')}/tasks`),
          { method: 'GET', ...authHeaders(useTokenA) },
        );
        const totalPayload = await safeJson(totalRes);
        const expectedTotal =
          typeof totalPayload?.total === 'number' ? totalPayload.total : null;
        const doneCountRes = await fetchImpl(
          joinUrl(
            baseUrl,
            `${exportsPath.replace(/\/exports$/, '')}/tasks?done=true`,
          ),
          { method: 'GET', ...authHeaders(useTokenA) },
        );
        const doneCountPayload = await safeJson(doneCountRes);
        const expectedDone =
          typeof doneCountPayload?.total === 'number'
            ? doneCountPayload.total
            : null;

        const jobPath = `${exportsPath}/${encodeURIComponent(String(exportId))}`;
        const deadline = Date.now() + exportPollTimeoutMs;
        let lastStatus;
        let job;
        for (;;) {
          const res = await fetchImpl(joinUrl(baseUrl, jobPath), {
            method: 'GET',
            ...authHeaders(useTokenA),
          });
          lastStatus = res.status;
          job = await safeJson(res);
          if (
            job != null &&
            typeof job === 'object' &&
            job.status === 'completed'
          ) {
            break;
          }
          if (Date.now() >= deadline) break;
          await sleepFn(exportPollIntervalMs);
        }

        const completed =
          job != null && typeof job === 'object' && job.status === 'completed';
        const report =
          completed && job.report != null && typeof job.report === 'object'
            ? job.report
            : null;
        const nameOk = report != null && report.name === projectA2Name;
        const totalOk =
          report != null &&
          (expectedTotal === null || report.total === expectedTotal);
        const doneOk =
          report != null &&
          (expectedDone === null || report.done === expectedDone);
        exportCompleted = completed;
        ledger.record(
          20,
          completed && report != null && nameOk && totalOk && doneOk,
          `GET ${jobPath} → HTTP ${lastStatus}; completed=${completed}; report name match=${nameOk}; total=${report?.total} (expected ${expectedTotal}); done=${report?.done} (expected ${expectedDone})`,
        );
      }
    }

    // ---- Criterion 21 — export isolation (create cross-user + read) -------
    {
      let createDeniedOk = false;
      let createEvidence =
        'no B project was created, so the cross-user export create probe was skipped';
      if (projectB1 !== undefined) {
        const res = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectB1))}/exports`,
          ),
          { ...post({}), ...authHeaders(useTokenA), method: 'POST' },
        );
        await safeJson(res);
        createDeniedOk = isDenied(res.status);
        createEvidence = `POST exports on B's project as A → HTTP ${res.status} (expected 403/404)`;
      }
      let readDeniedOk = false;
      let readEvidence =
        'no export job existed, so the cross-user export read probe was skipped';
      if (projectA2 !== undefined && exportId !== undefined) {
        const res = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectA2))}/exports/${encodeURIComponent(String(exportId))}`,
          ),
          { method: 'GET', ...authHeaders(useTokenB) },
        );
        const payload = await safeJson(res);
        const leaked =
          payload != null &&
          typeof payload === 'object' &&
          payload.id === exportId;
        readDeniedOk = isDenied(res.status) && !leaked;
        readEvidence = `GET A's export job as B → HTTP ${res.status} (expected 403/404); leaked=${leaked}`;
      }
      ledger.record(
        21,
        createDeniedOk && readDeniedOk,
        `${createEvidence}; ${readEvidence}`,
      );
    }

    // =======================================================================
    // ADMIN-CLI SEAM (criteria 22-23) and MIGRATION SEAM (criterion 24) —
    // `npm run …` in the delivered workspace, observed via stdout/exit codes.
    // =======================================================================

    // ---- Criterion 22 — stats deltas track HTTP writes --------------------
    {
      const stats1Run = runCli(['run', '--silent', 'admin', '--', 'stats']);
      const stats1 = parseLastJsonObject(stats1Run.stdout);
      let ok = false;
      let evidence = `${stats1Run.detail}; parseable JSON=${stats1 != null}`;
      if (stats1Run.ok && stats1 != null) {
        // One more HTTP-created project between the two stats reads: the CLI
        // must see the same live store the API writes.
        const res = await fetchImpl(joinUrl(baseUrl, '/projects'), {
          ...post({ name: `bench-stats-${suffixA}` }),
          ...authHeaders(useTokenA),
          method: 'POST',
        });
        await safeJson(res);
        const stats2Run = runCli(['run', '--silent', 'admin', '--', 'stats']);
        const stats2 = parseLastJsonObject(stats2Run.stdout);
        const shapeOk =
          stats2 != null &&
          ['users', 'projects', 'tasks'].every(
            (k) =>
              typeof stats1[k] === 'number' && typeof stats2[k] === 'number',
          );
        const usersFloorOk = shapeOk && stats1.users >= 2;
        const deltaOk =
          shapeOk &&
          isSuccess(res.status) &&
          stats2.projects === stats1.projects + 1 &&
          stats2.users === stats1.users;
        ok = shapeOk && usersFloorOk && deltaOk;
        evidence =
          `stats before={users:${stats1?.users},projects:${stats1?.projects},tasks:${stats1?.tasks}} ` +
          `after one HTTP project create={users:${stats2?.users},projects:${stats2?.projects},tasks:${stats2?.tasks}} ` +
          `(want projects +1, users unchanged, users ≥ 2)`;
      }
      ledger.record(22, ok, evidence);
    }

    // ---- Criterion 23 — deactivate-user is enforced by the API ------------
    {
      const suffixC = uniqueSuffix();
      const usernameC = `bench-user-c-${suffixC}`;
      const passwordC = `bench-pass-c-${suffixC}`;
      const regRes = await fetchImpl(
        joinUrl(baseUrl, '/auth/register'),
        post({ username: usernameC, password: passwordC }),
      );
      await safeJson(regRes);
      const preRes = await fetchImpl(
        joinUrl(baseUrl, '/auth/login'),
        post({ username: usernameC, password: passwordC }),
      );
      await safeJson(preRes);
      let ok = false;
      let evidence;
      if (!isSuccess(regRes.status) || !isSuccess(preRes.status)) {
        evidence = `precondition failed: register (C) → HTTP ${regRes.status}, login (C) → HTTP ${preRes.status}`;
      } else {
        const deact = runCli([
          'run',
          '--silent',
          'admin',
          '--',
          'deactivate-user',
          usernameC,
        ]);
        const postRes = await fetchImpl(
          joinUrl(baseUrl, '/auth/login'),
          post({ username: usernameC, password: passwordC }),
        );
        await safeJson(postRes);
        const othersRes = await fetchImpl(
          joinUrl(baseUrl, '/auth/login'),
          post({ username: usernameA, password: passwordA }),
        );
        await safeJson(othersRes);
        ok =
          deact.ok &&
          isAuthReject(postRes.status) &&
          isSuccess(othersRes.status);
        evidence = `${deact.detail}; login (deactivated C) → HTTP ${postRes.status} (expected 401/403); login (A, untouched) → HTTP ${othersRes.status} (expected 2xx)`;
      }
      ledger.record(23, ok, evidence);
    }

    // ---- Criterion 24 — migrate exits 0, idempotent, data intact ----------
    {
      const run1 = runCli(['run', '--silent', 'migrate']);
      const run2 = run1.ok
        ? runCli(['run', '--silent', 'migrate'])
        : { ok: false, detail: 'first run failed, re-run skipped' };
      const afterRes = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        method: 'GET',
        ...authHeaders(useTokenA),
      });
      const afterPayload = await safeJson(afterRes);
      const dataIntact =
        isSuccess(afterRes.status) &&
        Array.isArray(afterPayload) &&
        (projectA2 === undefined ||
          afterPayload.some((p) => p?.id === projectA2));
      ledger.record(
        24,
        run1.ok && run2.ok && dataIntact,
        `first ${run1.detail}; second ${run2.detail}; GET /projects afterwards → HTTP ${afterRes.status}, data intact=${dataIntact}`,
      );
    }

    // ---- Criterion 10 — DELETE /projects/:id + cascade --------------------
    if (projectA1 === undefined) {
      ledger.record(10, false, 'no project id, skipped DELETE project probe');
    } else {
      // Give projectA1 a task first, so the cascade actually has something
      // to remove.
      await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA1))}/tasks`,
        ),
        {
          ...post({ title: `bench-cascade-${suffixA}` }),
          ...authHeaders(useTokenA),
          method: 'POST',
        },
      );
      const delRes = await fetchImpl(
        joinUrl(baseUrl, `/projects/${encodeURIComponent(String(projectA1))}`),
        { method: 'DELETE', ...authHeaders(useTokenA) },
      );
      const afterRes = await fetchImpl(
        joinUrl(baseUrl, `/projects/${encodeURIComponent(String(projectA1))}`),
        { method: 'GET', ...authHeaders(useTokenA) },
      );
      await safeJson(afterRes);
      ledger.record(
        10,
        isSuccess(delRes.status) && isClientError(afterRes.status),
        `DELETE /projects/${projectA1} → HTTP ${delRes.status} (expected 2xx); subsequent GET → HTTP ${afterRes.status} (expected a 4xx)`,
      );
    }

    // ---- Criterion 11 — DELETE a project owned by B, as A → denied --------
    {
      let evidence =
        'no B project was created, so the isolation delete probe was skipped';
      let ok = false;
      if (projectB1 !== undefined) {
        const delRes = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectB1))}`,
          ),
          { method: 'DELETE', ...authHeaders(useTokenA) },
        );
        await safeJson(delRes);
        const stillThereRes = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectB1))}`,
          ),
          { method: 'GET', ...authHeaders(useTokenB) },
        );
        const stillTherePayload = await safeJson(stillThereRes);
        const stillThere =
          isSuccess(stillThereRes.status) &&
          stillTherePayload != null &&
          typeof stillTherePayload === 'object' &&
          stillTherePayload.id === projectB1;
        ok = isDenied(delRes.status) && stillThere;
        evidence = `DELETE B's project as A → HTTP ${delRes.status} (expected 403/404); still retrievable by B=${stillThere}`;
      }
      ledger.record(11, ok, evidence);
    }

    // ---- Criterion 25 — malformed JSON is rejected; server survives -------
    {
      const badRes = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        method: 'POST',
        headers: { ...jsonHeaders, authorization: `Bearer ${useTokenA}` },
        body: '{"name": "unterminated',
      });
      const rejected = isClientError(badRes.status);
      // The server must survive the malformed request: a normal authenticated
      // read afterwards still succeeds.
      const afterRes = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        method: 'GET',
        ...authHeaders(useTokenA),
      });
      const aliveOk = isSuccess(afterRes.status);
      ledger.record(
        25,
        rejected && aliveOk,
        `POST /projects malformed JSON → HTTP ${badRes.status} (expected a 4xx, not a crash/accept); follow-up GET /projects → HTTP ${afterRes.status}`,
      );
    }

    // ---- Criterion 26 — persistence across a REAL server restart ----------
    // Ticket #122, item 5: when the app-runner supplies its real `restart`
    // hook, create a durable marker, RESTART the server (kill + relaunch), then
    // re-login with the ORIGINAL credentials and re-fetch the marker AND the
    // completed export job. An in-memory store loses everything on restart and
    // FAILS here; an on-disk store survives. When no `restart` is available
    // (the standalone `node --test` face has no process control) the criterion
    // degrades to the prior in-process re-login signal.
    {
      let ok = false;
      let evidence;
      if (typeof restart === 'function') {
        // Create a durable marker BEFORE the restart with the current token.
        const markerName = `persist-marker-${uniqueSuffix()}`;
        let markerId = null;
        try {
          const createRes = await fetchImpl(joinUrl(baseUrl, '/projects'), {
            method: 'POST',
            headers: { ...jsonHeaders, authorization: `Bearer ${useTokenA}` },
            body: JSON.stringify({ name: markerName }),
          });
          const created = await safeJson(createRes);
          markerId =
            created != null && typeof created === 'object' ? created.id : null;
        } catch {
          // A create failure leaves markerId null — the post-restart re-fetch
          // then falls back to matching by name.
        }

        // Kill and relaunch the server on the same port.
        await restart();

        // Re-login with the ORIGINAL credentials — an in-memory user store is
        // now empty, so this fails.
        const loginRes = await fetchImpl(
          joinUrl(baseUrl, '/auth/login'),
          post({ username: usernameA, password: passwordA }),
        );
        const loginPayload = await safeJson(loginRes);
        const newToken =
          loginPayload != null && typeof loginPayload === 'object'
            ? loginPayload.token
            : null;
        const loginOk =
          isSuccess(loginRes.status) &&
          typeof newToken === 'string' &&
          newToken.length > 0;

        // Re-fetch the marker created before the restart.
        let markerPresent = false;
        if (loginOk) {
          const listRes = await fetchImpl(joinUrl(baseUrl, '/projects'), {
            method: 'GET',
            ...authHeaders(newToken),
          });
          const list = await safeJson(listRes);
          markerPresent =
            Array.isArray(list) &&
            list.some(
              (p) =>
                p != null &&
                typeof p === 'object' &&
                (p.id === markerId || p.name === markerName),
            );
        }

        // The completed export job must also survive (when one completed).
        let exportSurvived = true;
        if (
          loginOk &&
          exportCompleted &&
          projectA2 !== undefined &&
          exportId !== undefined
        ) {
          const jobRes = await fetchImpl(
            joinUrl(
              baseUrl,
              `/projects/${encodeURIComponent(String(projectA2))}/exports/${encodeURIComponent(String(exportId))}`,
            ),
            { method: 'GET', ...authHeaders(newToken) },
          );
          const jobPayload = await safeJson(jobRes);
          exportSurvived =
            isSuccess(jobRes.status) &&
            jobPayload != null &&
            typeof jobPayload === 'object' &&
            jobPayload.status === 'completed';
        }

        ok = loginOk && markerPresent && exportSurvived;
        evidence = `Persistence across a REAL restart: re-login → HTTP ${loginRes.status}, prior project present=${markerPresent}, completed export job survived=${exportSurvived} (an in-memory store loses all three)`;
      } else {
        // Standalone/unit face: no process control — record the in-process
        // re-login signal (this face cannot observe true cross-restart survival).
        const res = await fetchImpl(
          joinUrl(baseUrl, '/auth/login'),
          post({ username: usernameA, password: passwordA }),
        );
        const payload = await safeJson(res);
        ok =
          isSuccess(res.status) &&
          payload != null &&
          typeof payload === 'object' &&
          typeof payload.token === 'string' &&
          payload.token.length > 0;
        evidence = `Persistence check (no restart hook available): re-login → HTTP ${res.status}; token present=${ok}`;
      }
      ledger.record(26, ok, evidence);
    }
  } catch (err) {
    const reason = `frozen oracle aborted: ${
      err instanceof Error ? err.message : String(err)
    }`;
    const criteria = ledger.finalize(reason);
    return { scenario: SCENARIO_ID, passed: false, criteria };
  }

  const criteria = ledger.finalize('criterion probe did not run');
  return {
    scenario: SCENARIO_ID,
    passed: criteria.every((c) => c.met),
    criteria,
  };
}

// --- Standalone `node --test` face -------------------------------------

const BASE_URL = process.env.BENCH_APP_BASE_URL;

describe('epic-scope frozen acceptance oracle', { skip: !BASE_URL }, () => {
  it('every frozen criterion is met by the delivered app', async () => {
    const result = await evaluate(/** @type {string} */ (BASE_URL), {
      workspacePath: process.env.BENCH_APP_WORKSPACE ?? null,
    });
    const failed = result.criteria.filter((c) => !c.met);
    assert.equal(
      failed.length,
      0,
      `unmet criteria: ${failed.map((c) => `${c.criterion} — ${c.evidence}`).join('; ')}`,
    );
    assert.equal(result.passed, true);
  });
});
