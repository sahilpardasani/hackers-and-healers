// Synthetic FHIR R4 Bundle for demo patient "Maya" (fictional; no real PHI).
// Coded the way Epic and other EHRs typically return data, so the same
// normalizer handles demo mode and live SMART on FHIR data.

const PID = 'maya-demo-001';
const ref = { reference: `Patient/${PID}` };
const LOINC = 'http://loinc.org';
const ICD10 = 'http://hl7.org/fhir/sid/icd-10-cm';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const OBS_CAT = 'http://terminology.hl7.org/CodeSystem/observation-category';

let n = 0;
const id = p => `${p}-${++n}`;

const vital = (date, code, display, value, unit, ucum) => ({
  resourceType: 'Observation', id: id('vs'), status: 'final', subject: ref,
  category: [{ coding: [{ system: OBS_CAT, code: 'vital-signs' }] }],
  code: { coding: [{ system: LOINC, code, display }], text: display },
  effectiveDateTime: date,
  valueQuantity: { value, unit, system: 'http://unitsofmeasure.org', code: ucum }
});

const lab = (date, code, display, value, unit) => ({
  resourceType: 'Observation', id: id('lab'), status: 'final', subject: ref,
  category: [{ coding: [{ system: OBS_CAT, code: 'laboratory' }] }],
  code: { coding: [{ system: LOINC, code, display }], text: display },
  effectiveDateTime: date, valueQuantity: { value, unit }
});

const condition = (code, display, onset, clinical = 'active') => ({
  resourceType: 'Condition', id: id('cond'), subject: ref,
  clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: clinical }] },
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
  code: { coding: [{ system: ICD10, code, display }], text: display },
  onsetDateTime: onset
});

const medReq = (status, authoredOn, text, rxcui, dosageText) => ({
  resourceType: 'MedicationRequest', id: id('med'), status, intent: 'order', subject: ref, authoredOn,
  medicationCodeableConcept: { coding: rxcui ? [{ system: RXNORM, code: rxcui, display: text }] : [], text },
  dosageInstruction: [{ text: dosageText }]
});

const kg = lb => Math.round((lb / 2.20462) * 10) / 10;

export const mayaBundle = {
  resourceType: 'Bundle',
  type: 'collection',
  entry: [
    {
      resourceType: 'Patient', id: PID,
      name: [{ given: ['Maya'], family: 'Demo' }],
      gender: 'female', birthDate: '1994-03-14'
    },
    // Vitals (clinic) — weights in kg to exercise unit conversion
    vital('2026-07-17', '8302-2', 'Body height', 165, 'cm', 'cm'),
    vital('2026-07-17', '29463-7', 'Body weight', kg(196.0), 'kg', 'kg'),
    vital('2026-07-17', '39156-5', 'Body mass index', 32.6, 'kg/m2', 'kg/m2'),
    vital('2026-08-28', '29463-7', 'Body weight', kg(190.2), 'kg', 'kg'),
    vital('2026-09-25', '29463-7', 'Body weight', kg(185.3), 'kg', 'kg'),
    // Labs
    lab('2024-02-12', '4548-4', 'Hemoglobin A1c', 5.7, '%'),
    lab('2025-09-08', '4548-4', 'Hemoglobin A1c', 5.9, '%'),
    lab('2025-09-08', '2345-7', 'Glucose', 104, 'mg/dL'),
    // Conditions
    condition('R73.03', 'Prediabetes', '2025-09-08'),
    condition('Z86.32', 'Personal history of gestational diabetes', '2025-01-10'),
    // Medications
    medReq('completed', '2026-07-31', 'Zepbound 2.5 MG/0.5ML Auto-Injector (tirzepatide)', '2601723', 'Inject 2.5 mg subcutaneously once weekly'),
    medReq('active', '2026-08-28', 'Zepbound 5 MG/0.5ML Auto-Injector (tirzepatide)', '2601723', 'Inject 5 mg subcutaneously once weekly'),
    medReq('active', '2026-01-15', 'Norethindrone acetate 1 MG / Ethinyl estradiol 0.02 MG oral tablet', null, 'Take 1 tablet by mouth daily')
  ].map(resource => ({ resource }))
};
