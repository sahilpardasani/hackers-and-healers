import { useStore } from '../state/store.jsx';
import { weightStats, evaluate, effectiveGlp1, daysBetween, fmt } from '../rules/engine.js';

function WeightChart({ series, startW }) {
  const w = 320, h = 160, p = 26;
  const vals = series.map(s => s.lb);
  const min = Math.floor(Math.min(...vals, startW) - 3), max = Math.ceil(Math.max(...vals, startW) + 2);
  const t0 = new Date(series[0].date).getTime(), t1 = new Date(series[series.length - 1].date).getTime() || t0 + 1;
  const x = d => p + ((new Date(d).getTime() - t0) / Math.max(1, t1 - t0)) * (w - 2 * p);
  const y = v => h - p - ((v - min) / Math.max(1, max - min)) * (h - 2 * p);
  const path = series.map((s, i) => `${i ? 'L' : 'M'}${x(s.date).toFixed(1)},${y(s.lb).toFixed(1)}`).join(' ');
  const goal = startW * 0.95;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ marginTop: 6 }} role="img" aria-label="Weight trend">
      <line x1={p} x2={w - p} y1={y(goal)} y2={y(goal)} stroke="#16a34a" strokeDasharray="4 4" />
      <text x={w - p} y={y(goal) - 5} fontSize="10" textAnchor="end" fill="#16a34a">5% milestone · {goal.toFixed(1)}</text>
      <path d={path} fill="none" stroke="#7c5cff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {series.map((s, i) => <circle key={i} cx={x(s.date)} cy={y(s.lb)} r="3.5" fill={s.source === 'Self-reported' ? '#fff' : '#7c5cff'} stroke="#7c5cff" strokeWidth="2" />)}
      <text x={p} y={h - 6} fontSize="10" fill="#6b7280">{fmt(series[0].date)}</text>
      <text x={w - p} y={h - 6} fontSize="10" textAnchor="end" fill="#6b7280">{fmt(series[series.length - 1].date)}</text>
    </svg>
  );
}

export default function Progress() {
  const { state, today } = useStore();
  const { ctx, logs, selfReport } = state;
  const ws = weightStats(ctx, logs);
  const g = effectiveGlp1(ctx, logs);
  const milestone = evaluate(ctx, selfReport, logs, today).find(a => a.id === 'S-8');
  const weeks = g ? Math.floor(daysBetween(g.startDate, today) / 7) : null;
  const moods = logs.mood.slice(-10);
  const proteinDays = Object.entries(logs.protein).filter(([, v]) => v > 0);
  const weekExercise = (logs.exercise || []).filter(e => daysBetween(e.date, today) < 7);
  const weekMinutes = weekExercise.reduce((a, e) => a + e.minutes, 0);
  const avgProtein =proteinDays.length ? Math.round(proteinDays.reduce((a, [, v]) => a + v, 0) / proteinDays.length) : 0;

  return (
    <>
      <h1>Progress</h1>
      <p className="sub">{weeks !== null ? `${weeks} weeks on ${g.brand}` : 'Your trends'}</p>

      {ws ? (
        <>
          <div className="stats">
            <div className="stat"><b>{ws.lost >= 0 ? '−' : '+'}{Math.abs(ws.lost)}</b><span>lb since start</span></div>
            <div className="stat"><b>{ws.pct}%</b><span>of start weight</span></div>
            <div className="stat"><b>{ws.current}</b><span>lb now</span></div>
          </div>
          <div className="card" style={{ marginTop: 10 }}>
            <div className="row between"><div className="t">Weight trend</div>{milestone ? <span className="pill ok">5% reached</span> : <span className="pill brandp">In progress</span>}</div>
            <WeightChart series={ws.series} startW={ws.startW} />
            <div className="d">● From your record · ○ Self-reported</div>
          </div>
        </>
      ) : <div className="card"><div className="d">No weights yet. Log one from Today.</div></div>}

      {milestone && <div className="card alert success"><div className="t">{milestone.title}</div><div className="d">{milestone.body}</div></div>}

      <div className="card">
        <div className="t">Muscle protection</div>
        <div className="row between d" style={{ marginTop: 6 }}><span>Avg protein on logged days</span><b style={{ color: 'var(--ink)' }}>{avgProtein} g of 100</b></div>
        <div className="bar"><i style={{ width: `${Math.min(100, avgProtein)}%` }} /></div>
      </div>

      <div className="card">
        <div className="row between"><div className="t">Exercise (last 7 days)</div><span className="pill brandp">{weekMinutes} min</span></div>
        {weekExercise.length
          ? weekExercise.slice().reverse().map((e, i) => <div key={i} className="chk"><span>{e.kind} · {e.minutes} min</span><span className="src">{fmt(e.date)}</span></div>)
          : <div className="d">Nothing yet. Try the 🎙️ button: "I walked 30 minutes".</div>}
      </div>

      <div className="card">
        <div className="t">Mood check-ins</div>
        {moods.length ? (
          <div className="row" style={{ alignItems: 'flex-end', gap: 6, height: 70, marginTop: 10 }}>
            {moods.map(m => <div key={m.date} title={`${fmt(m.date)}: ${m.score}/5`} style={{ flex: 1, background: m.score <= 2 ? '#fca5a5' : '#c4b5fd', borderRadius: '6px 6px 0 0', height: m.score * 13 }} />)}
          </div>
        ) : <div className="d">No check-ins yet.</div>}
      </div>

      <div className="card">
        <div className="t">Side-effect log</div>
        {logs.sideEffects.length
          ? logs.sideEffects.slice().reverse().map((e, i) => <div key={i} className="chk"><span>{e.type}</span><span className="src">{fmt(e.date)}</span></div>)
          : <div className="d">Nothing logged.</div>}
      </div>
    </>
  );
}
