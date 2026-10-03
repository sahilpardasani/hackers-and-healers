// Turns parsed intents into store actions + a spoken/written reply.
// Answers come only from the patient's own data and the rules engine. Anything else is
// treated as a question for her clinician (added to Visit prep), never answered as medical advice.
import { evaluate, doseSchedule, weightStats, fmtLong } from '../rules/engine.js';

const TIPS = {
  Nausea: 'Try smaller meals, stop eating when you feel full, and go easy on greasy food.',
  Constipation: 'More water and fiber help, and so do gentle walks.',
  Reflux: 'Avoid lying down for 2–3 hours after eating.',
  Fatigue: 'Check your protein and fluids. With little ones, rest counts too.'
};

/** What's still open today, in priority order. */
export function nextSteps(state, today) {
  const { ctx, logs, selfReport } = state;
  const steps = [];
  const sched = doseSchedule(ctx, logs, today);
  const done = k => logs.done[`${today}:${k}`];
  const alerts = evaluate(ctx, selfReport, logs, today);
  if (alerts.some(a => a.id === 'S-4')) steps.push('contact your clinician about your belly pain');
  if (sched?.daysUntil === 0 && !logs.injections.some(i => i.date === today)) steps.push(`take your ${sched.nextMg} mg dose`);
  if (!logs.weights.some(w => w.date === today)) steps.push('log your weight');
  const protein = logs.protein[today] || 0;
  if (protein < 100) steps.push(`get ${100 - protein} more grams of protein`);
  if (!(logs.exercise || []).some(e => e.date === today) && done('strength') !== 'done') steps.push('fit in a 20-minute strength session');
  if (alerts.some(a => a.id === 'S-9') && !done('a1c')) steps.push('book your A1c test');
  if (sched && sched.daysUntil > 0 && sched.daysUntil <= 3) steps.push(`get ready for your ${sched.nextMg} mg dose on ${fmtLong(sched.nextDate)}`);
  return steps;
}

const list = a => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

export function answer(topic, state, today, text) {
  const { ctx, logs } = state;
  const sched = doseSchedule(ctx, logs, today);
  switch (topic) {
    case 'next': {
      const s = nextSteps(state, today).slice(0, 3);
      return s.length ? `Here's what's next: ${list(s)}.` : 'You\'ve done everything for today. Nice work!';
    }
    case 'dose':
      return sched
        ? `Your next dose is ${sched.daysUntil === 0 ? 'today' : fmtLong(sched.nextDate)}: ${sched.nextMg} mg${sched.stepUp ? ', a step up from ' + sched.currentMg + ' mg' : ''}.`
        : 'I don\'t see a GLP-1 on your record yet.';
    case 'refill':
      return ctx.meds.glp1 ? 'You have 1 pen left. You can pick up your refill Thursday or get it delivered Wednesday from the Today screen.' : 'I don\'t see a GLP-1 prescription to refill.';
    case 'contraception':
      return ctx.meds.glp1?.drug === 'tirzepatide' && ctx.meds.oralContraceptive
        ? 'Tirzepatide can make birth control pills less effective. Use a backup method like condoms for 4 weeks after starting and after each dose increase. Your OB can talk through non-pill options.'
        : 'I\'ll add this to your visit questions so you can ask your clinician.';
    case 'progress': {
      const ws = weightStats(ctx, logs);
      return ws ? `You've lost ${ws.lost} pounds since you started, which is ${ws.pct}% of your starting weight.${ws.pct >= 5 ? ' You\'ve passed the 5% milestone!' : ''}` : 'Log a weight and I\'ll track your progress.';
    }
    case 'sideEffects':
      return Object.entries(TIPS).filter(([k]) => text.toLowerCase().includes(k.toLowerCase().slice(0, 5))).map(([, v]) => v).join(' ')
        || 'Common side effects like nausea and constipation usually ease over time. Tell me what you\'re feeling and I\'ll log it. For severe belly pain, contact your clinician right away.';
    case 'protein': {
      const p = logs.protein[today] || 0;
      return `You're at ${p} of 100 grams today. Greek yogurt, a protein shake or chicken are quick ways to add more.`;
    }
    default:
      return null; // handled by caller: add to visit questions
  }
}

/**
 * Apply intents. Returns { actions: [reducer actions], reply: string, logged: [labels], addQuestion?: string }
 */
export function plan(intents, state, today) {
  const actions = [];
  const logged = [];
  const extras = [];
  let addQuestion = null;
  const sched = doseSchedule(state.ctx, state.logs, today);

  for (const i of intents) {
    switch (i.type) {
      case 'dose': {
        const mg = i.mg ?? (sched ? (sched.daysUntil <= 1 ? sched.nextMg : sched.currentMg) : null);
        actions.push({ type: 'logInjection', date: today, mg });
        logged.push(`💉 Dose${mg ? ` · ${mg} mg` : ''}`);
        if (state.ctx.meds.glp1?.drug === 'tirzepatide' && state.ctx.meds.oralContraceptive && sched?.stepUp) extras.push('Reminder: since this is a new dose, use backup birth control for the next 4 weeks.');
        break;
      }
      case 'weight':
        actions.push({ type: 'logWeight', date: today, lb: i.lb });
        logged.push(`⚖️ Weight · ${i.lb} lb`);
        break;
      case 'protein':
        actions.push({ type: 'addProtein', date: today, g: i.g });
        logged.push(`🍳 ${i.label} · ${i.g} g protein`);
        break;
      case 'water':
        actions.push({ type: 'addWater', date: today, n: i.n });
        logged.push(`💧 Water · ${i.n} glass${i.n > 1 ? 'es' : ''}`);
        break;
      case 'exercise':
        actions.push({ type: 'logExercise', date: today, kind: i.kind, minutes: i.minutes });
        if (i.kind === 'Strength') actions.push({ type: 'setDone', date: today, key: 'strength', value: 'done' });
        logged.push(`🏃 ${i.kind} · ${i.minutes} min`);
        break;
      case 'sideEffect':
        actions.push({ type: 'logSideEffects', date: today, types: i.types });
        logged.push(`🤢 ${i.types.join(', ')}`);
        if (i.types.includes('Belly pain')) extras.push('If your belly pain is severe or won\'t go away, especially with vomiting, contact your clinician right away. It can be a sign of pancreatitis or a gallbladder problem.');
        else i.types.forEach(t => TIPS[t] && extras.push(TIPS[t]));
        break;
      case 'mood':
        actions.push({ type: 'logMood', date: today, score: i.score });
        logged.push(`💜 Mood · ${i.score}/5`);
        if (i.score <= 2) extras.push('Thank you for telling me. Feeling low after having a baby is common, and support helps. Would you like to share a note with your OB? If you\'re in crisis, call or text 988.');
        break;
      case 'question': {
        const a = answer(i.topic, state, today, i.text);
        if (a) extras.push(a);
        else {
          addQuestion = i.text.charAt(0).toUpperCase() + i.text.slice(1) + '?';
          extras.push('That\'s a great question for your clinician. I can\'t give medical advice, so I\'ve added it to your visit questions.');
        }
        break;
      }
      default: break;
    }
  }

  if (addQuestion) actions.push({ type: 'addQuestion', question: addQuestion });

  let reply;
  if (!intents.length) reply = 'Sorry, I didn\'t catch that. You can say things like "I took my shot", "I walked 30 minutes", or "what\'s next?"';
  else {
    const head = logged.length ? `Got it. I logged ${logged.length === 1 ? 'that' : `${logged.length} things`}.` : '';
    reply = [head, ...extras].filter(Boolean).join(' ');
  }
  return { actions, reply, logged, addQuestion };
}
