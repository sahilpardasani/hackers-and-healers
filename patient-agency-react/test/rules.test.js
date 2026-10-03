// Run with: npm test   (Node 18+ built-in test runner, no extra deps)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mayaBundle } from '../src/data/mayaBundle.js';
import { normalize } from '../src/fhir/normalize.js';
import { evaluate, readiness, doseSchedule, weightStats, visitSummary } from '../src/rules/engine.js';

const ctx = normalize(mayaBundle, 'Demo record');
const TODAY = '2026-10-02'; // Friday
const empty = { weights: [], injections: [], sideEffects: [], mood: [], protein: {}, water: {} };
const ids = a => a.map(x => x.id);

test('normalizer: weights converted to lb and sorted', () => {
  assert.equal(ctx.weights.length, 3);
  assert.ok(Math.abs(ctx.weights[0].lb - 196.0) < 0.3);
  assert.equal(ctx.bmiLatest.value, 32.6);
});

test('normalizer: conditions and meds', () => {
  assert.equal(ctx.conditions.prediabetes, true);
  assert.equal(ctx.conditions.gdmHistory, true);
  assert.equal(ctx.meds.glp1.drug, 'tirzepatide');
  assert.equal(ctx.meds.glp1.currentMg, 5);
  assert.equal(ctx.meds.glp1.startDate, '2026-07-31');
  assert.ok(ctx.meds.oralContraceptive);
  assert.equal(ctx.a1cLatest.value, 5.9);
});

test('dose schedule: Sunday step-up to 7.5 mg', () => {
  const s = doseSchedule(ctx, empty, TODAY);
  assert.equal(s.nextDate, '2026-10-04');
  assert.equal(s.stepUp, true);
  assert.equal(s.nextMg, 7.5);
  assert.equal(s.weekNumber, 10);
});

test('S-6 contraception alert fires before step-up', () => {
  assert.ok(ids(evaluate(ctx, {}, empty, TODAY)).includes('S-6'));
});

test('S-9 A1c due (last A1c > 12 months)', () => {
  assert.ok(ids(evaluate(ctx, {}, empty, TODAY)).includes('S-9'));
});

test('S-4 belly pain red flag, sorted first', () => {
  const a = evaluate(ctx, {}, { ...empty, sideEffects: [{ date: TODAY, type: 'Belly pain' }] }, TODAY);
  assert.equal(a[0].id, 'S-4');
});

test('S-5 low mood', () => {
  const a = evaluate(ctx, {}, { ...empty, mood: [{ date: TODAY, score: 1 }] }, TODAY);
  assert.ok(ids(a).includes('S-5'));
});

test('S-1 breastfeeding pauses readiness', () => {
  assert.ok(ids(evaluate(ctx, { breastfeeding: 'yes' }, empty, TODAY)).includes('S-1'));
  assert.equal(readiness(ctx, { breastfeeding: 'yes' }).status, 'pause');
});

test('S-8 milestone once >= 5% lost', () => {
  const logs = { ...empty, weights: [{ date: TODAY, lb: 184.2 }] };
  const ws = weightStats(ctx, logs);
  assert.ok(ws.pct >= 5);
  assert.ok(ids(evaluate(ctx, {}, logs, TODAY)).includes('S-8'));
});

test('logging the 7.5 mg dose moves schedule and current dose', () => {
  const logs = { ...empty, injections: [{ date: '2026-10-04', mg: 7.5 }] };
  const s = doseSchedule(ctx, logs, '2026-10-04');
  assert.equal(s.currentMg, 7.5);
  assert.equal(s.nextDate, '2026-10-11');
  assert.equal(s.stepUp, false);
});

test('readiness: on treatment, coverage criteria met', () => {
  const r = readiness(ctx, { breastfeeding: 'weaned', pregnancyPlan: 'no', mtcHistory: 'no', pancreatitis: 'no' });
  assert.equal(r.status, 'on-treatment');
  assert.equal(r.meetsCoverage, true);
});

test('visit summary includes key lines', () => {
  const t = visitSummary(ctx, {}, empty, TODAY, ['Switch birth control?']);
  assert.match(t, /Zepbound/);
  assert.match(t, /Switch birth control/);
});
