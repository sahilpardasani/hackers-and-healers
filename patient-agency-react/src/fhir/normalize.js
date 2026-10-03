// Turns raw FHIR R4 resources into Patient Agency's PatientContext.
// Match on codes first (LOINC / ICD-10 / SNOMED / RxNorm), then fall back to text.

const LB_PER_KG = 2.20462;

const LOINC = { weight: '29463-7', bmi: '39156-5', height: '8302-2', a1c: '4548-4', glucose: '2345-7' };

const CONDITION_MATCHERS = {
  prediabetes: { codes: ['R73.03', 'R73.09', '714628002', '15777000'], text: /pre-?diabetes/i },
  t2d: { codes: [/^E11/, '44054006'], text: /type 2 diabetes/i },
  gdmHistory: { codes: ['Z86.32', /^O24\.4/, '11687002', '472971004'], text: /gestational diabetes/i },
  htn: { codes: ['I10', '38341003', '59621000'], text: /hypertension|high blood pressure/i },
  osa: { codes: ['G47.33', '78275009'], text: /sleep apnea/i }
};

const GLP1 = [
  { drug: 'tirzepatide', brand: 'Zepbound', re: /tirzepatide|zepbound|mounjaro/i, rxcui: ['2601723'], steps: [2.5, 5, 7.5, 10, 12.5, 15] },
  { drug: 'semaglutide', brand: 'Wegovy', re: /semaglutide|wegovy|ozempic|rybelsus/i, rxcui: ['1991302'], steps: [0.25, 0.5, 1, 1.7, 2.4] },
  { drug: 'liraglutide', brand: 'Saxenda', re: /liraglutide|saxenda|victoza/i, rxcui: ['475968'], steps: [0.6, 1.2, 1.8, 2.4, 3] }
];

const ORAL_CONTRACEPTIVE = /ethinyl estradiol|norethindrone|drospirenone|levonorgestrel|norgestimate|desogestrel|norgestrel|estradiol valerate.*dienogest/i;
const NON_ORAL = /intrauterine|\biud\b|implant|ring|patch|injection|mirena|kyleena|liletta|nexplanon|depo/i;

const codings = cc => (cc?.coding || []);
const textOf = cc => [cc?.text, ...codings(cc).map(c => c.display)].filter(Boolean).join(' ');
const hasCode = (cc, code) => codings(cc).some(c => c.code === code);
const matchesAny = (cc, codes) => codings(cc).some(c => codes.some(m => (m instanceof RegExp ? m.test(c.code || '') : m === c.code)));
const dateOf = r => (r.effectiveDateTime || r.issued || r.authoredOn || r.onsetDateTime || r.recordedDate || '').slice(0, 10);
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

function toLb(q) {
  if (!q || typeof q.value !== 'number') return null;
  const u = (q.code || q.unit || '').toLowerCase();
  if (u === 'kg') return Math.round(q.value * LB_PER_KG * 10) / 10;
  if (u === 'g') return Math.round((q.value / 1000) * LB_PER_KG * 10) / 10;
  return Math.round(q.value * 10) / 10; // [lb_av], lb, lbs
}

function isActiveCondition(c) {
  const s = codings(c.clinicalStatus)[0]?.code;
  return !s || ['active', 'recurrence', 'relapse'].includes(s) || /history/i.test(textOf(c.code));
}

function parseMg(text) {
  const m = /(\d+(?:\.\d+)?)\s*mg/i.exec(text || '');
  return m ? parseFloat(m[1]) : null;
}

export function flattenResources(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.flatMap(flattenResources);
  if (input.resourceType === 'Bundle') return (input.entry || []).map(e => e.resource).filter(Boolean);
  return [input];
}

export function normalize(input, source = 'Demo record') {
  const resources = flattenResources(input);
  const ctx = {
    source,
    patient: null,
    weights: [],
    bmiLatest: null,
    heightCm: null,
    a1c: [],
    a1cLatest: null,
    conditions: { prediabetes: false, t2d: false, gdmHistory: false, htn: false, osa: false },
    conditionList: [],
    meds: { glp1: null, oralContraceptive: null, active: [] }
  };

  const glp1Orders = [];

  for (const r of resources) {
    switch (r.resourceType) {
      case 'Patient': {
        const nm = r.name?.[0];
        ctx.patient = {
          id: r.id,
          firstName: nm?.given?.[0] || nm?.text?.split(' ')[0] || 'there',
          lastName: nm?.family || '',
          birthDate: r.birthDate || null,
          gender: r.gender || null
        };
        break;
      }
      case 'Observation': {
        const date = dateOf(r);
        if (hasCode(r.code, LOINC.weight) || /body weight/i.test(textOf(r.code))) {
          const lb = toLb(r.valueQuantity);
          if (lb) ctx.weights.push({ date, lb, source });
        } else if (hasCode(r.code, LOINC.bmi) || /body mass index|\bbmi\b/i.test(textOf(r.code))) {
          const v = r.valueQuantity?.value;
          if (v && (!ctx.bmiLatest || date > ctx.bmiLatest.date)) ctx.bmiLatest = { value: v, date, source, unit: r.valueQuantity?.code || r.valueQuantity?.unit || '' };
        } else if (hasCode(r.code, LOINC.height)) {
          ctx.heightCm = r.valueQuantity?.value ?? ctx.heightCm;
        } else if (hasCode(r.code, LOINC.a1c) || /a1c/i.test(textOf(r.code))) {
          const v = r.valueQuantity?.value;
          if (v) ctx.a1c.push({ date, value: v, source, unit: r.valueQuantity?.code || r.valueQuantity?.unit || '' });
        }
        break;
      }
      case 'Condition': {
        if (!isActiveCondition(r)) break;
        const label = r.code?.text || codings(r.code)[0]?.display || 'Condition';
        ctx.conditionList.push({ label, date: dateOf(r), source });
        for (const [key, m] of Object.entries(CONDITION_MATCHERS)) {
          if (matchesAny(r.code, m.codes) || m.text.test(textOf(r.code))) ctx.conditions[key] = true;
        }
        break;
      }
      case 'MedicationRequest': {
        const text = [textOf(r.medicationCodeableConcept), r.medicationReference?.display, r.dosageInstruction?.[0]?.text].filter(Boolean).join(' ');
        const date = dateOf(r);
        const glp = GLP1.find(g => g.re.test(text) || codings(r.medicationCodeableConcept).some(c => g.rxcui.includes(c.code)));
        if (glp) glp1Orders.push({ ...glp, date, status: r.status, mg: parseMg(text), text });
        if (r.status === 'active') {
          ctx.meds.active.push({ text: r.medicationCodeableConcept?.text || r.medicationReference?.display || 'Medication', date, source });
          if (ORAL_CONTRACEPTIVE.test(text) && !NON_ORAL.test(text)) {
            ctx.meds.oralContraceptive = { text: r.medicationCodeableConcept?.text || 'Oral contraceptive', date, source };
          }
        }
        break;
      }
      default:
        break;
    }
  }

  ctx.weights.sort(byDate);
  ctx.a1c.sort(byDate);
  ctx.a1cLatest = ctx.a1c[ctx.a1c.length - 1] || null;

  if (glp1Orders.length) {
    glp1Orders.sort(byDate);
    const active = [...glp1Orders].reverse().find(o => o.status === 'active') || glp1Orders[glp1Orders.length - 1];
    const sameDrug = glp1Orders.filter(o => o.drug === active.drug);
    ctx.meds.glp1 = {
      drug: active.drug,
      brand: active.brand,
      steps: active.steps,
      currentMg: active.mg,
      currentDoseSince: active.date,
      startDate: sameDrug[0].date,
      source
    };
  }

  return ctx;
}

export const _test = { toLb, parseMg };
