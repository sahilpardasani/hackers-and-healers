// Patient Agency rules engine (PRD section 7). Pure functions — easy to unit test.
// All clinical wording is illustrative and must be reviewed by a clinician before any pilot.

const DAY = 86400000;
export const toDate = s => new Date(s + (s.length === 10 ? 'T12:00:00' : ''));
export const iso = d => d.toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);
export const addDays = (s, n) => iso(new Date(toDate(s).getTime() + n * DAY));
export const fmt = s => (s ? toDate(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
export const fmtLong = s => (s ? toDate(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '');

/** Merge FHIR weights and self-reported weights into one series. */
export function weightSeries(ctx, logs) {
  const all = [...(ctx.weights || []), ...(logs.weights || []).map(w => ({ ...w, source: 'Self-reported' }))];
  return all.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Start weight = latest weight on/before GLP-1 start, else first weight. */
export function weightStats(ctx, logs) {
  const series = weightSeries(ctx, logs);
  if (!series.length) return null;
  const start = ctx.meds.glp1?.startDate;
  const before = start ? series.filter(w => w.date <= start) : [];
  const startW = (before[before.length - 1] || series[0]).lb;
  const current = series[series.length - 1].lb;
  const lost = Math.round((startW - current) * 10) / 10;
  const pct = Math.round((lost / startW) * 1000) / 10;
  return { series, startW, current, lost, pct };
}

/** Next weekly dose and whether it's a step-up (every 4 weeks on the same dose). */
/** GLP-1 from the record, updated by any higher dose the patient has logged since. */
export function effectiveGlp1(ctx, logs) {
  const g = ctx.meds.glp1;
  if (!g) return null;
  const higher = (logs.injections || []).filter(i => i.mg > g.currentMg && i.date >= g.currentDoseSince);
  if (!higher.length) return g;
  const first = higher.reduce((a, b) => (b.mg > a.mg || (b.mg === a.mg && b.date < a.date) ? b : a));
  return { ...g, currentMg: first.mg, currentDoseSince: first.date };
}

export function doseSchedule(ctx, logs, today, injectionDay = 0) {
  const g = effectiveGlp1(ctx, logs);
  if (!g) return null;
  const offset = (injectionDay - toDate(today).getDay() + 7) % 7;
  let nextDate = addDays(today, offset);
  const lastInj = (logs.injections || []).slice(-1)[0];
  // If she already took this week's dose (logged within 4 days of the scheduled day), move to the following week
  if (lastInj && Math.abs(daysBetween(lastInj.date, nextDate)) < 4) nextDate = addDays(nextDate, 7);
  const idx = g.steps.indexOf(g.currentMg);
  const weeksOnDose = Math.floor(daysBetween(g.currentDoseSince, nextDate) / 7);
  const stepUp = idx >= 0 && idx < g.steps.length - 1 && weeksOnDose >= 4;
  const nextMg = stepUp ? g.steps[idx + 1] : g.currentMg;
  const weekNumber = Math.floor(daysBetween(g.startDate, today) / 7) + 1;
  return { nextDate, nextMg, stepUp, weekNumber, steps: g.steps, currentMg: g.currentMg, daysUntil: daysBetween(today, nextDate) };
}

export function readiness(ctx, sr) {
  const items = [];
  const bmi = ctx.bmiLatest?.value;
  const c = ctx.conditions;
  const weightCondition = c.prediabetes || c.t2d || c.htn || c.osa;
  items.push({ label: 'BMI', value: bmi ? bmi.toFixed(1) : 'Not found', ok: !!bmi, source: ctx.bmiLatest ? `${ctx.source} · ${fmt(ctx.bmiLatest.date)}` : 'Tell us' });
  items.push({ label: 'Weight-related condition', value: weightCondition ? [c.prediabetes && 'Prediabetes', c.t2d && 'Type 2 diabetes', c.htn && 'High BP', c.osa && 'Sleep apnea'].filter(Boolean).join(', ') : 'None found', ok: true, source: ctx.source });
  items.push({ label: 'History of gestational diabetes', value: c.gdmHistory ? 'Yes' : 'Not found', ok: true, info: c.gdmHistory, source: ctx.source });
  items.push({ label: 'Contraception', value: ctx.meds.oralContraceptive ? 'Oral pill' : (sr.contraception || 'Not found'), warn: !!ctx.meds.oralContraceptive, source: ctx.meds.oralContraceptive ? `${ctx.source} · med list` : 'Self-report' });

  const meetsCoverage = bmi ? bmi >= 30 || (bmi >= 27 && weightCondition) : null;

  let status = 'incomplete';
  const reasons = [];
  if (sr.breastfeeding === 'yes') reasons.push('GLP-1 medicines aren\'t recommended while breastfeeding.');
  if (sr.pregnancyPlan === 'yes') reasons.push('You\'re planning a pregnancy in the next year. Timing needs a clinician conversation.');
  if (sr.mtcHistory === 'yes') reasons.push('A personal or family history of medullary thyroid cancer or MEN2 may rule out GLP-1s.');
  if (sr.pancreatitis === 'yes') reasons.push('A history of pancreatitis needs review with your clinician.');
  const answered = ['breastfeeding', 'pregnancyPlan', 'mtcHistory', 'pancreatitis'].every(k => sr[k]);
  if (reasons.length) status = 'pause';
  else if (ctx.meds.glp1) status = 'on-treatment';
  else if (answered) status = 'ready';
  return { items, status, reasons, meetsCoverage, answered };
}

/**
 * Returns alerts sorted by severity. Each alert explains why it fired.
 * severity: 'red' | 'amber' | 'info' | 'success'
 */
export function evaluate(ctx, sr, logs, today) {
  const alerts = [];
  const g = effectiveGlp1(ctx, logs);
  const sched = doseSchedule(ctx, logs, today);
  const latestMood = (logs.mood || []).slice(-1)[0];
  const latestEffects = (logs.sideEffects || []).filter(e => daysBetween(e.date, today) <= 2);

  // S-4 Belly pain red flag
  if (latestEffects.some(e => e.type === 'Belly pain')) {
    alerts.push({ id: 'S-4', severity: 'red', title: 'Severe or lasting belly pain?',
      body: 'Contact your clinician right away. Severe pain, especially with vomiting or pain spreading to your back, can be a sign of pancreatitis or a gallbladder problem.',
      sources: ['Self-reported side effect'], action: { label: 'Call my clinician', kind: 'call' } });
  }
  // S-5 Low mood
  if (latestMood && daysBetween(latestMood.date, today) <= 7 && latestMood.score <= 2) {
    alerts.push({ id: 'S-5', severity: 'red', title: 'Thanks for sharing 💜',
      body: 'Feeling low after having a baby is common, and support helps. Want to share a note with your OB? If you\'re in crisis, call or text 988 (Suicide & Crisis Lifeline).',
      sources: ['Mood check-in'], action: { label: 'Share with my OB', kind: 'share' } });
  }
  // S-1 / S-2 / S-3
  if (sr.breastfeeding === 'yes') {
    alerts.push({ id: 'S-1', severity: 'amber', title: 'Breastfeeding and GLP-1s',
      body: 'GLP-1 medicines aren\'t recommended while breastfeeding. Talk to your clinician. Patient Agency will focus on nutrition and activity for now.', sources: ['Self-report'] });
  }
  if (sr.pregnancyPlan === 'yes' && g) {
    alerts.push({ id: 'S-2', severity: 'amber', title: 'Planning another pregnancy?',
      body: 'Talk with your clinician about timing. For example, the semaglutide label advises stopping at least 2 months before a planned pregnancy.', sources: ['Self-report', 'Medication list'] });
  }
  if (sr.mtcHistory === 'yes' || sr.pancreatitis === 'yes') {
    alerts.push({ id: 'S-3', severity: 'amber', title: 'Check with your clinician first',
      body: 'Your history may affect whether a GLP-1 is right for you.', sources: ['Self-report'] });
  }
  // S-6 Tirzepatide + oral contraceptive around start / dose increase
  if (g?.drug === 'tirzepatide' && ctx.meds.oralContraceptive && sched) {
    const recentChange = daysBetween(g.currentDoseSince, today) <= 28;
    const upcoming = sched.stepUp && sched.daysUntil <= 7;
    if (recentChange || upcoming) {
      alerts.push({ id: 'S-6', severity: 'amber',
        title: upcoming ? `Heads-up for ${fmtLong(sched.nextDate)}'s dose increase` : 'Backup birth control reminder',
        body: 'Your record shows an oral contraceptive. Tirzepatide can make birth control pills less effective. Use a backup method (like condoms) for 4 weeks after starting and after each dose increase.',
        sources: [`${ctx.source} · med list`, 'Dose schedule'], action: { label: 'Got it, remind me', kind: 'ack' } });
    }
  }
  // S-9 A1c due
  if ((ctx.conditions.gdmHistory || ctx.conditions.prediabetes) && (!ctx.a1cLatest || daysBetween(ctx.a1cLatest.date, today) > 365)) {
    alerts.push({ id: 'S-9', severity: 'info', kind: 'task', title: 'Get your A1c test',
      body: `Because you ${ctx.conditions.gdmHistory ? 'had gestational diabetes' : 'have prediabetes'}, regular diabetes screening is recommended.${ctx.a1cLatest ? ` Last A1c: ${ctx.a1cLatest.value}% (${fmt(ctx.a1cLatest.date)} ${toDate(ctx.a1cLatest.date).getFullYear()}).` : ''}`,
      sources: [`${ctx.source} · labs`, 'Problem list'] });
  }
  // S-8 5% milestone
  const ws = weightStats(ctx, logs);
  if (ws && ws.pct >= 5) {
    alerts.push({ id: 'S-8', severity: 'success', title: `You've lost ${ws.pct}% of your starting weight 🎉`,
      body: 'Passing 5% is a milestone many plans check at re-authorization. It\'s in your visit summary.', sources: ['Weights'] });
  }
  const order = { red: 0, amber: 1, info: 2, success: 3 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
}

export function visitSummary(ctx, sr, logs, today, questions = []) {
  const g = effectiveGlp1(ctx, logs);
  const sched = doseSchedule(ctx, logs, today);
  const ws = weightStats(ctx, logs);
  const effects = (logs.sideEffects || []).map(e => `${e.type} (${fmt(e.date)})`);
  const moods = (logs.mood || []).map(m => m.score);
  const lines = [
    `Patient Agency visit summary · ${fmtLong(today)}`,
    `Patient: ${ctx.patient?.firstName || ''} ${ctx.patient?.lastName || ''}`.trim(),
    '',
    g ? `Medication: ${g.brand} (${g.drug}), currently ${g.currentMg} mg weekly since ${fmt(g.currentDoseSince)}. Started ${fmt(g.startDate)}.${sched?.stepUp ? ` Next step: ${sched.nextMg} mg on ${fmt(sched.nextDate)}.` : ''}` : 'Medication: no GLP-1 on file.',
    `Doses logged in Patient Agency: ${(logs.injections || []).length}`,
    ws ? `Weight: ${ws.startW} → ${ws.current} lb (${ws.lost >= 0 ? '−' : '+'}${Math.abs(ws.lost)} lb, ${ws.pct}%).` : 'Weight: no data.',
    `Exercise: ${(logs.exercise || []).length ? (logs.exercise || []).map(e => `${e.kind} ${e.minutes} min (${fmt(e.date)})`).join(', ') : 'none logged'}.`,
    `Side effects: ${effects.length ? effects.join(', ') : 'none logged'}.`,
    `Mood check-ins (1–5): ${moods.length ? moods.join(', ') : 'none logged'}.`,
    ctx.a1cLatest ? `Last A1c: ${ctx.a1cLatest.value}% (${ctx.a1cLatest.date}).` : 'A1c: none on file.',
    ctx.meds.oralContraceptive ? 'Contraception: oral pill (backup method reminder shown).' : '',
    `Breastfeeding: ${sr.breastfeeding || 'not answered'} · Pregnancy plans (12 mo): ${sr.pregnancyPlan || 'not answered'}`,
    '',
    'Questions:',
    ...(questions.length ? questions.map(q => `• ${q}`) : ['• (none yet)'])
  ];
  return lines.filter(l => l !== null).join('\n');
}
