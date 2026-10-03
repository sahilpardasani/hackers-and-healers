import { useStore } from '../state/store.jsx';

export const Sources = ({ items = [] }) => <div>{items.map(s => <span key={s} className="chip">{s}</span>)}</div>;

export function Toast() {
  const { toastMsg } = useStore();
  return <div className={`toast ${toastMsg ? 'show' : ''}`} role="status">{toastMsg}</div>;
}

export const TABS = [
  { id: 'today', label: 'Today', ic: '☀️' },
  { id: 'journey', label: 'Journey', ic: '🧭' },
  { id: 'progress', label: 'Progress', ic: '📈' },
  { id: 'data', label: 'My data', ic: '🔗' },
  { id: 'visit', label: 'Visit prep', ic: '🩺' },
  { id: 'trials', label: 'Trials', ic: '🔬' }
];

export function BottomNav({ tab, onChange }) {
  return (
    <nav className="nav">
      {TABS.map(t => (
        <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => onChange(t.id)} aria-current={tab === t.id}>
          <span className="ic">{t.ic}</span>{t.label}
        </button>
      ))}
    </nav>
  );
}

/** Alert from the rules engine. */
export function AlertCard({ alert, onAction }) {
  return (
    <div className={`card alert ${alert.severity === 'amber' ? '' : alert.severity}`}>
      <div className="t">{alert.severity === 'amber' ? '⚠️ ' : ''}{alert.title}</div>
      <div className="d">{alert.body}</div>
      <Sources items={alert.sources} />
      {alert.action && (
        <div className="acts">
          <button className="act primary" onClick={() => onAction(alert)}>{alert.action.label}</button>
          {alert.id === 'S-6' && <button className="act" onClick={() => onAction({ ...alert, action: { kind: 'askOb' } })}>Ask my OB</button>}
          {alert.id === 'S-5' && <button className="act" onClick={() => onAction({ ...alert, action: { kind: 'resources' } })}>Support resources</button>}
        </div>
      )}
    </div>
  );
}

/**
 * One-tap action card. When done, collapses to a green line with Undo.
 * actions: [{ label, onClick, primary }]
 */
export function ActionCard({ done, doneText, title, children, actions = [], onUndo, sources, warning }) {
  if (done) {
    return (
      <div className="card tcard done row between">
        <span className="donebadge">✅ {doneText}</span>
        {onUndo && <button className="undo" onClick={onUndo}>Undo</button>}
      </div>
    );
  }
  return (
    <div className="card tcard">
      <div className="t">{title}</div>
      <div className="d">{children}</div>
      <div className="acts">
        {actions.map(a => <button key={a.label} className={`act ${a.primary ? 'primary' : ''}`} onClick={a.onClick}>{a.label}</button>)}
      </div>
      {sources && <Sources items={sources} />}
      {warning && <div className="d" style={{ color: 'var(--red)' }}>⚠ {warning}</div>}
    </div>
  );
}

export const Check = ({ label, value, source, tone = 'ok' }) => (
  <div className="chk">
    <div>{label}<div className="src">{source}</div></div>
    <span className={`pill ${tone}`}>{value}</span>
  </div>
);
