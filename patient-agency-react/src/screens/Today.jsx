import { useMemo, useState } from 'react';
import { useStore } from '../state/store.jsx';
import { evaluate, doseSchedule, weightStats, fmt, fmtLong } from '../rules/engine.js';
import { ActionCard, AlertCard } from '../components/ui.jsx';

const PROTEIN_GOAL = 100;
const WATER_GOAL = 8;
const FOODS = [['Greek yogurt', 20], ['Protein shake', 25], ['2 eggs', 12], ['Chicken breast', 30], ['Cottage cheese', 14], ['Protein bar', 15]];
const EFFECTS = ['Nausea', 'Constipation', 'Reflux', 'Fatigue', 'Belly pain', 'None'];
const TIPS = {
  Nausea: 'Smaller meals, stop eating when full, go easy on greasy food.',
  Constipation: 'More water and fiber; gentle walks help.',
  Reflux: 'Avoid lying down within 2–3 hours of eating.',
  Fatigue: 'Check protein and fluids. With little ones, sleep counts too.'
};

export default function Today() {
  const { state, dispatch, toast, today } = useStore();
  const { ctx, logs, selfReport: sr, acked, sources } = state;
  const [quick, setQuick] = useState(null);
  const [effects, setEffects] = useState([]);

  const alerts = useMemo(() => evaluate(ctx, sr, logs, today), [ctx, sr, logs, today]);
  const sched = doseSchedule(ctx, logs, today);
  const ws = weightStats(ctx, logs);
  const latest = ws?.series[ws.series.length - 1];
  const [weightVal, setWeightVal] = useState(latest?.lb ?? 180);

  const protein = logs.protein[today] || 0;
  const water = logs.water[today] || 0;
  const done = k => logs.done[`${today}:${k}`];
  const setDone = (key, value, msg) => { dispatch({ type: 'setDone', date: today, key, value }); if (msg) toast(msg); };
  const weighedToday = logs.weights.find(w => w.date === today);
  const injectedToday = logs.injections.find(i => i.date === today);
  const moodToday = logs.mood.find(m => m.date === today);
  const a1cDue = alerts.some(a => a.id === 'S-9');
  const banner = alerts.filter(a => (a.severity === 'red' || a.severity === 'amber') && !acked[a.id] && a.id !== 'S-5'); // S-5 shows inline under Mood

  const logWeight = () => { dispatch({ type: 'logWeight', date: today, lb: weightVal }); setQuick(null); toast(`Weight logged: ${weightVal.toFixed(1)} lb`); };
  const addProtein = g => { dispatch({ type: 'addProtein', date: today, g }); toast(protein < PROTEIN_GOAL && protein + g >= PROTEIN_GOAL ? `🎉 Protein goal hit: ${protein + g} g` : `+${g} g protein · ${protein + g}/${PROTEIN_GOAL} g`); };
  const logDose = () => { dispatch({ type: 'logInjection', date: today, mg: sched.daysUntil === 0 ? sched.nextMg : sched.currentMg }); setQuick(null); toast('💉 Dose logged'); };
  const scrollTo = id => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const onAlert = a => {
    const k = a.action?.kind;
    if (k === 'ack') { dispatch({ type: 'ack', id: a.id, date: today }); toast('Got it. We\'ll remind you on dose day and for 4 weeks after.'); }
    else if (k === 'call') toast('Calling your clinician\'s office…');
    else if (k === 'share') toast('Note shared with your OB');
    else if (k === 'askOb') toast('Message sent to your OB\'s office');
    else if (k === 'resources') toast('Opening postpartum support resources');
  };

  const toggleEffect = e => setEffects(cur => e === 'None' ? (cur.includes('None') ? [] : ['None']) : (cur.includes(e) ? cur.filter(x => x !== e) : [...cur.filter(x => x !== 'None'), e]));
  const saveEffects = () => {
    const urgent = effects.includes('Belly pain');
    dispatch({ type: 'logSideEffects', date: today, types: effects });
    setEffects([]);
    if (urgent) { toast('Saved. Please read the alert at the top.'); document.querySelector('.screen')?.scrollTo({ top: 0, behavior: 'smooth' }); }
    else toast('Saved to your log and visit summary');
  };

  const doneCount = [weighedToday, protein >= PROTEIN_GOAL, done('strength') === 'done', !!done('refill') || !ctx.meds.glp1, !a1cDue || !!done('a1c'), moodToday].filter(Boolean).length;

  const Q = ({ id, ic, label, did }) => (
    <button className={`qbtn ${quick === id ? 'on' : did ? 'did' : ''}`}
      onClick={() => (id === 'effect' || id === 'mood') ? (setQuick(null), scrollTo(id === 'mood' ? 'moodsec' : 'effectsec')) : setQuick(quick === id ? null : id)}>
      <span className="ic">{did && quick !== id ? '✅' : ic}</span>{label}
    </button>
  );

  return (
    <>
      <h1>Hi, {ctx.patient?.firstName || 'there'} 👋</h1>
      <p className="sub">{fmtLong(today)}{sched ? ` · Week ${sched.weekNumber} on ${ctx.meds.glp1.brand}` : ''} · <b style={{ color: 'var(--brand)' }}>{doneCount}/6 done today</b></p>

      <div className="card hero">
        <div className="row between">
          <div><div className="d">Since you started</div><div style={{ fontSize: 26, fontWeight: 800 }}>{ws ? `${ws.lost >= 0 ? '−' : '+'}${Math.abs(ws.lost)} lb` : '—'}</div></div>
          {sched && <div style={{ textAlign: 'right' }}><div className="d">Next dose</div><div style={{ fontWeight: 700 }}>{sched.daysUntil === 0 ? 'Today' : fmtLong(sched.nextDate).split(',')[0]} · {sched.nextMg} mg</div></div>}
        </div>
        <div className="stepper"><div className="f" /><div className="f" /><div className={ctx.meds.glp1 ? 'f' : ''} /><div /></div>
        <div className="d" style={{ marginTop: 6 }}>Ready ✓ · Covered ✓ · {ctx.meds.glp1 ? 'Prescribed ✓ · ' : ''}<b style={{ color: '#fff' }}>On track</b></div>
      </div>

      {banner.map(a => <AlertCard key={a.id} alert={a} onAction={onAlert} />)}

      <h2>Quick log</h2>
      <div className="qgrid">
        <Q id="weight" ic="⚖️" label="Weight" did={!!weighedToday} />
        <Q id="protein" ic="🍳" label="Protein" did={protein >= PROTEIN_GOAL} />
        <Q id="water" ic="💧" label={`Water · ${water}/${WATER_GOAL}`} did={water >= WATER_GOAL} />
        <Q id="inject" ic="💉" label="Injection" did={!!injectedToday} />
        <Q id="effect" ic="🤢" label="Side effect" />
        <Q id="mood" ic="💜" label="Mood" did={!!moodToday} />
      </div>

      {quick === 'weight' && (
        <div className="panel"><div className="t">Log weight</div>
          <div className="stepperw">
            <button onClick={() => setWeightVal(v => Math.round((v - 0.2) * 10) / 10)} aria-label="decrease">−</button>
            <div className="val">{weightVal.toFixed(1)}<span style={{ fontSize: 13, fontWeight: 600 }}> lb</span></div>
            <button onClick={() => setWeightVal(v => Math.round((v + 0.2) * 10) / 10)} aria-label="increase">+</button>
            <button className="act primary" style={{ marginLeft: 'auto' }} onClick={logWeight}>Save</button>
          </div>
        </div>
      )}
      {quick === 'protein' && (
        <div className="panel"><div className="t">Add protein · {protein}/{PROTEIN_GOAL} g</div>
          <div className="acts">{FOODS.map(([n, g]) => <button key={n} className="act" onClick={() => addProtein(g)}>{n} · {g} g</button>)}</div>
        </div>
      )}
      {quick === 'water' && (
        <div className="panel"><div className="t">Water · {water} of {WATER_GOAL} glasses</div>
          <div className="d">Fluids help with nausea and constipation on GLP-1s.</div>
          <div className="acts">
            <button className="act primary" onClick={() => { dispatch({ type: 'addWater', date: today, n: 1 }); toast(`💧 ${water + 1}/${WATER_GOAL} glasses`); }}>+ 1 glass</button>
            <button className="act" onClick={() => dispatch({ type: 'addWater', date: today, n: 2 })}>+ Bottle (2)</button>
            <button className="act" onClick={() => dispatch({ type: 'addWater', date: today, n: -1 })}>− 1</button>
          </div>
        </div>
      )}
      {quick === 'inject' && (
        <div className="panel"><div className="t">Weekly injection</div>
          <div className="d">{injectedToday ? `Logged today: ${injectedToday.mg} mg` : sched ? `Next dose: ${fmtLong(sched.nextDate)} · ${sched.nextMg} mg${sched.stepUp ? ' (new strength)' : ''}` : 'No GLP-1 on your record.'}</div>
          {sched && <div className="acts">
            <button className="act primary" onClick={logDose}>💉 Log dose now</button>
            <button className="act" onClick={() => toast(`Reminder set: ${fmtLong(sched.nextDate)} 8:00 am`)}>⏰ Remind me</button>
            <button className="act" onClick={() => toast('Tip: rotate between belly, thigh and upper arm')}>Site rotation tips</button>
          </div>}
        </div>
      )}

      <h2>Today's actions</h2>

      {sched?.daysUntil === 0 && (
        <ActionCard done={!!injectedToday} doneText={`Dose logged · ${injectedToday?.mg} mg`} title={`Take your ${sched.nextMg} mg dose`}
          actions={[{ label: '💉 Log dose', primary: true, onClick: logDose }, { label: 'Remind me at 8 pm', onClick: () => toast('Reminder set for 8:00 pm') }]}
          sources={['Medication list', 'Dose schedule']}>
          {sched.stepUp ? 'First dose at your new strength.' : 'Your weekly dose is due today.'}
        </ActionCard>
      )}

      <ActionCard done={!!weighedToday} doneText={`Logged ${weighedToday?.lb.toFixed(1)} lb`} title="Weigh in"
        onUndo={() => dispatch({ type: 'undoWeight', date: today })}
        actions={[{ label: `✓ Log ${weightVal.toFixed(1)} lb`, primary: true, onClick: logWeight }, { label: 'Edit', onClick: () => setQuick('weight') }]}
        sources={[latest ? `${latest.source} · ${fmt(latest.date)}` : 'No weight on file']}
        warning={!sources.devices ? 'Devices disconnected. Logging manually.' : null}>
        {latest ? <>Last weight: <b>{latest.lb.toFixed(1)} lb</b> ({fmt(latest.date)}). Step on the scale and confirm.</> : 'Add your first weight.'}
      </ActionCard>

      <ActionCard done={protein >= PROTEIN_GOAL} doneText={`Protein goal hit · ${protein} g`} title="Hit your protein goal"
        onUndo={() => dispatch({ type: 'resetProtein', date: today })}
        actions={FOODS.slice(0, 4).map(([n, g]) => ({ label: `+ ${n} · ${g} g`, onClick: () => addProtein(g) }))}
        sources={['Self-reported']}>
        <b>{protein} of {PROTEIN_GOAL} g</b> so far. Protein helps protect muscle while you lose weight.
        <div className="bar"><i style={{ width: `${Math.min(100, protein)}%` }} /></div>
      </ActionCard>

      <ActionCard done={done('strength') === 'done'} doneText="Strength session done 💪" title="20-min strength session"
        onUndo={() => setDone('strength', null)}
        actions={done('strength') === 'scheduled'
          ? [{ label: '▶ Start workout', primary: true, onClick: () => setDone('strength', 'done', '💪 Nice work!') }, { label: 'Snooze to 8 pm', onClick: () => toast('Moved to 8:00 pm after bedtime') }]
          : [{ label: '📅 Book 1:00 pm', primary: true, onClick: () => setDone('strength', 'scheduled', '📅 Added to calendar: 1:00 pm (20 min)') }, { label: '▶ Start now', onClick: () => setDone('strength', 'done', '💪 Nice work!') }, { label: 'Skip today', onClick: () => toast('No problem. We\'ll suggest tomorrow\'s nap slot.') }]}
        sources={['Calendar (mock)']}
        warning={!sources.calendar ? 'Calendar disconnected.' : null}>
        {done('strength') === 'scheduled' ? <>Scheduled for <b>1:00 pm</b> during nap time.</> : <>You're free <b>1:00–1:30 pm</b> during nap time. Strength training helps keep muscle on GLP-1s.</>}
      </ActionCard>

      {ctx.meds.glp1 && (
        <ActionCard done={!!done('refill')} doneText={done('refill') === 'delivery' ? 'Delivery set for Wed' : 'Pickup Thu after 10 am'} title={`Refill ${ctx.meds.glp1.brand}`}
          onUndo={() => setDone('refill', null)}
          actions={[{ label: '🏪 Pick up Thu', primary: true, onClick: () => setDone('refill', 'pickup', 'Refill requested: pickup Thu') }, { label: '🚚 Deliver Wed', onClick: () => setDone('refill', 'delivery', 'Refill requested: delivery Wed') }]}
          sources={['Pharmacy (mock)', 'Insurance (mock)']}>
          1 pen left. Copay <b>$25</b> with prior auth.
        </ActionCard>
      )}

      {a1cDue && (() => { const a = alerts.find(x => x.id === 'S-9'); return (
        <ActionCard done={!!done('a1c')} doneText={done('a1c') === 'booked' ? 'Lab booked · Sat 9:00 am' : 'Lab order requested'} title={a.title}
          onUndo={() => setDone('a1c', null)}
          actions={[{ label: '🧪 Book Sat 9:00 am', primary: true, onClick: () => setDone('a1c', 'booked', '🧪 Lab booked') }, { label: 'Request order', onClick: () => setDone('a1c', 'requested', 'Lab order request sent') }]}
          sources={a.sources}>
          {a.body}
        </ActionCard>
      ); })()}

      <h2 id="moodsec">How are you feeling?</h2>
      <div className="card">
        <div className="t">Mood today</div>
        <div className="mood">
          {['😞', '😕', '😐', '🙂', '😄'].map((e, i) => (
            <button key={e} className={moodToday?.score === i + 1 ? 'on' : ''} onClick={() => dispatch({ type: 'logMood', date: today, score: i + 1 })} aria-label={`mood ${i + 1}`}>{e}</button>
          ))}
        </div>
        {moodToday && moodToday.score > 2 && <div className="d" style={{ marginTop: 8 }}>Logged. We'll include your trend in your visit summary.</div>}
        {moodToday && moodToday.score <= 2 && (
          <div className="card alert red" style={{ margin: '10px 0 0' }}>
            <div className="t">Thanks for sharing 💜</div>
            <div className="d">Feeling low after having a baby is common, and support helps. If you're in crisis, call or text <b>988</b>.</div>
            <div className="acts">
              <button className="act primary" onClick={() => toast('Note shared with your OB')}>Share with my OB</button>
              <button className="act" onClick={() => toast('Opening postpartum support resources')}>Support resources</button>
            </div>
          </div>
        )}
      </div>

      <h2 id="effectsec">Any side effects?</h2>
      <div className="card">
        <div className="acts" style={{ marginTop: 0 }}>
          {EFFECTS.map(e => <button key={e} className={`act ${effects.includes(e) ? 'on' : ''}`} onClick={() => toggleEffect(e)}>{e}</button>)}
        </div>
        {effects.length === 0 && <div className="d" style={{ marginTop: 8 }}>Tap any you've noticed.</div>}
        {effects.filter(e => TIPS[e]).map(e => <div key={e} className="d" style={{ marginTop: 6 }}><b>{e}:</b> {TIPS[e]}</div>)}
        {effects.includes('Belly pain') && <div className="d" style={{ marginTop: 6, color: 'var(--red)' }}>Save to see what to do about belly pain.</div>}
        {effects.length > 0 && <button className="act primary" style={{ marginTop: 10 }} onClick={saveEffects}>Save to my log</button>}
      </div>
    </>
  );
}
