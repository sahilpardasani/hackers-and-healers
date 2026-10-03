import { useState } from 'react';
import { useStore } from '../state/store.jsx';
import { visitSummary } from '../rules/engine.js';

export default function VisitPrep() {
  const { state, dispatch, toast, today } = useStore();
  const { ctx, selfReport, logs, questions } = state;
  const [draft, setDraft] = useState('');
  const text = visitSummary(ctx, selfReport, logs, today, questions);

  const addQuestion = () => {
    if (!draft.trim()) return;
    dispatch({ type: 'setQuestions', questions: [...questions, draft.trim()] });
    setDraft('');
  };
  const removeQuestion = i => dispatch({ type: 'setQuestions', questions: questions.filter((_, j) => j !== i) });

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast('Summary copied'); }
    catch { toast('Copy not available in this browser'); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `patient-agency-visit-summary-${today}.txt` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <h1>Visit prep</h1>
      <p className="sub">A summary for your next check-in</p>

      <div className="card">
        <div className="tag">Auto-generated from your record + check-ins</div>
        <pre className="summary">{text}</pre>
      </div>

      <div className="card">
        <div className="t">My questions</div>
        {questions.map((q, i) => (
          <div key={i} className="chk"><span style={{ fontSize: 13 }}>{q}</span><button className="undo" onClick={() => removeQuestion(i)}>Remove</button></div>
        ))}
        <div className="row" style={{ marginTop: 8 }}>
          <input type="text" value={draft} placeholder="Add a question…" onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && addQuestion()} />
          <button className="act primary" onClick={addQuestion}>Add</button>
        </div>
      </div>

      <button className="btn block" onClick={copy}>📋 Copy summary</button>
      <button className="btn ghost block" style={{ marginTop: 8 }} onClick={download}>⬇️ Download (.txt)</button>
    </>
  );
}
