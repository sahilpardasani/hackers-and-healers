import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUtterance } from '../src/agent/parse.js';
import { plan, nextSteps } from '../src/agent/respond.js';
import { mayaBundle } from '../src/data/mayaBundle.js';
import { normalize } from '../src/fhir/normalize.js';

const types = s => parseUtterance(s).map(i => i.type);
const TODAY = '2026-10-04'; // Sunday, step-up day
const state = {
  ctx: normalize(mayaBundle),
  selfReport: {},
  logs: { weights: [], injections: [], sideEffects: [], mood: [], exercise: [], protein: {}, water: {}, done: {} },
  questions: []
};

test('dose', () => {
  assert.deepEqual(types('I took my shot'), ['dose']);
  assert.equal(parseUtterance('just injected 7.5 mg')[0].mg, 7.5);
});

test('multi-intent: dose + exercise', () => {
  const i = parseUtterance('Took my Zepbound and walked 30 minutes with the stroller');
  assert.deepEqual(i.map(x => x.type), ['dose', 'exercise']);
  assert.equal(i[1].minutes, 30);
  assert.equal(i[1].kind, 'Walk');
});

test('exercise kinds and defaults', () => {
  assert.equal(parseUtterance('did twenty minutes of weights')[0].kind, 'Strength');
  assert.equal(parseUtterance('did twenty minutes of weights')[0].minutes, 20);
  assert.equal(parseUtterance('went for a run for half an hour')[0].minutes, 30);
});

test('weight, protein, water', () => {
  assert.equal(parseUtterance('I weigh 183.4')[0].lb, 183.4);
  assert.equal(parseUtterance('scale says 182 pounds')[0].lb, 182);
  assert.equal(parseUtterance('weighed in at 183.6 this morning')[0].lb, 183.6);
  assert.equal(parseUtterance('I am 32 years old').length, 0);
  assert.equal(parseUtterance('had a protein shake')[0].g, 25);
  assert.equal(parseUtterance('ate 30 grams of protein')[0].g, 30);
  assert.equal(parseUtterance('drank 2 glasses of water')[0].n, 2);
  assert.equal(parseUtterance('drank a bottle of water')[0].n, 2);
});

test('side effects and mood', () => {
  assert.deepEqual(parseUtterance('feeling nauseous today')[0], { type: 'sideEffect', types: ['Nausea'] });
  assert.ok(parseUtterance('my stomach hurts').some(i => i.type === 'sideEffect' && i.types.includes('Belly pain')));
  assert.equal(parseUtterance('I feel really down').find(i => i.type === 'mood').score, 2);
  assert.equal(parseUtterance('feeling great today').find(i => i.type === 'mood').score, 5);
});

test('questions', () => {
  assert.equal(parseUtterance("what's next?")[0].topic, 'next');
  assert.equal(parseUtterance('when is my next dose')[0].topic, 'dose');
  assert.equal(parseUtterance('can I take ibuprofen?')[0].topic, 'other');
  assert.deepEqual(types('I took my shot, what should I do next?'), ['question', 'dose']);
});

test('plan: dose on step-up day logs 7.5 mg + contraception reminder', () => {
  const p = plan(parseUtterance('I took my shot'), state, TODAY);
  assert.deepEqual(p.actions[0], { type: 'logInjection', date: TODAY, mg: 7.5 });
  assert.match(p.reply, /backup birth control/);
});

test('plan: strength marks the strength action done', () => {
  const p = plan(parseUtterance('did 20 minutes of strength'), state, TODAY);
  assert.ok(p.actions.some(a => a.type === 'setDone' && a.key === 'strength'));
});

test('plan: unknown medical question goes to visit questions, no advice', () => {
  const p = plan(parseUtterance('can I take ibuprofen?'), state, TODAY);
  assert.ok(p.actions.some(a => a.type === 'addQuestion'));
  assert.match(p.reply, /can't give medical advice/);
});

test('plan: belly pain gets urgent guidance; low mood mentions 988', () => {
  assert.match(plan([{ type: 'sideEffect', types: ['Belly pain'] }], state, TODAY).reply, /contact your clinician/);
  assert.match(plan([{ type: 'mood', score: 1 }], state, TODAY).reply, /988/);
});

test('next steps include dose on dose day', () => {
  assert.match(nextSteps(state, TODAY).join(' '), /7.5 mg dose/);
});

test('nothing understood', () => {
  assert.match(plan(parseUtterance('blah blah'), state, TODAY).reply, /didn't catch that/);
});
