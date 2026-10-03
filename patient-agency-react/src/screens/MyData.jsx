import { useStore } from '../state/store.jsx';
import { fmt } from '../rules/engine.js';

const OTHER = [
  ['devices', '⌚', '#fdecec', 'Devices', 'Apple Health / Health Connect (planned)', 'Weight, activity, sleep'],
  ['calendar', '📅', '#efeaff', 'Calendar', 'Google / Outlook (mock)', 'Finding time for workouts & visits'],
  ['pharmacy', '💊', '#fff4e0', 'Pharmacy', 'Surescripts (planned)', 'Refills, stock, fill history'],
  ['insurance', '🛡️', '#e8f7ee', 'Insurance', 'Flexpa (planned)', 'Coverage, prior auth, copays']
];

export default function MyData() {
  const { state, dispatch, toast } = useStore();
  const { ctx, sources } = state;
  const counts = `${ctx.weights.length} weights · ${ctx.a1c.length} A1c · ${ctx.conditionList.length} conditions · ${ctx.meds.active.length} active meds`;

  return (
    <>
      <h1>My data</h1>
      <p className="sub">You choose what Patient Agency can use. Turn any source off anytime.</p>

      <div className="card">
        <div className="row">
          <div className="logo" style={{ background: '#e8f0ff' }}>🏥</div>
          <div style={{ flex: 1 }}>
            <div className="t">Health record (FHIR)</div>
            <div className="d">{ctx.source}{ctx.isDemo ? ' · synthetic' : ''}</div>
            <div className="src" style={{ marginTop: 3 }}>{counts}</div>
          </div>
          <span className="pill ok">Connected</span>
        </div>
        <div className="acts">
          <button className="act" onClick={() => { dispatch({ type: 'disconnect' }); toast('Disconnected'); }}>Disconnect</button>
        </div>
      </div>

      {OTHER.map(([k, ic, bg, t, s, u]) => (
        <div key={k} className="card">
          <div className="row">
            <div className="logo" style={{ background: bg }}>{ic}</div>
            <div style={{ flex: 1 }}><div className="t">{t}</div><div className="d">{s}</div><div className="src" style={{ marginTop: 3 }}>Used for: {u}</div></div>
            <label className="toggle">
              <input type="checkbox" checked={!!sources[k]} onChange={() => { dispatch({ type: 'toggleSource', key: k }); toast(`${t} ${sources[k] ? 'off. Related reminders paused.' : 'on'}`); }} />
              <span />
            </label>
          </div>
        </div>
      ))}

      <div className="card">
        <div className="t">From your record</div>
        {ctx.conditionList.map(c => <div key={c.label} className="chk"><span>{c.label}</span><span className="src">{fmt(c.date)}</span></div>)}
        {ctx.meds.active.map(m => <div key={m.text} className="chk"><span>💊 {m.text}</span><span className="src">{fmt(m.date)}</span></div>)}
      </div>

      <div className="card" style={{ background: '#fafafa' }}>
        <div className="t">🔒 Sensitive data</div>
        <div className="d">Reproductive and mental health info is used only for safety checks on this device. Your check-ins never leave this device in this prototype.</div>
        <div className="acts"><button className="act" onClick={() => { if (confirm('Delete all check-ins and answers on this device?')) { dispatch({ type: 'deleteMyData' }); toast('Your on-device data was deleted'); } }}>Delete my data</button></div>
      </div>
    </>
  );
}
