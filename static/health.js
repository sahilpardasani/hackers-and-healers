(() => {
  'use strict';
  const form = document.querySelector('#health-form');
  if (!form) return;
  const el = name => document.querySelector(`#health-${name}`);
  const source = document.body.dataset.sampleMode === 'true' ? 'sample' : 'connected';
  let preview = null, busy = false, loading = false;
  const status = message => { el('status').textContent = message; };
  const sync = () => { el('send').disabled = busy || !preview?.configured || !el('consent').checked; };
  async function post(path, body) {
    const response = await fetch(`/api/health/${path}`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(240000) });
    if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('The backend is unavailable. Restart the local service.');
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 409) { preview = null; el('consent').checked = false; sync(); }
      throw new Error(data.error || 'The request failed. Try again.');
    }
    return data;
  }
  async function load() {
    if (busy || loading) return;
    loading = true;
    el('consent').checked = false; el('trials').checked = false;
    preview = null; sync(); status('Loading your local context. Nothing is sent to NVIDIA yet.');
    try {
      preview = await post('context', {source});
      el('context').textContent = JSON.stringify(preview.context, null, 2);
      el('config').textContent = preview.configured ? `Model: ${preview.model} · Hosted by NVIDIA` : 'Set NVIDIA_API_KEY on the server to enable this feature.';
      status('Review the context and consent before asking.'); sync();
    } catch (error) { status(error.message); }
    finally { loading = false; }
  }
  document.querySelector('#tab-health')?.addEventListener('click', () => { if (!preview) load(); });
  new MutationObserver(() => {
    if (!document.querySelector('#panel-health').hidden && !preview) load();
  }).observe(document.querySelector('#panel-health'), {attributes: true, attributeFilter: ['hidden']});
  if (window.location.hash === '#health') load();
  el('consent').addEventListener('change', sync);
  document.querySelectorAll('[data-health-prompt]').forEach(button => button.addEventListener('click', () => { el('question').value = button.dataset.healthPrompt; el('question').focus(); }));
  el('clear').addEventListener('click', () => {
    if (busy) return;
    el('question').value = ''; el('answer').textContent = ''; el('answer').hidden = true;
    el('trial-results').replaceChildren(); load();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !preview || !el('consent').checked) return;
    busy = true; sync(); el('clear').disabled = true;
    el('answer').hidden = true; el('trial-results').replaceChildren();
    status('Preparing your explanation. Trial searches and the model can take a few minutes…');
    try {
      const data = await post('ask', {source, preview_token: preview.preview_token,
        question: el('question').value, consent_nvidia: true,
        include_trials: el('trials').checked, consent_trials: el('trials').checked});
      el('answer').textContent = data.answer; el('answer').hidden = false;
      status([data.disclaimer, ...data.warnings].join(' '));
      data.trials.forEach(trial => {
        const card = document.createElement('article'); card.className = 'card';
        const h = document.createElement('h2'); h.textContent = trial.title;
        const p = document.createElement('p'); p.textContent = `${trial.nct_id} · ${trial.status.replaceAll('_', ' ')} · Study-team review required`;
        const link = document.createElement('a'); link.textContent = 'View verified study record →';
        link.href = `https://clinicaltrials.gov/study/${trial.nct_id}`; link.target = '_blank'; link.rel = 'noopener noreferrer';
        card.append(h, p, link); el('trial-results').append(card);
      });
    } catch (error) { status(error.name === 'TimeoutError' ? 'The request timed out. Please try again.' : error.message); }
    finally { busy = false; el('clear').disabled = false; sync(); }
  });
})();
