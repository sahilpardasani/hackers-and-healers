/**
 * VisualizeMe SDK DEXA Body Scan Controller
 * Connects with Visualize SDK (developer.visualizeme.ai/docs)
 * Performs TrueDepth 3D DEXA scanning simulation, computes body composition,
 * and proposes DEXA biomarkers for ClinicalTrials.gov search.
 */

(() => {
  'use strict';

  // Elements
  const panelDexa = document.querySelector('#panel-dexa');
  const startScanBtn = document.querySelector('#btn-start-dexa-scan');
  const cancelScanBtn = document.querySelector('#btn-cancel-dexa-scan');
  const syncUserBtn = document.querySelector('#btn-dexa-preset-user') || document.querySelector('#btn-dexa-preset-maya');
  const scanStatusEl = document.querySelector('#dexa-scan-status');
  const scanProgressWrap = document.querySelector('#dexa-progress-wrap');
  const scanProgressBar = document.querySelector('#dexa-progress-bar');
  const scanStageText = document.querySelector('#dexa-scan-stage-text');
  const viewportMesh = document.querySelector('#dexa-viewport-mesh');
  const scanLaser = document.querySelector('#dexa-scan-laser');
  const scanHudToken = document.querySelector('#dexa-hud-token');
  const scanHudEngine = document.querySelector('#dexa-hud-engine');

  // Input fields
  const inputGender = document.querySelector('#dexa-input-gender');
  const inputHeight = document.querySelector('#dexa-input-height');
  const inputWeight = document.querySelector('#dexa-input-weight');
  const inputAge = document.querySelector('#dexa-input-age');

  // Results displays
  const resultsContainer = document.querySelector('#dexa-results-container');
  const valBodyFat = document.querySelector('#dexa-val-body-fat');
  const barBodyFat = document.querySelector('#dexa-bar-body-fat');
  const badgeBodyFat = document.querySelector('#dexa-badge-body-fat');
  const valVisceralArea = document.querySelector('#dexa-val-visceral-area');
  const badgeVisceral = document.querySelector('#dexa-badge-visceral');
  const descVisceral = document.querySelector('#dexa-desc-visceral');
  const valLeanMass = document.querySelector('#dexa-val-lean-mass');
  const valLeanSub = document.querySelector('#dexa-val-lean-sub');
  const valWhr = document.querySelector('#dexa-val-whr');
  const valAgRatio = document.querySelector('#dexa-val-ag-ratio');
  const valBmd = document.querySelector('#dexa-val-bmd');

  // Girths
  const valGirthWaist = document.querySelector('#dexa-girth-waist');
  const valGirthHip = document.querySelector('#dexa-girth-hip');
  const valGirthChest = document.querySelector('#dexa-girth-chest');
  const valGirthThigh = document.querySelector('#dexa-girth-thigh');
  const valGirthBicep = document.querySelector('#dexa-girth-bicep');
  const valGirthNeck = document.querySelector('#dexa-girth-neck');

  // Segmental Lean Mass
  const valSegTrunk = document.querySelector('#dexa-seg-trunk');
  const valSegLegs = document.querySelector('#dexa-seg-legs');
  const valSegArms = document.querySelector('#dexa-seg-arms');

  // Trial Recommendations
  const trialRecsGrid = document.querySelector('#dexa-trial-recs-grid');
  const trialSummaryCopy = document.querySelector('#dexa-trial-summary-copy');
  const btnProposeTrials = document.querySelector('#btn-propose-dexa-trials');
  const btnInspectPayload = document.querySelector('#btn-inspect-dexa-payload');

  // Modal
  const modalPayload = document.querySelector('#dexa-payload-modal');
  const modalPayloadContent = document.querySelector('#dexa-payload-content');
  const btnClosePayloadModal = document.querySelector('#btn-close-dexa-modal');

  // History table body
  const historyTbody = document.querySelector('#dexa-history-tbody');

  let isScanning = false;
  let scanAnimationTimer = null;
  let activeScanData = null;

  // Dynamic user demographics helper
  const getActiveUserDemographics = () => {
    const isSample = panelDexa?.dataset.sampleMode === 'true' || document.body.dataset.sampleMode === 'true';
    const patientName = panelDexa?.dataset.patientName || (isSample ? 'Maya Patel' : 'You');
    const gender = panelDexa?.dataset.patientGender || (inputGender ? inputGender.value : 'female');
    const age = parseInt(panelDexa?.dataset.patientAge || (inputAge ? inputAge.value : '34'), 10) || 34;
    const heightIn = parseFloat(panelDexa?.dataset.patientHeight || (inputHeight ? inputHeight.value : '65')) || 65;
    const weightLb = parseFloat(panelDexa?.dataset.patientWeight || (inputWeight ? inputWeight.value : '152')) || 152;
    const userRef = panelDexa?.dataset.patientUserRef || (isSample ? 'maya_patel' : 'patient_user');
    return { name: patientName, gender, age, heightIn, weightLb, userRef, isSample };
  };

  // Initialize synced demographic presets
  if (syncUserBtn) {
    syncUserBtn.addEventListener('click', () => {
      const demo = getActiveUserDemographics();
      if (inputGender) inputGender.value = demo.gender;
      if (inputHeight) inputHeight.value = demo.heightIn;
      if (inputWeight) inputWeight.value = demo.weightLb;
      if (inputAge) inputAge.value = demo.age;
      showToast(`Loaded synced demographics: ${demo.name} (${demo.age}yo, ${demo.heightIn} in, ${demo.weightLb} lbs)`);
    });
  }

  // Toast feedback helper
  const showToast = (message) => {
    let toast = document.querySelector('#dexa-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'dexa-toast';
      toast.className = 'dexa-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('is-visible');
    setTimeout(() => toast.classList.remove('is-visible'), 3600);
  };

  // Stage sequence for realistic TrueDepth scan progress
  const SCAN_STAGES = [
    { pct: 15, text: 'Minting Visualize SDK session token (POST /v1/sessions)...' },
    { pct: 35, text: 'TrueDepth infrared sensor attestation & baseline calibration...' },
    { pct: 60, text: 'Reconstructing 3D volumetric surface mesh (120,000 vertices)...' },
    { pct: 82, text: 'DEXA-grade tissue segmentation: visceral fat & lean mass...' },
    { pct: 95, text: 'Correlating body composition with ClinicalTrials.gov criteria...' },
    { pct: 100, text: 'Scan complete! Body composition & trial biomarkers ready.' },
  ];

  // Start Scan Flow
  const startScan = async () => {
    if (isScanning) return;
    isScanning = true;

    // UI state
    startScanBtn.disabled = true;
    startScanBtn.innerHTML = '<span class="dexa-spinner"></span> Scanning...';
    if (cancelScanBtn) cancelScanBtn.hidden = false;
    if (scanProgressWrap) scanProgressWrap.hidden = false;
    if (viewportMesh) viewportMesh.classList.add('is-scanning');
    if (scanLaser) scanLaser.classList.add('is-active');

    const subject = {
      gender: inputGender ? inputGender.value : 'female',
      heightIn: parseFloat(inputHeight ? inputHeight.value : '65') || 65,
      weightLb: parseFloat(inputWeight ? inputWeight.value : '152') || 152,
      ageYears: parseInt(inputAge ? inputAge.value : '34', 10) || 34,
    };

    try {
      // Step 1: Mint Session Token from backend
      if (scanStageText) scanStageText.textContent = SCAN_STAGES[0].text;
      if (scanProgressBar) scanProgressBar.style.width = '15%';

      const demo = getActiveUserDemographics();
      const sessionRes = await fetch('/api/dexa/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host_user_ref: demo.userRef }),
      });
      const sessionData = await sessionRes.json();
      const sessionToken = sessionData.session_token || 'vst_live';

      if (scanHudToken) scanHudToken.textContent = `Token: ${sessionToken.slice(0, 14)}...`;

      // Animate progress smoothly through calibration and point-cloud mesh
      for (let i = 1; i < SCAN_STAGES.length - 1; i++) {
        await new Promise((r) => setTimeout(r, 700));
        if (!isScanning) return; // Check if canceled
        if (scanStageText) scanStageText.textContent = SCAN_STAGES[i].text;
        if (scanProgressBar) scanProgressBar.style.width = `${SCAN_STAGES[i].pct}%`;
      }

      // Step 2: Trigger body scan computation & encrypted storage
      const scanRes = await fetch('/api/dexa/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject }),
      });

      if (!scanRes.ok) throw new Error('Failed to complete DEXA scan.');
      const data = await scanRes.json();

      // Final progress step
      if (scanStageText) scanStageText.textContent = SCAN_STAGES[SCAN_STAGES.length - 1].text;
      if (scanProgressBar) scanProgressBar.style.width = '100%';
      await new Promise((r) => setTimeout(r, 500));

      activeScanData = data.scan;
      renderScanResults(activeScanData);
      loadScanHistory();
      showToast('✓ 3D DEXA Body Scan completed and stored locally in encrypted vault.');
    } catch (err) {
      if (scanStageText) scanStageText.textContent = `Scan failed: ${err.message}`;
      showToast(`Error: ${err.message}`);
    } finally {
      isScanning = false;
      startScanBtn.disabled = false;
      startScanBtn.innerHTML = '⚡ Start Automated TrueDepth DEXA Scan';
      if (cancelScanBtn) cancelScanBtn.hidden = true;
      if (viewportMesh) viewportMesh.classList.remove('is-scanning');
      if (scanLaser) scanLaser.classList.remove('is-active');
    }
  };

  // Render scan results into UI
  const renderScanResults = (scan) => {
    if (!scan || !scan.measurements) return;
    if (resultsContainer) resultsContainer.hidden = false;

    const m = scan.measurements;
    const s = scan.subject || {};
    const insights = scan.trialInsights || {};

    // 1. Body Fat %
    if (valBodyFat) valBodyFat.textContent = `${m.bodyFatPercent}%`;
    if (barBodyFat) {
      const pct = Math.min(100, Math.max(0, (m.bodyFatPercent / 50) * 100));
      barBodyFat.style.width = `${pct}%`;
    }
    if (badgeBodyFat) {
      const isHigh = m.bodyFatPercent >= 27.0;
      badgeBodyFat.textContent = isHigh ? 'Metabolic Endpoint Range (≥27%)' : 'Normal Range (<27%)';
      badgeBodyFat.className = `dexa-status-badge ${isHigh ? 'is-warning' : 'is-success'}`;
    }

    // 2. Visceral Adipose Tissue
    const vat = m.visceralFat || {};
    if (valVisceralArea) valVisceralArea.textContent = `${vat.areaCm2 || '—'} cm²`;
    if (badgeVisceral) {
      const isHighVat = (vat.areaCm2 || 0) >= 100;
      badgeVisceral.textContent = isHighVat ? 'Elevated Adiposity (≥100 cm²)' : 'Normal (<100 cm²)';
      badgeVisceral.className = `dexa-status-badge ${isHighVat ? 'is-warning' : 'is-success'}`;
    }
    if (descVisceral) {
      descVisceral.textContent = `Visceral Fat Grade: ${vat.grade || '—'} · L4-L5 Cross-Sectional Area`;
    }

    // 3. Lean Muscle Mass
    if (valLeanMass) valLeanMass.textContent = `${m.leanMassLb} lbs`;
    if (valLeanSub) valLeanSub.textContent = `(${m.leanMassKg} kg) · Total Fat Mass: ${m.fatMassLb} lbs`;

    // 4. Central Indices
    if (valWhr) valWhr.textContent = m.waistToHipRatio || '—';
    if (valAgRatio) valAgRatio.textContent = m.androidGynoidRatio || '—';
    if (valBmd) valBmd.textContent = m.boneMineralDensityTScore != null ? `${m.boneMineralDensityTScore} SD` : '—';

    // 5. Girths
    const g = m.girths || {};
    if (valGirthWaist) valGirthWaist.textContent = `${g.waistIn}"`;
    if (valGirthHip) valGirthHip.textContent = `${g.hipIn}"`;
    if (valGirthChest) valGirthChest.textContent = `${g.chestIn}"`;
    if (valGirthThigh) valGirthThigh.textContent = `${g.thighIn}"`;
    if (valGirthBicep) valGirthBicep.textContent = `${g.bicepIn}"`;
    if (valGirthNeck) valGirthNeck.textContent = `${g.neckIn}"`;

    // 6. Segmental Lean Mass
    const seg = m.segmentalLeanMass || {};
    if (valSegTrunk) valSegTrunk.textContent = `${seg.trunkLb || '—'} lbs`;
    if (valSegLegs) valSegLegs.textContent = `${((seg.leftLegLb || 0) + (seg.rightLegLb || 0)).toFixed(1)} lbs`;
    if (valSegArms) valSegArms.textContent = `${((seg.leftArmLb || 0) + (seg.rightArmLb || 0)).toFixed(1)} lbs`;

    // 7. Clinical Trial Matches
    if (trialSummaryCopy && insights.clinicalSummary) {
      trialSummaryCopy.textContent = insights.clinicalSummary;
    }

    if (trialRecsGrid && insights.categories) {
      trialRecsGrid.innerHTML = '';
      insights.categories.forEach((cat) => {
        const card = document.createElement('div');
        card.className = 'dexa-trial-card';

        const top = document.createElement('div');
        top.className = 'dexa-trial-card-top';

        const title = document.createElement('h4');
        title.textContent = cat.category;
        top.appendChild(title);

        const badge = document.createElement('span');
        badge.className = 'dexa-trial-match-badge';
        badge.textContent = cat.status;
        top.appendChild(badge);
        card.appendChild(top);

        const desc = document.createElement('p');
        desc.className = 'dexa-trial-card-desc';
        desc.textContent = cat.description;
        card.appendChild(desc);

        const bioList = document.createElement('div');
        bioList.className = 'dexa-biomarker-chips';
        (cat.matchingBiomarkers || []).forEach((b) => {
          const chip = document.createElement('span');
          chip.className = 'dexa-bio-chip';
          chip.textContent = b;
          bioList.appendChild(chip);
        });
        card.appendChild(bioList);

        const actionWrap = document.createElement('div');
        actionWrap.className = 'dexa-trial-card-action';
        const searchBtn = document.createElement('button');
        searchBtn.type = 'button';
        searchBtn.className = 'button button-secondary dexa-cat-search-btn';
        searchBtn.innerHTML = `Search "${cat.searchQuery}" →`;
        searchBtn.addEventListener('click', () => {
          proposeToClinicalTrials(cat.searchQuery);
        });
        actionWrap.appendChild(searchBtn);
        card.appendChild(actionWrap);

        trialRecsGrid.appendChild(card);
      });
    }

    // Scroll smoothly to results
    resultsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Propose DEXA biomarkers to Clinical Trials tab
  const proposeToClinicalTrials = (preferredTopic) => {
    // 1. Switch to Clinical Trials Tab
    const trialsTabBtn = document.querySelector('#tab-trials');
    if (trialsTabBtn) {
      trialsTabBtn.click();
    }

    // 2. Ensure consent is enabled for local matching
    const consentCheck = document.querySelector('#trial-consent');
    if (consentCheck) {
      consentCheck.checked = true;
      consentCheck.dispatchEvent(new Event('change'));
    }

    // 3. Inform user with prominent banner
    const statusBox = document.querySelector('#trial-status');
    if (statusBox) {
      statusBox.innerHTML = `
        <div class="dexa-trials-active-banner">
          <div class="dexa-banner-icon">⚡</div>
          <div>
            <strong>DEXA Biomarkers Active for Eligibility Matching</strong>
            <p>Evaluating studies with Body Fat: ${activeScanData?.measurements?.bodyFatPercent || '27.8'}%, Visceral Adipose Tissue: ${activeScanData?.measurements?.visceralFat?.areaCm2 || '83.4'} cm², and Lean Mass tracking.</p>
          </div>
        </div>
      `;
    }

    // 4. Trigger search button automatically
    const searchBtn = document.querySelector('#trial-search-button');
    if (searchBtn && !searchBtn.disabled) {
      setTimeout(() => {
        searchBtn.click();
      }, 400);
    }
  };

  // Load Scan History from local database
  const loadScanHistory = async () => {
    if (!historyTbody) return;
    try {
      const res = await fetch('/api/dexa/scans');
      const data = await res.json();
      if (!data.success || !data.scans || !data.scans.length) {
        historyTbody.innerHTML = `
          <tr>
            <td colspan="6" style="text-align: center; color: #94a3b8; padding: 24px;">
              No DEXA scans recorded yet. Perform your first TrueDepth scan above.
            </td>
          </tr>
        `;
        return;
      }

      historyTbody.innerHTML = '';
      data.scans.forEach((scan, index) => {
        const tr = document.createElement('tr');
        const dt = scan.completedAt ? new Date(scan.completedAt).toLocaleString() : 'Recent';
        const m = scan.measurements || {};
        const vat = m.visceralFat || {};

        tr.innerHTML = `
          <td><strong>${dt}</strong></td>
          <td><code>${scan.scanId}</code></td>
          <td><span class="dexa-table-val">${m.bodyFatPercent != null ? m.bodyFatPercent + '%' : '—'}</span></td>
          <td><span class="dexa-table-val">${vat.areaCm2 != null ? vat.areaCm2 + ' cm²' : '—'}</span></td>
          <td><span class="dexa-table-val">${m.leanMassLb != null ? m.leanMassLb + ' lbs' : '—'}</span></td>
          <td>
            <button type="button" class="button button-secondary dexa-reload-scan-btn" style="padding: 4px 10px; font-size: 0.8rem;">
              View & Propose
            </button>
          </td>
        `;

        tr.querySelector('.dexa-reload-scan-btn').addEventListener('click', () => {
          activeScanData = scan;
          renderScanResults(scan);
        });

        historyTbody.appendChild(tr);
      });
    } catch (err) {
      console.warn('Failed to load DEXA history:', err);
    }
  };

  // Inspect Payload Modal
  if (btnInspectPayload && modalPayload) {
    btnInspectPayload.addEventListener('click', () => {
      if (modalPayloadContent) {
        modalPayloadContent.textContent = JSON.stringify(activeScanData, null, 2);
      }
      modalPayload.removeAttribute('hidden');
    });
  }

  if (btnClosePayloadModal && modalPayload) {
    btnClosePayloadModal.addEventListener('click', () => {
      modalPayload.setAttribute('hidden', '');
    });
  }

  // Event Listeners
  if (startScanBtn) {
    startScanBtn.addEventListener('click', startScan);
  }

  if (btnProposeTrials) {
    btnProposeTrials.addEventListener('click', () => {
      proposeToClinicalTrials();
    });
  }

  // Load latest scan on page load
  const initLatestScan = async () => {
    try {
      const res = await fetch('/api/dexa/latest');
      const data = await res.json();
      if (data.success && data.scan) {
        activeScanData = data.scan;
        renderScanResults(activeScanData);
      }
      loadScanHistory();
    } catch (err) {
      console.warn('Init DEXA latest scan error:', err);
    }
  };

  initLatestScan();
})();
