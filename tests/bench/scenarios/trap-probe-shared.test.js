/**
 * Contract tests for the behavioural trap-probe harness
 * (`bench/scenarios/trap-probe-shared.js`, Story #156).
 *
 * The harness owns the THREE-VALUED trap verdict: measured-clean,
 * measured-defective, and unmeasured. Every unmeasurable path — a tree that
 * never answers its readiness path, a probe that throws mid-flight, a
 * scenario whose app block cannot be resolved — must funnel to a `null`
 * score, never to a pass or a fail. These tests drive each of those paths
 * with an injected `withRunningApp` so no server is spawned.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  authenticate,
  createProbeClient,
  measured,
  probeDeliveredApp,
  readScenarioApp,
  scenarioDirOf,
  uniqueUsername,
  unmeasured,
} from '../../../bench/scenarios/trap-probe-shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'bench',
  'scenarios',
);

const FIXTURE_APP = {
  startCommand: 'node server.js',
  readinessPath: '/',
  portEnvVar: 'PORT',
};

/** An injected `withRunningApp` that reports the given readiness. */
function fakeRunner(ready) {
  return async (_opts, fn) =>
    fn('http://127.0.0.1:9999', { ready, port: 9999 });
}

describe('verdict constructors', () => {
  it('unmeasured() is null-scored, null-defect, and carries its reason', () => {
    const v = unmeasured('the app never booted');
    assert.equal(v.score, null);
    assert.equal(v.defectPresent, null);
    assert.equal(v.measured, false);
    assert.match(v.evidence.join(' '), /the app never booted/);
  });

  it('measured() maps defectPresent to the inverted 0|1 score', () => {
    assert.deepEqual(measured({ defectPresent: false, evidence: ['ok'] }), {
      score: 1,
      defectPresent: false,
      measured: true,
      evidence: ['ok'],
    });
    assert.deepEqual(measured({ defectPresent: true, evidence: ['bad'] }), {
      score: 0,
      defectPresent: true,
      measured: true,
      evidence: ['bad'],
    });
  });
});

describe('probeDeliveredApp', () => {
  it('reports UNMEASURED when the delivered app never becomes ready', async () => {
    let probeRan = false;
    const verdict = await probeDeliveredApp(
      '/tmp/delivered',
      async () => {
        probeRan = true;
        return measured({ defectPresent: false, evidence: [] });
      },
      { app: FIXTURE_APP, withRunningAppFn: fakeRunner(false) },
    );
    assert.equal(probeRan, false, 'the probe must not run against a dead app');
    assert.equal(verdict.score, null);
    assert.equal(verdict.defectPresent, null);
    assert.match(verdict.evidence.join(' '), /readiness/);
  });

  it('reports UNMEASURED when the probe throws mid-flight', async () => {
    const verdict = await probeDeliveredApp(
      '/tmp/delivered',
      async () => {
        throw new Error('connection reset');
      },
      { app: FIXTURE_APP, withRunningAppFn: fakeRunner(true) },
    );
    assert.equal(verdict.score, null);
    assert.equal(verdict.defectPresent, null);
    assert.match(verdict.evidence.join(' '), /connection reset/);
  });

  it('reports UNMEASURED when the app itself cannot be started', async () => {
    const verdict = await probeDeliveredApp(
      '/tmp/delivered',
      async () => null,
      {
        app: FIXTURE_APP,
        withRunningAppFn: async () => {
          throw new Error('spawn ENOENT');
        },
      },
    );
    assert.equal(verdict.score, null);
    assert.match(verdict.evidence.join(' '), /spawn ENOENT/);
  });

  it('reports UNMEASURED when the scenario app block cannot be resolved', async () => {
    const verdict = await probeDeliveredApp(
      '/tmp/delivered',
      async () => null,
      {
        scenarioDir: '/nonexistent/scenario',
        withRunningAppFn: fakeRunner(true),
      },
    );
    assert.equal(verdict.score, null);
    assert.match(verdict.evidence.join(' '), /app launch block/);
  });

  it('returns the probe verdict verbatim when the app is up', async () => {
    const verdict = await probeDeliveredApp(
      '/tmp/delivered',
      async (client) => {
        assert.equal(client.baseUrl, 'http://127.0.0.1:9999');
        return measured({ defectPresent: true, evidence: ['leaked'] });
      },
      { app: FIXTURE_APP, withRunningAppFn: fakeRunner(true) },
    );
    assert.deepEqual(verdict, {
      score: 0,
      defectPresent: true,
      measured: true,
      evidence: ['leaked'],
    });
  });

  it('rejects a non-string deliveredTreePath and a non-function probe', async () => {
    await assert.rejects(
      () => probeDeliveredApp('', async () => null),
      TypeError,
    );
    await assert.rejects(() => probeDeliveredApp('/tmp/x', null), TypeError);
  });
});

describe('createProbeClient', () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status: 200,
      async text() {
        return '{"ok":true}';
      },
    };
  };

  it('sends JSON bodies and bearer credentials, and parses the response', async () => {
    const client = createProbeClient('http://host/', fetchImpl);
    const res = await client.request('/projects', {
      method: 'POST',
      token: 'tok',
      body: { name: 'n' },
    });
    assert.deepEqual(res.body, { ok: true });
    assert.equal(res.status, 200);
    const [{ url, init }] = calls;
    assert.equal(url, 'http://host/projects', 'no double slash');
    assert.equal(init.headers.authorization, 'Bearer tok');
    assert.equal(init.headers['content-type'], 'application/json');
    assert.equal(init.body, '{"name":"n"}');
  });

  it('surfaces an unparseable body as a null value plus the raw text', async () => {
    const client = createProbeClient('http://host', async () => ({
      status: 500,
      async text() {
        return '<html>boom</html>';
      },
    }));
    const res = await client.request('/x');
    assert.equal(res.status, 500);
    assert.equal(res.body, null);
    assert.match(res.text, /boom/);
  });
});

describe('authenticate', () => {
  const routes = {
    registerPath: '/auth/register',
    loginPath: '/auth/login',
    tokenField: 'token',
  };

  it('returns the issued credential and the registered id', async () => {
    const client = {
      request: async (p) =>
        p === '/auth/register'
          ? { status: 201, body: { id: 7 } }
          : { status: 200, body: { token: 'abc' } },
    };
    const principal = await authenticate(client, routes);
    assert.equal(principal.userId, 7);
    assert.equal(principal.token, 'abc');
    assert.ok(principal.username.length > 0);
  });

  it('throws when the app cannot register, log in, or issue a credential', async () => {
    await assert.rejects(
      () =>
        authenticate(
          { request: async () => ({ status: 500, body: null }) },
          routes,
        ),
      /register .* HTTP 500/,
    );
    await assert.rejects(
      () =>
        authenticate(
          {
            request: async (p) =>
              p === '/auth/register'
                ? { status: 201, body: { id: 1 } }
                : { status: 401, body: null },
          },
          routes,
        ),
      /login .* HTTP 401/,
    );
    await assert.rejects(
      () =>
        authenticate(
          {
            request: async (p) =>
              p === '/auth/register'
                ? { status: 201, body: { id: 1 } }
                : { status: 200, body: {} },
          },
          routes,
        ),
      /no usable "token" credential/,
    );
  });
});

describe('scenario wiring', () => {
  it('readScenarioApp reads the real scenario launch blocks', () => {
    for (const id of ['epic-scope', 'story-scope']) {
      const app = readScenarioApp(path.join(SCENARIOS_DIR, id));
      assert.equal(app.startCommand, 'npm start');
      assert.equal(app.portEnvVar, 'PORT');
    }
    assert.throws(() => readScenarioApp(''), TypeError);
  });

  it('scenarioDirOf resolves a traps/ module back to its scenario directory', () => {
    const dir = scenarioDirOf(
      new URL('file:///repo/bench/scenarios/epic-scope/traps/idor.js').href,
    );
    assert.equal(dir, '/repo/bench/scenarios/epic-scope');
  });

  it('uniqueUsername never collides across calls', () => {
    const names = new Set(
      Array.from({ length: 50 }, () => uniqueUsername('probe')),
    );
    assert.equal(names.size, 50);
  });
});
