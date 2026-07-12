/**
 * tests/bench/scenarios/epic-scope/acceptance-restart.test.js
 *
 * Criterion 23 — persistence across a REAL server restart (Ticket #122,
 * item 5). The former criterion never restarted anything: it re-logged-in
 * in-process, so a pure in-memory Map scored 24/24. The oracle now drives the
 * app-runner's real `restart` hook; an in-memory store loses its state on
 * restart and MUST fail criterion 23, while an on-disk store survives.
 *
 * These tests exercise the oracle's criterion-23 branch with an injected
 * `restart` and a fake in-memory app whose state either survives or is cleared
 * on restart — no real server, no filesystem.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluate } from '../../../../bench/scenarios/epic-scope/acceptance.test.js';

/**
 * Build a minimal in-memory fake of the delivered app plus a `restart` hook.
 * When `persistent` is false the restart clears all state (an in-memory store);
 * when true the state survives (an on-disk store).
 *
 * The router supports the subset of endpoints the oracle drives; anything else
 * returns a generic 200 so evaluate() never throws before criterion 23.
 */
function makeFakeApp({ persistent }) {
  let users = new Map(); // username → { id, password }
  let tokens = new Map(); // token → userId
  let projects = []; // { id, name, ownerId }
  let nextId = 1;

  const json = (status, body) => ({
    status,
    async json() {
      return body;
    },
  });

  const parse = (url) => {
    const u = new URL(url);
    return { path: u.pathname, query: u.searchParams };
  };

  const userIdFromAuth = (opts) => {
    const auth =
      opts?.headers?.authorization ?? opts?.headers?.Authorization ?? '';
    const m = /^Bearer (.+)$/.exec(auth);
    return m ? (tokens.get(m[1]) ?? null) : null;
  };

  const fetchImpl = async (url, opts = {}) => {
    const { path } = parse(url);
    const method = (opts.method ?? 'GET').toUpperCase();
    let body = {};
    if (typeof opts.body === 'string') {
      try {
        body = JSON.parse(opts.body);
      } catch {
        return json(400, { error: 'bad json' });
      }
    }

    if (path === '/auth/register' && method === 'POST') {
      if (!body.username || !body.password) return json(400, { error: 'x' });
      if (users.has(body.username)) return json(409, { error: 'dup' });
      const id = nextId++;
      users.set(body.username, { id, password: body.password });
      return json(201, { id, username: body.username });
    }

    if (path === '/auth/login' && method === 'POST') {
      const u = users.get(body.username);
      if (!u || u.password !== body.password) return json(401, { error: 'x' });
      const token = `tok-${u.id}-${Math.random().toString(36).slice(2)}`;
      tokens.set(token, u.id);
      return json(200, { token });
    }

    if (path === '/projects' && method === 'POST') {
      const uid = userIdFromAuth(opts);
      if (uid == null) return json(401, { error: 'x' });
      if (!body.name) return json(400, { error: 'x' });
      const p = {
        id: nextId++,
        name: body.name,
        ownerId: uid,
        createdAt: new Date().toISOString(),
      };
      projects.push(p);
      return json(201, p);
    }

    if (path === '/projects' && method === 'GET') {
      const uid = userIdFromAuth(opts);
      if (uid == null) return json(401, { error: 'x' });
      return json(
        200,
        projects.filter((p) => p.ownerId === uid),
      );
    }

    // Everything else: generic OK so evaluate() never throws before crit 23.
    return json(200, {});
  };

  const restart = async () => {
    if (!persistent) {
      users = new Map();
      tokens = new Map();
      projects = [];
    }
    return { ready: true, port: 0, baseUrl: 'http://fake' };
  };

  return { fetchImpl, restart };
}

const CRIT_23 = 23;

describe('epic-scope criterion 23 — persistence across a REAL restart (Ticket #122, item 5)', () => {
  it('an IN-MEMORY app (state cleared on restart) FAILS criterion 23', async () => {
    const app = makeFakeApp({ persistent: false });
    const result = await evaluate('http://fake', {
      fetchImpl: app.fetchImpl,
      restart: app.restart,
      uniqueSuffix: () => 'fixed',
    });
    const c23 = result.criteria.find((c) => c.index === CRIT_23);
    assert.equal(c23.met, false, 'in-memory store must fail persistence');
  });

  it('an ON-DISK app (state survives restart) PASSES criterion 23', async () => {
    const app = makeFakeApp({ persistent: true });
    const result = await evaluate('http://fake', {
      fetchImpl: app.fetchImpl,
      restart: app.restart,
      uniqueSuffix: () => `u${Math.random().toString(36).slice(2)}`,
    });
    const c23 = result.criteria.find((c) => c.index === CRIT_23);
    assert.equal(c23.met, true, 'persistent store must survive the restart');
  });

  it('without a restart hook, criterion 23 degrades to the in-process re-login signal', async () => {
    // A persistent app with NO restart hook: the criterion still records a
    // (weaker) pass rather than throwing (standalone/unit face).
    const app = makeFakeApp({ persistent: true });
    const result = await evaluate('http://fake', {
      fetchImpl: app.fetchImpl,
      uniqueSuffix: () => `u${Math.random().toString(36).slice(2)}`,
    });
    const c23 = result.criteria.find((c) => c.index === CRIT_23);
    assert.equal(typeof c23.met, 'boolean');
    assert.ok(/no restart hook available/.test(c23.evidence));
  });
});
