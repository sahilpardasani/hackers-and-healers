import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store.jsx';
import { parseUtterance } from '../agent/parse.js';
import { plan } from '../agent/respond.js';

const SUGGESTIONS = ['I took my shot', 'Walked 30 minutes with the stroller', 'Had a protein shake', 'Drank 2 glasses of water', 'Feeling a bit nauseous', 'What\'s next?', 'When is my next dose?'];

const SpeechRecognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

function useSpeech(onFinal) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const rec = useRef(null);
  const finalRef = useRef('');

  const start = () => {
    if (!SpeechRecognition || listening) return;
    const r = new SpeechRecognition();
    r.lang = 'en-US';
    r.interimResults = true;
    r.continuous = false;
    finalRef.current = '';
    r.onresult = e => {
      let fin = '', int = '';
      for (const res of e.results) (res.isFinal ? (fin += res[0].transcript) : (int += res[0].transcript));
      finalRef.current = fin;
      setInterim(fin || int);
    };
    r.onerror = () => setListening(false);
    r.onend = () => {
      setListening(false);
      setInterim('');
      if (finalRef.current.trim()) onFinal(finalRef.current.trim());
    };
    rec.current = r;
    setListening(true);
    r.start();
  };
  const stop = () => rec.current?.stop();
  useEffect(() => () => rec.current?.abort?.(), []);
  return { supported: !!SpeechRecognition, listening, interim, start, stop };
}

function speak(text, enabled) {
  if (!enabled || typeof window === 'undefined' || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[\u{1F300}-\u{1FAFF}]/gu, ''));
  u.rate = 1.02;
  window.speechSynthesis.speak(u);
}

export default function VoiceAgent() {
  const { state, dispatch, today } = useStore();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [voiceReplies, setVoiceReplies] = useState(true);
  const [messages, setMessages] = useState([
    { role: 'agent', text: `Hi ${state.ctx?.patient?.firstName || 'there'}! Tell me what you did and I'll log it, or ask me what's next.` }
  ]);
  const listRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const send = utterance => {
    const s = stateRef.current;
    const snapshot = { logs: s.logs, questions: s.questions };
    const intents = parseUtterance(utterance);
    const { actions, reply, logged } = plan(intents, s, today);
    actions.forEach(dispatch);
    setMessages(m => [...m, { role: 'user', text: utterance }, { role: 'agent', text: reply, logged, snapshot: actions.length ? snapshot : null }]);
    speak(reply, voiceReplies);
    setText('');
  };

  const speech = useSpeech(send);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, speech.interim]);

  const undo = idx => {
    const msg = messages[idx];
    if (!msg?.snapshot) return;
    dispatch({ type: 'restore', ...msg.snapshot });
    setMessages(m => m.map((x, i) => (i === idx ? { ...x, snapshot: null, undone: true } : x)).concat({ role: 'agent', text: 'Okay, I undid that.' }));
  };
  const lastUndoable = messages.reduce((acc, m, i) => (m.snapshot ? i : acc), -1);

  if (!open) {
    return <button className="fab" onClick={() => setOpen(true)} aria-label="Open voice log">🎙️</button>;
  }

  return (
    <div className="sheet" role="dialog" aria-label="Voice log">
      <div className="sheet-head">
        <div>
          <div className="t">🎙️ Voice log</div>
          <div className="src">{speech.supported ? 'Voice is transcribed by your browser' : 'Voice not supported in this browser, so type instead'}</div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className={`act ${voiceReplies ? 'on' : ''}`} onClick={() => { setVoiceReplies(v => !v); window.speechSynthesis?.cancel(); }} aria-label="Toggle spoken replies">{voiceReplies ? '🔊' : '🔇'}</button>
          <button className="act" onClick={() => { setOpen(false); speech.stop(); window.speechSynthesis?.cancel(); }} aria-label="Close">✕</button>
        </div>
      </div>

      <div className="msgs" ref={listRef}>
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">
              {m.text}
              {m.logged?.length > 0 && (
                <div className="logged">
                  {m.logged.map(l => <span key={l} className={`chip ${m.undone ? 'struck' : ''}`}>{m.undone ? '' : '✓ '}{l}</span>)}
                  {i === lastUndoable && <button className="undo" style={{ marginLeft: 6 }} onClick={() => undo(i)}>Undo</button>}
                </div>
              )}
            </div>
          </div>
        ))}
        {speech.listening && <div className="msg user"><div className="bubble interim">{speech.interim || 'Listening…'}</div></div>}
      </div>

      <div className="sugs">
        {SUGGESTIONS.map(s => <button key={s} className="act" onClick={() => send(s)}>{s}</button>)}
      </div>

      <div className="composer">
        <input type="text" value={text} placeholder='Try "I took my shot and walked 20 minutes"' onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && text.trim() && send(text.trim())} aria-label="Type a message" />
        {text.trim()
          ? <button className="mic" onClick={() => send(text.trim())} aria-label="Send">➤</button>
          : <button className={`mic ${speech.listening ? 'live' : ''}`} disabled={!speech.supported} onClick={speech.listening ? speech.stop : speech.start} aria-label={speech.listening ? 'Stop listening' : 'Start talking'}>🎙️</button>}
      </div>
      <div className="src center" style={{ padding: '0 12px 10px' }}>Patient Agency logs your check-ins and shares your own data. It doesn't give medical advice.</div>
    </div>
  );
}
