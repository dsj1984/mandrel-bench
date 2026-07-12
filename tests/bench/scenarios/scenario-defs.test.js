/**
 * Contract tests for the benchmark scenario corpus and its frozen quality
 * oracles (Story #4214).
 *
 * Verifies the three acceptance criteria of the Story:
 *   1. Each scenario seed (`bench/scenarios/<id>/scenario.json`) defines the
 *      task seed used by both arms (a prompt + the acceptance contract).
 *   2. Each frozen oracle (`acceptance.test.js#evaluate`) asserts the
 *      delivered app's user-visible HTTP behavior and is frozen — pure with
 *      respect to the app (no app-internal imports), deterministic, and
 *      structured (one verdict per criterion, in seed order).
 *   3. The adapter (`acceptance-eval-adapter.js`) invokes the existing
 *      acceptance-eval cross-check and returns its verdict alongside the
 *      frozen-suite result.
 *
 * These are contract-tier checks: they assert the shape of the scenario
 * assets and the wiring to the cross-check, with the HTTP boundary and the
 * cross-check gate both injected (no real `claude`, no network, no server).
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildVerdictFromFrozenResult,
  parseGateEnvelope,
  runCrossCheckViaCli,
  scoreScenarioQuality,
} from '../../../bench/scenarios/acceptance-eval-adapter.js';
import { evaluate as evaluateEpicScope } from '../../../bench/scenarios/epic-scope/acceptance.test.js';
import { evaluate as evaluateHello } from '../../../bench/scenarios/hello-world/acceptance.test.js';
import { evaluate as evaluateStoryScope } from '../../../bench/scenarios/story-scope/acceptance.test.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'bench',
  'scenarios',
);
// The Epic #66 3-rung corpus, in rising-difficulty order. All three rungs sit
// on ONE difficulty ladder whose monotonicity is a calibration guardrail
// (D-010): 'hello-world' is instrumentation only (never a value-delta rung),
// 'story-scope' and 'epic-scope' are the two value rungs, each also carrying
// its own trap-class axis (a SEPARATE differential signal, not folded into
// the ladder or the seven composite dimensions).
const SCENARIO_IDS = ['hello-world', 'story-scope', 'epic-scope'];

// Touch-chain scenario ids (issue #124, PR-E): brownfield rungs whose
// scenario.json declares `touches[]` instead of a greenfield `seed` prompt —
// the per-scenario sandbox overlay IS the baseline, so the generic seed-and-
// acceptance contract below does not apply to them. Their chain contract is
// asserted in its own describe block further down, and the full end-to-end
// wiring in tests/bench/scenarios/brownfield-longitudinal/chain-e2e.test.js.
const CHAIN_SCENARIO_IDS = ['brownfield-longitudinal'];

/**
 * Security-hint terms a trap-scenario prompt must never contain (Epic #66,
 * Story #75 / Story #78) — naming the planted defect class in the prompt
 * would destroy the headroom the trap needs (target-architecture §12).
 *
 * Covers all trap classes across both trap-bearing rungs: plaintext-password
 * / token-generation (story-scope) and plaintext-password / idor /
 * missing-input-validation / hardcoded-secret (epic-scope). The
 * hardcoded-secret terms were added after an Epic #66 audit found this list
 * incomplete — it missed the exact phrasing ("environment variable", "never
 * be inlined") that leaked the answer to the hardcoded-secret trap directly
 * in the epic-scope seed prompt (fixed in the same remediation pass). These
 * terms hint at WHERE/HOW a defect must be avoided (the implementation
 * choice the trap measures), not at the underlying functional requirement
 * itself — e.g. a prompt may legitimately say tokens are "signed with a
 * secret key" (the functional contract) without saying to read that key
 * from an environment variable and never inline it (the fix).
 */
const SECURITY_HINT_TERMS = [
  // Prompt-realism cutover: behavioural answer-leaks. A seed prompt must
  // state GOALS, not pre-answer the judgment calls the suite scores — these
  // phrases gave away the isolation / no-echo / validation / envelope /
  // session-invalidation answers verbatim in the pre-cutover prompts.
  'never reveal',
  'error envelope',
  'echoes the password',
  'not return the password',
  'must stop working',
  'rejects an invalid payload',
  'hash',
  'bcrypt',
  'salt',
  'encrypt',
  'secure',
  'random token',
  'environment variable',
  'env var',
  'inline',
  'inlined',
  '.env',
  'process.env',
  'ownership check',
  'authorization check',
  'validation guard',
];

/**
 * Benign, non-leaking env-var boilerplate every scenario prompt legitimately
 * carries (the app's PORT config contract, e.g. "the PORT environment
 * variable (default 3000)") — stripped before scanning for security-hint
 * terms so the "environment variable" / "env var" hint terms (added after
 * the Epic #66 audit found the hardcoded-secret leak) don't false-positive
 * on ordinary port-config prose that has nothing to do with any trap class.
 */
const BENIGN_ENV_VAR_RE = /\bPORT environment variable\b/gi;

/**
 * Lower-cased seed prompt with the known-benign env-var boilerplate removed,
 * ready for a security-hint-term scan.
 *
 * @param {{ seed: { prompt: string } }} scenario
 * @returns {string}
 */
function scanned(scenario) {
  return scenario.seed.prompt.replace(BENIGN_ENV_VAR_RE, '').toLowerCase();
}

function loadScenario(id) {
  const raw = readFileSync(
    path.join(SCENARIOS_DIR, id, 'scenario.json'),
    'utf8',
  );
  return JSON.parse(raw);
}

/**
 * Build a stub `fetch` from an ordered list of canned responses keyed by a
 * matcher predicate, so a frozen oracle can be driven without a server.
 *
 * @param {Array<{ when: (url: string, init: object) => boolean, status: number, headers?: Record<string,string>, json?: unknown, text?: string }>} routes
 */
function stubFetch(routes) {
  return async (url, init = {}) => {
    const route = routes.find((r) => r.when(String(url), init));
    if (!route) {
      throw new Error(`stubFetch: no route for ${init.method ?? 'GET'} ${url}`);
    }
    const headers = new Map(
      Object.entries(route.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
      status: route.status,
      headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
      async text() {
        return (
          route.text ??
          (route.json !== undefined ? JSON.stringify(route.json) : '')
        );
      },
      async json() {
        if (route.json === undefined) throw new Error('no json');
        return route.json;
      },
    };
  };
}

describe('scenario seeds (AC1: task seed shared by both arms)', () => {
  it('exposes exactly the expected scenarios on disk', () => {
    const dirs = readdirSync(SCENARIOS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    assert.deepEqual(dirs, [...SCENARIO_IDS, ...CHAIN_SCENARIO_IDS].sort());
  });

  for (const id of SCENARIO_IDS) {
    it(`${id}/scenario.json defines a non-empty task seed and acceptance contract`, () => {
      const s = loadScenario(id);
      assert.equal(s.id, id, 'id matches its directory');
      assert.equal(typeof s.title, 'string');
      assert.ok(s.title.length > 0, 'has a title');

      // The seed is the task both arms receive — a prompt plus the
      // acceptance contract. It must be present and non-trivial.
      assert.ok(s.seed && typeof s.seed === 'object', 'has a seed object');
      assert.equal(typeof s.seed.prompt, 'string');
      assert.ok(
        s.seed.prompt.length >= 40,
        'seed prompt is a real task description',
      );
      assert.ok(
        Array.isArray(s.seed.acceptance) && s.seed.acceptance.length > 0,
        'seed carries the acceptance contract',
      );
      for (const item of s.seed.acceptance) {
        assert.equal(typeof item, 'string');
        assert.ok(item.length > 0);
      }

      // The seed must point at its frozen acceptance suite, and the app
      // launch contract must be present so the harness can boot it.
      assert.equal(s.acceptanceSuite, './acceptance.test.js');
      assert.ok(
        s.app && typeof s.app === 'object',
        'declares an app launch contract',
      );
      assert.equal(typeof s.app.startCommand, 'string');
      assert.equal(typeof s.app.portEnvVar, 'string');
      assert.equal(typeof s.app.readinessPath, 'string');
    });
  }

  it('difficulty is monotonic across the ladder (hello-world < story-scope < brownfield-longitudinal < epic-scope)', () => {
    const hello = loadScenario('hello-world');
    const storyScope = loadScenario('story-scope');
    const brownfield = loadScenario('brownfield-longitudinal');
    const epicScope = loadScenario('epic-scope');
    assert.ok(
      Number(hello.difficulty) < Number(storyScope.difficulty),
      'story-scope must out-rank hello-world on difficulty for the monotonicity check',
    );
    assert.ok(
      Number(storyScope.difficulty) < Number(brownfield.difficulty),
      'brownfield-longitudinal must out-rank story-scope on difficulty for the monotonicity check',
    );
    assert.ok(
      Number(brownfield.difficulty) < Number(epicScope.difficulty),
      'epic-scope must out-rank brownfield-longitudinal on difficulty for the monotonicity check',
    );
  });

  describe('brownfield-longitudinal chain-scenario contract (issue #124, PR-E)', () => {
    const s = loadScenario('brownfield-longitudinal');
    const dir = path.join(SCENARIOS_DIR, 'brownfield-longitudinal');

    it('declares the chain identity: routing story, targetN 4, explicit 0.90 advance threshold', () => {
      assert.equal(s.id, 'brownfield-longitudinal');
      assert.equal(s.routing, 'story');
      assert.equal(s.targetN, 4);
      assert.equal(s.chainAdvanceThreshold, 0.9);
      assert.equal(s.difficulty, 4);
    });

    it('is a touches[] chain, NOT a greenfield seed — no seed prompt, no changeRequest, no top-level acceptance suite', () => {
      // The sandbox overlay is the baseline; a spec-bearing seed prompt here
      // would leak the conventions the rung exists to measure reading.
      assert.equal(s.seed, undefined);
      assert.equal(s.changeRequest, undefined);
      assert.equal(s.acceptanceSuite, undefined);
      assert.ok(Array.isArray(s.touches), 'declares touches[]');
    });

    it('declares the five design touches in order, each wired to real on-disk artifacts', () => {
      assert.deepEqual(
        s.touches.map((t) => t.id),
        [
          'credit-notes',
          'role-enforcement',
          'client-rename',
          'name-split',
          'receivables-perf',
        ],
      );
      for (const [i, t] of s.touches.entries()) {
        const k = i + 1;
        assert.equal(t.promptPath, `./touches/${k}/prompt.md`);
        assert.equal(t.acceptanceSuite, `./touches/${k}/acceptance.test.js`);
        const prompt = readFileSync(path.join(dir, t.promptPath), 'utf8');
        assert.ok(
          prompt.trim().length >= 120,
          `touch ${k} prompt is a real change request`,
        );
        assert.ok(
          readdirSync(path.join(dir, 'touches', String(k))).includes(
            'supersedes.json',
          ),
          `touch ${k} carries its supersedes.json (read by the evolution runner, not scenario.json)`,
        );
      }
    });

    it('carries the seed layer, the frozen-suite mirror, the evolution runner, and an app launch contract', () => {
      const entries = readdirSync(dir);
      for (const required of [
        'sandbox',
        'frozen-suite',
        'suite-evolution.js',
      ]) {
        assert.ok(entries.includes(required), `${required} present`);
      }
      assert.equal(s.suiteEvolutionModule, './suite-evolution.js');
      assert.equal(s.app.startCommand, 'npm start');
      assert.equal(s.app.readinessPath, '/health');
      assert.equal(s.app.portEnvVar, 'PORT');
    });

    it('declares all four convention grep-oracles and each module exists', () => {
      assert.deepEqual(s.conventionOracles, [
        './conventions/error-envelope.js',
        './conventions/validation-call.js',
        './conventions/layering.js',
        './conventions/money-integer.js',
      ]);
      for (const rel of s.conventionOracles) {
        assert.doesNotThrow(() => readFileSync(path.join(dir, rel), 'utf8'));
      }
    });

    it('the arm-3 controlClaudeMd fixture exists, points at the repo docs generically, and restates NO convention or landmine content', () => {
      assert.equal(s.controlClaudeMd, './control-claudemd.md');
      const fixture = readFileSync(path.join(dir, s.controlClaudeMd), 'utf8');
      assert.ok(
        /docs\//.test(fixture),
        'points the agent at the repo documentation',
      );
      // Restating convention specifics (or hinting at the landmines) in the
      // arm-3 fixture would collapse the "does the doc alone suffice" probe
      // into "we told it the answers".
      for (const leak of [
        /CONVENTIONS\.md/i,
        /E_[A-Z_]+/, // concrete error-code vocabulary
        /sendError/,
        /amountCents|integer cents|_cents/i,
        /repositor(y|ies).{0,40}db\.js/is,
        /page\s?size|pagination default/i,
        /re-reads? the user row|token-embedded role/i,
        /customer_name|denormali[sz]ed/i,
      ]) {
        assert.ok(
          !leak.test(fixture),
          `control-claudemd fixture leaks instrument content (${leak})`,
        );
      }
    });
  });

  describe('story-scope scenario contract (Epic #66, Story #75)', () => {
    it('declares routing "story" and targetN 8', () => {
      const s = loadScenario('story-scope');
      assert.equal(s.routing, 'story');
      assert.equal(s.targetN, 8);
    });

    it('the seed prompt contains no security-hint terms (trap headroom, §12)', () => {
      const s = loadScenario('story-scope');
      const prompt = scanned(s);
      for (const term of SECURITY_HINT_TERMS) {
        assert.ok(
          !prompt.includes(term.toLowerCase()),
          `seed prompt must not contain the security-hint term "${term}"`,
        );
      }
    });
  });

  describe('epic-scope scenario contract (Epic #66, Story #78)', () => {
    it('declares routing "epic" and targetN 8', () => {
      const s = loadScenario('epic-scope');
      assert.equal(s.routing, 'epic');
      assert.equal(s.targetN, 8);
    });

    it('the seed prompt contains no security-hint terms (trap headroom, §12)', () => {
      const s = loadScenario('epic-scope');
      const prompt = scanned(s);
      for (const term of SECURITY_HINT_TERMS) {
        assert.ok(
          !prompt.includes(term.toLowerCase()),
          `seed prompt must not contain the security-hint term "${term}"`,
        );
      }
    });

    it('carries a 20-25 item frozen acceptance contract sized for a 4-6-Story decomposition', () => {
      const s = loadScenario('epic-scope');
      assert.ok(
        s.seed.acceptance.length >= 20 && s.seed.acceptance.length <= 25,
        `expected 20-25 acceptance criteria, got ${s.seed.acceptance.length}`,
      );
    });
  });
});

describe('machine-readable story-count contract (Epic #86, Story #95)', () => {
  // The plan-quality axis (bench/score/plan-quality.js) reads decomposition
  // sanity from a MACHINE-READABLE `storyCountContract` on each scenario spec —
  // NOT from prose. Epic-scope decomposes into 4-6 Stories; the story-routed
  // rungs stay a single standalone Story.
  for (const id of SCENARIO_IDS) {
    it(`${id}/scenario.json declares a well-formed storyCountContract`, () => {
      const s = loadScenario(id);
      const c = s.storyCountContract;
      assert.ok(c && typeof c === 'object', 'has a storyCountContract object');
      assert.equal(typeof c.mode, 'string');
      assert.ok(c.mode.length > 0, 'mode is non-empty');
      assert.ok(
        Number.isInteger(c.minStories) && c.minStories >= 1,
        'minStories is a positive integer',
      );
      assert.ok(
        Number.isInteger(c.maxStories) && c.maxStories >= c.minStories,
        'maxStories is an integer ≥ minStories',
      );
    });
  }

  it('epic-scope decomposes into 4-6 Stories (mode "epic")', () => {
    const c = loadScenario('epic-scope').storyCountContract;
    assert.equal(c.mode, 'epic');
    assert.equal(c.minStories, 4);
    assert.equal(c.maxStories, 6);
  });

  it('story-scope is a single standalone Story (mode "standalone")', () => {
    const c = loadScenario('story-scope').storyCountContract;
    assert.equal(c.mode, 'standalone');
    assert.equal(c.minStories, 1);
    assert.equal(c.maxStories, 1);
  });

  it('hello-world is a single standalone Story (mode "standalone")', () => {
    const c = loadScenario('hello-world').storyCountContract;
    assert.equal(c.mode, 'standalone');
    assert.equal(c.minStories, 1);
    assert.equal(c.maxStories, 1);
  });
});

describe('frozen oracles are pure w.r.t. the delivered app (AC2: frozen)', () => {
  for (const id of SCENARIO_IDS) {
    it(`${id}/acceptance.test.js imports nothing from the delivered app`, () => {
      const src = readFileSync(
        path.join(SCENARIOS_DIR, id, 'acceptance.test.js'),
        'utf8',
      );
      const importRe = /^\s*import\s[^;]*from\s+['"]([^'"]+)['"]/gm;
      const specs = [...src.matchAll(importRe)].map((m) => m[1]);
      for (const spec of specs) {
        // A frozen oracle may import node builtins only. Any relative or
        // bare third-party import would couple it to app or framework
        // internals and break the freeze.
        assert.ok(
          spec.startsWith('node:'),
          `frozen oracle ${id} must import only node: builtins, found "${spec}"`,
        );
      }
    });

    it(`${id}/acceptance.test.js exports a frozen criteria list and an evaluate()`, async () => {
      const mod = await import(
        `../../../bench/scenarios/${id}/acceptance.test.js`
      );
      assert.equal(typeof mod.evaluate, 'function');
      assert.ok(Array.isArray(mod.CRITERIA) && mod.CRITERIA.length > 0);
      assert.ok(Object.isFrozen(mod.CRITERIA), 'CRITERIA is frozen');

      // The oracle's criteria text matches the scenario seed exactly, so
      // the verdict the adapter builds lines up criterion for criterion.
      const seed = loadScenario(id);
      assert.deepEqual([...mod.CRITERIA], seed.seed.acceptance);
    });
  }

  it('rejects a non-string baseUrl', async () => {
    await assert.rejects(() => evaluateHello(''), TypeError);
    await assert.rejects(() => evaluateStoryScope(''), TypeError);
    await assert.rejects(() => evaluateEpicScope(''), TypeError);
  });
});

describe('frozen change requests — the second touch (Epic #86, Story #96)', () => {
  it('story-scope declares a frozen changeRequest (password change + session invalidation)', () => {
    const cr = loadScenario('story-scope').changeRequest;
    assert.ok(cr && typeof cr === 'object', 'story-scope has a changeRequest');
    assert.equal(cr.id, 'password-change');
    assert.equal(typeof cr.prompt, 'string');
    assert.ok(cr.prompt.length >= 40, 'change-request prompt is a real task');
    assert.equal(cr.acceptanceSuite, './acceptance.touch2.test.js');
  });

  it('epic-scope declares a frozen changeRequest (project sharing with role-based access)', () => {
    const cr = loadScenario('epic-scope').changeRequest;
    assert.ok(cr && typeof cr === 'object', 'epic-scope has a changeRequest');
    assert.equal(cr.id, 'project-sharing');
    assert.equal(typeof cr.prompt, 'string');
    assert.ok(cr.prompt.length >= 40, 'change-request prompt is a real task');
    assert.equal(cr.acceptanceSuite, './acceptance.touch2.test.js');
  });

  it('hello-world declares NO changeRequest (the driver skips touch 2 for it)', () => {
    const s = loadScenario('hello-world');
    assert.equal(
      s.changeRequest,
      undefined,
      'hello-world must not declare a second touch',
    );
  });

  for (const id of ['story-scope', 'epic-scope']) {
    it(`${id} change-request prompt contains no security-hint terms (trap headroom, §12)`, () => {
      const cr = loadScenario(id).changeRequest;
      const prompt = cr.prompt.replace(BENIGN_ENV_VAR_RE, '').toLowerCase();
      for (const term of SECURITY_HINT_TERMS) {
        assert.ok(
          !prompt.includes(term),
          `${id} change-request prompt leaks the hint term "${term}"`,
        );
      }
    });

    it(`${id}/acceptance.touch2.test.js imports only node: builtins (frozen)`, () => {
      const src = readFileSync(
        path.join(SCENARIOS_DIR, id, 'acceptance.touch2.test.js'),
        'utf8',
      );
      const importRe = /^\s*import\s[^;]*from\s+['"]([^'"]+)['"]/gm;
      const specs = [...src.matchAll(importRe)].map((m) => m[1]);
      for (const spec of specs) {
        assert.ok(
          spec.startsWith('node:'),
          `frozen touch-2 oracle ${id} must import only node: builtins, found "${spec}"`,
        );
      }
    });

    it(`${id}/acceptance.touch2.test.js exports a frozen CRITERIA list and an evaluate()`, async () => {
      const mod = await import(
        `../../../bench/scenarios/${id}/acceptance.touch2.test.js`
      );
      assert.equal(typeof mod.evaluate, 'function');
      assert.ok(Array.isArray(mod.CRITERIA) && mod.CRITERIA.length > 0);
      assert.ok(Object.isFrozen(mod.CRITERIA), 'touch-2 CRITERIA is frozen');
      await assert.rejects(() => mod.evaluate(''), TypeError);
    });
  }

  it('the story-scope touch-2 suite asserts session invalidation BEHAVIOURALLY (an old session → 401), not via a source scan', async () => {
    const mod = await import(
      '../../../bench/scenarios/story-scope/acceptance.touch2.test.js'
    );
    // Its criteria name the behavioural session-invalidation probe (old
    // credential rejected on GET /me), proving it is asserted over HTTP.
    const joined = mod.CRITERIA.join(' ').toLowerCase();
    assert.ok(
      joined.includes('session invalidation') && joined.includes('401'),
      'the touch-2 suite must assert session invalidation behaviourally',
    );
  });
});

// ---------------------------------------------------------------------------
// Touch-2 oracle DISCRIMINATION (audit H6). The touch-2 acceptance oracles'
// evaluate(baseUrl, {fetchImpl}) bodies (~150 lines of real fetch
// orchestration each) are the scoring instrument the persistence thesis rides
// on (touch2.outcome → continuity delta), but were previously covered only by
// shape/import checks + a STRING assertion on the criteria text. A bug (wrong
// criterion index, an always-met probe, a mis-mapped status) would silently
// mis-score touch-2 for BOTH arms with no failing test. These drive the real
// bodies against a COMPLIANT stub (all criteria met) and a REGRESSED stub
// (the touch-1 property broken), mirroring the touch-1 hello-world pattern.
// ---------------------------------------------------------------------------

/** A minimal JSON `Response` double the frozen touch-2 oracles consume. */
function jsonResponse(status, payload) {
  return {
    status,
    headers: { get: () => 'application/json' },
    async text() {
      return JSON.stringify(payload ?? {});
    },
    async json() {
      if (payload === undefined) throw new Error('no json');
      return payload;
    },
  };
}

/** Extract a Bearer token from a request init's headers, or null. */
function bearerToken(init) {
  const auth = init?.headers?.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice(7)
    : null;
}

/**
 * A stateful stub of the story-scope touch-2 app (password change + session
 * invalidation). `invalidateOnChange:false` regresses the touch-1 property —
 * the pre-change session keeps authenticating after the password change.
 */
function makeStoryScopeTouch2Fetch({ invalidateOnChange = true } = {}) {
  const users = new Map(); // username → password
  const sessions = new Map(); // token → username
  let seq = 0;
  return async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : {};
    const token = bearerToken(init);

    if (path.endsWith('/signup') && method === 'POST') {
      users.set(body.username, body.password);
      return jsonResponse(201, { ok: true });
    }
    if (path.endsWith('/login') && method === 'POST') {
      if (users.get(body.username) !== body.password) {
        return jsonResponse(401, { error: 'invalid credentials' });
      }
      const t = `sess-${seq++}`;
      sessions.set(t, body.username);
      return jsonResponse(200, { session: t });
    }
    if (path.endsWith('/password') && method === 'POST') {
      if (!token || !sessions.has(token)) {
        return jsonResponse(401, { error: 'no credential' });
      }
      if (!body.newPassword) return jsonResponse(400, { error: 'empty' });
      const username = sessions.get(token);
      users.set(username, body.newPassword);
      if (invalidateOnChange) {
        for (const [t, un] of [...sessions.entries()]) {
          if (un === username) sessions.delete(t);
        }
      }
      return jsonResponse(200, { ok: true });
    }
    if (path.endsWith('/me') && method === 'GET') {
      if (!token || !sessions.has(token)) {
        return jsonResponse(401, { error: 'no session' });
      }
      return jsonResponse(200, { username: sessions.get(token) });
    }
    throw new Error(`story-scope touch-2 stub: no route for ${method} ${path}`);
  };
}

describe('story-scope frozen touch-2 oracle behavior (audit H6)', () => {
  it('passes with all criteria met against a compliant password-change app', async () => {
    const mod = await import(
      '../../../bench/scenarios/story-scope/acceptance.touch2.test.js'
    );
    const result = await mod.evaluate('http://127.0.0.1:3000', {
      fetchImpl: makeStoryScopeTouch2Fetch({ invalidateOnChange: true }),
      uniqueSuffix: () => 'fixed',
    });
    assert.equal(result.scenario, 'story-scope');
    assert.equal(result.passed, true);
    assert.ok(
      result.criteria.every((c) => c.met),
      `unmet: ${result.criteria
        .filter((c) => !c.met)
        .map((c) => c.evidence)
        .join('; ')}`,
    );
  });

  it('fails the session-invalidation criterion when the old session still authenticates', async () => {
    const mod = await import(
      '../../../bench/scenarios/story-scope/acceptance.touch2.test.js'
    );
    const result = await mod.evaluate('http://127.0.0.1:3000', {
      fetchImpl: makeStoryScopeTouch2Fetch({ invalidateOnChange: false }),
      uniqueSuffix: () => 'fixed',
    });
    assert.equal(result.passed, false);
    // Criterion 1 is the behavioural session-invalidation probe (old
    // credential must be rejected on GET /me).
    const invalidation = result.criteria.find((c) => c.index === 1);
    assert.equal(invalidation.met, false);
    assert.ok(
      invalidation.evidence.includes('401'),
      'the regression evidence should name the expected 401',
    );
  });
});

/**
 * A stateful stub of the epic-scope touch-2 app (project sharing + role-based
 * access). `enforceViewerWrite:false` regresses the touch-1 property — a
 * viewer can create a task on the shared project.
 */
function makeEpicScopeTouch2Fetch({ enforceViewerWrite = true } = {}) {
  const users = new Map(); // username → { id, password }
  const tokens = new Map(); // token → userId
  const projects = new Map(); // projectId → ownerId
  const shares = new Map(); // projectId → Map(userId → role)
  let uid = 0;
  let tok = 0;
  let pid = 0;
  const relationship = (projectId, userId) => {
    if (projects.get(projectId) === userId) return 'owner';
    return shares.get(projectId)?.get(userId) ?? null;
  };
  return async (url, init = {}) => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : {};
    const userId = tokens.get(bearerToken(init) ?? '') ?? null;

    if (parts[0] === 'auth' && parts[1] === 'register' && method === 'POST') {
      const id = ++uid;
      users.set(body.username, { id, password: body.password });
      return jsonResponse(201, { id, username: body.username });
    }
    if (parts[0] === 'auth' && parts[1] === 'login' && method === 'POST') {
      const rec = users.get(body.username);
      if (!rec || rec.password !== body.password) {
        return jsonResponse(401, { error: 'invalid' });
      }
      const t = `tok-${tok++}`;
      tokens.set(t, rec.id);
      return jsonResponse(200, { token: t });
    }
    if (parts[0] === 'projects' && parts.length === 1 && method === 'POST') {
      const id = ++pid;
      projects.set(id, userId);
      return jsonResponse(201, { id, name: body.name, ownerId: userId });
    }
    if (parts[0] === 'projects' && parts.length >= 2) {
      const projectId = Number(parts[1]);
      const rel = relationship(projectId, userId);
      // POST /projects/:id/shares — owner only.
      if (parts[2] === 'shares' && method === 'POST') {
        if (rel !== 'owner') return jsonResponse(404, { error: 'not found' });
        if (!shares.has(projectId)) shares.set(projectId, new Map());
        shares.get(projectId).set(body.userId, body.role);
        return jsonResponse(201, { ok: true });
      }
      // /projects/:id/tasks
      if (parts[2] === 'tasks') {
        if (method === 'GET') {
          return rel
            ? jsonResponse(200, { items: [], total: 0, page: 1, pageSize: 20 })
            : jsonResponse(404, { error: 'not found' });
        }
        if (method === 'POST') {
          if (rel === 'owner' || rel === 'editor') {
            return jsonResponse(201, { id: 1, title: body.title });
          }
          if (rel === 'viewer') {
            return enforceViewerWrite
              ? jsonResponse(403, { error: 'forbidden' })
              : jsonResponse(201, { id: 1, title: body.title });
          }
          return jsonResponse(404, { error: 'not found' });
        }
      }
      // GET /projects/:id
      if (parts.length === 2 && method === 'GET') {
        return rel
          ? jsonResponse(200, { id: projectId })
          : jsonResponse(404, { error: 'not found' });
      }
    }
    throw new Error(
      `epic-scope touch-2 stub: no route for ${method} /${parts.join('/')}`,
    );
  };
}

describe('epic-scope frozen touch-2 oracle behavior (audit H6)', () => {
  let suffix = 0;
  const uniqueSuffix = () => `u${suffix++}`;

  it('passes with all criteria met against a compliant role-based-access app', async () => {
    suffix = 0;
    const mod = await import(
      '../../../bench/scenarios/epic-scope/acceptance.touch2.test.js'
    );
    const result = await mod.evaluate('http://127.0.0.1:3000', {
      fetchImpl: makeEpicScopeTouch2Fetch({ enforceViewerWrite: true }),
      uniqueSuffix,
    });
    assert.equal(result.scenario, 'epic-scope');
    assert.equal(result.passed, true);
    assert.ok(
      result.criteria.every((c) => c.met),
      `unmet: ${result.criteria
        .filter((c) => !c.met)
        .map((c) => c.evidence)
        .join('; ')}`,
    );
  });

  it('fails the viewer-write criterion when a viewer can create a task', async () => {
    suffix = 0;
    const mod = await import(
      '../../../bench/scenarios/epic-scope/acceptance.touch2.test.js'
    );
    const result = await mod.evaluate('http://127.0.0.1:3000', {
      fetchImpl: makeEpicScopeTouch2Fetch({ enforceViewerWrite: false }),
      uniqueSuffix,
    });
    assert.equal(result.passed, false);
    // Criterion 2 is the viewer-may-NOT-write probe (a non-2xx denial).
    const viewerWrite = result.criteria.find((c) => c.index === 2);
    assert.equal(viewerWrite.met, false);
  });
});

describe('hello-world frozen oracle behavior', () => {
  it('passes when the delivered page returns 200 text/html with the text', async () => {
    const fetchImpl = stubFetch([
      {
        when: (u) => u.endsWith('/'),
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        text: '<!doctype html><h1>Hello, World!</h1>',
      },
    ]);
    const result = await evaluateHello('http://127.0.0.1:3000', { fetchImpl });
    assert.equal(result.scenario, 'hello-world');
    assert.equal(result.passed, true);
    assert.equal(result.criteria.length, 3);
    assert.ok(result.criteria.every((c) => c.met));
    // Criteria are returned in seed order.
    assert.deepEqual(
      result.criteria.map((c) => c.index),
      [0, 1, 2],
    );
  });

  it('fails each criterion when the body lacks the text / wrong type / wrong status', async () => {
    const fetchImpl = stubFetch([
      {
        when: (u) => u.endsWith('/'),
        status: 500,
        headers: { 'content-type': 'application/json' },
        text: 'nope',
      },
    ]);
    const result = await evaluateHello('http://127.0.0.1:3000', { fetchImpl });
    assert.equal(result.passed, false);
    assert.deepEqual(
      result.criteria.map((c) => c.met),
      [false, false, false],
    );
  });

  it('does not throw when the app is unreachable; reports a transport failure', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await evaluateHello('http://127.0.0.1:3000', { fetchImpl });
    assert.equal(result.passed, false);
    assert.ok(result.criteria[0].evidence.includes('ECONNREFUSED'));
  });

  it('is deterministic — identical inputs yield identical output', async () => {
    const make = () =>
      stubFetch([
        {
          when: (u) => u.endsWith('/'),
          status: 200,
          headers: { 'content-type': 'text/html' },
          text: 'Hello, World!',
        },
      ]);
    const a = await evaluateHello('http://h', { fetchImpl: make() });
    const b = await evaluateHello('http://h', { fetchImpl: make() });
    assert.deepEqual(a, b);
  });
});

describe('story-scope frozen oracle behavior', () => {
  // A dynamic fetch stub modelling a conforming persisted-auth + per-user
  // notes backend, so the full signup/login/me/notes round-trip (including
  // cross-user isolation) can be driven deterministically without a server.
  function makeStoryScopeFetch() {
    const users = new Map(); // username → { id, username, password }
    const sessions = new Map(); // session → userId
    const notes = new Map(); // noteId → { id, title, body, ownerId }
    let seq = 0;

    const send = (status, json) => ({
      status,
      headers: { get: () => 'application/json' },
      async text() {
        return json === undefined ? '' : JSON.stringify(json);
      },
      async json() {
        if (json === undefined) throw new Error('no json');
        return json;
      },
    });

    const authUser = (init) => {
      const auth = init?.headers?.authorization ?? '';
      const session = auth.replace(/^Bearer\s+/i, '');
      return session ? sessions.get(session) : undefined;
    };

    return async (url, init = {}) => {
      const u = new URL(String(url));
      const method = (init.method ?? 'GET').toUpperCase();
      const body = init.body ? JSON.parse(init.body) : undefined;

      if (u.pathname === '/signup' && method === 'POST') {
        const ok =
          typeof body?.username === 'string' &&
          body.username.length > 0 &&
          typeof body?.password === 'string' &&
          body.password.length > 0;
        if (!ok) return send(400, { error: 'invalid' });
        if (users.has(body.username)) return send(409, { error: 'duplicate' });
        const id = `user-${++seq}`;
        users.set(body.username, {
          id,
          username: body.username,
          password: body.password,
        });
        return send(201, { id, username: body.username });
      }

      if (u.pathname === '/login' && method === 'POST') {
        const user = users.get(body?.username);
        if (!user || user.password !== body?.password)
          return send(401, { error: 'unauthorized' });
        const session = `sess-${++seq}`;
        sessions.set(session, user.id);
        return send(200, { session });
      }

      if (u.pathname === '/me' && method === 'GET') {
        const userId = authUser(init);
        if (userId === undefined) return send(401, { error: 'unauthorized' });
        const user = [...users.values()].find((x) => x.id === userId);
        return send(200, { id: user.id, username: user.username });
      }

      if (u.pathname === '/notes' && method === 'POST') {
        const userId = authUser(init);
        if (userId === undefined) return send(401, { error: 'unauthorized' });
        const ok = typeof body?.title === 'string' && body.title.length > 0;
        if (!ok) return send(400, { error: 'invalid' });
        const id = `note-${++seq}`;
        const note = {
          id,
          title: body.title,
          body: body.body,
          ownerId: userId,
        };
        notes.set(id, note);
        return send(201, note);
      }

      if (u.pathname === '/notes' && method === 'GET') {
        const userId = authUser(init);
        if (userId === undefined) return send(401, { error: 'unauthorized' });
        const own = [...notes.values()].filter((n) => n.ownerId === userId);
        return send(200, own);
      }

      return send(404, { error: 'route not found' });
    };
  }

  it('passes the full signup/login/me/notes round-trip against a conforming, isolating backend', async () => {
    const result = await evaluateStoryScope('http://127.0.0.1:3000', {
      fetchImpl: makeStoryScopeFetch(),
      uniqueSuffix: (() => {
        let n = 0;
        return () => `fixed-${++n}`;
      })(),
    });
    assert.equal(result.scenario, 'story-scope');
    assert.equal(
      result.passed,
      true,
      `unmet: ${result.criteria
        .filter((c) => !c.met)
        .map((c) => `[${c.index}] ${c.criterion} — ${c.evidence}`)
        .join('; ')}`,
    );
    assert.equal(result.criteria.length, 6);
    assert.deepEqual(
      result.criteria.map((c) => c.index),
      [0, 1, 2, 3, 4, 5],
    );
  });

  it("flags the cross-user isolation criterion when the backend leaks another user's notes", async () => {
    // A backend that returns ALL notes regardless of owner fails criterion 5.
    const base = makeStoryScopeFetch();
    const fetchImpl = async (url, init = {}) => {
      const res = await base(url, init);
      const u = new URL(String(url));
      if (
        u.pathname === '/notes' &&
        (init.method ?? 'GET').toUpperCase() === 'GET'
      ) {
        // Re-fetch with a fabricated admin-like override that leaks all
        // notes: simulate by wrapping the json() to append a foreign note.
        const original = await res.json();
        const leaked = [
          ...original,
          {
            id: 'leak',
            title: 'B note',
            body: 'leaked',
            ownerId: 'someone-else',
          },
        ];
        return {
          status: res.status,
          headers: res.headers,
          async text() {
            return JSON.stringify(leaked);
          },
          async json() {
            return leaked;
          },
        };
      }
      return res;
    };
    const result = await evaluateStoryScope('http://127.0.0.1:3000', {
      fetchImpl,
      uniqueSuffix: (() => {
        let n = 0;
        return () => `leak-${++n}`;
      })(),
    });
    const c5 = result.criteria.find((c) => c.index === 5);
    assert.equal(
      c5.met,
      false,
      'criterion 5 (cross-user notes isolation) should be unmet',
    );
    assert.equal(result.passed, false);
  });

  it('does not throw when the backend is unreachable', async () => {
    const result = await evaluateStoryScope('http://127.0.0.1:3000', {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(result.passed, false);
    assert.equal(result.criteria.length, 6);
    assert.ok(result.criteria[0].evidence.includes('ECONNREFUSED'));
  });
});

describe('epic-scope frozen oracle behavior', () => {
  // A dynamic fetch stub modelling a conforming, isolating multi-user
  // project/task backend, so the full auth + project + task round-trip
  // (including per-user ownership scoping, pagination, filtering, cascade
  // delete, and a consistent error envelope) can be driven deterministically
  // without a real server.
  function makeEpicScopeFetch({ leakCrossOwnerReads = false } = {}) {
    const users = new Map(); // username → { id, username, password }
    const tokens = new Map(); // token → userId
    const projects = new Map(); // projectId → { id, name, ownerId, createdAt }
    const tasks = new Map(); // taskId → { id, title, projectId, assigneeId, createdAt, done }
    let seq = 0;

    const send = (status, json) => ({
      status,
      headers: { get: () => 'application/json' },
      async text() {
        return json === undefined ? '' : JSON.stringify(json);
      },
      async json() {
        if (json === undefined) throw new Error('no json');
        return json;
      },
    });
    const err = (status, message) => send(status, { error: message });

    const authUser = (init) => {
      const auth = init?.headers?.authorization ?? '';
      const token = auth.replace(/^Bearer\s+/i, '');
      return token ? tokens.get(token) : undefined;
    };

    const ownedProject = (id, userId) => {
      const p = projects.get(id);
      return p && p.ownerId === userId ? p : undefined;
    };

    return async (url, init = {}) => {
      const u = new URL(String(url));
      const parts = u.pathname.split('/').filter(Boolean);
      const method = (init.method ?? 'GET').toUpperCase();
      let body;
      if (init.body) {
        try {
          body = JSON.parse(init.body);
        } catch {
          // A conforming backend rejects a syntactically malformed JSON body
          // with a 4xx rather than crashing (criterion 22's robustness probe).
          return err(400, 'malformed JSON body');
        }
      }

      if (parts[0] === 'auth' && parts[1] === 'register' && method === 'POST') {
        const ok =
          typeof body?.username === 'string' &&
          body.username.length > 0 &&
          typeof body?.password === 'string' &&
          body.password.length > 0;
        if (!ok) return err(400, 'invalid');
        if (users.has(body.username)) return err(409, 'duplicate');
        const id = `user-${++seq}`;
        users.set(body.username, {
          id,
          username: body.username,
          password: body.password,
        });
        return send(201, { id, username: body.username });
      }

      if (parts[0] === 'auth' && parts[1] === 'login' && method === 'POST') {
        const user = users.get(body?.username);
        if (!user || user.password !== body?.password)
          return err(401, 'unauthorized');
        const token = `tok-${++seq}`;
        tokens.set(token, user.id);
        return send(200, { token });
      }

      const userId = authUser(init);
      if (userId === undefined) return err(401, 'unauthorized');

      if (parts[0] === 'projects' && parts.length === 1 && method === 'POST') {
        const ok = typeof body?.name === 'string' && body.name.length > 0;
        if (!ok) return err(400, 'invalid');
        const id = `proj-${++seq}`;
        const project = {
          id,
          name: body.name,
          ownerId: userId,
          createdAt: '2026-01-01T00:00:00Z',
        };
        projects.set(id, project);
        return send(201, project);
      }

      if (parts[0] === 'projects' && parts.length === 1 && method === 'GET') {
        return send(
          200,
          [...projects.values()].filter((p) => p.ownerId === userId),
        );
      }

      if (parts[0] === 'projects' && parts.length === 2 && method === 'GET') {
        const pid = decodeURIComponent(parts[1]);
        // The leaky variant deliberately skips ownership scoping — any
        // authenticated user can read any project by id — to prove
        // criterion 11 (cross-user read isolation) actually fails when the
        // ownership check is missing.
        const project = leakCrossOwnerReads
          ? projects.get(pid)
          : ownedProject(pid, userId);
        return project ? send(200, project) : err(404, 'not found');
      }

      if (
        parts[0] === 'projects' &&
        parts.length === 2 &&
        method === 'DELETE'
      ) {
        const pid = decodeURIComponent(parts[1]);
        const project = ownedProject(pid, userId);
        if (!project) return err(404, 'not found');
        projects.delete(pid);
        for (const [tid, t] of tasks) {
          if (t.projectId === pid) tasks.delete(tid);
        }
        return send(204);
      }

      if (
        parts[0] === 'projects' &&
        parts[2] === 'tasks' &&
        parts.length === 3 &&
        method === 'POST'
      ) {
        const pid = decodeURIComponent(parts[1]);
        if (!ownedProject(pid, userId)) return err(404, 'not found');
        const ok = typeof body?.title === 'string' && body.title.length > 0;
        if (!ok) return err(400, 'invalid');
        if (body?.assigneeId !== undefined && body.assigneeId !== null) {
          const known = [...users.values()].some(
            (u2) => u2.id === body.assigneeId,
          );
          if (!known) return err(400, 'unknown assigneeId');
        }
        const id = `task-${++seq}`;
        const task = {
          id,
          title: body.title,
          projectId: pid,
          assigneeId: body?.assigneeId ?? null,
          createdAt: '2026-01-01T00:00:00Z',
          done: false,
        };
        tasks.set(id, task);
        return send(201, task);
      }

      if (
        parts[0] === 'projects' &&
        parts[2] === 'tasks' &&
        parts.length === 3 &&
        method === 'GET'
      ) {
        const pid = decodeURIComponent(parts[1]);
        if (!ownedProject(pid, userId)) return err(404, 'not found');
        const page = Math.max(
          1,
          parseInt(u.searchParams.get('page') ?? '1', 10) || 1,
        );
        const pageSize = Math.min(
          100,
          Math.max(
            1,
            parseInt(u.searchParams.get('pageSize') ?? '20', 10) || 20,
          ),
        );
        const doneFilter = u.searchParams.get('done');
        let all = [...tasks.values()].filter((t) => t.projectId === pid);
        if (doneFilter === 'true') all = all.filter((t) => t.done === true);
        if (doneFilter === 'false') all = all.filter((t) => t.done === false);
        const items = all.slice((page - 1) * pageSize, page * pageSize);
        return send(200, { items, total: all.length, page, pageSize });
      }

      if (
        parts[0] === 'projects' &&
        parts[2] === 'tasks' &&
        parts.length === 4 &&
        method === 'PATCH'
      ) {
        const pid = decodeURIComponent(parts[1]);
        const tid = decodeURIComponent(parts[3]);
        if (!ownedProject(pid, userId)) return err(404, 'not found');
        const task = tasks.get(tid);
        if (!task || task.projectId !== pid) return err(404, 'not found');
        const updated = { ...task };
        if (body?.title !== undefined) updated.title = body.title;
        if (body?.done !== undefined) updated.done = body.done;
        tasks.set(tid, updated);
        return send(200, updated);
      }

      if (
        parts[0] === 'projects' &&
        parts[2] === 'tasks' &&
        parts.length === 4 &&
        method === 'DELETE'
      ) {
        const pid = decodeURIComponent(parts[1]);
        const tid = decodeURIComponent(parts[3]);
        if (!ownedProject(pid, userId)) return err(404, 'not found');
        const task = tasks.get(tid);
        if (!task || task.projectId !== pid) return err(404, 'not found');
        tasks.delete(tid);
        return send(204);
      }

      return err(404, 'route not found');
    };
  }

  it('passes the full multi-user auth + project + task round-trip against a conforming, isolating backend', async () => {
    const result = await evaluateEpicScope('http://127.0.0.1:3000', {
      fetchImpl: makeEpicScopeFetch(),
      uniqueSuffix: (() => {
        let n = 0;
        return () => `fixed-${++n}`;
      })(),
    });
    assert.equal(result.scenario, 'epic-scope');
    assert.equal(
      result.passed,
      true,
      `unmet: ${result.criteria
        .filter((c) => !c.met)
        .map((c) => `[${c.index}] ${c.criterion} — ${c.evidence}`)
        .join('; ')}`,
    );
    assert.equal(result.criteria.length, 24);
    assert.deepEqual(
      result.criteria.map((c) => c.index),
      Array.from({ length: 24 }, (_, i) => i),
    );
  });

  it("flags the isolation criterion when the backend leaks another user's project by id", async () => {
    // A backend that returns ANY project by id regardless of ownership fails
    // criterion 11 (cross-user read isolation).
    const result = await evaluateEpicScope('http://127.0.0.1:3000', {
      fetchImpl: makeEpicScopeFetch({ leakCrossOwnerReads: true }),
      uniqueSuffix: (() => {
        let n = 0;
        return () => `iso-${++n}`;
      })(),
    });
    const c11 = result.criteria.find((c) => c.index === 11);
    assert.equal(
      c11.met,
      false,
      'criterion 11 (cross-user read isolation) should be unmet',
    );
    assert.equal(result.passed, false);
  });

  it('flags the pagination criterion when the backend ignores pageSize', async () => {
    const base = makeEpicScopeFetch();
    const fetchImpl = async (url, init = {}) => {
      const u = new URL(String(url));
      const res = await base(url, init);
      if (
        u.pathname.includes('/tasks') &&
        (init.method ?? 'GET').toUpperCase() === 'GET' &&
        u.searchParams.has('pageSize')
      ) {
        const payload = await res.json();
        if (Array.isArray(payload?.items)) {
          // Wrongly ignore pageSize and return everything.
          return {
            status: res.status,
            headers: res.headers,
            async text() {
              return JSON.stringify({ ...payload, pageSize: 2 });
            },
            async json() {
              return {
                ...payload,
                pageSize: 2,
                items: [...payload.items, ...payload.items],
              };
            },
          };
        }
      }
      return res;
    };
    const result = await evaluateEpicScope('http://127.0.0.1:3000', {
      fetchImpl,
      uniqueSuffix: (() => {
        let n = 0;
        return () => `page-${++n}`;
      })(),
    });
    const c18 = result.criteria.find((c) => c.index === 18);
    assert.equal(c18.met, false, 'pagination criterion should be unmet');
  });

  it('does not throw when the backend is unreachable', async () => {
    const result = await evaluateEpicScope('http://127.0.0.1:3000', {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(result.passed, false);
    assert.equal(result.criteria.length, 24);
    assert.ok(result.criteria[0].evidence.includes('ECONNREFUSED'));
  });
});

describe('acceptance-eval cross-check adapter (AC3)', () => {
  const frozenPass = {
    scenario: 'hello-world',
    passed: true,
    criteria: [
      { index: 0, criterion: 'a', met: true, evidence: 'ok-a' },
      { index: 1, criterion: 'b', met: true, evidence: 'ok-b' },
    ],
  };
  const frozenFail = {
    scenario: 'hello-world',
    passed: false,
    criteria: [
      { index: 0, criterion: 'a', met: true, evidence: 'ok-a' },
      { index: 1, criterion: 'b', met: false, evidence: 'bad-b' },
    ],
  };

  it('lifts a frozen result into a schema-valid acceptance-eval verdict', () => {
    const verdict = buildVerdictFromFrozenResult({
      frozenResult: frozenFail,
      storyId: 4214,
      epicId: 4211,
    });
    assert.equal(verdict.storyId, 4214);
    assert.equal(verdict.epicId, 4211);
    assert.equal(verdict.schemaVersion, 1);
    assert.equal(verdict.round, 1);
    assert.equal(verdict.criteria.length, 2);
    assert.equal(verdict.criteria[0].verdict, 'met');
    assert.equal(verdict.criteria[1].verdict, 'unmet');
    assert.equal(verdict.criteria[1].evidence, 'bad-b');
    // verify[]-as-evidence is carried so the cross-check sees the probe.
    assert.equal(verdict.criteria[0].verifyEvidence[0].outcome, 'pass');
    assert.equal(verdict.criteria[1].verifyEvidence[0].outcome, 'fail');
  });

  it('the lifted verdict actually validates against the real verdict schema', async () => {
    // Use the same gate validator the production cross-check uses, so this
    // is a genuine contract assertion, not a re-implementation.
    const { validateVerdict } = await import(
      '../../../.agents/scripts/acceptance-eval.js'
    );
    const verdict = buildVerdictFromFrozenResult({
      frozenResult: frozenPass,
      storyId: 4214,
      epicId: 4211,
    });
    assert.doesNotThrow(() => validateVerdict(verdict));
  });

  it('invokes the existing cross-check in-process and returns its verdict alongside the frozen result', async () => {
    // Inject the gate so we assert the wiring (the verdict reaches the
    // gate; the gate decision reaches the caller) without exercising the
    // gate's own decision logic here.
    let received = null;
    const runGateFn = async (args) => {
      received = args;
      return {
        envelope: { decision: 'proceed', metCount: 2, totalCriteria: 2 },
        exitCode: 0,
      };
    };
    const out = await scoreScenarioQuality({
      evaluate: async () => frozenPass,
      baseUrl: 'http://127.0.0.1:3000',
      storyId: 4214,
      epicId: 4211,
      transport: 'in-process',
      runGateFn,
    });
    // The cross-check received the lifted verdict.
    assert.ok(received, 'gate was invoked');
    assert.equal(received.verdict.storyId, 4214);
    assert.equal(
      received.emitSignal,
      false,
      'benchmark probe suppresses the signal emit',
    );
    // The combined result carries BOTH faces of the Quality score.
    assert.equal(out.scenario, 'hello-world');
    assert.equal(out.frozen.passed, true);
    assert.equal(out.crossCheck.decision, 'proceed');
    assert.equal(out.agree, true);
  });

  it('reports disagreement when the frozen suite fails but the cross-check would proceed', async () => {
    const runGateFn = async () => ({
      envelope: { decision: 'proceed' },
      exitCode: 0,
    });
    const out = await scoreScenarioQuality({
      evaluate: async () => frozenFail,
      baseUrl: 'http://127.0.0.1:3000',
      storyId: 4214,
      epicId: 4211,
      transport: 'in-process',
      runGateFn,
    });
    assert.equal(out.frozen.passed, false);
    assert.equal(out.crossCheck.decision, 'proceed');
    assert.equal(out.agree, false);
  });

  it('CLI transport spawns acceptance-eval.js with --no-signal and parses its envelope', () => {
    let spawnArgs = null;
    const spawnFn = (exe, args) => {
      spawnArgs = { exe, args };
      return {
        status: 0,
        stdout:
          'some log line\n' +
          JSON.stringify(
            { storyId: 4214, decision: 'proceed', metCount: 2 },
            null,
            2,
          ),
      };
    };
    const verdict = buildVerdictFromFrozenResult({
      frozenResult: frozenPass,
      storyId: 4214,
      epicId: 4211,
    });
    const out = runCrossCheckViaCli({
      verdict,
      storyId: 4214,
      epicId: 4211,
      spawnFn,
    });
    assert.ok(
      spawnArgs.args.includes('--no-signal'),
      'CLI probe is side-effect free',
    );
    assert.ok(spawnArgs.args.includes('--story'));
    assert.ok(spawnArgs.args.includes('4214'));
    assert.ok(spawnArgs.args.includes('--epic'));
    assert.equal(out.decision, 'proceed');
    assert.equal(out.exitCode, 0);
  });
});

describe('parseGateEnvelope', () => {
  it('extracts the trailing JSON envelope from mixed stdout', () => {
    const stdout =
      '[Orchestrator] noise\n' +
      JSON.stringify({ decision: 'block', a: 1 }, null, 2);
    assert.deepEqual(parseGateEnvelope(stdout), { decision: 'block', a: 1 });
  });

  it('returns null for empty / unparseable stdout', () => {
    assert.equal(parseGateEnvelope(''), null);
    assert.equal(parseGateEnvelope('not json at all'), null);
  });
});
