/**
 * trap-probe-shared.js — shared boot-and-probe scaffolding for the
 * BEHAVIOURAL trap oracles under `bench/scenarios/<id>/traps/*.js`
 * (Story #156).
 *
 * The trap axis exists to measure a property the frozen acceptance suite is
 * blind to. Until this module landed, every trap oracle did that by grepping
 * the delivered SOURCE (`trap-oracle-shared.js#scanTree`), which made the
 * axis measure *prose shape* rather than *behaviour*: a symmetric regex fires
 * identically against a tree that behaviourally proves the property and one
 * that merely names it (the epic-r2 `idor` false positive). A behavioural
 * oracle instead boots the delivered app — the same way the frozen suite's
 * harness does, via `bench/driver/app-runner.js#withRunningApp` — and drives
 * HTTP probes on surfaces the frozen suite deliberately does not sample.
 *
 * ## The three-valued verdict
 *
 * A source scan can always render a verdict; a behavioural probe cannot. The
 * delivered tree may fail to install, fail to boot, or answer nothing on its
 * readiness path — and in that state the honest verdict is neither "clean"
 * nor "defective" but **unmeasured**. This module therefore widens the trap
 * verdict to three values:
 *
 *   - `{ score: 1, defectPresent: false, measured: true }` — probed, clean.
 *   - `{ score: 0, defectPresent: true,  measured: true }` — probed, defective.
 *   - `{ score: null, defectPresent: null, measured: false }` — unmeasurable.
 *
 * `bench/scenarios/trap-runner.js` propagates a `null` score verbatim and
 * excludes it from `cleanRate`, so an unbootable tree stays *visibly*
 * unmeasured rather than silently scoring a free pass (or a fabricated
 * failure) on every trap class.
 *
 * ## Why probe failures are unmeasured, not defects
 *
 * A probe that throws mid-flight (transport error, a response shape the probe
 * cannot interpret, an unmet precondition such as "the app could not even
 * register a user") has learned nothing about the trapped property. Reporting
 * that as a defect would attribute a delivery failure to the trap axis and
 * pollute the differential with noise the axis does not mean to measure. Every
 * such path funnels through {@link unmeasured}.
 *
 * Oracles built on this module never echo a captured password, token, or
 * secret value into `evidence` — derived signals only (the same discipline
 * the source-scanning family follows).
 *
 * @module bench/scenarios/trap-probe-shared
 */

import fs from 'node:fs';
import path from 'node:path';

import { withRunningApp } from '../driver/app-runner.js';

/**
 * Readiness ceiling for a trap probe's app boot. Deliberately shorter than
 * the app-runner default: the frozen suite has already paid the long boot
 * wait for this same tree by the time the trap oracles run, so a tree that
 * has not answered within this window is genuinely not coming up.
 */
export const DEFAULT_PROBE_READINESS_TIMEOUT_MS = 20 * 1000;

/**
 * Build the UNMEASURED verdict — the third value a behavioural trap oracle
 * can return. `score` and `defectPresent` are both `null` so no consumer can
 * mistake an unmeasurable tree for a pass (score 1) or a failure (score 0).
 *
 * @param {string} reason — why the class could not be measured (no secrets).
 * @returns {{ score: null, defectPresent: null, measured: false, evidence: string[] }}
 */
export function unmeasured(reason) {
  return {
    score: null,
    defectPresent: null,
    measured: false,
    evidence: [`unmeasured: ${reason}`],
  };
}

/**
 * Build a MEASURED verdict from a behavioural finding.
 *
 * @param {object} args
 * @param {boolean} args.defectPresent
 * @param {string[]} args.evidence
 * @returns {{ score: 0|1, defectPresent: boolean, measured: true, evidence: string[] }}
 */
export function measured({ defectPresent, evidence }) {
  return {
    score: defectPresent ? 0 : 1,
    defectPresent: Boolean(defectPresent),
    measured: true,
    evidence: Array.isArray(evidence) ? evidence : [],
  };
}

/**
 * Read a scenario's `app` launch block (the same block the frozen suite's
 * harness boots the delivered tree with) from its `scenario.json`.
 *
 * @param {string} scenarioDir — absolute path to `bench/scenarios/<id>`.
 * @param {object} [ports]
 * @param {Pick<typeof fs, 'readFileSync'>} [ports.fsImpl]
 * @returns {{ startCommand: string, readinessPath?: string, portEnvVar: string }}
 */
export function readScenarioApp(scenarioDir, ports = {}) {
  if (typeof scenarioDir !== 'string' || scenarioDir.length === 0) {
    throw new TypeError('readScenarioApp requires a non-empty scenarioDir');
  }
  const fsImpl = ports.fsImpl ?? fs;
  const raw = fsImpl.readFileSync(
    path.join(scenarioDir, 'scenario.json'),
    'utf8',
  );
  const spec = JSON.parse(raw);
  if (!spec?.app || typeof spec.app.startCommand !== 'string') {
    throw new TypeError(
      `scenario.json at ${scenarioDir} declares no usable app launch block`,
    );
  }
  return spec.app;
}

/**
 * Resolve the scenario directory that owns a trap-oracle module — i.e. the
 * parent of the module's `traps/` (or `traps-touch2/`) directory.
 *
 * @param {string} moduleUrl — the oracle module's `import.meta.url`.
 * @returns {string} absolute scenario directory path.
 */
export function scenarioDirOf(moduleUrl) {
  const filePath = new URL(moduleUrl).pathname;
  return path.dirname(path.dirname(filePath));
}

/**
 * Join a base URL and a path without producing a double slash.
 *
 * @param {string} baseUrl
 * @param {string} pathname
 * @returns {string}
 */
function joinUrl(baseUrl, pathname) {
  return `${baseUrl.replace(/\/+$/, '')}/${String(pathname).replace(/^\/+/, '')}`;
}

/**
 * A minimal JSON-over-HTTP client handed to every probe. Deliberately thin —
 * it never throws on a non-2xx status (a probe's whole job is to inspect
 * statuses) and never throws on an unparseable body (it exposes both the
 * parsed value and the raw text).
 *
 * @param {string} baseUrl
 * @param {typeof fetch} fetchImpl
 * @returns {{ baseUrl: string, request: (pathname: string, opts?: object) => Promise<{ status: number, body: unknown, text: string }> }}
 */
export function createProbeClient(baseUrl, fetchImpl = fetch) {
  return {
    baseUrl,
    async request(pathname, opts = {}) {
      const { method = 'GET', body, token, headers = {} } = opts;
      const init = {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      };
      if (body !== undefined) {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const res = await fetchImpl(joinUrl(baseUrl, pathname), init);
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed, text };
    },
  };
}

/** True for any 2xx status. */
export const isSuccess = (status) => status >= 200 && status < 300;

/**
 * Build a collision-proof username for a probe run. Trap probes share the
 * delivered app (and its persisted store) with the frozen suite and with each
 * other, so every probe registers its own run-stamped principals rather than
 * reusing a fixed name that a prior probe may already have taken.
 *
 * @param {string} prefix
 * @returns {string}
 */
export function uniqueUsername(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Register a principal and sign it in, returning the credential the app
 * issued. Throws on any non-2xx or missing-token outcome — probes let that
 * propagate so {@link probeDeliveredApp} converts an unusable app into an
 * UNMEASURED verdict rather than a defect.
 *
 * @param {{ request: Function }} client
 * @param {object} routes
 * @param {string} routes.registerPath
 * @param {string} routes.loginPath
 * @param {string} routes.tokenField  — response field holding the credential.
 * @param {string} [routes.username]
 * @param {string} [routes.password]
 * @returns {Promise<{ username: string, password: string, userId: unknown, token: string }>}
 */
export async function authenticate(client, routes) {
  const {
    registerPath,
    loginPath,
    tokenField,
    username = uniqueUsername('probe'),
    password = 'Pr0be-passw0rd!',
  } = routes ?? {};

  const reg = await client.request(registerPath, {
    method: 'POST',
    body: { username, password },
  });
  if (!isSuccess(reg.status)) {
    throw new Error(`register ${registerPath} → HTTP ${reg.status}`);
  }

  const login = await client.request(loginPath, {
    method: 'POST',
    body: { username, password },
  });
  if (!isSuccess(login.status)) {
    throw new Error(`login ${loginPath} → HTTP ${login.status}`);
  }
  const token = login.body?.[tokenField];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      `login ${loginPath} returned no usable "${tokenField}" credential`,
    );
  }

  return {
    username,
    password,
    userId: reg.body?.id ?? null,
    token,
  };
}

/**
 * Boot the delivered app, hand a probe an HTTP client, and normalize every
 * failure mode into the three-valued trap verdict.
 *
 * The probe receives `(client, info)` and returns a verdict — normally via
 * {@link measured}, or {@link unmeasured} when it discovers mid-flight that
 * the property is not observable on this tree. Anything the probe throws is
 * caught here and reported as UNMEASURED: a probe that could not complete has
 * learned nothing about the trapped property, and scoring that as a defect
 * would attribute a delivery failure to the trap axis.
 *
 * @param {string} deliveredTreePath — absolute path to the delivered app tree.
 * @param {(client: object, info: object) => Promise<object>} probe
 * @param {object} [ports]
 * @param {object} [ports.app] — app launch block override (tests supply a fixture's).
 * @param {string} [ports.scenarioDir] — scenario dir to read `app` from when no override.
 * @param {typeof withRunningApp} [ports.withRunningAppFn]
 * @param {typeof fetch} [ports.fetchImpl]
 * @param {number} [ports.readinessTimeoutMs]
 * @param {object} [ports.appRunnerDeps] — forwarded to `withRunningApp`'s deps.
 * @param {Pick<typeof fs, 'readFileSync'>} [ports.fsImpl]
 * @returns {Promise<{ score: 0|1|null, defectPresent: boolean|null, measured: boolean, evidence: string[] }>}
 */
export async function probeDeliveredApp(deliveredTreePath, probe, ports = {}) {
  if (typeof deliveredTreePath !== 'string' || deliveredTreePath.length === 0) {
    throw new TypeError(
      'probeDeliveredApp(deliveredTreePath): deliveredTreePath must be a non-empty string',
    );
  }
  if (typeof probe !== 'function') {
    throw new TypeError('probeDeliveredApp requires a probe function');
  }

  let app;
  try {
    app = ports.app ?? readScenarioApp(ports.scenarioDir, ports);
  } catch (err) {
    return unmeasured(
      `the scenario app launch block could not be resolved: ${err?.message ?? err}`,
    );
  }

  const withRunningAppFn = ports.withRunningAppFn ?? withRunningApp;

  try {
    return await withRunningAppFn(
      {
        workspacePath: deliveredTreePath,
        app,
        readinessTimeoutMs:
          ports.readinessTimeoutMs ?? DEFAULT_PROBE_READINESS_TIMEOUT_MS,
      },
      async (baseUrl, info) => {
        if (!info?.ready) {
          return unmeasured(
            'the delivered app never answered its readiness path, so no behavioural probe could run',
          );
        }
        const client = createProbeClient(baseUrl, ports.fetchImpl ?? fetch);
        try {
          const verdict = await probe(client, info);
          return verdict ?? unmeasured('the probe returned no verdict');
        } catch (err) {
          return unmeasured(
            `the probe could not complete against the delivered app: ${err?.message ?? err}`,
          );
        }
      },
      ports.appRunnerDeps,
    );
  } catch (err) {
    return unmeasured(
      `the delivered app could not be started: ${err?.message ?? err}`,
    );
  }
}
