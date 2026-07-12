// tests/bench/driver/app-runner.test.js
/**
 * Unit tests for bench/driver/app-runner.js — Story #2.
 *
 * Verifies the delivered-app lifecycle with every external effect injected:
 *   - findFreePort resolves the port a fake server reports,
 *   - parseStartCommand splits a simple command,
 *   - pollReadiness retries transport errors then succeeds, and times out,
 *   - killApp signals SIGTERM then escalates to SIGKILL,
 *   - withRunningApp installs only when node_modules is absent, yields baseUrl
 *     (even when the app never came up), and always reaps the child.
 *
 * No real port is bound, no real process spawned, no real fetch issued.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findFreePort,
  killApp,
  parseStartCommand,
  pollReadiness,
  withRunningApp,
} from '../../../bench/driver/app-runner.js';

const RESOLVED = Promise.resolve();
const noopSleep = () => RESOLVED;
const neverSleep = () => new Promise(() => {});

/** A controllable fake child process. */
function fakeChild({ pid = 4242 } = {}) {
  const handlers = {};
  return {
    pid,
    exitCode: null,
    signalCode: null,
    stdout: { on() {} },
    stderr: { on() {} },
    once(ev, cb) {
      handlers[ev] = cb;
    },
    emit(ev, ...a) {
      handlers[ev]?.(...a);
    },
  };
}

// ---------------------------------------------------------------------------
// findFreePort
// ---------------------------------------------------------------------------

test('findFreePort: resolves the port the fake server reports', async () => {
  const netFactory = () => ({
    once() {},
    listen(_p, cb) {
      cb();
    },
    address() {
      return { port: 51234 };
    },
    close(cb) {
      cb();
    },
  });
  assert.equal(await findFreePort({ netFactory }), 51234);
});

// ---------------------------------------------------------------------------
// parseStartCommand
// ---------------------------------------------------------------------------

test('parseStartCommand: splits a simple command', () => {
  assert.deepEqual(parseStartCommand('npm start'), {
    cmd: 'npm',
    args: ['start'],
  });
  assert.deepEqual(parseStartCommand('node server.js --x'), {
    cmd: 'node',
    args: ['server.js', '--x'],
  });
  assert.throws(() => parseStartCommand('  '), /non-empty startCommand/);
});

// ---------------------------------------------------------------------------
// pollReadiness
// ---------------------------------------------------------------------------

test('pollReadiness: retries transport errors then reports ready', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) throw new Error('ECONNREFUSED');
    return { status: 200 };
  };
  const res = await pollReadiness({
    url: 'http://127.0.0.1:1/',
    fetchImpl,
    sleepFn: noopSleep,
    now: () => 0,
  });
  assert.equal(res.ready, true);
  assert.equal(res.attempts, 3);
});

test('pollReadiness: gives up at the deadline', async () => {
  let t = 0;
  const res = await pollReadiness({
    url: 'http://127.0.0.1:1/',
    timeoutMs: 1000,
    fetchImpl: async () => {
      throw new Error('refused');
    },
    sleepFn: noopSleep,
    now: () => {
      const v = t;
      t += 600; // two ticks crosses the 1000ms deadline
      return v;
    },
  });
  assert.equal(res.ready, false);
});

// ---------------------------------------------------------------------------
// killApp
// ---------------------------------------------------------------------------

test('killApp: SIGTERM is enough when the child exits promptly', async () => {
  const child = fakeChild();
  const signals = [];
  await killApp(child, {
    sleepFn: neverSleep, // grace never elapses; the exit must win
    killFn: (target, sig) => {
      signals.push([target, sig]);
      if (sig === 'SIGTERM') child.emit('exit');
    },
  });
  assert.deepEqual(signals, [[-4242, 'SIGTERM']]);
});

test('killApp: escalates to SIGKILL when the child ignores SIGTERM', async () => {
  const child = fakeChild();
  const signals = [];
  await killApp(child, {
    sleepFn: noopSleep, // grace elapses immediately
    killFn: (target, sig) => {
      signals.push([target, sig]);
      if (sig === 'SIGKILL') child.emit('exit');
    },
  });
  assert.deepEqual(signals, [
    [-4242, 'SIGTERM'],
    [-4242, 'SIGKILL'],
  ]);
});

test('killApp: no-op on a missing child', async () => {
  await killApp(null); // must not throw
  await killApp({});
});

// ---------------------------------------------------------------------------
// withRunningApp
// ---------------------------------------------------------------------------

const APP = {
  startCommand: 'npm start',
  readinessPath: '/',
  defaultPort: 3000,
  portEnvVar: 'PORT',
};

function baseDeps(overrides = {}) {
  const child = fakeChild();
  const spawnCalls = [];
  const installCalls = [];
  const deps = {
    netFactory: () => ({
      once() {},
      listen(_p, cb) {
        cb();
      },
      address() {
        return { port: 40000 };
      },
      close(cb) {
        cb();
      },
    }),
    spawnFn: (cmd, args, o) => {
      spawnCalls.push({ cmd, args, env: o.env });
      return child;
    },
    spawnSyncFn: (cmd, args) => {
      installCalls.push({ cmd, args });
      return { status: 0 };
    },
    existsFn: () => true, // package.json + node_modules present → no install
    fetchImpl: async () => ({ status: 200 }),
    sleepFn: noopSleep,
    killFn: (_t, sig) => {
      if (sig === 'SIGTERM') child.emit('exit');
    },
    logger: { info() {}, warn() {} },
    ...overrides,
  };
  return { deps, child, spawnCalls, installCalls };
}

test('withRunningApp: yields baseUrl, skips install when node_modules present, reaps child', async () => {
  const { deps, spawnCalls, installCalls } = baseDeps();
  let seen = null;
  const result = await withRunningApp(
    { workspacePath: '/ws', app: APP },
    (baseUrl, info) => {
      seen = { baseUrl, info };
      return 'scored';
    },
    deps,
  );

  assert.equal(result, 'scored');
  assert.equal(seen.baseUrl, 'http://127.0.0.1:40000');
  assert.equal(seen.info.ready, true);
  assert.equal(installCalls.length, 0, 'no install when node_modules present');
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].env.PORT, '40000');
});

test('withRunningApp: runs npm install when node_modules is absent', async () => {
  const { deps, installCalls } = baseDeps({
    // package.json present, node_modules absent
    existsFn: (p) => p.endsWith('package.json'),
  });
  await withRunningApp({ workspacePath: '/ws', app: APP }, () => 'ok', deps);
  assert.equal(installCalls.length, 1);
  assert.deepEqual(installCalls[0].args, [
    'install',
    '--no-audit',
    '--no-fund',
  ]);
});

test('withRunningApp: a never-ready app still yields baseUrl (oracle records quality=0)', async () => {
  const { deps } = baseDeps({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  let info = null;
  const out = await withRunningApp(
    {
      workspacePath: '/ws',
      app: APP,
      readinessTimeoutMs: 10,
      readinessIntervalMs: 1,
    },
    (_baseUrl, i) => {
      info = i;
      return 'probed-anyway';
    },
    { ...deps, sleepFn: noopSleep },
  );
  assert.equal(out, 'probed-anyway');
  assert.equal(info.ready, false);
});

test('withRunningApp: reaps the child even when the callback throws', async () => {
  const { deps, child } = baseDeps();
  let reaped = false;
  const killFn = (_t, sig) => {
    if (sig === 'SIGTERM') {
      reaped = true;
      child.emit('exit');
    }
  };
  await assert.rejects(
    withRunningApp(
      { workspacePath: '/ws', app: APP },
      () => {
        throw new Error('callback boom');
      },
      { ...deps, killFn },
    ),
    /callback boom/,
  );
  assert.equal(reaped, true);
});

test('withRunningApp: validates inputs', async () => {
  await assert.rejects(
    withRunningApp({ app: APP }, () => {}, {}),
    /non-empty workspacePath/,
  );
  await assert.rejects(
    withRunningApp({ workspacePath: '/ws', app: {} }, () => {}, {}),
    /app.startCommand and app.portEnvVar/,
  );
  await assert.rejects(
    withRunningApp({ workspacePath: '/ws', app: APP }, 'not-a-fn', {}),
    /requires a callback fn/,
  );
});

test('withRunningApp: exposes a real restart hook that reaps and respawns on the same port (Ticket #122, item 5)', async () => {
  const { deps, spawnCalls } = baseDeps();
  let restartResult = null;
  await withRunningApp(
    { workspacePath: '/ws', app: APP },
    async (_baseUrl, info) => {
      assert.equal(typeof info.restart, 'function', 'restart hook provided');
      restartResult = await info.restart();
      return 'ok';
    },
    deps,
  );
  // One initial spawn + one respawn from restart.
  assert.equal(spawnCalls.length, 2, 'restart respawned the app');
  // Same port re-injected on the respawn.
  assert.equal(spawnCalls[1].env.PORT, '40000');
  assert.equal(restartResult.ready, true);
  assert.equal(restartResult.port, 40000);
});
