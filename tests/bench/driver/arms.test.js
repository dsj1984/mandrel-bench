// tests/bench/driver/arms.test.js
/**
 * Unit tests for bench/driver/arms.js — the Ticket #123 benchmark-arm
 * registry. Verifies:
 *   - every known arm maps onto exactly one base arm; unknown arms throw,
 *   - the mandrel/control predicates cover the variants and never throw,
 *   - only `mandrel-story-routed` declares a routing override ('story'),
 *   - only `control-claudemd` seeds the static CLAUDE.md,
 *   - `parseBenchArms` keeps the DEFAULT arm set unchanged (arms 3/4 are
 *     opt-in) and fails fast on an unknown arm name.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  armDrivesDeliverLight,
  armSeedsStaticClaudeMd,
  BASE_ARMS,
  baseArm,
  DEFAULT_ARM_SET,
  isControlArm,
  isMandrelArm,
  KNOWN_ARMS,
  parseBenchArms,
  routingOverrideForArm,
} from '../../../bench/driver/arms.js';

test('KNOWN_ARMS carries the two base arms plus the opt-in variants', () => {
  assert.deepEqual([...KNOWN_ARMS].sort(), [
    'control',
    'control-claudemd',
    'mandrel',
    'mandrel-light',
    'mandrel-story-routed',
  ]);
  assert.deepEqual([...BASE_ARMS], ['mandrel', 'control']);
});

test('baseArm maps every known arm onto its base and throws on an unknown arm', () => {
  assert.equal(baseArm('mandrel'), 'mandrel');
  assert.equal(baseArm('mandrel-story-routed'), 'mandrel');
  assert.equal(baseArm('mandrel-light'), 'mandrel');
  assert.equal(baseArm('control'), 'control');
  assert.equal(baseArm('control-claudemd'), 'control');
  assert.throws(() => baseArm('nope'), /unknown benchmark arm "nope"/);
  assert.throws(() => baseArm(undefined), TypeError);
});

test('isMandrelArm / isControlArm cover the variants and never throw', () => {
  assert.equal(isMandrelArm('mandrel'), true);
  assert.equal(isMandrelArm('mandrel-story-routed'), true);
  assert.equal(isMandrelArm('mandrel-light'), true);
  assert.equal(isMandrelArm('control'), false);
  assert.equal(isMandrelArm('control-claudemd'), false);
  assert.equal(isControlArm('control'), true);
  assert.equal(isControlArm('control-claudemd'), true);
  assert.equal(isControlArm('mandrel'), false);
  assert.equal(isControlArm('mandrel-story-routed'), false);
  assert.equal(isControlArm('mandrel-light'), false);
  // Predicates degrade (false), never throw, on foreign/legacy values.
  assert.equal(isMandrelArm('nope'), false);
  assert.equal(isControlArm(undefined), false);
});

test('routingOverrideForArm: only mandrel-story-routed forces story routing', () => {
  assert.equal(routingOverrideForArm('mandrel-story-routed'), 'story');
  assert.equal(routingOverrideForArm('mandrel'), null);
  // mandrel-light honours the scenario's declared routing (a light delivery is
  // a single standalone Story) — it forces no routing override.
  assert.equal(routingOverrideForArm('mandrel-light'), null);
  assert.equal(routingOverrideForArm('control'), null);
  assert.equal(routingOverrideForArm('control-claudemd'), null);
});

test('armDrivesDeliverLight: only mandrel-light drives the single /deliver-light session', () => {
  assert.equal(armDrivesDeliverLight('mandrel-light'), true);
  assert.equal(armDrivesDeliverLight('mandrel'), false);
  assert.equal(armDrivesDeliverLight('mandrel-story-routed'), false);
  assert.equal(armDrivesDeliverLight('control'), false);
  assert.equal(armDrivesDeliverLight('control-claudemd'), false);
  // Degrades (false), never throws, on foreign/legacy values.
  assert.equal(armDrivesDeliverLight('nope'), false);
  assert.equal(armDrivesDeliverLight(undefined), false);
});

test('armSeedsStaticClaudeMd: only control-claudemd seeds the fixture', () => {
  assert.equal(armSeedsStaticClaudeMd('control-claudemd'), true);
  assert.equal(armSeedsStaticClaudeMd('control'), false);
  assert.equal(armSeedsStaticClaudeMd('mandrel'), false);
  assert.equal(armSeedsStaticClaudeMd('mandrel-story-routed'), false);
  assert.equal(armSeedsStaticClaudeMd('mandrel-light'), false);
});

test('parseBenchArms: unset/blank resolves to the UNCHANGED default arm set', () => {
  assert.deepEqual(parseBenchArms(undefined), ['mandrel', 'control']);
  assert.deepEqual(parseBenchArms(null), ['mandrel', 'control']);
  assert.deepEqual(parseBenchArms('   '), ['mandrel', 'control']);
  assert.deepEqual([...DEFAULT_ARM_SET], ['mandrel', 'control']);
});

test('parseBenchArms: accepts the opt-in variant arms (trimmed csv)', () => {
  assert.deepEqual(parseBenchArms('control, control-claudemd'), [
    'control',
    'control-claudemd',
  ]);
  assert.deepEqual(
    parseBenchArms('mandrel,mandrel-story-routed,control,control-claudemd'),
    ['mandrel', 'mandrel-story-routed', 'control', 'control-claudemd'],
  );
  // Story #190: the mandrel-light arm parses alongside the mandrel baseline.
  assert.deepEqual(parseBenchArms('mandrel,mandrel-light'), [
    'mandrel',
    'mandrel-light',
  ]);
});

test('parseBenchArms: fails fast on an unknown arm name', () => {
  assert.throws(
    () => parseBenchArms('mandrel,contrl'),
    /unknown benchmark arm "contrl"/,
  );
});
