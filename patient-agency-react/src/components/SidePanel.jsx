// Demo-only explainer shown next to the phone frame on desktop.
const CONTENT = {
  trials: {
    title: 'Clinical trials: explore research',
    data: ['Current record → minimal local matching profile', 'ClinicalTrials.gov API v2 → public recruiting studies', 'Local pre-screen → reasons and questions for the study team'],
    why: 'Only search topics leave the local backend. Matching is preliminary; historical labs and incomplete criteria require study-team review.'
  },
  connect: {
    title: 'Connect: SMART on FHIR',
    data: ['SMART standalone launch (PKCE) via fhirclient', 'SMART Health IT sandbox or Epic sandbox', 'Demo mode: synthetic FHIR R4 Bundle "Maya"'],
    why: 'Live connections prove the FHIR path works. Demo mode guarantees a postpartum GLP-1 patient whose data triggers every rule.'
  },
  today: {
    title: 'Today: daily actions',
    data: ['Observation (vital-signs) → latest weight', 'MedicationRequest → GLP-1 dose + oral contraceptive', 'Condition + Observation (labs) → A1c due', 'Self-reported: weight, protein, water, injection, side effects, mood'],
    why: 'Each card turns data into a one-tap action. Tap the 🎙️ button to log by voice ("I took my shot and walked 30 minutes") or ask "what\'s next?". The contraception alert needs two sources together: the medication list and the dose schedule.'
  },
  journey: {
    title: 'Journey: readiness',
    data: ['Observation BMI (LOINC 39156-5)', 'Condition: prediabetes, gestational diabetes history', 'MedicationRequest: current GLP-1', 'Self-report: breastfeeding, pregnancy plans, thyroid cancer / pancreatitis history'],
    why: 'Postpartum adds safety checks that EHR data often doesn\'t capture in structured form, so self-report fills the gaps.'
  },
  progress: {
    title: 'Progress',
    data: ['FHIR weights + self-reported weights (merged)', 'Mood and side-effect logs'],
    why: 'Shows the plan is working, and makes the 5% milestone visible (relevant for prior auth renewal).'
  },
  data: {
    title: 'My data: consent & control',
    data: ['Connected FHIR source', 'On-device self-reported logs', 'Planned: HealthEx, Flexpa, Surescripts, Apple Health / Health Connect'],
    why: 'The patient can see and control every source, and delete her on-device data at any time.'
  },
  visit: {
    title: 'Visit prep',
    data: ['Generated from FHIR + self-reported logs', 'Copy or download as text'],
    why: 'Turns weeks of home data into a 30-second read for her clinician.'
  }
};

export default function SidePanel({ tab }) {
  const c = CONTENT[tab] || CONTENT.today;
  return (
    <aside className="side">
      <div className="card" style={{ background: '#1f2a37', color: '#fff', border: 'none' }}>
        <div className="tag" style={{ color: '#c4b5fd' }}>Prototype · sandbox / synthetic data</div>
        <div style={{ fontSize: 17, fontWeight: 700, marginTop: 4 }}>Patient Agency: postpartum GLP-1 journey</div>
        <div style={{ fontSize: 13, color: '#cbd5e1', marginTop: 6, lineHeight: 1.5 }}>
          <i>"As a millennial parent, I want to act on my health data so that I can be successful in my weight management journey in the postpartum period."</i>
        </div>
      </div>
      <div className="card">
        <h3>{c.title}</h3>
        <div className="tag" style={{ marginTop: 10 }}>Data powering this screen</div>
        <ul>{c.data.map(d => <li key={d}>{d}</li>)}</ul>
        <div className="tag" style={{ marginTop: 12 }}>Why it matters</div>
        <div style={{ fontSize: 13, lineHeight: 1.5, marginTop: 4 }}>{c.why}</div>
      </div>
      <div className="d" style={{ padding: '0 4px' }}>Not medical advice. Clinical rules require clinician review before use with patients.</div>
    </aside>
  );
}
