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

  // Modal elements & state
  const modal = document.querySelector('#trial-interest-modal');
  const modalCloseBtn = modal?.querySelector('.trial-modal-close');
  const modalCancelBtn = modal?.querySelector('.trial-modal-cancel');
  const modalDoneBtn = modal?.querySelector('.trial-modal-done-btn');
  const modalSubmitBtn = modal?.querySelector('#trial-modal-submit-btn');
  const modalNct = modal?.querySelector('#trial-modal-nct');
  const modalStudyTitle = modal?.querySelector('#trial-modal-study-title');
  const modalPiName = modal?.querySelector('#trial-modal-pi-name');
  const modalPiRole = modal?.querySelector('#trial-modal-pi-role');
  const modalPiAffiliation = modal?.querySelector('#trial-modal-pi-affiliation');
  const modalMessageInput = modal?.querySelector('#trial-modal-message-input');
  const modalNotesInput = modal?.querySelector('#trial-modal-notes-input');
  const modalConsentCheck = modal?.querySelector('#trial-modal-consent-check');
  const modalFormView = modal?.querySelector('#trial-modal-form-view');
  const modalSuccessView = modal?.querySelector('#trial-modal-success-view');
  const modalError = modal?.querySelector('#trial-modal-error');
  const promptChips = modal ? modal.querySelectorAll('.prompt-chip') : [];

  let activeModalTrial = null;
  let isSubmittingInquiry = false;

  const openInterestModal = (trial) => {
    if (!modal) return;
    activeModalTrial = trial;
    const pi = trial.principal_investigator || {};
    const piName = pi.name || 'Principal Investigator';
    const piRole = pi.role || 'Principal Investigator';
    const piAffil = pi.affiliation || (trial.locations?.[0]?.facility) || 'Clinical Trial Lead Center';

    if (modalNct) modalNct.textContent = trial.nct_id;
    if (modalStudyTitle) modalStudyTitle.textContent = trial.title;
    if (modalPiName) modalPiName.textContent = piName;
    if (modalPiRole) modalPiRole.textContent = piRole;
    if (modalPiAffiliation) modalPiAffiliation.textContent = piAffil;

    const lastName = piName.replace(/^(Dr\.?|Doctor)\s*/i, '').split(',')[0].trim();
    const condText = (trial.conditions || [])[0] ? ` regarding ${trial.conditions[0]}` : '';
    if (modalMessageInput) {
      modalMessageInput.value = `Hello Dr. ${lastName},\n\nI reviewed your study "${trial.title}"${condText} on ClinicalTrials.gov. My local health records meet the core pre-screening criteria, and I would like to learn more about participation requirements and site availability through Nudge Lab.`;
    }
    if (modalNotesInput) modalNotesInput.value = '';
    if (modalConsentCheck) modalConsentCheck.checked = true;

    if (modalFormView) modalFormView.style.display = 'block';
    if (modalSuccessView) modalSuccessView.style.display = 'none';
    if (modalError) { modalError.style.display = 'none'; modalError.textContent = ''; }

    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  };

  const closeInterestModal = () => {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
    activeModalTrial = null;
  };

  if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeInterestModal);
  if (modalCancelBtn) modalCancelBtn.addEventListener('click', closeInterestModal);
  if (modalDoneBtn) modalDoneBtn.addEventListener('click', closeInterestModal);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeInterestModal();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) closeInterestModal();
    });
  }

  promptChips.forEach(chip => {
    chip.addEventListener('click', () => {
      const q = chip.dataset.chip;
      if (!modalMessageInput || !q) return;
      if (!modalMessageInput.value.includes(q)) {
        modalMessageInput.value = modalMessageInput.value.trim() + `\n\nQuestion: ${q}`;
        modalMessageInput.focus();
      }
    });
  });

  if (modalSubmitBtn) {
    modalSubmitBtn.addEventListener('click', async () => {
      if (!activeModalTrial || isSubmittingInquiry) return;
      const message = modalMessageInput ? modalMessageInput.value.trim() : '';
      if (!message) {
        if (modalError) {
          modalError.textContent = 'Please enter a message to intermediate with the study investigator.';
          modalError.style.display = 'block';
        }
        return;
      }
      if (modalConsentCheck && !modalConsentCheck.checked) {
        if (modalError) {
          modalError.textContent = 'Please authorize Nudge Lab intermediation before submitting.';
          modalError.style.display = 'block';
        }
        return;
      }
      if (modalError) modalError.style.display = 'none';

      isSubmittingInquiry = true;
      modalSubmitBtn.disabled = true;
      const btnText = modalSubmitBtn.querySelector('.btn-text');
      const btnSpinner = modalSubmitBtn.querySelector('.btn-spinner');
      if (btnText) btnText.textContent = 'Submitting to Intermediary…';
      if (btnSpinner) btnSpinner.style.display = 'inline-block';

      try {
        const pi = activeModalTrial.principal_investigator || {};
        const payload = {
          nct_id: activeModalTrial.nct_id,
          trial_title: activeModalTrial.title,
          pi_name: pi.name || 'Principal Investigator',
          pi_role: pi.role || 'Principal Investigator',
          pi_affiliation: pi.affiliation || '',
          message: message,
          patient_notes: modalNotesInput ? modalNotesInput.value.trim() : '',
          source: source
        };

        const res = await fetch('/api/trials/inquire', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(payload)
        });
        const resData = await res.json();
        if (!res.ok) throw new Error(resData.error || 'Failed to submit inquiry.');

        const succTitle = modal.querySelector('#success-trial-title');
        const succPi = modal.querySelector('#success-pi-name');
        const succMsg = modal.querySelector('#trial-modal-success-msg');
        if (succTitle) succTitle.textContent = `${activeModalTrial.nct_id} · ${activeModalTrial.title}`;
        if (succPi) succPi.textContent = `${payload.pi_name} (${payload.pi_affiliation || 'Lead Center'})`;
        if (succMsg && resData.message) succMsg.textContent = resData.message;

        if (modalFormView) modalFormView.style.display = 'none';
        if (modalSuccessView) modalSuccessView.style.display = 'block';
      } catch (err) {
        if (modalError) {
          modalError.textContent = err.message;
          modalError.style.display = 'block';
        }
      } finally {
        isSubmittingInquiry = false;
        modalSubmitBtn.disabled = false;
        if (btnText) btnText.textContent = 'Send Intermediated Inquiry';
        if (btnSpinner) btnSpinner.style.display = 'none';
      }
    });
  }

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

    const actions = node('div', undefined, 'trial-actions');
    const interestBtn = node('button', undefined, 'button button-primary trial-interest-btn');
    interestBtn.type = 'button';
    const btnIcon = node('span', '✉', 'btn-icon');
    btnIcon.setAttribute('aria-hidden', 'true');
    interestBtn.append(btnIcon, document.createTextNode(" I'm interested in this trial"));
    interestBtn.addEventListener('click', () => openInterestModal(trial));
    actions.append(interestBtn);

    if (/^NCT\d{8}$/.test(trial.nct_id)) {
      const link = node('a', 'View official study →', 'trial-link');
      link.href = `https://clinicaltrials.gov/study/${trial.nct_id}`;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      actions.append(link);
    }
    card.append(actions);
    return card;
  };
  const LAB_META = {
    systolic: {
      name: 'Systolic Blood Pressure',
      short: 'Systolic BP',
      unit: 'mmHg',
      icon: '💓',
      role: 'Checked for cardiovascular eligibility & hypertension cutoffs',
      format: (val) => `${Math.round(val)} mmHg`,
      status: (val) => {
        if (val == null) return { text: 'Not in synced record', badge: 'Not recorded', cls: 'badge-muted' };
        if (val >= 140) return { text: 'Stage 2 Hypertension (≥140)', badge: 'High (≥140)', cls: 'badge-warning' };
        if (val >= 130) return { text: 'Elevated systolic BP (≥130)', badge: 'Elevated (≥130)', cls: 'badge-warning' };
        return { text: 'Normal blood pressure (<130)', badge: 'Normal (<130)', cls: 'badge-normal' };
      }
    },
    bmi: {
      name: 'Body Mass Index',
      short: 'BMI',
      unit: 'kg/m²',
      icon: '⚖️',
      role: 'Checked against metabolic, obesity, and weight inclusion rules',
      format: (val) => `${val.toFixed(1)} kg/m²`,
      status: (val) => {
        if (val == null) return { text: 'Not in synced record', badge: 'Not recorded', cls: 'badge-muted' };
        if (val >= 30) return { text: 'Obesity criteria range (≥30)', badge: 'BMI ≥ 30', cls: 'badge-info' };
        if (val >= 25) return { text: 'Overweight criteria range (25–29.9)', badge: 'BMI 25–29.9', cls: 'badge-info' };
        return { text: 'Normal weight range (<25)', badge: 'Normal (<25)', cls: 'badge-normal' };
      }
    },
    a1c: {
      name: 'Hemoglobin A1c',
      short: 'HbA1c',
      unit: '%',
      icon: '🩸',
      role: 'Checked against diabetes & glycemic eligibility thresholds',
      format: (val) => `${val.toFixed(1)}%`,
      status: (val) => {
        if (val == null) return { text: 'Not in synced record', badge: 'Not recorded', cls: 'badge-muted' };
        if (val >= 6.5) return { text: 'Type 2 diabetes range (≥6.5%)', badge: '≥ 6.5%', cls: 'badge-warning' };
        if (val >= 5.7) return { text: 'Prediabetes range (5.7% – 6.4%)', badge: '5.7% – 6.4%', cls: 'badge-info' };
        return { text: 'Normal glycemic range (<5.7%)', badge: 'Normal (<5.7%)', cls: 'badge-normal' };
      }
    },
    egfr: {
      name: 'Estimated GFR (Kidney)',
      short: 'eGFR',
      unit: 'mL/min/1.73m²',
      icon: '🧪',
      role: 'Checked against renal safety and impairment cutoffs (<60)',
      format: (val) => `${Math.round(val)} mL/min`,
      status: (val) => {
        if (val == null) return { text: 'Not in synced record', badge: 'Not recorded', cls: 'badge-muted' };
        if (val < 60) return { text: 'Reduced renal function (<60)', badge: '< 60 mL/min', cls: 'badge-warning' };
        return { text: 'Normal renal function (≥60)', badge: 'Normal (≥60)', cls: 'badge-normal' };
      }
    },
    body_fat: {
      name: 'Body Fat Percentage (DEXA)',
      short: 'Body Fat %',
      unit: '%',
      icon: '🧬',
      role: 'Captured via Visualize TrueDepth 3D scan; checked for incretin & metabolic trials',
      format: (val) => `${val.toFixed(1)}%`,
      status: (val) => {
        if (val == null) return { text: 'Not scanned yet · Use DEXA Scan tab', badge: 'Not scanned', cls: 'badge-muted' };
        if (val >= 27) return { text: 'Metabolic inclusion cutoff (≥27%)', badge: 'DEXA ≥ 27%', cls: 'badge-warning' };
        return { text: 'Standard body fat range (<27%)', badge: 'Normal (<27%)', cls: 'badge-normal' };
      }
    },
    visceral_fat: {
      name: 'Visceral Adipose Tissue (VAT)',
      short: 'Visceral Fat',
      unit: 'cm²',
      icon: '📊',
      role: 'DEXA L4-L5 cross-sectional area; correlates with hepatic steatosis & cardiometabolic risk (≥100 cm²)',
      format: (val) => `${val.toFixed(1)} cm²`,
      status: (val) => {
        if (val == null) return { text: 'Not scanned yet · Use DEXA Scan tab', badge: 'Not scanned', cls: 'badge-muted' };
        if (val >= 100) return { text: 'High central adiposity (≥100 cm²)', badge: 'Elevated (≥100)', cls: 'badge-warning' };
        return { text: 'Normal visceral range (<100 cm²)', badge: 'Normal (<100)', cls: 'badge-normal' };
      }
    }
  };

  read(`/api/trials/profile?source=${source}`).then(data => {
    profileBox.replaceChildren();
    const p = data.profile;

    // 1. Demographics Bar
    const metaBar = node('div', undefined, 'profile-meta-bar');
    const agePill = node('div', undefined, 'profile-meta-pill');
    agePill.append(node('span', '👤', 'meta-icon'), node('span', 'Age: ', 'meta-label'), node('strong', p.age != null ? `${p.age} years` : 'Not recorded'));
    metaBar.append(agePill);

    const sexPill = node('div', undefined, 'profile-meta-pill');
    const sexDisplay = p.sex ? (p.sex.charAt(0).toUpperCase() + p.sex.slice(1).toLowerCase()) : 'Not recorded';
    sexPill.append(node('span', p.sex === 'FEMALE' ? '♀' : (p.sex === 'MALE' ? '♂' : '⚧'), 'meta-icon'), node('span', 'Recorded Sex: ', 'meta-label'), node('strong', sexDisplay));
    metaBar.append(sexPill);

    const srcPill = node('div', undefined, 'profile-meta-pill');
    const srcDisplay = source === 'sample' ? 'Fictional Maya Sample' : 'Connected Epic Sandbox';
    srcPill.append(node('span', '', 'status-dot'), node('span', 'Record Source: ', 'meta-label'), node('strong', srcDisplay));
    metaBar.append(srcPill);

    profileBox.append(metaBar);

    // 2. Search Topics
    const topicSection = node('div', undefined, 'profile-section');
    const topicHeader = node('div', undefined, 'profile-section-header');
    topicHeader.append(node('h3', 'Search Topics for Clinical Trials', 'profile-section-title'));
    topicHeader.append(node('span', 'Active conditions matched against ClinicalTrials.gov recruiting criteria', 'profile-section-subtitle'));
    topicSection.append(topicHeader);

    if (p.conditions && p.conditions.length) {
      const topicsGrid = node('div', undefined, 'profile-topics-grid');
      p.conditions.forEach(c => {
        const chip = node('div', undefined, 'profile-topic-chip');
        const icon = node('span', '🩺', 'topic-icon');
        const textWrap = node('div', undefined, 'topic-info');
        textWrap.append(node('strong', c.name, 'topic-name'));
        let detail = 'From documented conditions in your EHR record';
        if (c.source === 'labs') {
          detail = 'Suggested from local vitals reading (e.g. Systolic BP ≥ 130 mmHg)';
        } else if (c.source === 'dexa' || c.source === 'dexa_scan') {
          detail = 'Discovered via Visualize TrueDepth 3D DEXA scan (Elevated VAT ≥ 95 cm² or Body Fat ≥ 27%)';
        }
        textWrap.append(node('span', detail, 'topic-source'));
        chip.append(icon, textWrap);
        topicsGrid.append(chip);
      });
      topicSection.append(topicsGrid);
    } else {
      topicSection.append(node('p', 'No searchable conditions found in current records. Sync more records or load sample data.', 'empty-state'));
    }
    profileBox.append(topicSection);

    // 3. Biomarkers & Vitals Evaluated Locally
    const labsSection = node('div', undefined, 'profile-section');
    const labsHeader = node('div', undefined, 'profile-section-header');
    labsHeader.append(node('h3', 'Parameters Evaluated Locally for Eligibility', 'profile-section-title'));
    labsHeader.append(node('span', 'Checked securely on this machine without exposing raw health records to third parties', 'profile-section-subtitle'));
    labsSection.append(labsHeader);

    const labsGrid = node('div', undefined, 'profile-labs-grid');
    const labKeys = ['systolic', 'bmi', 'a1c', 'egfr', 'body_fat', 'visceral_fat'];

    labKeys.forEach(key => {
      const cfg = LAB_META[key];
      let val = p.labs ? p.labs[key] : null;
      if (val == null && p.dexa && p.dexa.measurements) {
        if (key === 'body_fat') val = p.dexa.measurements.bodyFatPercent;
        if (key === 'visceral_fat') val = p.dexa.measurements.visceralFat?.areaCm2;
      }
      const card = node('div', undefined, `profile-lab-card ${val != null ? 'is-recorded' : 'is-empty'}`);

      const top = node('div', undefined, 'lab-card-top');
      const titleWrap = node('div', undefined, 'lab-title-wrap');
      titleWrap.append(node('span', cfg.icon, 'lab-icon'));
      titleWrap.append(node('strong', cfg.name, 'lab-name'));
      top.append(titleWrap);

      const st = cfg.status(val);
      const badge = node('span', st.badge, `lab-badge ${st.cls}`);
      top.append(badge);
      card.append(top);

      const valRow = node('div', undefined, 'lab-value-row');
      if (val != null) {
        valRow.append(node('span', cfg.format(val), 'lab-value-num'));
        valRow.append(node('span', st.text, 'lab-value-context'));
      } else {
        valRow.append(node('span', '—', 'lab-value-empty'));
        valRow.append(node('span', 'Not recorded in synced record', 'lab-value-context muted-text'));
      }
      card.append(valRow);

      card.append(node('p', cfg.role, 'lab-criteria-note'));
      labsGrid.append(card);
    });

    labsSection.append(labsGrid);
    profileBox.append(labsSection);

    ready = p.conditions.length > 0;
    if (!ready) profileBox.append(node('p', 'No searchable conditions or supported lab-derived topics were found. Sync more records or explore the fictional sample.', 'empty-state'));
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
