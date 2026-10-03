// Offline intent parser for the voice log agent.
// Turns one utterance ("took my shot and walked 30 minutes") into a list of intents.
// Deliberately rule-based: predictable, testable, no data leaves the device.
// Swap in an LLM later by returning the same intent shape.

const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fifteen: 15, sixty: 60 };
const num = s => (s == null ? null : /^\d/.test(s) ? parseFloat(s) : WORDS[s.toLowerCase()] ?? null);
const NUM = '(\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty-five|sixty)';

const FOODS = [
  [/protein shake|shake/, 'Protein shake', 25],
  [/greek yogh?urt|yogh?urt/, 'Greek yogurt', 20],
  [/chicken/, 'Chicken', 30],
  [/cottage cheese/, 'Cottage cheese', 14],
  [/protein bar/, 'Protein bar', 15],
  [/tuna|salmon|fish/, 'Fish', 25],
  [/tofu/, 'Tofu', 15]
];

const EXERCISE = [
  [/strength|weights|lift(ed|ing)?|squats|resistance|pilates/, 'Strength'],
  [/walk(ed|ing)?|stroller/, 'Walk'],
  [/run|ran|jog(ged|ging)?/, 'Run'],
  [/yoga|stretch(ed|ing)?/, 'Yoga'],
  [/bike|biked|cycl(e|ed|ing)|spin/, 'Cycling'],
  [/swim(ming)?|swam/, 'Swim'],
  [/work(ed)? ?out|exercis(e|ed)|gym/, 'Workout']
];

const EFFECTS = [
  [/nause(a|ous)|queasy|sick to my stomach|throw(ing)? up|vomit/, 'Nausea'],
  [/constipat/, 'Constipation'],
  [/reflux|heartburn|acid/, 'Reflux'],
  [/tired|exhausted|fatigue|wiped out|no energy/, 'Fatigue'],
  [/(stomach|belly|abdominal|tummy) (pain|hurts|ache|cramp)|pain in my (stomach|belly|abdomen)/, 'Belly pain']
];

const MOODS = [
  [/hopeless|can'?t cope|depressed|worthless|want to give up/, 1],
  [/down|low|sad|stressed|anxious|overwhelmed|struggling|rough|not great|bad/, 2],
  [/meh|so-so|okay|ok\b|alright/, 3],
  [/good|fine|better/, 4],
  [/great|amazing|happy|fantastic|awesome|wonderful/, 5]
];

const QUESTION_START = /^(what|when|how|should|can|could|is|are|do|does|why|which|will|am i)\b/;

function questionTopic(t) {
  if (/next (dose|shot|injection)|when.*(dose|shot|injection|inject)|dose (day|increase)/.test(t)) return 'dose';
  if (/refill|pharmacy|run(ning)? out/.test(t)) return 'refill';
  if (/birth control|contracepti|the pill\b/.test(t)) return 'contraception';
  if (/progress|how much (weight|have i lost)|lost so far|on track/.test(t)) return 'progress';
  if (/nause|constipat|side effect|reflux|heartburn/.test(t)) return 'sideEffects';
  if (/protein/.test(t)) return 'protein';
  if (/next step|what('?s| is) next|what should i do|to ?do|today|plan for/.test(t)) return 'next';
  return 'other';
}

export function parseUtterance(raw) {
  const text = (raw || '').trim();
  const t = text.toLowerCase().replace(/[’]/g, "'");
  const intents = [];
  if (!t) return intents;

  // Questions (can co-exist with logs: "I took my shot, what's next?")
  const parts = t.split(/[.!]|,\s*(?:and\s+)?(?=(?:what|when|how|should|can|is|do)\b)|\s+and\s+(?=(?:what|when|how|should|can)\b)/).map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (p.includes('?') || QUESTION_START.test(p)) intents.push({ type: 'question', topic: questionTopic(p), text: p.replace(/\?$/, '') });
  }
  const isOnlyQuestion = intents.length && parts.every(p => p.includes('?') || QUESTION_START.test(p));
  if (isOnlyQuestion) return intents;

  // Dose
  if (/(took|did|gave|injected|done|had|finished)\b[^.]*\b(shot|dose|injection|pen|zepbound|wegovy|mounjaro|ozempic|saxenda)/.test(t) || /\binjected\b/.test(t)) {
    const mg = /(\d+(?:\.\d+)?)\s*(mg|milligrams?)/.exec(t);
    intents.push({ type: 'dose', mg: mg ? parseFloat(mg[1]) : null });
  }

  // Weight
  const w = /(?:weigh(?:ed)?(?: in)?(?: at)?|weight(?: is| was)?|scale (?:says|said)|i'?m(?: at)?)\s*(\d{2,3}(?:\.\d)?)\s*(?:lb|lbs|pounds)?/.exec(t)
    || /(\d{2,3}(?:\.\d)?)\s*(?:lb|lbs|pounds)\b/.exec(t);
  if (w) {
    const lb = parseFloat(w[1]);
    if (lb >= 80 && lb <= 600) intents.push({ type: 'weight', lb });
  }

  // Protein
  const grams = new RegExp(`${NUM}\\s*(?:g|grams?)\\s*(?:of\\s*)?protein`).exec(t);
  if (grams) intents.push({ type: 'protein', g: num(grams[1]), label: 'Protein' });
  else {
    const eggs = new RegExp(`${NUM}\\s*eggs?`).exec(t);
    if (eggs) intents.push({ type: 'protein', g: Math.round((num(eggs[1]) || 2) * 6), label: `${num(eggs[1]) || 2} eggs` });
    for (const [re, label, g] of FOODS) if (re.test(t)) { intents.push({ type: 'protein', g, label }); break; }
  }

  // Water
  const water = new RegExp(`${NUM}\\s*(glass(?:es)?|cups?|bottles?)\\s*(?:of\\s*)?water`).exec(t);
  if (water) intents.push({ type: 'water', n: (num(water[1]) || 1) * (/bottle/.test(water[2]) ? 2 : 1) });
  else if (/drank (some )?water|had (some )?water/.test(t)) intents.push({ type: 'water', n: 1 });

  // Exercise
  const ex = EXERCISE.find(([re]) => re.test(t));
  if (ex && !/should i|can i/.test(t)) {
    const mins = new RegExp(`${NUM}\\s*(?:min|mins|minutes)`).exec(t);
    const minutes = mins ? num(mins[1]) : /half an hour/.test(t) ? 30 : /an hour|one hour/.test(t) ? 60 : 20;
    intents.push({ type: 'exercise', kind: ex[1], minutes });
  }

  // Side effects
  if (/no side effects|side effects? (are|were) fine|feeling fine physically/.test(t)) intents.push({ type: 'sideEffect', types: ['None'] });
  else {
    const types = EFFECTS.filter(([re]) => re.test(t)).map(([, n]) => n);
    if (types.length) intents.push({ type: 'sideEffect', types });
  }

  // Mood (only when talking about feelings, to avoid false positives)
  if (/\b(feel|feeling|felt|mood|i'?m|i am|today was|day was)\b/.test(t)) {
    const sideOnly = intents.some(i => i.type === 'sideEffect') && !/mood|emotionally/.test(t);
    const m = MOODS.find(([re]) => re.test(t));
    if (m && !(sideOnly && m[1] >= 3)) intents.push({ type: 'mood', score: m[1] });
  }

  return intents;
}
