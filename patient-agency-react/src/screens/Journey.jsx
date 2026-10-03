import { useStore } from '../state/store.jsx';
import { readiness, doseSchedule, effectiveGlp1, fmt } from '../rules/engine.js';
import { Check } from '../components/ui.jsx';

const QUESTIONS = [
  { key: 'breastfeeding', q: 'Are you breastfeeding?', options: [['yes', 'Yes'], ['weaned', 'Weaned'], ['never', 'Didn\'t breastfeed']] },
  { key: 'pregnancyPlan', q: 'Planning a pregnancy in the next 12 months?', options: [['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure']] },
  { key: 'mtcHistory', q: 'You or family: medullary thyroid cancer or MEN2?', options: [['yes', 'Yes'], ['no', 'No']] },
  { key: 'pancreatitis', q: 'Ever had pancreatitis?', options: [['yes', 'Yes'], ['no', 'No']] }
];

const STATUS = {
  ready: ['ok', 'Ready to discuss', 'You may be a good fit. Bring this summary to your clinician.'],
  'on-treatment': ['ok', 'On treatment', 'Your record shows an active GLP-1 prescription.'],
  pause: ['warn', 'Talk to your clinician first', null],
  incomplete: ['brandp', 'A few questions left', 'Answer the questions below to finish your check.']
};

export default function Journey() {
  const { state, dispatch, today } = useStore();
  const { ctx, selfReport: sr, logs } = state;
  const r = readiness(ctx, sr);
  const g = effectiveGlp1(ctx, logs);
  const sched = doseSchedule(ctx, logs, today);
  const [tone, label, desc] = STATUS[r.status];

  return (
    <>
      <h1>Your journey</h1>
      <p className="sub">From "is this right for me?" to staying on track</p>

      <details className="stage" open>
        <summary>1 · Readiness check <span className={`pill ${tone}`}>{label}</span></summary>
        <div className="body">
          {r.items.map(i => <Check key={i.label} label={i.label} value={i.value} source={i.source} tone={i.warn ? 'warn' : i.info ? 'info' : i.ok ? 'ok' : 'bad'} />)}
          {r.meetsCoverage !== null && <Check label="Typical coverage criteria (BMI ≥30, or ≥27 + condition)" value={r.meetsCoverage ? 'Likely met' : 'Not met'} source="Calculated from your record" tone={r.meetsCoverage ? 'ok' : 'warn'} />}

          <div className="tag" style={{ marginTop: 12 }}>Tell us (one tap each)</div>
          {QUESTIONS.map(({ key, q, options }) => (
            <div key={key} className="q">
              <div style={{ fontSize: 13 }}>{q}</div>
              <div className="acts" style={{ marginTop: 6 }}>
                {options.map(([v, l]) => (
                  <button key={v} className={`act ${sr[key] === v ? 'on' : ''}`} onClick={() => dispatch({ type: 'answer', key, value: v })}>{l}</button>
                ))}
              </div>
            </div>
          ))}
          <div className={`card alert ${r.status === 'pause' ? '' : 'success'}`} style={{ margin: '10px 0 0' }}>
            <div className="t">{label}</div>
            <div className="d">{r.status === 'pause' ? r.reasons.join(' ') : desc}</div>
          </div>
        </div>
      </details>

      <details className="stage">
        <summary>2 · Coverage & prior auth <span className="pill info">Mock</span></summary>
        <div className="body">
          <div className="d">Live payer data (Flexpa / CMS Patient Access API) is out of MVP scope.</div>
          <Check label="BMI documented" value={ctx.bmiLatest ? 'From record' : 'Missing'} source="FHIR Observation" tone={ctx.bmiLatest ? 'ok' : 'warn'} />
          <Check label="Prior auth" value="Approved (sample)" source="Mock payer" />
          <Check label="Re-authorization" value="~5% loss" source="Typical plan requirement" tone="info" />
        </div>
      </details>

      <details className="stage">
        <summary>3 · Prescription <span className={`pill ${g ? 'ok' : 'brandp'}`}>{g ? 'Active' : 'None yet'}</span></summary>
        <div className="body">
          {g ? (
            <>
              <Check label="Medication" value={`${g.brand} (${g.drug})`} source={g.source} />
              <Check label="Started" value={fmt(g.startDate)} source="MedicationRequest.authoredOn" />
              <Check label="Current dose" value={`${g.currentMg} mg weekly`} source={`Since ${fmt(g.currentDoseSince)}`} />
              {ctx.meds.oralContraceptive && <Check label="Birth control" value="Oral pill" source={ctx.meds.oralContraceptive.text} tone="warn" />}
            </>
          ) : <div className="d">No GLP-1 found on your record. When you and your clinician start one, Patient Agency will pick it up on your next sync.</div>}
        </div>
      </details>

      {sched && (
        <details className="stage" open>
          <summary>4 · Dose schedule <span className="pill brandp">Week {sched.weekNumber}</span></summary>
          <div className="body">
            <div className="d">The dose usually goes up every 4 weeks, as tolerated, with your clinician.</div>
            <div className="titr">
              {sched.steps.map(s => (
                <div key={s} className={s === sched.nextMg && sched.stepUp ? 'now' : s <= sched.currentMg ? 'past' : ''}>
                  {s}{s === sched.nextMg && sched.stepUp ? <><br />{fmt(sched.nextDate)}</> : null}
                </div>
              ))}
            </div>
            <div className="d" style={{ marginTop: 8 }}>🔔 Before each step up, Patient Agency checks side effects this month, backup birth control and refill timing.</div>
          </div>
        </details>
      )}
    </>
  );
}
