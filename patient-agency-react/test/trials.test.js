import test from 'node:test';
import assert from 'node:assert/strict';
import { trialProfile } from '../src/fhir/trialProfile.js';

test('trial profile sends minimal fields with supported units', () => {
  const result = trialProfile({ patient: { id: 'private', firstName: 'Secret', birthDate: '1990-10-04', gender: 'female' }, conditionList: [{ label: 'Prediabetes' }], a1cLatest: { value: 6.1, unit: '%' } }, new Date('2026-10-03T12:00:00'));
  assert.equal(result.age, 35);
  assert.equal(result.labs.a1c, 6.1);
  assert.deepEqual(result.conditions, ['Prediabetes']);
  assert.ok(!JSON.stringify(result).includes('Secret'));
  assert.ok(!JSON.stringify(result).includes('1990-10-04'));
});
test('unsupported or missing units are not interpreted', () => {
  const result = trialProfile({ a1cLatest: { value: 53, unit: 'mmol/mol' }, bmiLatest: { value: 33 } });
  assert.equal(result.labs.a1c, null);
  assert.equal(result.labs.bmi, null);
});
