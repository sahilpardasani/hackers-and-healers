// Minimal profile for the local matcher. Never send names, IDs, or birth dates.
export function trialProfile(ctx, now = new Date()) {
  const birth = ctx?.patient?.birthDate;
  const born = birth && /^\d{4}-\d{2}-\d{2}$/.test(birth) ? new Date(`${birth}T12:00:00`) : null;
  const age = born && !Number.isNaN(born.valueOf()) ? now.getFullYear() - born.getFullYear()
    - (now.getMonth() < born.getMonth() || (now.getMonth() === born.getMonth() && now.getDate() < born.getDate()) ? 1 : 0) : null;
  const a1c = ctx?.a1cLatest;
  const bmi = ctx?.bmiLatest;
  return {
    age, sex: ctx?.patient?.gender || null,
    conditions: (ctx?.conditionList || []).map(c => c.label).filter(Boolean),
    labs: {
      a1c: a1c?.unit === '%' && Number.isFinite(a1c.value) ? a1c.value : null,
      bmi: ['kg/m2', 'kg/m^2', 'kg/m²'].includes(bmi?.unit) && Number.isFinite(bmi.value) ? bmi.value : null,
      egfr: null, systolic: null,
    },
  };
}
