// Photon Health e-Prescribing Module (https://reference.photon.health/)
(function() {
  'use strict';

  // Elements
  const composerForm = document.getElementById('photon-order-form');
  const medicationSelect = document.getElementById('rx-med-select');
  const medicationCustomWrap = document.getElementById('rx-custom-med-wrap');
  const medNameInput = document.getElementById('rx-med-name');
  const medStrengthInput = document.getElementById('rx-med-strength');
  const medFormInput = document.getElementById('rx-med-form');
  const medSigInput = document.getElementById('rx-med-sig');
  const medQuantityInput = document.getElementById('rx-med-quantity');
  const medUnitSelect = document.getElementById('rx-med-unit');
  const medRefillsInput = document.getElementById('rx-med-refills');
  const medDaysSupplyInput = document.getElementById('rx-med-days');
  const pharmacySelect = document.getElementById('rx-pharmacy-select');
  const deliveryTypeRadios = document.querySelectorAll('input[name="rx-delivery-type"]');
  const triggerResultInput = document.getElementById('rx-trigger-result');
  const clinicalRationaleInput = document.getElementById('rx-clinical-rationale');
  const submitButton = document.getElementById('btn-submit-photon-order');
  const ordersListContainer = document.getElementById('photon-orders-container');
  const ordersCountBadge = document.getElementById('photon-orders-count');
  const graphqlPreviewCode = document.getElementById('photon-graphql-preview');

  // Payload modal elements
  const payloadModal = document.getElementById('photon-payload-modal');
  const payloadModalClose = document.getElementById('btn-close-payload-modal');
  const payloadModalContent = document.getElementById('photon-payload-content');

  // State
  let catalog = [];
  let pharmacies = [];

  // Initialize
  async function init() {
    setupEventListeners();
    await loadInitialData();
    updateGraphQLPreview();
  }

  async function loadInitialData() {
    try {
      const [catRes, pharmRes] = await Promise.all([
        fetch('/api/prescriptions/catalog').then(r => r.json()),
        fetch('/api/prescriptions/pharmacies').then(r => r.json())
      ]);
      if (catRes.success) catalog = catRes.catalog || [];
      if (pharmRes.success) pharmacies = pharmRes.pharmacies || [];
    } catch (err) {
      console.warn('Failed to load initial prescription data:', err);
    }
  }

  function setupEventListeners() {
    // Recommendation card prefill buttons
    document.addEventListener('click', function(e) {
      const btn = e.target.closest('[data-rx-prefill]');
      if (btn) {
        e.preventDefault();
        try {
          const recData = JSON.parse(btn.getAttribute('data-rx-prefill'));
          prefillComposer(recData);
        } catch (err) {
          console.error('Error prefilling recommendation:', err);
        }
      }
    });

    // Medication dropdown change
    if (medicationSelect) {
      medicationSelect.addEventListener('change', function() {
        const val = this.value;
        if (val === 'custom') {
          if (medicationCustomWrap) medicationCustomWrap.style.display = 'block';
        } else {
          if (medicationCustomWrap) medicationCustomWrap.style.display = 'none';
          const match = catalog.find(m => m.treatmentId === val);
          if (match) {
            if (medNameInput) medNameInput.value = match.name;
            if (medStrengthInput) medStrengthInput.value = match.strength;
            if (medFormInput) medFormInput.value = match.form;
            if (medSigInput) medSigInput.value = match.defaultSig;
            if (medQuantityInput) medQuantityInput.value = match.defaultQuantity;
            if (medUnitSelect) medUnitSelect.value = match.dispenseUnit;
            if (medRefillsInput) medRefillsInput.value = match.defaultRefills;
            if (medDaysSupplyInput) medDaysSupplyInput.value = match.defaultDaysSupply;
          }
        }
        updateGraphQLPreview();
      });
    }

    // Input changes update GraphQL live preview
    const inputs = [
      medNameInput, medStrengthInput, medFormInput, medSigInput,
      medQuantityInput, medUnitSelect, medRefillsInput, medDaysSupplyInput,
      pharmacySelect, triggerResultInput, clinicalRationaleInput
    ];
    inputs.forEach(input => {
      if (input) {
        input.addEventListener('input', updateGraphQLPreview);
        input.addEventListener('change', updateGraphQLPreview);
      }
    });

    // Delivery Type Radios
    deliveryTypeRadios.forEach(radio => {
      radio.addEventListener('change', function() {
        const isDelivery = this.value === 'DELIVERY';
        const addressBlock = document.getElementById('rx-delivery-address-block');
        if (addressBlock) addressBlock.style.display = isDelivery ? 'block' : 'none';
        
        // Filter pharmacy selector for delivery or retail
        if (pharmacySelect && pharmacies.length) {
          pharmacySelect.innerHTML = '';
          const filtered = pharmacies.filter(p => isDelivery ? p.delivery : !p.delivery);
          const list = filtered.length ? filtered : pharmacies;
          list.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} — ${p.address}`;
            pharmacySelect.appendChild(opt);
          });
        }
        updateGraphQLPreview();
      });
    });

    // Form submit
    if (composerForm) {
      composerForm.addEventListener('submit', handleOrderSubmit);
    }

    // Cancel order delegation
    document.addEventListener('click', async function(e) {
      const cancelBtn = e.target.closest('[data-rx-cancel]');
      if (cancelBtn) {
        e.preventDefault();
        const orderId = cancelBtn.getAttribute('data-rx-cancel');
        if (confirm(`Cancel prescription order ${orderId} on Photon Health?`)) {
          await cancelOrder(orderId, cancelBtn);
        }
      }

      // View Payload delegation
      const payloadBtn = e.target.closest('[data-rx-view-payload]');
      if (payloadBtn) {
        e.preventDefault();
        try {
          const raw = JSON.parse(payloadBtn.getAttribute('data-rx-view-payload'));
          openPayloadModal(raw);
        } catch (err) {
          console.error('Error opening payload:', err);
        }
      }
    });

    // Close Modal
    if (payloadModalClose) {
      payloadModalClose.addEventListener('click', closePayloadModal);
    }
    if (payloadModal) {
      payloadModal.addEventListener('click', function(e) {
        if (e.target === payloadModal) closePayloadModal();
      });
    }
  }

  function prefillComposer(rec) {
    if (!composerForm) return;

    // Check if in select
    if (medicationSelect) {
      const hasOption = [...medicationSelect.options].some(o => o.value === rec.treatmentId);
      if (hasOption) {
        medicationSelect.value = rec.treatmentId;
        if (medicationCustomWrap) medicationCustomWrap.style.display = 'none';
      } else {
        medicationSelect.value = 'custom';
        if (medicationCustomWrap) medicationCustomWrap.style.display = 'block';
      }
    }

    if (medNameInput) medNameInput.value = rec.name;
    if (medStrengthInput) medStrengthInput.value = rec.strength;
    if (medFormInput) medFormInput.value = rec.form;
    if (medSigInput) medSigInput.value = rec.sig;
    if (medQuantityInput) medQuantityInput.value = rec.quantity || 30;
    if (medUnitSelect) medUnitSelect.value = rec.dispenseUnit || 'TABLET';
    if (medRefillsInput) medRefillsInput.value = rec.refills !== undefined ? rec.refills : 3;
    if (medDaysSupplyInput) medDaysSupplyInput.value = rec.daysSupply || 30;
    if (triggerResultInput) triggerResultInput.value = rec.trigger || '';
    if (clinicalRationaleInput) clinicalRationaleInput.value = rec.clinicalRationale || '';

    updateGraphQLPreview();

    // Scroll smoothly to composer
    composerForm.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Highlight form with brief pulse
    composerForm.classList.add('rx-form-highlight');
    setTimeout(() => composerForm.classList.remove('rx-form-highlight'), 1800);
  }

  function updateGraphQLPreview() {
    if (!graphqlPreviewCode) return;
    const medName = medNameInput ? medNameInput.value || 'Metformin HCl ER' : 'Metformin HCl ER';
    const treatmentId = medicationSelect && medicationSelect.value !== 'custom' ? medicationSelect.value : 'rx_custom_id';
    const pharmacyId = pharmacySelect ? pharmacySelect.value : 'ph_pharm_cvs_1042';

    const preview = {
      endpoint: "https://api.photon.health/graphql",
      operation: "mutation createOrder($externalId: ID, $patientId: ID!, $fills: [FillInput!]!, $address: AddressInput!, $pharmacyId: ID)",
      variables: {
        externalId: "ext_" + Math.random().toString(36).substring(2, 10),
        patientId: "pat_photon_maya_01",
        fills: [
          {
            treatmentId: treatmentId,
            medication: medName,
            dispenseQuantity: parseFloat(medQuantityInput ? medQuantityInput.value || 30 : 30),
            dispenseUnit: medUnitSelect ? medUnitSelect.value || 'TABLET' : 'TABLET',
            refills: parseInt(medRefillsInput ? medRefillsInput.value || 3 : 3, 10),
            daysSupply: parseInt(medDaysSupplyInput ? medDaysSupplyInput.value || 30 : 30, 10),
            sig: medSigInput ? medSigInput.value : ''
          }
        ],
        pharmacyId: pharmacyId,
        address: {
          street1: document.getElementById('rx-address-street') ? document.getElementById('rx-address-street').value : "742 Evergreen Terrace",
          city: document.getElementById('rx-address-city') ? document.getElementById('rx-address-city').value : "Seattle",
          state: document.getElementById('rx-address-state') ? document.getElementById('rx-address-state').value : "WA",
          postalCode: document.getElementById('rx-address-zip') ? document.getElementById('rx-address-zip').value : "98101",
          country: "US"
        }
      }
    };

    graphqlPreviewCode.textContent = JSON.stringify(preview, null, 2);
  }

  async function handleOrderSubmit(e) {
    e.preventDefault();

    const selectedPharmOption = pharmacySelect ? pharmacySelect.options[pharmacySelect.selectedIndex] : null;
    const pharmacyName = selectedPharmOption ? selectedPharmOption.text.split(' — ')[0] : 'Selected Pharmacy';

    const orderPayload = {
      treatment_id: medicationSelect && medicationSelect.value !== 'custom' ? medicationSelect.value : 'rx_custom_order',
      medication_name: medNameInput ? medNameInput.value : 'Medication',
      dosage: medStrengthInput ? medStrengthInput.value : 'Standard',
      form: medFormInput ? medFormInput.value : 'Tablet',
      sig: medSigInput ? medSigInput.value : 'Take as directed',
      quantity: medQuantityInput ? parseFloat(medQuantityInput.value) : 30,
      dispense_unit: medUnitSelect ? medUnitSelect.value : 'TABLET',
      refills: medRefillsInput ? parseInt(medRefillsInput.value, 10) : 3,
      days_supply: medDaysSupplyInput ? parseInt(medDaysSupplyInput.value, 10) : 30,
      pharmacy_id: pharmacySelect ? pharmacySelect.value : 'ph_pharm_cvs_1042',
      pharmacy_name: pharmacyName,
      delivery_address: {
        street1: document.getElementById('rx-address-street') ? document.getElementById('rx-address-street').value : "742 Evergreen Terrace",
        city: document.getElementById('rx-address-city') ? document.getElementById('rx-address-city').value : "Seattle",
        state: document.getElementById('rx-address-state') ? document.getElementById('rx-address-state').value : "WA",
        postalCode: document.getElementById('rx-address-zip') ? document.getElementById('rx-address-zip').value : "98101",
        country: "US"
      },
      trigger_result: triggerResultInput ? triggerResultInput.value : "Verified clinical observation",
      clinical_rationale: clinicalRationaleInput ? clinicalRationaleInput.value : "Patient directed electronic prescription order."
    };

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.innerHTML = `<span class="rx-spinner-sm"></span> Disagreeing &amp; Dispatching to Photon…`;
    }

    try {
      const response = await fetch('/api/prescriptions/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderPayload)
      });
      const data = await response.json();

      if (data.success && data.order) {
        showSuccessNotification(data.order);
        prependOrderToHistory(data.order);
        // Reset or scroll
        const historySection = document.getElementById('photon-orders-history-section');
        if (historySection) {
          historySection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } else {
        alert(data.error || 'Failed to dispatch order. Check your connection.');
      }
    } catch (err) {
      console.error('Error submitting prescription order:', err);
      alert('Network error while communicating with Photon Health API.');
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          Send e-Prescription via Photon Health
        `;
      }
    }
  }

  function showSuccessNotification(order) {
    const banner = document.getElementById('rx-order-success-banner');
    if (!banner) return;
    document.getElementById('rx-success-order-id').textContent = order.id;
    document.getElementById('rx-success-med-name').textContent = `${order.medication.name} ${order.medication.dosage}`;
    document.getElementById('rx-success-pharmacy').textContent = order.pharmacy.name;
    banner.style.display = 'block';
    setTimeout(() => {
      banner.style.display = 'none';
    }, 12000);
  }

  function prependOrderToHistory(order) {
    if (!ordersListContainer) return;

    // Remove empty state if present
    const emptyState = document.getElementById('rx-orders-empty');
    if (emptyState) emptyState.remove();

    const card = document.createElement('article');
    card.className = 'rx-order-card';
    card.id = `rx-order-card-${order.id}`;

    const dateFormatted = new Date(order.createdAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const isRouting = order.state === 'ROUTING';
    const stateBadge = isRouting 
      ? `<span class="rx-status-badge rx-status-routing"><span class="rx-pulse-dot"></span> ROUTING</span>`
      : `<span class="rx-status-badge rx-status-accepted">${order.state}</span>`;

    card.innerHTML = `
      <div class="rx-order-header">
        <div class="rx-order-id-group">
          <span class="rx-photon-id">${order.id}</span>
          ${stateBadge}
        </div>
        <span class="rx-order-date">${dateFormatted}</span>
      </div>

      <div class="rx-order-body">
        <h4 class="rx-order-med-title">${escapeHtml(order.medication.name)} <span class="rx-order-strength">${escapeHtml(order.medication.dosage)}</span></h4>
        <div class="rx-sig-box">
          <strong>Sig:</strong> ${escapeHtml(order.medication.sig)}
        </div>
        
        <div class="rx-order-meta-grid">
          <div class="rx-order-meta-item">
            <span class="rx-meta-k">Dispense</span>
            <span class="rx-meta-v">${order.medication.quantity} ${order.medication.dispenseUnit} (Refills: ${order.medication.refills})</span>
          </div>
          <div class="rx-order-meta-item">
            <span class="rx-meta-k">Fulfillment Routing</span>
            <span class="rx-meta-v">${escapeHtml(order.pharmacy.name)}</span>
          </div>
          <div class="rx-order-meta-item">
            <span class="rx-meta-k">Based on Clinical Result</span>
            <span class="rx-meta-v rx-result-chip">⚡ ${escapeHtml(order.triggerResult || 'Verified lab metric')}</span>
          </div>
        </div>
      </div>

      <div class="rx-order-footer">
        <div class="rx-order-actions">
          <button type="button" class="btn-rx-action" data-rx-view-payload='${escapeAttr(JSON.stringify(order))}'>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
            Photon GraphQL Payload
          </button>
          <a href="${order.trackingUrl}" target="_blank" rel="noopener" class="btn-rx-action">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Photon Portal
          </a>
        </div>
        <button type="button" class="btn-rx-cancel" data-rx-cancel="${order.id}">Cancel Order</button>
      </div>
    `;

    ordersListContainer.insertBefore(card, ordersListContainer.firstChild);

    // Update count badge
    if (ordersCountBadge) {
      const cur = parseInt(ordersCountBadge.textContent || '0', 10);
      ordersCountBadge.textContent = cur + 1;
    }
  }

  async function cancelOrder(orderId, btn) {
    btn.disabled = true;
    btn.textContent = 'Canceling…';
    try {
      const res = await fetch(`/api/prescriptions/orders/${orderId}/cancel`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const card = document.getElementById(`rx-order-card-${orderId}`);
        if (card) {
          const statusBadge = card.querySelector('.rx-status-badge');
          if (statusBadge) {
            statusBadge.className = 'rx-status-badge rx-status-canceled';
            statusBadge.textContent = 'CANCELED';
          }
          btn.remove();
        }
      } else {
        alert(data.error || 'Failed to cancel order.');
        btn.disabled = false;
        btn.textContent = 'Cancel Order';
      }
    } catch (err) {
      console.error('Error canceling order:', err);
      btn.disabled = false;
      btn.textContent = 'Cancel Order';
    }
  }

  function openPayloadModal(order) {
    if (!payloadModal || !payloadModalContent) return;
    payloadModalContent.textContent = JSON.stringify(order, null, 2);
    payloadModal.removeAttribute('hidden');
    payloadModal.classList.add('is-open');
  }

  function closePayloadModal() {
    if (!payloadModal) return;
    payloadModal.setAttribute('hidden', '');
    payloadModal.classList.remove('is-open');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/'/g, '&apos;');
  }

  // Run on DOM loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
