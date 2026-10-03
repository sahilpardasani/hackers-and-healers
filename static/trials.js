(() => {
  'use strict';
  const form = document.querySelector('#trial-search-form');
  if (!form) return;
  const profileBox = document.querySelector('#trial-profile');
  const results = document.querySelector('#trial-results');
  const status = document.querySelector('#trial-status');
  const button = document.querySelector('#trial-search-button');
  const consent = document.querySelector('#trial-consent');
  const source = document.body.dataset.sampleMode === 'true' ? 'sample' : 'connected';
  let ready = false;
  let busy = false;
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const updateButton = () => { button.disabled = !ready || !consent.checked || busy; };
  consent.addEventListener('change', updateButton);
  const read = async (url) => {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(90000) });
    if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('The local backend returned an unexpected response. Check that it is running.');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
    return data;
  };
  const list = (parent, title, items) => {
    if (!items?.length) return;
    parent.append(node('h3', title));
    const ul = node('ul');
    items.forEach(item => ul.append(node('li', item)));
    parent.append(ul);
  };
  const renderTrial = trial => {
    const card = node('article', undefined, 'card trial-card');
    const labels = { strong_match: 'Criteria overlap · review needed', possible_match: 'Potential study · review needed', likely_ineligible: 'Potential eligibility barriers' };
    card.append(node('span', labels[trial.match.verdict] || 'Review needed', 'step-chip'));
    card.append(node('h2', trial.title));
    card.append(node('p', `${trial.nct_id} · ${trial.status.replaceAll('_', ' ').toLowerCase()} · ${trial.location_count} sites`, 'muted'));
    card.append(node('p', trial.summary?.slice(0, 650) || 'Review the full study record for details.'));
    list(card, 'Why it surfaced', trial.match.reasons);
    list(card, 'Potential barriers—not a final decision', trial.match.blockers);
    list(card, 'Questions for the study team', trial.match.flags);
    const details = node('details');
    details.append(node('summary', `Review criteria and sites · ${trial.match.unreviewed} criteria not evaluated`));
    for (const category of ['inclusion', 'exclusion']) {
      list(details, `${category[0].toUpperCase()}${category.slice(1)} criteria`, (trial.match[category] || []).map(item => `${item.text} — ${item.result.replaceAll('_', ' ')}. ${item.basis || 'Study-team review needed.'}`));
    }
    list(details, 'Sites (up to five shown)', (trial.locations || []).map(s => [s.facility, s.city, s.state, s.country, s.miles != null ? `${s.miles} miles` : null].filter(Boolean).join(', ')));
    list(details, 'Study contacts', (trial.contacts || []).map(c => [c.name, c.phone, c.email].filter(Boolean).join(' · ')));
    card.append(details);
    if (/^NCT\d{8}$/.test(trial.nct_id)) {
      const link = node('a', 'View official study →', 'trial-link');
      link.href = `https://clinicaltrials.gov/study/${trial.nct_id}`;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      card.append(link);
    }
    return card;
  };
  read(`/api/trials/profile?source=${source}`).then(data => {
    profileBox.replaceChildren();
    const p = data.profile;
    profileBox.append(node('p', `Age: ${p.age ?? 'not available'} · Recorded sex: ${p.sex || 'not available'}`));
    list(profileBox, 'Search topics', p.conditions.map(c => `${c.name} — ${c.source === 'labs' ? 'lab-derived suggestion, not a diagnosis' : 'from your record'}`));
    list(profileBox, 'Values checked locally', Object.entries(p.labs).map(([key, value]) => `${key}: ${value ?? 'not available / unsupported units'}`));
    ready = p.conditions.length > 0;
    if (!ready) profileBox.append(node('p', 'No searchable conditions or supported lab-derived topics were found. Sync more records or explore the fictional sample.'));
    updateButton();
  }).catch(error => { profileBox.textContent = error.message; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!ready || !consent.checked || busy) return;
    const values = new FormData(form);
    const params = new URLSearchParams({ source, consent: 'yes' });
    for (const name of ['lat', 'lon', 'miles']) if (values.get(name)) params.set(name, values.get(name));
    if (values.get('all')) params.set('all', '1');
    busy = true; updateButton(); results.replaceChildren();
    results.setAttribute('aria-busy', 'true');
    status.textContent = 'Searching ClinicalTrials.gov and checking criteria locally. This may take a minute…';
    try {
      const data = await read(`/api/trials?${params}`);
      status.textContent = data.trials.length ? `${data.trials.length} studies to explore. Limited results per topic; this is not an exhaustive search or eligibility decision.` : (data.note || 'No studies found with these filters. Try a wider radius or include possible barriers.');
      data.trials.forEach(trial => results.append(renderTrial(trial)));
    } catch (error) {
      status.textContent = error.name === 'TimeoutError' ? 'The search timed out. Try again; completed API requests are cached locally.' : error.message;
    } finally { busy = false; updateButton(); results.setAttribute('aria-busy', 'false'); }
  });
})();
