// tests/bench/scenarios/brownfield-longitudinal/conventions.test.js
/**
 * Discrimination tests for the four Ledgerline convention grep-oracles
 * (issue #124, PR-B; design §4 — "each with a mandatory discrimination
 * test").
 *
 * Every oracle is exercised against three in-memory fixture TREES (fed
 * through the same `fsImpl` port `scanTree`/`collectSourceFiles` expose,
 * so the full path-aware verdict logic runs without touching disk):
 *
 *   - a CLEAN tree — convention followed ⇒ clean, no findings;
 *   - a VIOLATING tree — convention broken ⇒ findings with file:line;
 *   - a COMPLIANT-BUT-PATTERN-MATCHING tree — the epic-r2 idor
 *     false-positive regression shape: the violating pattern appears only
 *     in a comment, a string literal, a test file, or a file the
 *     convention explicitly allows (a `*.repo.js` importing the db handle
 *     merely to re-export it) ⇒ MUST stay clean.
 *
 * Plus the anchoring case: the frozen seed itself is clean under all four
 * oracles — the baseline defines the instrument's zero.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluate as evaluateErrorEnvelope } from '../../../../bench/scenarios/brownfield-longitudinal/conventions/error-envelope.js';
import { evaluate as evaluateLayering } from '../../../../bench/scenarios/brownfield-longitudinal/conventions/layering.js';
import { evaluate as evaluateMoneyInteger } from '../../../../bench/scenarios/brownfield-longitudinal/conventions/money-integer.js';
import { evaluate as evaluateValidationCall } from '../../../../bench/scenarios/brownfield-longitudinal/conventions/validation-call.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'bench',
  'scenarios',
  'brownfield-longitudinal',
  'sandbox',
);

const FIXTURE_ROOT = '/fixture';

/**
 * Build a `{ readdirSync, readFileSync }` port over an in-memory tree
 * keyed by paths relative to FIXTURE_ROOT — a real tree as far as the
 * oracles' walker is concerned.
 */
function fsFromTree(tree) {
  const files = new Map();
  const dirs = new Set([FIXTURE_ROOT]);
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(FIXTURE_ROOT, rel);
    files.set(abs, content);
    let dir = path.dirname(abs);
    while (!dirs.has(dir)) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  return {
    readdirSync(dir) {
      if (!dirs.has(dir)) {
        throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' });
      }
      const names = new Map();
      for (const file of files.keys()) {
        if (path.dirname(file) === dir) names.set(path.basename(file), 'file');
      }
      for (const sub of dirs) {
        if (path.dirname(sub) === dir) names.set(path.basename(sub), 'dir');
      }
      return [...names.entries()].map(([name, kind]) => ({
        name,
        isDirectory: () => kind === 'dir',
        isFile: () => kind === 'file',
      }));
    },
    readFileSync(file) {
      if (!files.has(file)) {
        throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      }
      return files.get(file);
    },
  };
}

function run(evaluate, tree) {
  return evaluate(FIXTURE_ROOT, { fsImpl: fsFromTree(tree) });
}

describe('the frozen seed is clean under all four convention oracles', () => {
  for (const [name, evaluate] of [
    ['error-envelope', evaluateErrorEnvelope],
    ['layering', evaluateLayering],
    ['validation-call', evaluateValidationCall],
    ['money-integer', evaluateMoneyInteger],
  ]) {
    it(`${name}: the seed baseline has zero findings`, () => {
      const result = evaluate(SANDBOX_DIR);
      assert.equal(result.class, name);
      assert.deepEqual(
        result.findings,
        [],
        `seed not clean: ${result.findings}`,
      );
      assert.equal(result.clean, true);
    });
  }
});

describe('error-envelope oracle', () => {
  it('clean: errors flow through sendError from src/lib/errors.js', () => {
    const result = run(evaluateErrorEnvelope, {
      'src/lib/errors.js': [
        'export function sendError(res, status, code, message) {',
        "  res.writeHead(status, { 'content-type': 'application/json' });",
        '  res.end(JSON.stringify({ error: { code, message } }));',
        '}',
      ].join('\n'),
      'src/routes/widgets.routes.js': [
        "import { sendError } from '../lib/errors.js';",
        'export function registerWidgetRoutes(router) {',
        "  router.add('GET', '/widgets/:id', (req, res) => {",
        "    sendError(res, 404, 'E_NOT_FOUND', 'widget not found');",
        '  });',
        '}',
      ].join('\n'),
    });
    assert.equal(result.clean, true);
    assert.deepEqual(result.findings, []);
  });

  it('violating: a hand-rolled envelope and raw 4xx writeHead are flagged with file:line', () => {
    const result = run(evaluateErrorEnvelope, {
      'src/routes/widgets.routes.js': [
        'export function registerWidgetRoutes(router) {',
        "  router.add('GET', '/widgets/:id', (req, res) => {",
        "    res.writeHead(404, { 'content-type': 'application/json' });",
        "    res.end(JSON.stringify({ error: { code: 'E_NOT_FOUND', message: 'nope' } }));",
        '  });',
        '}',
      ].join('\n'),
    });
    assert.equal(result.clean, false);
    assert.ok(
      result.findings.some((f) =>
        f.startsWith('src/routes/widgets.routes.js:3'),
      ),
    );
    assert.ok(
      result.findings.some((f) =>
        f.startsWith('src/routes/widgets.routes.js:4'),
      ),
    );
  });

  it('regression (epic-r2 shape): envelope literals in comments, strings and test files stay clean', () => {
    const result = run(evaluateErrorEnvelope, {
      'src/lib/errors.js': 'export function sendError() {}\n',
      'src/routes/widgets.routes.js': [
        "import { sendError } from '../lib/errors.js';",
        '// Example body: { error: { code: "E_NOT_FOUND", message: "…" } }',
        'const DOCS_SNIPPET =',
        '  \'a 404 body looks like {"error":{"code":"E_NOT_FOUND"}} — see docs\';',
        '/* never do res.writeHead(500) by hand */',
        'export function registerWidgetRoutes(router) {',
        "  router.add('GET', '/widgets', (req, res) => sendError(res, 404, 'E_NOT_FOUND', DOCS_SNIPPET));",
        '}',
      ].join('\n'),
      'tests/widgets.test.js': [
        "test('shape', () => {",
        "  assert.deepEqual(res.body, { error: { code: 'E_NOT_FOUND', message: 'x' } });",
        '  res.writeHead(404);',
        '});',
      ].join('\n'),
    });
    assert.equal(result.clean, true, JSON.stringify(result.findings));
  });
});

describe('layering oracle', () => {
  it('clean: only repositories import the db handle; routes/services stay SQL-free', () => {
    const result = run(evaluateLayering, {
      'src/repositories/widgets.repo.js': [
        "import { getDb } from '../lib/db.js';",
        'export function findWidget(id) {',
        "  return getDb().prepare('SELECT * FROM widgets WHERE id = ?').get(id);",
        '}',
      ].join('\n'),
      'src/services/widgets.service.js': [
        "import { findWidget } from '../repositories/widgets.repo.js';",
        'export function getWidget(id) { return findWidget(id); }',
      ].join('\n'),
    });
    assert.equal(result.clean, true);
    assert.deepEqual(result.findings, []);
  });

  it('violating: a db import in a service and inline SQL in a route are flagged', () => {
    const result = run(evaluateLayering, {
      'src/services/widgets.service.js': [
        "import { getDb } from '../lib/db.js';",
        'export function getWidget(id) {',
        "  return getDb().prepare('SELECT * FROM widgets WHERE id = ?').get(id);",
        '}',
      ].join('\n'),
      'src/routes/widgets.routes.js': [
        'export function registerWidgetRoutes(router, db) {',
        "  router.add('GET', '/widgets', (req, res) => {",
        "    const rows = db.prepare('SELECT id FROM widgets WHERE active = 1').all();",
        '    res.end(JSON.stringify(rows));',
        '  });',
        '}',
      ].join('\n'),
    });
    assert.equal(result.clean, false);
    assert.ok(
      result.findings.some(
        (f) =>
          f.startsWith('src/services/widgets.service.js:1') &&
          f.includes('imports src/lib/db.js'),
      ),
    );
    assert.ok(result.findings.some((f) => f.includes('db-handle usage')));
    assert.ok(
      result.findings.some(
        (f) =>
          f.startsWith('src/routes/widgets.routes.js:') &&
          f.includes('SQL statement text'),
      ),
    );
  });

  it('regression (epic-r2 shape): a re-exporting *.repo.js, a commented-out import and SQL-ish prose stay clean', () => {
    const result = run(evaluateLayering, {
      // Compliant by the convention's letter: it IS a repository file, even
      // though it only re-exports the handle.
      'src/repositories/base.repo.js': [
        "import { getDb } from '../lib/db.js';",
        'export { getDb };',
      ].join('\n'),
      'src/services/widgets.service.js': [
        "// import { getDb } from '../lib/db.js'; — moved to the repo layer",
        "import { findWidget } from '../repositories/widgets.repo.js';",
        'export function getWidget(id) {',
        '  if (!findWidget(id)) {',
        "    throw new Error('Select an item from the list first');",
        '  }',
        '  return findWidget(id);',
        '}',
      ].join('\n'),
    });
    assert.equal(result.clean, true, JSON.stringify(result.findings));
  });
});

describe('validation-call oracle', () => {
  it('clean: a write route file calling validate(body, schema)', () => {
    const result = run(evaluateValidationCall, {
      'src/routes/widgets.routes.js': [
        "import { validate } from '../lib/validate.js';",
        "import { widgetSchema } from '../schemas/widget.schema.js';",
        'export function registerWidgetRoutes(router) {',
        "  router.add('POST', '/widgets', (req, res) => {",
        '    const problems = validate(req.body, widgetSchema);',
        '    if (problems.length > 0) return;',
        '  });',
        '}',
      ].join('\n'),
    });
    assert.equal(result.clean, true);
    assert.deepEqual(result.findings, []);
  });

  it('violating: a write route file with no validate() call is flagged', () => {
    const result = run(evaluateValidationCall, {
      'src/routes/widgets.routes.js': [
        'export function registerWidgetRoutes(router) {',
        "  router.add('POST', '/widgets', (req, res) => {",
        '    res.end(JSON.stringify(req.body));',
        '  });',
        '}',
      ].join('\n'),
    });
    assert.equal(result.clean, false);
    assert.equal(result.findings.length, 1);
    assert.ok(result.findings[0].startsWith('src/routes/widgets.routes.js:2'));
    assert.ok(result.findings[0].includes('never calls validate'));
  });

  it('regression (epic-r2 shape): write-route syntax in comments and a comment-only validate() stay accurate', () => {
    // A read-only route file whose comments mention `.post(` must stay
    // clean…
    const readOnly = run(evaluateValidationCall, {
      'src/routes/health.routes.js': [
        "// TODO: add a .post( probe endpoint and router.add('POST', …) later",
        'export function registerHealthRoutes(router) {',
        "  router.add('GET', '/health', (req, res) => res.end('ok'));",
        '}',
      ].join('\n'),
    });
    assert.equal(readOnly.clean, true, JSON.stringify(readOnly.findings));

    // …and a real write route cannot satisfy the rule with a validate()
    // that only exists inside a comment.
    const commentOnly = run(evaluateValidationCall, {
      'src/routes/widgets.routes.js': [
        '// remember: validate(req.body, widgetSchema) before the service call',
        'export function registerWidgetRoutes(router) {',
        "  router.add('POST', '/widgets', (req, res) => res.end('ok'));",
        '}',
      ].join('\n'),
    });
    assert.equal(commentOnly.clean, false);
  });
});

describe('money-integer oracle', () => {
  it('clean: integer-cents arithmetic and integer guards', () => {
    const result = run(evaluateMoneyInteger, {
      'src/services/payments.service.js': [
        'export function recordPayment({ amountCents }) {',
        '  if (!Number.isInteger(amountCents) || amountCents < 1) {',
        "    throw new Error('E_VALIDATION');",
        '  }',
        '  const discountPercent = 10;',
        '  const ratio = discountPercent / 100;',
        '  return { amountCents, ratio };',
        '}',
      ].join('\n'),
    });
    assert.equal(result.clean, true, JSON.stringify(result.findings));
  });

  it('violating: parseFloat, toFixed and cents/100 arithmetic are flagged with file:line', () => {
    const result = run(evaluateMoneyInteger, {
      'src/services/payments.service.js': [
        'export function recordPayment(body) {',
        '  const amount = parseFloat(body.amount);',
        '  const amountCents = Math.round(amount * 100);',
        '  const dollars = (amountCents / 100).toFixed(2);',
        '  return { amountCents, dollars };',
        '}',
      ].join('\n'),
    });
    assert.equal(result.clean, false);
    assert.ok(result.findings.some((f) => f.includes('parseFloat')));
    assert.ok(result.findings.some((f) => f.includes('.toFixed()')));
    assert.ok(
      result.findings.some((f) => f.includes('cents↔dollars arithmetic')),
    );
    assert.ok(
      result.findings.some((f) =>
        f.startsWith('src/services/payments.service.js:2'),
      ),
    );
  });

  it('regression (epic-r2 shape): parseFloat in a comment or an error-message string stays clean', () => {
    const result = run(evaluateMoneyInteger, {
      'src/services/payments.service.js': [
        '// never parseFloat(body.amount) here — money is integer cents',
        'export function recordPayment({ amountCents }) {',
        '  if (!Number.isInteger(amountCents)) {',
        '    throw new Error(',
        "      'amounts are integer cents — parseFloat-style decimals like 10.50 are rejected; do not call .toFixed(2) on them',",
        '    );',
        '  }',
        '  return { amountCents };',
        '}',
      ].join('\n'),
    });
    assert.equal(result.clean, true, JSON.stringify(result.findings));
  });
});
