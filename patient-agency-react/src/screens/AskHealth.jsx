import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store.jsx';
import { trialProfile } from '../fhir/trialProfile.js';

export default function AskHealth() {
  const { state } = useStore();
  const profile = useMemo(() => trialProfile(state.ctx), [state.ctx]);
  const [preview, setPreview] = useState(null);
  const [question, setQuestion] = useState('');
  const [consent, setConsent] = useState(false);
  const [trials, setTrials] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState('');
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  async function post(path, body) {
    const response = await fetch(`/api/health/${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ source: 'client', profile, ...body }), signal: AbortSignal.timeout(240000) });
    if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('Run the Python backend and Vite development server to use this feature.');
    const data = await response.json();
    if (!response.ok) { if (response.status === 409) setPreview(null); throw new Error(data.error || 'Request failed.'); }
    return data;
  }
  useEffect(() => {
    generation.current += 1;
    let active = true;
    setPreview(null); setConsent(false); setTrials(false); setResult(null); setStatus('Reading local context…');
    post('context', {}).then(p => { if (active) { setPreview(p); setStatus('Review the context before sharing.'); } })
      .catch(e => { if (active) setStatus(e.message); });
    return () => { active = false; generation.current += 1; };
  }, [profile, revision]);
  async function ask(event) {
    event.preventDefault();
    if (!preview || !consent || busy) return;
    const currentGeneration = generation.current;
    setBusy(true); setResult(null); setStatus('Preparing your explanation…');
    try {
      const r = await post('ask', { question, preview_token: preview.preview_token,
        consent_nvidia: consent, include_trials: trials, consent_trials: trials });
      if (currentGeneration === generation.current) {
        setResult(r); setStatus([r.disclaimer, ...r.warnings].join(' '));
      }
    } catch (e) { if (currentGeneration === generation.current) setStatus(e.name === 'TimeoutError' ? 'The request timed out. Please try again.' : e.message); }
    finally { setBusy(false); }
  }
  return <>
    <h1>Ask about your health</h1>
    <div className="card"><h3>Understand your record</h3><p>This feature sends your question and the previewed context to NVIDIA’s hosted GLM model. Names, IDs, addresses, and exact birth dates are not included. The context still contains sensitive health information.</p>
      <p className="d">Use sandbox or fictional data. No HIPAA-compliance or zero-retention claim is made. Don't type identifying details. React supplies its current record's minimal profile; it does not use a different patient from the backend.</p>
      <details><summary>Review context sent to NVIDIA</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview ? JSON.stringify(preview.context, null, 2) : 'Loading…'}</pre></details>
      {preview && <p className="d">{preview.configured ? `NVIDIA · ${preview.model}` : 'Add NVIDIA_API_KEY to the backend .env and restart.'}</p>}
    </div>
    <form className="card" onSubmit={ask}>
      <label htmlFor="ask-health-question">What would you like to understand?</label>
      <textarea id="ask-health-question" rows="4" maxLength="1200" value={question} onChange={e => setQuestion(e.target.value)} required placeholder="Explain my results and what to ask my clinician." style={{ width: '100%', boxSizing: 'border-box' }} />
      <p><label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} required /> I agree to send my question and this health context to NVIDIA.</label></p>
      <p><label><input type="checkbox" checked={trials} onChange={e => setTrials(e.target.checked)} /> Include trials: share search topics with ClinicalTrials.gov and retrieved trial details with NVIDIA.</label></p>
      <p className="d">Each answer uses this question and record only. The app does not save conversations; provider policies still apply. Not medical advice or an emergency service.</p>
      <div className="acts"><button className="act primary" disabled={busy || !consent || !preview?.configured}>{busy ? 'Thinking…' : 'Ask about my record'}</button><button type="button" className="act" disabled={busy} onClick={() => { setQuestion(''); setRevision(r => r + 1); }}>Clear &amp; refresh</button></div>
    </form>
    <p role="status">{status}</p>
    {result && <div className="card" style={{ whiteSpace: 'pre-wrap' }}>{result.answer}</div>}
    {result?.trials.map(t => <article className="card" key={t.nct_id}><h3>{t.title}</h3><p>{t.status.replaceAll('_', ' ')} · Eligibility needs study-team review.</p><a href={`https://clinicaltrials.gov/study/${t.nct_id}`} target="_blank" rel="noopener noreferrer">View verified study record →</a></article>)}
  </>;
}
