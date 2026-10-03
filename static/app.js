(() => {
  'use strict';

  const storageKey = key => document.body.dataset.sampleMode === 'true' ? `sample.${key}` : key;

  const storage = {
    read(key, fallback) {
      try {
        const value = JSON.parse(localStorage.getItem(storageKey(key)));
        return value ?? fallback;
      } catch {
        return fallback;
      }
    },
    write(key, value) {
      try {
        localStorage.setItem(storageKey(key), JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
  };

  const today = () => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
  };

  const consent = document.querySelector('#consent');
  const connectButton = document.querySelector('#connect-button');
  if (consent && connectButton) {
    const syncConsent = () => {
      connectButton.disabled = !consent.checked;
      connectButton.setAttribute('aria-disabled', String(connectButton.disabled));
    };
    consent.addEventListener('change', syncConsent);
    syncConsent();
  }

  const toast = document.querySelector('[data-toast]');
  let toastTimer;
  const showToast = (message) => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2400);
  };

  const tabs = [...document.querySelectorAll('[data-tab-target]')];
  const panels = [...document.querySelectorAll('[data-tab-panel]')];
  const activateTab = (target, { focus = false, scroll = true } = {}) => {
    const selected = tabs.find((tab) => tab.dataset.tabTarget === target);
    if (!selected) return;
    tabs.forEach((tab) => {
      const active = tab === selected;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    panels.forEach((panel) => {
      const active = panel.dataset.tabPanel === target;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
    if (focus) selected.focus();
    if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tabTarget));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0
        : event.key === 'End' ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      activateTab(tabs[nextIndex].dataset.tabTarget, { focus: true, scroll: false });
    });
  });
  if (['#trials', '#health'].includes(window.location.hash)) activateTab(window.location.hash.slice(1), { scroll: false });

  const logKey = 'patient-agency.logs.v1';
  const logsForToday = () => storage.read(logKey, {})[today()] || {};
  const saveLog = (kind) => {
    const logs = storage.read(logKey, {});
    const date = today();
    logs[date] = logs[date] || {};
    logs[date][kind] = (logs[date][kind] || 0) + 1;
    storage.write(logKey, logs);
  };
  const setLogState = (button) => {
    const logged = Boolean(logsForToday()[button.dataset.log]);
    button.setAttribute('aria-pressed', String(logged));
    const check = button.querySelector('.action-check');
    if (check && logged) {
      check.textContent = '✓';
      check.style.color = '#2d805e';
    }
  };
  document.querySelectorAll('[data-log]').forEach((button) => {
    setLogState(button);
    button.addEventListener('click', () => {
      saveLog(button.dataset.log);
      setLogState(button);
      const label = button.querySelector('strong')?.textContent || button.dataset.log;
      showToast(`${label} saved on this device`);
    });
  });

  const answersKey = 'patient-agency.answers.v1';
  const answers = storage.read(answersKey, {});
  const syncAnswerState = (button) => {
    const selected = answers[button.dataset.answer] === button.dataset.value;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  };
  document.querySelectorAll('[data-answer]').forEach((button) => {
    syncAnswerState(button);
    button.addEventListener('click', () => {
      answers[button.dataset.answer] = button.dataset.value;
      storage.write(answersKey, answers);
      document.querySelectorAll(`[data-answer="${button.dataset.answer}"]`).forEach(syncAnswerState);
      showToast('Answer saved on this device');
    });
  });

  const demoPanel = document.querySelector('[data-demo-panel]');
  const openDemo = document.querySelector('[data-demo-preview]');
  const closeDemo = document.querySelector('[data-close-demo]');
  let lastFocused;
  const closeDemoPanel = () => {
    if (!demoPanel) return;
    demoPanel.hidden = true;
    lastFocused?.focus();
  };
  openDemo?.addEventListener('click', () => {
    if (!demoPanel) return;
    lastFocused = document.activeElement;
    demoPanel.hidden = false;
    closeDemo?.focus();
  });
  closeDemo?.addEventListener('click', closeDemoPanel);
  demoPanel?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDemoPanel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...demoPanel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  demoPanel?.querySelectorAll('.preview-actions button').forEach((button) => {
    button.addEventListener('click', () => showToast(`${button.textContent} added to this demo`));
  });

  const notes = document.querySelector('#visit-notes');
  const notesKey = 'patient-agency.visit-notes.v1';
  if (notes) {
    notes.value = storage.read(notesKey, '');
    notes.addEventListener('input', () => storage.write(notesKey, notes.value));
  }

  const summaryText = () => {
    const title = document.querySelector('.summary-card h2')?.textContent?.trim() || 'Patient Agency summary';
    const body = document.querySelector('.summary-card p:not(.muted)')?.textContent?.trim() || '';
    const currentNotes = notes?.value?.trim() || '';
    return `${title}\n\n${body}\n\nQuestions:\n${currentNotes}`;
  };
  const copyText = async (text) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const temporary = document.createElement('textarea');
    temporary.value = text;
    temporary.setAttribute('readonly', '');
    temporary.style.position = 'fixed';
    temporary.style.opacity = '0';
    document.body.appendChild(temporary);
    temporary.select();
    document.execCommand('copy');
    temporary.remove();
  };
  document.querySelector('[data-copy-summary]')?.addEventListener('click', async () => {
    try {
      await copyText(summaryText());
      showToast('Visit summary copied');
    } catch {
      showToast('Copy is unavailable in this browser');
    }
  });
  document.querySelector('[data-download-summary]')?.addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([summaryText()], { type: 'text/plain' }));
    link.download = 'patient-agency-visit-summary.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    showToast('Visit summary downloaded');
  });
})();
