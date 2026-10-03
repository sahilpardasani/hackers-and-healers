import { useEffect, useState } from 'react';
import { useStore } from '../state/store.jsx';
import { mayaBundle } from '../data/mayaBundle.js';
import { normalize } from '../fhir/normalize.js';
import { SERVERS, connect, isReturningFromAuth, completeAuthAndFetch } from '../fhir/smart.js';

export default function Connect() {
  const { dispatch, toast } = useStore();
  const [agreed, setAgreed] = useState(false);
  const [server, setServer] = useState(SERVERS[0].id);
  const [busy, setBusy] = useState(isReturningFromAuth());
  const [error, setError] = useState(null);

  // Returning from the SMART authorize redirect: finish auth and load data
  useEffect(() => {
    if (!isReturningFromAuth()) return;
    completeAuthAndFetch()
      .then(({ resources, errors, source }) => {
        const ctx = normalize(resources, source);
        dispatch({ type: 'setContext', ctx });
        toast(errors.length ? `Connected. Couldn't load: ${errors.join(', ')}` : `Connected to ${source}`);
      })
      .catch(e => { setError(e.message || 'Connection failed'); setBusy(false); });
  }, [dispatch, toast]);

  const useDemo = () => {
    dispatch({ type: 'setContext', ctx: { ...normalize(mayaBundle, 'Demo record'), isDemo: true } });
    toast('Loaded demo patient Maya');
  };

  const useLive = async () => {
    setError(null);
    try { setBusy(true); await connect(server); }
    catch (e) { setError(e.message); setBusy(false); }
  };

  if (busy) {
    return (
      <div className="center" style={{ paddingTop: 160 }}>
        <div style={{ fontSize: 40 }}>🌱</div>
        <h1>Connecting…</h1>
        <p className="sub">Securely loading your health record</p>
      </div>
    );
  }

  return (
    <>
      <div style={{ fontSize: 44, marginTop: 24 }}>🌱</div>
      <h1>Welcome to Patient Agency</h1>
      <p className="sub">Your postpartum GLP-1 journey, with your health data turned into small daily actions.</p>

      <div className="card">
        <div className="t">What Patient Agency uses</div>
        <div className="d">
          Your health record (weight, BMI, labs, conditions, medications), read-only through SMART on FHIR, plus check-ins you add yourself.
          Your check-ins stay on this device. You can disconnect or delete your data at any time.
        </div>
        <label className="row" style={{ marginTop: 10, fontSize: 13 }}>
          <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />
          I understand Patient Agency doesn't provide medical advice.
        </label>
      </div>

      <h2>Connect your health record</h2>
      <div className="card">
        <select value={server} onChange={e => setServer(e.target.value)} aria-label="FHIR server">
          {SERVERS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <button className="btn block" style={{ marginTop: 10 }} disabled={!agreed} onClick={useLive}>🔗 Connect my health record</button>
        <div className="d" style={{ marginTop: 6 }}>Sandbox only. Use a test patient, never real credentials.</div>
        {error && <div className="err">{error}</div>}
      </div>

      <button className="btn ghost block" disabled={!agreed} onClick={useDemo}>✨ Try with demo patient "Maya"</button>
      <div className="d center" style={{ marginTop: 8 }}>Synthetic postpartum patient, 9 weeks on tirzepatide</div>
    </>
  );
}
