import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../state/store.jsx';
import { trialProfile } from '../fhir/trialProfile.js';

export default function ClinicalTrials() {
  const { state } = useStore();
  const profile = useMemo(() => trialProfile(state.ctx), [state.ctx]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { setConsent(false); setResult(null); setError(''); }, [profile]);
  const search = async event => {
    event.preventDefault();
    if (!consent || busy) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await fetch('/api/trials/match', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...profile, all: true }), signal: AbortSignal.timeout(90000),
      });
      if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('The matching backend is unavailable. Run the Python backend and Vite dev server; a static GitHub Pages site cannot run the matcher.');
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Trial search failed.');
      setResult(payload);
    } catch (err) { setError(err.name === 'TimeoutError' ? 'Search timed out. Please try again.' : err.message); }
    finally { setBusy(false); }
  };
  return <>
    <h1>Clinical trials</h1>
    <p className="d">Explore studies with your clinician. This is a preliminary screen, not medical advice or a decision that you qualify.</p>
    <div className="card"><h3>Your search profile</h3>
      <p className="d">Source: {state.ctx?.source || 'Current React record'}{state.ctx?.isDemo ? ' · fictional sample' : ''}</p>
      <p>Age: {profile.age ?? 'unknown'} · Recorded sex: {profile.sex || 'unknown'}</p>
      <p>Topics: {profile.conditions.join(', ') || 'Search suggestions may be derived from supported lab values—not diagnoses.'}</p>
      <p>A1c: {profile.labs.a1c ?? 'unavailable'} · BMI: {profile.labs.bmi ?? 'unavailable'}</p>
      <p className="d">The React record currently supplies A1c and BMI when units are known. eGFR and blood pressure are available through the Python dashboard if synced. Older cached demo records may need reconnecting to include units.</p>
    </div>
    <form className="card" onSubmit={search}>
      <p className="d">The local backend compares this profile with ClinicalTrials.gov listings. Only condition topics go to ClinicalTrials.gov—not your name, IDs, birth date, or lab values. Historical labs and pregnancy/breastfeeding criteria need study-team review.</p>
      <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} required /> I agree to share these search topics with ClinicalTrials.gov.</label>
      <div className="acts"><button className="act primary" disabled={!consent || busy}>{busy ? 'Searching…' : 'Find clinical trials'}</button></div>
    </form>
    <p role="status">{busy ? 'Fetching public trial listings and checking locally…' : error || (result ? `${result.trials.length} studies found. Limited results; study-team review required.` : '')}</p>
    {result?.trials.length === 0 && <p>{result.note || 'No studies found for these topics.'}</p>}
    {result?.trials.map(trial => <article className="card" key={trial.nct_id}>
      <span className="chip">{trial.match.verdict === 'likely_ineligible' ? 'Potential eligibility barriers' : 'Potential study · review needed'}</span>
      <h3>{trial.title}</h3><p className="d">{trial.nct_id} · {trial.status.replaceAll('_', ' ')} · {trial.location_count} sites</p>
      <p>{trial.summary.slice(0, 400)}</p>
      <ul>{[...trial.match.reasons, ...trial.match.blockers, ...trial.match.flags].map((r, i) => <li key={i}>{r}</li>)}</ul>
      <details><summary>{trial.match.unreviewed} criteria not evaluated · details</summary>
        <ul>{[...trial.match.inclusion, ...trial.match.exclusion].map((c, i) => <li key={i}>{c.text} — {c.result.replaceAll('_', ' ')}. {c.basis}</li>)}</ul>
        <p>{trial.locations.map(s => [s.facility, s.city, s.state].filter(Boolean).join(', ')).join('; ')}</p>
      </details>
      {/^NCT\d{8}$/.test(trial.nct_id) && <a href={`https://clinicaltrials.gov/study/${trial.nct_id}`} target="_blank" rel="noopener noreferrer">View official study →</a>}
    </article>)}
  </>;
}
