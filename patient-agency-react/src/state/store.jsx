import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, useCallback } from 'react';
import { iso } from '../rules/engine.js';

const KEY = 'patient-agency.v1';
export const todayISO = () => iso(new Date());

const emptyLogs = { weights: [], injections: [], sideEffects: [], mood: [], exercise: [], protein: {}, water: {}, done: {} };

const initial = {
  ctx: null,              // normalized PatientContext (FHIR)
  selfReport: {},         // readiness answers
  logs: emptyLogs,        // self-reported logs
  sources: { record: true, devices: true, calendar: true, food: true, pharmacy: true, insurance: true },
  questions: ['Should I consider a non-pill birth control?', 'What should I do about my medication if we plan another pregnancy?'],
  acked: {}               // alert id -> date acknowledged
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return initial;
    const s = JSON.parse(raw);
    return { ...initial, ...s, logs: { ...emptyLogs, ...s.logs } };
  } catch { return initial; }
}

const day = (obj, d) => obj?.[d] || 0;

function reducer(state, a) {
  const L = state.logs;
  switch (a.type) {
    case 'setContext': return { ...state, ctx: a.ctx };
    case 'disconnect': return { ...initial };
    case 'answer': return { ...state, selfReport: { ...state.selfReport, [a.key]: a.value } };
    case 'logWeight': return { ...state, logs: { ...L, weights: [...L.weights.filter(w => w.date !== a.date), { date: a.date, lb: a.lb }] } };
    case 'undoWeight': return { ...state, logs: { ...L, weights: L.weights.filter(w => w.date !== a.date) } };
    case 'logInjection': return { ...state, logs: { ...L, injections: [...L.injections, { date: a.date, mg: a.mg, site: a.site || null }] } };
    case 'addProtein': return { ...state, logs: { ...L, protein: { ...L.protein, [a.date]: Math.max(0, day(L.protein, a.date) + a.g) } } };
    case 'resetProtein': return { ...state, logs: { ...L, protein: { ...L.protein, [a.date]: 0 } } };
    case 'addWater': return { ...state, logs: { ...L, water: { ...L.water, [a.date]: Math.max(0, Math.min(12, day(L.water, a.date) + a.n)) } } };
    case 'logSideEffects': return { ...state, logs: { ...L, sideEffects: [...L.sideEffects, ...a.types.map(type => ({ date: a.date, type }))] } };
    case 'logMood': return { ...state, logs: { ...L, mood: [...L.mood.filter(m => m.date !== a.date), { date: a.date, score: a.score }] } };
    case 'logExercise': return { ...state, logs: { ...L, exercise: [...L.exercise, { date: a.date, kind: a.kind, minutes: a.minutes }] } };
    case 'addQuestion': return state.questions.includes(a.question) ? state : { ...state, questions: [...state.questions, a.question] };
    // Voice agent undo: restore a snapshot taken before its actions ran
    case 'restore': return { ...state, logs: a.logs, questions: a.questions };
    case 'setDone': return { ...state, logs: { ...L, done: { ...L.done, [`${a.date}:${a.key}`]: a.value } } };
    case 'ack': return { ...state, acked: { ...state.acked, [a.id]: a.date } };
    case 'toggleSource': return { ...state, sources: { ...state.sources, [a.key]: !state.sources[a.key] } };
    case 'setQuestions': return { ...state, questions: a.questions };
    case 'deleteMyData': return { ...state, logs: emptyLogs, selfReport: {}, acked: {} };
    default: return state;
  }
}

const Ctx = createContext(null);

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);
  const [toastMsg, setToastMsg] = useState(null);
  const timer = useRef();

  useEffect(() => {
    // Only the synthetic demo record is cached. Live EHR data stays in memory and is re-fetched on reconnect.
    const toSave = state.ctx?.isDemo ? state : { ...state, ctx: null };
    try { localStorage.setItem(KEY, JSON.stringify(toSave)); } catch { /* storage unavailable: keep in memory */ }
  }, [state]);

  const toast = useCallback(msg => {
    setToastMsg(msg);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToastMsg(null), 2200);
  }, []);

  const value = useMemo(() => ({ state, dispatch, toast, toastMsg, today: todayISO() }), [state, toast, toastMsg]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useStore = () => useContext(Ctx);
