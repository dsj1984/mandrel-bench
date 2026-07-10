// tests/bench/schemas/scorecard-schema.test.js
//
// Contract tier for the benchmark scorecard JSON schema (Epic #4211,
// Story #4215). Proves the schema at bench/schemas/scorecard.schema.json
// validates the committed fixture (the binding acceptance item) and that it
// genuinely constrains the record shape — required fields, enums, ranges,
// and additionalProperties: false all reject malformed scorecards.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/bench/schemas/ → repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  'bench',
  'schemas',
  'scorecard.schema.json',
);
const FIXTURE_PATH = path.join(
  REPO_ROOT,
  'bench',
  'fixtures',
  'sample-scorecard.json',
);

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

function buildValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** Deep clone so each negative case starts from a known-valid record. */
const clone = (obj) => JSON.parse(JSON.stringify(obj));

describe('scorecard schema — meta', () => {
  it('compiles under draft 2020-12 in strict mode', () => {
    assert.doesNotThrow(buildValidator);
  });

  it('declares the draft 2020-12 meta-schema and an $id', () => {
    assert.equal(
      schema.$schema,
      'https://json-schema.org/draft/2020-12/schema',
    );
    assert.equal(schema.$id, 'mandrel-bench-scorecard');
  });
});

describe('scorecard schema — validates the committed fixture', () => {
  it('accepts bench/fixtures/sample-scorecard.json', () => {
    const validate = buildValidator();
    const ok = validate(fixture);
    assert.ok(
      ok,
      `fixture failed validation: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  });

  it('the fixture exercises all seven dimensions', () => {
    assert.deepEqual(
      Object.keys(fixture.dimensions).sort(),
      [
        'autonomy',
        'efficiency',
        'maintainability',
        'overheadRatio',
        'planningFidelity',
        'quality',
        'security',
      ].sort(),
    );
  });
});

describe('scorecard schema — rejects malformed records', () => {
  const validate = buildValidator();

  it('rejects a record missing a top-level required field', () => {
    const bad = clone(fixture);
    delete bad.dimensions;
    assert.equal(validate(bad), false);
  });

  it('rejects a scorecard missing benchmarkVersion (D-014: it is a required top-level stamp field)', () => {
    const bad = clone(fixture);
    delete bad.benchmarkVersion;
    assert.equal(validate(bad), false);
    assert.ok(
      (validate.errors ?? []).some(
        (e) =>
          e.keyword === 'required' &&
          e.params?.missingProperty === 'benchmarkVersion',
      ),
      'expected a "required" error naming benchmarkVersion',
    );
  });

  it('rejects an empty benchmarkVersion (minLength 1)', () => {
    const bad = clone(fixture);
    bad.benchmarkVersion = '';
    assert.equal(validate(bad), false);
  });

  it('rejects a record missing one of the seven dimensions', () => {
    const bad = clone(fixture);
    delete bad.dimensions.overheadRatio;
    assert.equal(validate(bad), false);
  });

  it('rejects a record missing the maintainability dimension', () => {
    const bad = clone(fixture);
    delete bad.dimensions.maintainability;
    assert.equal(validate(bad), false);
  });

  it('rejects a record missing the security dimension', () => {
    const bad = clone(fixture);
    delete bad.dimensions.security;
    assert.equal(validate(bad), false);
  });

  it('rejects a maintainability.score above its [0,1] range', () => {
    const bad = clone(fixture);
    bad.dimensions.maintainability.score = 1.1;
    assert.equal(validate(bad), false);
  });

  it('rejects a security.score below its [0,1] range', () => {
    const bad = clone(fixture);
    bad.dimensions.security.score = -0.1;
    assert.equal(validate(bad), false);
  });

  it('rejects an unknown top-level property (additionalProperties: false)', () => {
    const bad = clone(fixture);
    bad.surpriseField = 'nope';
    assert.equal(validate(bad), false);
  });

  it('rejects an unknown property inside a dimension', () => {
    const bad = clone(fixture);
    bad.dimensions.quality.extra = 1;
    assert.equal(validate(bad), false);
  });

  it('rejects a wrong schemaVersion const', () => {
    const bad = clone(fixture);
    bad.schemaVersion = 2;
    assert.equal(validate(bad), false);
  });

  it('rejects an out-of-enum scenario', () => {
    const bad = clone(fixture);
    bad.scenario = 'auth-flow';
    assert.equal(validate(bad), false);
  });

  it('rejects an out-of-enum arm', () => {
    const bad = clone(fixture);
    bad.arm = 'baseline';
    assert.equal(validate(bad), false);
  });

  it('rejects a quality.score above its [0,1] range', () => {
    const bad = clone(fixture);
    bad.dimensions.quality.score = 1.5;
    assert.equal(validate(bad), false);
  });

  it('rejects a negative efficiency.wallClockMs', () => {
    const bad = clone(fixture);
    bad.dimensions.efficiency.wallClockMs = -1;
    assert.equal(validate(bad), false);
  });

  it('rejects a non-RFC3339 timestamp', () => {
    const bad = clone(fixture);
    bad.timestamp = 'last tuesday';
    assert.equal(validate(bad), false);
  });

  it('rejects a runId with whitespace (pattern violation)', () => {
    const bad = clone(fixture);
    bad.runId = 'run with spaces';
    assert.equal(validate(bad), false);
  });
});

describe('scorecard schema — new Epic #66 corpus scenario ids', () => {
  const validate = buildValidator();

  it('accepts a record for the story-scope scenario', () => {
    const rec = clone(fixture);
    rec.runId = 'story-scope-mandrel-2026-07-09-r01';
    rec.scenario = 'story-scope';
    assert.ok(
      validate(rec),
      `story-scope record failed: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  });

  it('accepts a record for the epic-scope scenario', () => {
    const rec = clone(fixture);
    rec.runId = 'epic-scope-mandrel-2026-07-09-r01';
    rec.scenario = 'epic-scope';
    assert.ok(
      validate(rec),
      `epic-scope record failed: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  });
});

describe('scorecard schema — multi-class trap block (Epic #66, Story #74)', () => {
  const validate = buildValidator();

  const trapRecord = (trap) => {
    const rec = clone(fixture);
    rec.runId = 'story-scope-mandrel-2026-07-09-r02';
    rec.scenario = 'story-scope';
    rec.trap = trap;
    return rec;
  };

  it('accepts { trap: { classes: [{class, score, defectPresent}], cleanRate } }', () => {
    const rec = trapRecord({
      classes: [
        { class: 'plaintext-password', score: 1, defectPresent: false },
        { class: 'token-generation', score: 0, defectPresent: true },
      ],
      cleanRate: 0.5,
    });
    const ok = validate(rec);
    assert.ok(
      ok,
      `trap block failed validation: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  });

  it('accepts an optional per-class evidence array', () => {
    const rec = trapRecord({
      classes: [
        {
          class: 'idor',
          score: 1,
          defectPresent: false,
          evidence: ['no cross-user resource access detected'],
        },
      ],
      cleanRate: 1,
    });
    assert.ok(validate(rec), JSON.stringify(validate.errors, null, 2));
  });

  it('rejects a trap block missing cleanRate', () => {
    const rec = trapRecord({
      classes: [
        { class: 'plaintext-password', score: 1, defectPresent: false },
      ],
    });
    assert.equal(validate(rec), false);
  });

  it('rejects a trap block missing classes', () => {
    const rec = trapRecord({ cleanRate: 1 });
    assert.equal(validate(rec), false);
  });

  it('rejects a trap class entry missing a required field', () => {
    const rec = trapRecord({
      classes: [{ class: 'plaintext-password', score: 1 }],
      cleanRate: 1,
    });
    assert.equal(validate(rec), false);
  });

  it('rejects an out-of-range per-class score', () => {
    const rec = trapRecord({
      classes: [
        { class: 'plaintext-password', score: 1.5, defectPresent: false },
      ],
      cleanRate: 1,
    });
    assert.equal(validate(rec), false);
  });

  it('rejects an unknown property on a trap class entry (additionalProperties: false)', () => {
    const rec = trapRecord({
      classes: [
        {
          class: 'plaintext-password',
          score: 1,
          defectPresent: false,
          surprise: 'nope',
        },
      ],
      cleanRate: 1,
    });
    assert.equal(validate(rec), false);
  });

  it('rejects the old single-class trapSignal shape (defectClass/signals) as a trap block', () => {
    const rec = trapRecord({
      defectClass: 'plaintext-password-storage',
      defectPresent: false,
      score: 1,
      signals: { hasHashing: true },
      evidence: 'clean',
    });
    assert.equal(validate(rec), false);
  });
});

describe('scorecard schema — control-arm nullable dimensions', () => {
  const validate = buildValidator();

  it('accepts null planningFidelity.score and null quality.acceptanceEvalScore for the control arm', () => {
    const control = clone(fixture);
    control.runId = 'hello-world-control-2026-06-16-r03';
    control.arm = 'control';
    control.dimensions.planningFidelity.score = null;
    control.dimensions.quality.acceptanceEvalScore = null;
    control.dimensions.efficiency.costUsd = null;
    control.dimensions.overheadRatio.timeRatio = null;
    control.dimensions.maintainability.maintainabilityJudgeScore = null;
    control.dimensions.security.securityJudgeScore = null;
    const ok = validate(control);
    assert.ok(
      ok,
      `control-arm record failed: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  });
});

describe('scorecard schema — per-phase envelopes (D-019, Epic #86 Story #94)', () => {
  const validate = buildValidator();

  it('accepts a mandrel-arm record carrying a phases[] block', () => {
    const rec = clone(fixture);
    rec.arm = 'mandrel';
    rec.phases = [
      { phase: 'plan', costUsd: 0.4, tokens: 40000, wallClockMs: 120000 },
      { phase: 'deliver', costUsd: 1.1, tokens: 140000, wallClockMs: 480000 },
    ];
    const ok = validate(rec);
    assert.ok(
      ok,
      `phases record failed: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  });

  it('accepts a null per-phase costUsd', () => {
    const rec = clone(fixture);
    rec.phases = [
      { phase: 'plan', costUsd: null, tokens: 1, wallClockMs: 1 },
      { phase: 'deliver', costUsd: null, tokens: 1, wallClockMs: 1 },
    ];
    assert.equal(validate(rec), true);
  });

  it('a control record remains valid WITHOUT a phases block', () => {
    const control = clone(fixture);
    control.arm = 'control';
    delete control.phases;
    assert.equal(validate(control), true);
  });

  it('rejects an unknown phase name', () => {
    const rec = clone(fixture);
    rec.phases = [{ phase: 'refactor', tokens: 1, wallClockMs: 1 }];
    assert.equal(validate(rec), false);
  });

  it('rejects a phase entry missing a required field', () => {
    const rec = clone(fixture);
    rec.phases = [{ phase: 'plan', costUsd: 0.1 }];
    assert.equal(validate(rec), false);
  });

  it('rejects an unknown property on a phase entry (additionalProperties:false)', () => {
    const rec = clone(fixture);
    rec.phases = [{ phase: 'plan', tokens: 1, wallClockMs: 1, extra: true }];
    assert.equal(validate(rec), false);
  });
});
