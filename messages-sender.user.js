// ==UserScript==
// @name         Messages Sender
// @namespace    http://tampermonkey.net/
// @version      4.7
// @description  Batch-prep chats: handles numbers, text, and images. Premium gold-on-black UI. Strict session-level duplicate prevention for both modes. Prevents button spam. Minimizable. v4.7: positive send confirmation using live-DOM-confirmed selectors (data-e2e-message-outgoing + data-e2e-text-message-content).
// @author       You
// @match        https://messages.google.com/*
// @downloadURL  https://raw.githubusercontent.com/onth-bot/ONTH-message-sender/main/messages-sender.user.js
// @updateURL    https://raw.githubusercontent.com/onth-bot/ONTH-message-sender/main/messages-sender.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(() => {
  'use strict';
  if (window.top !== window.self) return;

  const PANEL_ID       = '__gm_batch_panel';
  const START_BTN_ID   = '__gm_batch_start';
  const STOP_BTN_ID    = '__gm_batch_stop';
  const NEXT_BTN_ID    = '__gm_batch_next';
  const NUMS_ID        = '__gm_batch_numbers';
  const MSG_ID         = '__gm_batch_message';
  const STATUS_ID      = '__gm_batch_status';
  const FAILURES_ID    = '__gm_batch_failures';
  const PAIRED_ID      = '__gm_batch_paired';
  const TAB_BATCH_ID   = '__gm_tab_batch';
  const TAB_PAIRED_ID  = '__gm_tab_paired';
  const VIEW_BATCH_ID  = '__gm_view_batch';
  const VIEW_PAIRED_ID = '__gm_view_paired';
  const PREVIEW_ID     = '__gm_batch_preview';
  const MIN_BTN_ID     = '__gm_batch_minimize';
  const PILL_ID        = '__gm_batch_pill';
  const PILL_STATUS_ID = '__gm_batch_pill_status';
  const BODY_ID        = '__gm_batch_body';

  // -------- Reliability knobs --------
  const MAX_TRIES_PER_NUMBER   = 2;
  const MAX_POST_RUN_PASSES    = 1;
  const SEND_CONFIRM_TIMEOUTMS = 300000;

  let stopRequested  = false;
  let waitingForNext = false;
  let isRunning      = false;
  let activeMode     = 'batch';
  let isMinimized    = false;

  // Strict session registry: tracks "number|message_snippet" to prevent ANY double sends in one session.
  const sessionSentRegistry = new Set();

  const getSignature = (num, msg) => `${num}|${(msg || '').trim().slice(0, 50)}`;

  const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
  const digits = (s)  => (s || '').replace(/\D+/g, '');

  /* ---------- Theme tokens (Glass-Dark Logistics) ---------- */
  const T = {
    pageBg:      '#080a0d',
    panelBg:     '#111520',
    cardBg:      '#111520',
    border:      '#1e2535',
    cyan:        '#00d4ff',
    cyanDim:     '#006e85',
    cyanBorder:  'rgba(0, 212, 255, 0.25)',
    cyanHover:   'rgba(0, 212, 255, 0.15)',
    textPrimary: '#e8edf5',
    textBody:    '#e8edf5',
    textMuted:   '#4a5568',
    danger:      '#ff4d6a',
    dangerBg:    'rgba(255,77,106,0.1)',
    warning:     '#ffb020',
    warningBg:   'rgba(255,176,32,0.1)',
    success:     '#22d98a',
    successBg:   'rgba(34,217,138,0.1)',
    info:        '#40e4ff',
  };

  /* ---------- Core polling helper ---------- */
  async function waitFor(conditionFn, { timeout = 8000, interval = 40, label = 'condition' } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = conditionFn();
      if (result) return result;
      await sleep(interval);
    }
    throw new Error(`${label}: timed out after ${timeout}ms`);
  }

  /* ---------- DOM helpers ---------- */
  const deepFind = (pred, roots = [document]) => {
    const seen = new WeakSet();
    const walk = (root) => {
      if (!root) return null;
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (pred(el)) return el;
        if (el.shadowRoot) {
          const hit = walk(el.shadowRoot);
          if (hit) return hit;
        }
      }
      return null;
    };
    for (const r of roots) {
      const hit = walk(r);
      if (hit) return hit;
    }
    return null;
  };

  const _deepFindCache = new Map();
  const cachedDeepFind = (key, pred, roots) => {
    const cached = _deepFindCache.get(key);
    if (cached && cached.isConnected && pred(cached)) return cached;
    const found = deepFind(pred, roots);
    if (found) _deepFindCache.set(key, found);
    else _deepFindCache.delete(key);
    return found;
  };

  /* ---------- Reusable predicates ---------- */
  const isComposerTextarea = (el) =>
    el.tagName === 'TEXTAREA' &&
    el.getAttribute('data-e2e-message-input-box') !== null &&
    el.offsetParent !== null;

  const isSendButton = (el) =>
    el.tagName === 'BUTTON' &&
    el.getAttribute('data-e2e-send-text-button') !== null &&
    el.offsetParent !== null;

  const setVal = (el, val) => {
    if (!el) return;
    const nativeInputValueSetter     = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,  'value')?.set;
    const nativeTextAreaValueSetter  = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (el.tagName === 'TEXTAREA' && nativeTextAreaValueSetter) {
      nativeTextAreaValueSetter.call(el, val);
    } else if (el.tagName === 'INPUT' && nativeInputValueSetter) {
      nativeInputValueSetter.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const strongClick = (el) => {
    if (!el) return;
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.focus?.();
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, buttons: 1 }))
    );
  };

  function setStatus(txt) {
    const el = document.getElementById(STATUS_ID);
    if (el) el.textContent = txt;
    const pillStatus = document.getElementById(PILL_STATUS_ID);
    if (pillStatus) pillStatus.textContent = txt;
    console.log('[BatchSender]', txt);
  }

  /* ---------- Failures UI ---------- */
  function showFailuresInUI(failedItems) {
    const box = document.getElementById(FAILURES_ID);
    if (!box) return;
    if (!failedItems || !failedItems.length) {
      box.style.display = 'none';
      box.textContent   = '';
      return;
    }
    box.style.display = 'block';
    box.textContent   = '';

    const header = document.createElement('div');
    Object.assign(header.style, { color: T.danger, fontFamily: "'DM Mono', monospace", marginBottom: '6px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em' });
    header.textContent = `⚠ ${failedItems.length} FAILED — copy numbers below:`;
    box.appendChild(header);

    const list = document.createElement('div');
    Object.assign(list.style, { fontFamily: "'DM Mono', monospace", fontSize: '10px', color: T.textBody, lineHeight: '1.7', userSelect: 'all' });
    list.textContent = failedItems.map(f => f.number).join('\n');
    box.appendChild(list);

    console.group('[BatchSender] FINAL FAILURES');
    console.table(failedItems);
    console.groupEnd();
  }

  function toggleRunState(running) {
    isRunning = running;
    const startBtn = document.getElementById(START_BTN_ID);
    if (startBtn) {
      startBtn.disabled      = running;
      startBtn.style.opacity = running ? '0.5' : '1';
      startBtn.style.cursor  = running ? 'not-allowed' : 'pointer';
      startBtn.textContent   = running ? 'Running…' : 'Start Batch';
    }
    const nextBtn = document.getElementById(NEXT_BTN_ID);
    if (nextBtn) {
      if (!running) {
        nextBtn.disabled      = true;
        nextBtn.style.opacity = '0.4';
        nextBtn.style.cursor  = 'not-allowed';
      }
    }
    updatePillIndicator();
  }

  function setNextButtonEnabled(enabled) {
    const nextBtn = document.getElementById(NEXT_BTN_ID);
    if (!nextBtn) return;
    nextBtn.disabled      = !enabled;
    nextBtn.style.opacity  = enabled ? '1' : '0.4';
    nextBtn.style.cursor   = enabled ? 'pointer' : 'not-allowed';
  }

  function updatePillIndicator() {
    const pill = document.getElementById(PILL_ID);
    if (!pill) return;
    const dot = pill.querySelector('.__gm_pill_dot');
    if (!dot) return;
    if (isRunning) {
      dot.style.background  = T.cyan;
      dot.style.boxShadow   = `0 0 8px ${T.cyanBorder}`;
      dot.style.animation   = '__gm_pulse 1.4s infinite';
    } else if (waitingForNext) {
      dot.style.background  = T.warning;
      dot.style.boxShadow   = `0 0 8px ${T.warningBg}`;
      dot.style.animation   = '__gm_pulse 1.4s infinite';
    } else {
      dot.style.background  = T.textMuted;
      dot.style.boxShadow   = 'none';
      dot.style.animation   = 'none';
    }
  }

  function composerIsVisible() {
    return !!cachedDeepFind('composer', isComposerTextarea);
  }

  function hasAttachment() {
    return !!document.querySelector('mw-attachment-view, [data-e2e-attached-media]');
  }

  function findNumberInput() {
    let inp = deepFind(el =>
      (el.tagName === 'INPUT' || el.getAttribute('role') === 'combobox') &&
      (el.offsetParent !== null) &&
      (/name|phone|email|number|recipient|to/i.test(el.getAttribute('aria-label') || '') ||
       /name|phone|email|number|recipient|to/i.test(el.getAttribute('placeholder') || ''))
    );
    if (inp) return inp;

    inp = deepFind(el =>
      el.tagName === 'INPUT' &&
      el.type === 'text' &&
      el.offsetParent !== null &&
      !el.readOnly &&
      !el.disabled
    );
    if (inp) return inp;

    inp = deepFind(el =>
      el.getAttribute('role') === 'combobox' &&
      el.offsetParent !== null
    );
    if (inp) return inp;

    inp = deepFind(el =>
      (el.tagName === 'INPUT' || el.contentEditable === 'true') &&
      el.offsetParent !== null &&
      !el.readOnly &&
      el.closest('mw-conversation-container, [role="dialog"], .modal, .overlay, [data-e2e-new-conversation]')
    );

    return inp;
  }

  function findStartChatButton() {
    let btn = cachedDeepFind('startChat', (el) =>
      (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tabIndex >= 0) &&
      /start chat|new chat|new conversation|compose/i.test((el.textContent || '') + (el.getAttribute('aria-label') || ''))
    );
    if (btn) return btn;

    btn = deepFind(el =>
      (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') &&
      (el.classList.contains('fab') ||
       /add|plus|create|new/i.test(el.getAttribute('aria-label') || '') ||
       el.querySelector('mat-icon, [data-mat-icon-name]'))
    );
    if (btn) return btn;

    btn = deepFind(el =>
      el.getAttribute('data-e2e-start-chat-button') !== null ||
      el.getAttribute('data-e2e-new-conversation') !== null
    );

    return btn;
  }

  function setMinimized(minimize) {
    isMinimized = minimize;
    const panel = document.getElementById(PANEL_ID);
    const pill  = document.getElementById(PILL_ID);
    if (!panel || !pill) return;
    if (minimize) {
      panel.style.display = 'none';
      pill.style.display  = 'flex';
      updatePillIndicator();
    } else {
      panel.style.display = 'block';
      pill.style.display  = 'none';
    }
  }

  /* ---------- UI Panel ---------- */
  function addPanel() {
    if (document.getElementById(PANEL_ID)) return;

    if (!document.getElementById('gm-batch-fonts')) {
      const fl = Object.assign(document.createElement('link'), { id:'gm-batch-fonts', rel:'stylesheet',
        href:'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:ital,wght@0,400;0,500&family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700&display=swap' });
      document.head.appendChild(fl);
    }

    const style = document.createElement('style');
    style.textContent = `
      @keyframes __gm_pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      #${MSG_ID} img { max-height: 150px; max-width: 100%; height: auto; width: auto; display: block; margin: 4px 0; border-radius: 4px; border: 1px solid ${T.border}; }
      #${START_BTN_ID}:hover:not(:disabled) { background: ${T.cyan} !important; color: ${T.pageBg} !important; transform: translateY(-1px); box-shadow: 0 4px 15px ${T.cyanBorder}; }
      #${STOP_BTN_ID}:hover  { background: ${T.dangerBg} !important; border-color: ${T.danger} !important; color: ${T.danger} !important; transform: translateY(-1px); }
      #${NEXT_BTN_ID}:hover:not(:disabled) { background: ${T.cyanHover} !important; border-color: ${T.cyan} !important; color: ${T.cyan} !important; transform: translateY(-1px); box-shadow: 0 4px 15px ${T.cyanBorder}; }
      #${START_BTN_ID}, #${STOP_BTN_ID}, #${NEXT_BTN_ID} { transition: all 0.2s ease; }
      #${MIN_BTN_ID} { background: transparent; border: 1px solid ${T.border}; color: ${T.textMuted}; width: 24px; height: 24px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; transition: all 0.15s ease; font-size: 14px; line-height: 1; }
      #${MIN_BTN_ID}:hover { border-color: ${T.cyanBorder}; color: ${T.cyan}; background: ${T.cyanHover}; }

      #${PILL_ID} { position: fixed; top: 16px; right: 16px; z-index: 2147483647; display: none; align-items: center; gap: 8px; padding: 8px 12px; background: ${T.panelBg}; border: 1px solid ${T.border}; border-radius: 6px; cursor: pointer; box-shadow: 0 8px 24px rgba(8,10,13,0.9), 0 0 0 1px rgba(0,212,255,0.05); font-family: 'DM Sans', sans-serif; font-size: 11px; color: ${T.textBody}; transition: all 0.2s ease; max-width: 260px; }
      #${PILL_ID}:hover { border-color: ${T.cyanBorder}; background: ${T.cardBg}; transform: translateY(-1px); box-shadow: 0 12px 32px rgba(8,10,13,0.95), 0 0 0 1px ${T.cyanBorder}; }
      #${PILL_ID} .__gm_pill_dot   { width: 8px; height: 8px; border-radius: 50%; background: ${T.textMuted}; flex-shrink: 0; transition: all 0.2s ease; }
      #${PILL_ID} .__gm_pill_label { color: ${T.cyan}; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; font-size: 10px; font-family: 'DM Mono', monospace; flex-shrink: 0; }
      #${PILL_ID} #${PILL_STATUS_ID} { color: ${T.textMuted}; font-family: 'DM Mono', monospace; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }

      .__gm_tab { flex: 1; padding: 9px 0; background: transparent; color: ${T.textMuted}; border: none; border-bottom: 2px solid transparent; cursor: pointer; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; transition: all 0.2s ease; font-family: 'DM Mono', monospace; }
      .__gm_tab:hover { color: ${T.textBody}; }
      .__gm_tab.__gm_tab_active { color: ${T.cyan}; border-bottom-color: ${T.cyan}; }

      #${PREVIEW_ID} { margin-top: 8px; max-height: 80px; overflow-y: auto; font-size: 10px; font-family: 'DM Mono', monospace; color: ${T.textMuted}; padding: 8px 10px; background: ${T.pageBg}; border-radius: 4px; border: 1px solid ${T.border}; line-height: 1.5; }
      #${PREVIEW_ID} .pair-row   { display: flex; gap: 6px; padding: 2px 0; }
      #${PREVIEW_ID} .pair-num   { color: ${T.textBody}; flex-shrink: 0; min-width: 75px; }
      #${PREVIEW_ID} .pair-arrow { color: ${T.cyan}; flex-shrink: 0; }
      #${PREVIEW_ID} .pair-msg   { color: ${T.textMuted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      #${FAILURES_ID} { display: none; margin-top: 10px; padding: 10px; background: ${T.dangerBg}; border: 1px solid rgba(255,77,106,0.3); border-radius: 4px; max-height: 120px; overflow-y: auto; }

      #${PANEL_ID} ::-webkit-scrollbar        { width: 4px; }
      #${PANEL_ID} ::-webkit-scrollbar-track  { background: transparent; }
      #${PANEL_ID} ::-webkit-scrollbar-thumb  { background: ${T.border}; border-radius: 4px; }
      #${PANEL_ID} ::-webkit-scrollbar-thumb:hover { background: ${T.textMuted}; }

      .__gm_header::after {
        content: ''; position: absolute; bottom: 0; left: 0; width: 100%; height: 2px;
        background: linear-gradient(90deg, transparent, ${T.cyan}, transparent);
      }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position:     'fixed',
      top:          '16px',
      right:        '16px',
      width:        '260px',
      padding:      '12px',
      background:   T.panelBg,
      backgroundImage: `linear-gradient(rgba(0,212,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,212,255,0.03) 1px, transparent 1px)`,
      backgroundSize: '40px 40px',
      color:        T.textPrimary,
      border:       `1px solid ${T.border}`,
      borderRadius: '6px',
      boxShadow:    '0 20px 50px rgba(8,10,13,0.9), 0 0 0 1px rgba(0,212,255,0.05)',
      zIndex:       '2147483647',
      fontFamily:   "'DM Sans', sans-serif",
      fontSize:     '12px',
      lineHeight:   '1.4',
    });

    /* ---- Header ---- */
    const header = document.createElement('div');
    header.className = '__gm_header';
    Object.assign(header.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '12px', marginBottom: '12px', position: 'relative' });

    const title = document.createElement('div');
    title.textContent = 'Batch Sender';
    Object.assign(title.style, { fontFamily: "'Bebas Neue', sans-serif", fontSize: '18px', color: T.cyan, letterSpacing: '1px', margin: '0' });

    const minBtn = document.createElement('button');
    minBtn.id   = MIN_BTN_ID;
    minBtn.type = 'button';
    minBtn.title = 'Minimize';
    minBtn.setAttribute('aria-label', 'Minimize panel');
    minBtn.textContent = '–';

    header.appendChild(title);
    header.appendChild(minBtn);

    /* ---- Body wrapper ---- */
    const body = document.createElement('div');
    body.id = BODY_ID;

    /* ---- Tabs ---- */
    const tabRow = document.createElement('div');
    Object.assign(tabRow.style, { display: 'flex', gap: '0', marginBottom: '14px', borderBottom: `1px solid ${T.border}` });

    const tabBatch = document.createElement('button');
    tabBatch.id        = TAB_BATCH_ID;
    tabBatch.className = '__gm_tab __gm_tab_active';
    tabBatch.textContent = 'Same Message';
    tabBatch.type = 'button';

    const tabPaired = document.createElement('button');
    tabPaired.id        = TAB_PAIRED_ID;
    tabPaired.className = '__gm_tab';
    tabPaired.textContent = 'Paired';
    tabPaired.type = 'button';

    tabRow.appendChild(tabBatch);
    tabRow.appendChild(tabPaired);

    /* ---- Input styles helper ---- */
    const inputStyles = {
      width: '100%', background: T.cardBg, color: T.textPrimary,
      border: `1px solid ${T.border}`, borderRadius: '4px',
      padding: '8px', boxSizing: 'border-box', fontSize: '10px',
      fontFamily: "'DM Mono', monospace",
      transition: 'all 0.2s ease', outline: 'none',
    };
    const focusHandler = function () { this.style.border = `1px solid ${T.cyan}`; this.style.boxShadow = `0 0 0 3px ${T.cyanBorder}`; };
    const blurHandler  = function () { this.style.border = `1px solid ${T.border}`;      this.style.boxShadow = 'none'; };

    const labelStyles = { marginBottom: '6px', fontSize: '10px', fontFamily: "'DM Mono', monospace", color: T.cyan, textTransform: 'uppercase', letterSpacing: '0.06em', opacity: '0.85' };

    /* ---- Batch view ---- */
    const viewBatch = document.createElement('div');
    viewBatch.id = VIEW_BATCH_ID;

    const numsLabel = document.createElement('div');
    numsLabel.textContent = 'Phone Numbers';
    Object.assign(numsLabel.style, labelStyles);

    const numsBox = document.createElement('textarea');
    numsBox.id = NUMS_ID;
    Object.assign(numsBox.style, { ...inputStyles, height: '55px', resize: 'vertical' });
    numsBox.placeholder = '5597409248\n5597409249\n...';
    numsBox.addEventListener('focus', focusHandler);
    numsBox.addEventListener('blur',  blurHandler);

    const msgLabel = document.createElement('div');
    msgLabel.textContent = 'Message Content';
    Object.assign(msgLabel.style, { ...labelStyles, margin: '12px 0 6px 0' });

    const msgBox = document.createElement('div');
    msgBox.id = MSG_ID;
    msgBox.contentEditable = 'true';
    Object.assign(msgBox.style, {
      ...inputStyles,
      minHeight: '45px', maxHeight: '80px', overflowY: 'auto',
      whiteSpace: 'pre-wrap', wordWrap: 'break-word',
    });
    msgBox.addEventListener('focus', focusHandler);
    msgBox.addEventListener('blur',  blurHandler);

    viewBatch.appendChild(numsLabel);
    viewBatch.appendChild(numsBox);
    viewBatch.appendChild(msgLabel);
    viewBatch.appendChild(msgBox);

    /* ---- Paired view ---- */
    const viewPaired = document.createElement('div');
    viewPaired.id = VIEW_PAIRED_ID;
    viewPaired.style.display = 'none';

    const pairedLabel = document.createElement('div');
    pairedLabel.textContent = 'Paste from Sheets or Type Pairs';
    Object.assign(pairedLabel.style, labelStyles);

    const pairedHint = document.createElement('div');
    Object.assign(pairedHint.style, { marginBottom: '8px', fontSize: '10px', color: T.textMuted, lineHeight: '1.5' });

    const pairedBox = document.createElement('textarea');
    pairedBox.id = PAIRED_ID;
    Object.assign(pairedBox.style, { ...inputStyles, height: '100px', resize: 'vertical', lineHeight: '1.6' });
    pairedBox.addEventListener('focus', focusHandler);
    pairedBox.addEventListener('blur',  blurHandler);

    const preview = document.createElement('div');
    preview.id = PREVIEW_ID;
    preview.textContent = 'Parsed pairs will appear here…';

    pairedBox.addEventListener('input', () => updatePreview());
    pairedBox.addEventListener('paste', () => setTimeout(updatePreview, 50));

    viewPaired.appendChild(pairedLabel);
    viewPaired.appendChild(pairedHint);
    viewPaired.appendChild(pairedBox);
    viewPaired.appendChild(preview);

    /* ---- Buttons ---- */
    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display: 'flex', gap: '8px', marginTop: '14px' });

    const startBtn = document.createElement('button');
    startBtn.id          = START_BTN_ID;
    startBtn.type        = 'button';
    startBtn.textContent = 'Start Batch';
    Object.assign(startBtn.style, {
      flex: '1', padding: '8px 10px', background: T.cyanDim, color: '#fff',
      border: `1px solid ${T.cyan}`, borderRadius: '4px', cursor: 'pointer',
      fontFamily: "'DM Sans', sans-serif", fontWeight: '600', fontSize: '12px',
      boxShadow: '0 2px 12px rgba(0,212,255,0.1)',
    });

    const stopBtn = document.createElement('button');
    stopBtn.id          = STOP_BTN_ID;
    stopBtn.type        = 'button';
    stopBtn.textContent = 'Stop';
    Object.assign(stopBtn.style, {
      width: '70px', padding: '10px', background: T.pageBg,
      color: T.textMuted, border: `1px solid ${T.border}`,
      borderRadius: '4px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", fontWeight: '600', fontSize: '12px',
    });

    const nextBtn = document.createElement('button');
    nextBtn.id          = NEXT_BTN_ID;
    nextBtn.type        = 'button';
    nextBtn.textContent = 'Continue';
    nextBtn.disabled    = true;
    Object.assign(nextBtn.style, {
      marginTop: '8px', width: '100%', padding: '10px',
      background: T.cyanHover, color: T.cyan, border: `1px solid ${T.cyanBorder}`,
      borderRadius: '4px', cursor: 'not-allowed', fontFamily: "'DM Sans', sans-serif", fontWeight: '600',
      fontSize: '12px', letterSpacing: '0.02em', opacity: '0.4',
    });

    const status = document.createElement('div');
    status.id = STATUS_ID;
    status.textContent = 'Ready';
    Object.assign(status.style, {
      marginTop: '12px', color: T.textMuted, minHeight: '18px', fontSize: '11px',
      padding: '8px 10px', background: T.pageBg, borderRadius: '4px',
      border: `1px solid ${T.border}`, fontFamily: "'DM Mono', monospace",
    });

    const failuresBox = document.createElement('div');
    failuresBox.id = FAILURES_ID;

    btnRow.appendChild(startBtn);
    btnRow.appendChild(stopBtn);

    body.appendChild(tabRow);
    body.appendChild(viewBatch);
    body.appendChild(viewPaired);
    body.appendChild(btnRow);
    body.appendChild(nextBtn);
    body.appendChild(status);
    body.appendChild(failuresBox);

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    /* ---- Minimized pill ---- */
    const pill = document.createElement('div');
    pill.id = PILL_ID;
    pill.title = 'Click to expand Batch Sender';
    pill.setAttribute('role', 'button');
    pill.setAttribute('tabindex', '0');

    const pillDot = document.createElement('div');
    pillDot.className = '__gm_pill_dot';

    const pillLabel = document.createElement('span');
    pillLabel.className = '__gm_pill_label';
    pillLabel.textContent = 'Batch';

    const pillStatus = document.createElement('span');
    pillStatus.id = PILL_STATUS_ID;
    pillStatus.textContent = 'Ready';

    pill.appendChild(pillDot);
    pill.appendChild(pillLabel);
    pill.appendChild(pillStatus);
    document.body.appendChild(pill);
  }

  /* ---------- Tab switching ---------- */
  function switchTab(mode) {
    activeMode = mode;
    const tabBatch   = document.getElementById(TAB_BATCH_ID);
    const tabPaired  = document.getElementById(TAB_PAIRED_ID);
    const viewBatch  = document.getElementById(VIEW_BATCH_ID);
    const viewPaired = document.getElementById(VIEW_PAIRED_ID);

    if (mode === 'batch') {
      tabBatch.classList.add('__gm_tab_active');
      tabPaired.classList.remove('__gm_tab_active');
      viewBatch.style.display  = 'block';
      viewPaired.style.display = 'none';
    } else {
      tabPaired.classList.add('__gm_tab_active');
      tabBatch.classList.remove('__gm_tab_active');
      viewBatch.style.display  = 'none';
      viewPaired.style.display = 'block';
    }
  }

  /* ---------- Parsers ---------- */
  function parseNumbers(raw) {
    const seen = new Set();
    return raw
      .split(/[\n,]+/)
      .map(s => digits(s.trim()))
      .filter(s => s.length >= 7)
      .filter(s => {
        if (seen.has(s)) return false;
        seen.add(s);
        return true;
      });
  }

  function parsePairs(raw) {
    raw = (raw || '').replace(/\r/g, '');
    const pairs = [];
    const lines  = raw.split('\n');
    let i = 0;

    const startsWithNumber = (line) => /^\s*"?\s*[\+\(\)\-\d][\d\s\-\+\(\)]{6,}/.test(line || '');

    while (i < lines.length) {
      let line = lines[i];
      if (!line || !line.replace(/["\s]/g, '')) { i++; continue; }
      if (!startsWithNumber(line)) {
        throw new Error(`Paired parse error at line ${i + 1}: line does not start with a phone number.`);
      }

      const tabIdx  = line.indexOf('\t');
      const pipeIdx = line.indexOf('|');
      let num = '';
      let msg = '';

      if (tabIdx !== -1) {
        const left = line.slice(0, tabIdx).trim();
        let right   = line.slice(tabIdx + 1);
        num = digits(left);

        const trimmedRight = right.trimStart();
        const startsQuoted = trimmedRight.startsWith('"');

        if (startsQuoted) {
          let field = trimmedRight;
          const isClosed = (s) => {
            let inQuotes = false;
            for (let k = 0; k < s.length; k++) {
              if (s[k] === '"') {
                const next = s[k + 1];
                if (inQuotes && next === '"') { k++; } else { inQuotes = !inQuotes; }
              }
            }
            return !inQuotes;
          };

          while (!isClosed(field)) {
            i++;
            if (i >= lines.length) break;
            field += '\n' + lines[i];
          }

          if (!isClosed(field)) {
            throw new Error(`Paired parse error: unterminated quoted message starting near line ${i + 1}.`);
          }
          field = field.trim();
          if (!(field.startsWith('"') && field.endsWith('"'))) {
            throw new Error(`Paired parse error near line ${i + 1}: quoted message not properly closed.`);
          }
          msg = field.slice(1, -1).replace(/""/g, '"');
        } else {
          msg = right.trim();
        }
      } else if (pipeIdx !== -1) {
        num = digits(line.slice(0, pipeIdx).trim());
        msg = line.slice(pipeIdx + 1).trim();
        if (msg.startsWith('"') && msg.endsWith('"')) msg = msg.slice(1, -1).replace(/""/g, '"');
      } else {
        throw new Error(`Paired parse error at line ${i + 1}: missing tab separator. Copy columns J+K together from Sheets.`);
      }

      if (num.length < 7) throw new Error(`Paired parse error near line ${i + 1}: invalid number.`);
      if (!msg)           throw new Error(`Paired parse error near line ${i + 1}: empty message for ${num}.`);

      pairs.push({ number: num, message: msg });
      i++;
    }

    const seen = new Set();
    for (const p of pairs) {
      if (seen.has(p.number)) throw new Error(`Paired parse error: duplicate number detected: ${p.number}`);
      seen.add(p.number);
    }

    return pairs;
  }

  /* ---------- Live preview ---------- */
  function updatePreview() {
    const previewEl = document.getElementById(PREVIEW_ID);
    const pairedBox = document.getElementById(PAIRED_ID);
    if (!previewEl || !pairedBox) return;
    while (previewEl.firstChild) previewEl.removeChild(previewEl.firstChild);

    let pairs = [];
    try { pairs = parsePairs(pairedBox.value); } catch (e) { /* surface on start */ }

    if (pairs.length === 0) {
      const empty = document.createElement('span');
      empty.style.color = T.textMuted;
      empty.textContent = 'No valid pairs detected yet…';
      previewEl.appendChild(empty);
      return;
    }

    const maxShow = 20;
    const hdr = document.createElement('div');
    Object.assign(hdr.style, { color: T.info, marginBottom: '4px', fontSize: '9px', fontWeight: '600' });
    hdr.textContent = `${pairs.length} pair${pairs.length !== 1 ? 's' : ''} found`;
    previewEl.appendChild(hdr);

    for (const p of pairs.slice(0, maxShow)) {
      const numDisplay = p.number.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
      const firstLine  = p.message.split('\n')[0];
      const msgShort   = firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine;

      const row = document.createElement('div');
      row.className = 'pair-row';

      const numSpan = document.createElement('span');
      numSpan.className   = 'pair-num';
      numSpan.textContent = numDisplay;

      const arrow = document.createElement('span');
      arrow.className   = 'pair-arrow';
      arrow.textContent = '→';

      const msgSpan = document.createElement('span');
      msgSpan.className   = 'pair-msg';
      msgSpan.textContent = msgShort;

      row.appendChild(numSpan);
      row.appendChild(arrow);
      row.appendChild(msgSpan);
      previewEl.appendChild(row);
    }

    if (pairs.length > maxShow) {
      const more = document.createElement('div');
      Object.assign(more.style, { color: T.textMuted, marginTop: '2px' });
      more.textContent = `…and ${pairs.length - maxShow} more`;
      previewEl.appendChild(more);
    }
  }

  /* ---------- Reset to main view ---------- */
  async function resetToMainView() {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (
        !composerIsVisible() &&
        !deepFind(el => el.tagName === 'INPUT' && el.offsetParent !== null &&
          el.closest('[data-e2e-new-conversation], [role="dialog"]'))
      ) {
        await sleep(50);
        return;
      }
      for (const target of [document.activeElement, document.body, document]) {
        if (!target) continue;
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true,
        }));
      }
      await sleep(80);

      const closeBtn = deepFind(el =>
        (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') &&
        (/back|close|cancel|dismiss/i.test(el.getAttribute('aria-label') || '') ||
         el.querySelector('[data-mat-icon-name="arrow_back"], [data-mat-icon-name="close"]'))
      );
      if (closeBtn) {
        strongClick(closeBtn);
        try {
          await waitFor(() => !composerIsVisible(), { timeout: 2000, interval: 30, label: 'close conversation' });
          return;
        } catch { }
      } else {
        await sleep(100);
      }
    }
    await sleep(100);
  }

  /* ---------- Clear and set the number input ---------- */
  async function clearAndSetInput(input, phone) {
    input.focus();
    setVal(input, '');
    input.select?.();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true }));
    setVal(input, '');
    setVal(input, phone);

    try {
      await waitFor(() =>
        deepFind(el =>
          (el.getAttribute('role') === 'listbox' || el.getAttribute('role') === 'option' ||
           el.classList.contains('autocomplete-list') || el.classList.contains('suggestion')) &&
          el.offsetParent !== null
        ), { timeout: 1000, interval: 30, label: 'contact suggestions' }
      );
    } catch { await sleep(50); }
  }

  async function selectContactWithRetry(input, phone, phoneDigits, tag) {
    const MAX_CONTACT_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_CONTACT_ATTEMPTS; attempt++) {
      setStatus(`${tag} Selecting contact (attempt ${attempt})…`);
      ['keydown', 'keypress', 'keyup'].forEach(type => {
        input.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
      });

      const candidatePred = (el) => {
        const txt      = (el.textContent || '').trim();
        const aria     = (el.getAttribute('aria-label') || '').trim();
        const combined = (txt + ' ' + aria).toLowerCase();
        const hasDigits     = digits(txt).includes(phoneDigits) || digits(aria).includes(phoneDigits);
        const looksLikeSendTo = /send to/i.test(combined);
        const isOption        = el.getAttribute('role') === 'option';
        const isButtonish     = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'LI' || el.tagName === 'DIV';
        return el.offsetParent !== null && isButtonish && (hasDigits || looksLikeSendTo || isOption);
      };

      let contact = null;
      try {
        contact = await waitFor(() => deepFind(candidatePred), { timeout: 1500, interval: 40, label: 'contact dropdown' });
      } catch { }

      if (contact) {
        strongClick(contact);
      } else {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }

      try {
        await waitFor(() => composerIsVisible(), { timeout: 3000, interval: 40, label: 'composer after contact select' });
        return true;
      } catch { }

      if (attempt < MAX_CONTACT_ATTEMPTS) {
        setStatus(`${tag} Conversation didn't open, retrying…`);
        await resetToMainView();
        const startBtn = findStartChatButton();
        if (startBtn) {
          strongClick(startBtn);
          try {
            input = await waitFor(() => findNumberInput(), { timeout: 3000, interval: 40, label: 'number input retry' });
          } catch { }
        }
        await clearAndSetInput(input, phone);
      }
    }
    throw new Error('Could not enter conversation after clicking contact');
  }

  /* ---------- Pre-extract message content once per batch (batch mode) ---------- */
  let _cachedText        = null;
  let _cachedImageBlobs  = null;

  function extractMessageContent() {
    const richBox = document.getElementById(MSG_ID);
    let text = '';
    const walker = document.createTreeWalker(
      richBox,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      { acceptNode: (node) => (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT }
    );
    let node; let lastWasBR = false;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const content = node.textContent;
        if (content) { text += content; lastWasBR = false; }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'BR') {
          if (!lastWasBR) { text += '\n'; lastWasBR = true; }
        } else if (node.tagName === 'DIV' || node.tagName === 'P') {
          if (text && !text.endsWith('\n')) { text += '\n'; }
          lastWasBR = false;
        }
      }
    }
    _cachedText = text.trim();
    const imgs = richBox.querySelectorAll('img');
    _cachedImageBlobs = null;
    return imgs.length > 0;
  }

  async function ensureImageBlobs() {
    if (_cachedImageBlobs !== null) return _cachedImageBlobs;
    const richBox  = document.getElementById(MSG_ID);
    const imgs     = richBox.querySelectorAll('img');
    const promises = Array.from(imgs).map(async (img) => {
      try { const res = await fetch(img.src); return await res.blob(); } catch { return null; }
    });
    _cachedImageBlobs = (await Promise.all(promises)).filter(Boolean);
    return _cachedImageBlobs;
  }

  async function transferContent(composer, textOverride = null) {
    composer.focus();
    const textToSend = textOverride !== null ? textOverride : _cachedText;
    if (textToSend) {
      composer.focus();
      composer.select?.();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      const inserted = document.execCommand('insertText', false, textToSend);
      if (!inserted || !composer.value) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(composer, textToSend);
        else composer.value = textToSend;
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleep(100);
    }
    if (textOverride === null) {
      const blobs = await ensureImageBlobs();
      if (blobs && blobs.length > 0) {
        const dt = new DataTransfer();
        for (const blob of blobs) { dt.items.add(new File([blob], 'image.png', { type: blob.type })); }
        const pasteEvent = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        composer.dispatchEvent(pasteEvent);
        try { await waitFor(() => hasAttachment(), { timeout: 3000, interval: 50, label: 'attachment after paste' }); } catch { }
      }
    }
  }

  async function waitForSendConfirmation({ outgoingCountBefore = 0 }) {
  const deadline = Date.now() + SEND_CONFIRM_TIMEOUTMS;

  // Step 1: wait for new outgoing bubble to appear
  let newestBubble = null;
  await waitFor(
    () => {
      if (stopRequested) throw new Error('Stopped');
      const bubbles = document.querySelectorAll('[data-e2e-message-outgoing]');
      if (bubbles.length <= outgoingCountBefore) return false;
      newestBubble = bubbles[bubbles.length - 1];
      return true;
    },
    { timeout: SEND_CONFIRM_TIMEOUTMS, interval: 80, label: 'new outgoing bubble' }
  );

  // Step 2: wait for aria-label on mws-text-message-part to confirm sent/delivered
  await waitFor(
    () => {
      if (stopRequested) throw new Error('Stopped');
      const part = newestBubble?.querySelector('mws-text-message-part');
      const label = part?.getAttribute('aria-label') || '';
      return /Sent on|Delivered/i.test(label);
    },
    { timeout: 30000, interval: 200, label: 'sent/delivered confirmation' }
  );

  return true;
}

  /* ---------- Main per-number flow ---------- */
  async function prepAndWaitSend(phone, index, total, textOverride = null) {
    const tag         = `[${index + 1}/${total}]`;
    const phoneDigits = digits(phone);
    _deepFindCache.delete('composer');
    _deepFindCache.delete('sendBtn');
    _deepFindCache.delete('startChat');

    await resetToMainView();

    setStatus(`${tag} Opening chat…`);
    const startBtn = await waitFor(() => findStartChatButton(), { timeout: 5000, interval: 50, label: 'start chat button' });
    strongClick(startBtn);

    setStatus(`${tag} Waiting for input…`);
    const input = await waitFor(() => findNumberInput(), { timeout: 3000, interval: 30, label: 'number input' });

    setStatus(`${tag} Entering number…`);
    await clearAndSetInput(input, phone);
    await selectContactWithRetry(input, phone, phoneDigits, tag);

    setStatus(`${tag} Finding composer…`);
    const composer = await waitFor(() => cachedDeepFind('composer', isComposerTextarea), { timeout: 3000, interval: 30, label: 'composer' });

    composer.focus();

    setStatus(`${tag} Pasting content…`);
    await transferContent(composer, textOverride);

    const sendBtn = await waitFor(() => cachedDeepFind('sendBtn', isSendButton), { timeout: 3000, interval: 30, label: 'send button' });
    sendBtn.style.outline       = `3px solid ${T.cyan}`;
    sendBtn.style.outlineOffset = '2px';
    sendBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });

    setStatus(`${tag} Click Send. Waiting for confirmation…`);

    const outgoingCountBefore = document.querySelectorAll('[data-e2e-message-outgoing]').length;

    setNextButtonEnabled(false);
    updatePillIndicator();

    const confirmed = await waitForSendConfirmation({ outgoingCountBefore });
    waitingForNext = false;
    sendBtn.style.outline       = '';
    sendBtn.style.outlineOffset = '';

    if (!confirmed) throw new Error('Send timed out — could not confirm send. Will retry.');
    await sleep(300);
    setStatus(`${tag} Confirmed sent, moving on…`);
  }

  async function attemptSendWithRetries({ number, message, index, total, modeLabel }) {
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_TRIES_PER_NUMBER; attempt++) {
      if (stopRequested) throw new Error('Stopped');
      try {
        setStatus(`[${index + 1}/${total}] ${modeLabel} attempt ${attempt}/${MAX_TRIES_PER_NUMBER}…`);
        await prepAndWaitSend(number, index, total, message);
        return { ok: true };
      } catch (e) {
        lastErr = e;
        console.error('[BatchSender] attempt failed', attempt, number, e);
        waitingForNext = false;
        setNextButtonEnabled(false);
        updatePillIndicator();
        await resetToMainView();
        await sleep(500);
      }
    }
    return { ok: false, error: lastErr?.message || 'Unknown error' };
  }

  async function retryFailuresPostRun(failed, runnerName) {
    if (!failed.length || stopRequested) return failed;
    let remaining = failed.slice();
    for (let pass = 1; pass <= MAX_POST_RUN_PASSES; pass++) {
      if (!remaining.length || stopRequested) break;
      setStatus(`${runnerName}: Retrying failures (pass ${pass}/${MAX_POST_RUN_PASSES})…`);

      const nextRemaining = [];
      for (let i = 0; i < remaining.length; i++) {
        if (stopRequested) break;
        const item = remaining[i];

        const sigText = item.message !== null ? item.message : item.capturedText;
        const sig = getSignature(item.number, sigText);
        if (sessionSentRegistry.has(sig)) continue;

        const result = await attemptSendWithRetries({
          number:    item.number,
          message:   item.message ?? null,
          index:     i,
          total:     remaining.length,
          modeLabel: 'Retry',
        });

        if (result.ok) {
          sessionSentRegistry.add(sig);
        } else {
          nextRemaining.push({ ...item, error: result.error });
        }
      }
      remaining = nextRemaining.slice();
    }
    return remaining;
  }

  /* ---------- Batch runner (same message) ---------- */
  async function runBatch(numbers) {
    stopRequested  = false;
    waitingForNext = false;
    toggleRunState(true);
    showFailuresInUI([]);

    const hasImages = extractMessageContent();
    if (hasImages) { setStatus('Pre-loading images…'); await ensureImageBlobs(); }

    const batchTextSnapshot = _cachedText;

    let successCount = 0; let failCount = 0; let skipCount = 0;
    const failed = [];

    for (let i = 0; i < numbers.length; i++) {
      if (stopRequested) { setStatus('Stopped.'); break; }
      const num    = numbers[i];
      const msgSig = getSignature(num, batchTextSnapshot);

      if (sessionSentRegistry.has(msgSig)) {
        skipCount++;
        setStatus(`[${i + 1}/${numbers.length}] Skipping ${num} (already sent this session).`);
        continue;
      }

      const result = await attemptSendWithRetries({
        number:    num,
        message:   null,
        index:     i,
        total:     numbers.length,
        modeLabel: 'Batch',
      });

      if (result.ok) {
        sessionSentRegistry.add(msgSig);
        successCount++;
      } else {
        failCount++;
        failed.push({ number: num, message: null, capturedText: batchTextSnapshot, error: result.error });
        setStatus(`Error on ${num}: ${result.error}`);
      }
    }

    if (!stopRequested && failed.length) {
      setStatus(`Initial run done. Retrying ${failed.length} failed…`);
      const remaining = await retryFailuresPostRun(failed, 'Batch');
      successCount += (failed.length - remaining.length);
      failCount     = remaining.length;
      if (remaining.length) showFailuresInUI(remaining);
    }

    const parts = [`${successCount} sent`, `${failCount} failed`];
    if (skipCount) parts.push(`${skipCount} skipped (duplicate)`);
    setStatus(`Done. ${parts.join(', ')}.`);
    toggleRunState(false);
  }

  /* ---------- Paired runner (unique message per number) ---------- */
  async function runPaired(pairs) {
    stopRequested  = false;
    waitingForNext = false;
    toggleRunState(true);
    showFailuresInUI([]);

    _cachedText = null; _cachedImageBlobs = [];
    let successCount = 0; let failCount = 0; let skipCount = 0;
    const failedPairs = [];

    for (let i = 0; i < pairs.length; i++) {
      if (stopRequested) { setStatus('Stopped.'); break; }
      const { number, message } = pairs[i];
      const nameMatch = message.match(/^Hey\s+(\w+)/i);
      const nameTag   = nameMatch ? nameMatch[1] : number;
      const msgSig    = getSignature(number, message);

      if (sessionSentRegistry.has(msgSig)) {
        skipCount++;
        setStatus(`[${i + 1}/${pairs.length}] Skipping ${nameTag} (already sent this session).`);
        continue;
      }

      const result = await attemptSendWithRetries({
        number,
        message,
        index:     i,
        total:     pairs.length,
        modeLabel: 'Paired',
      });

      if (result.ok) {
        sessionSentRegistry.add(msgSig);
        successCount++;
        setStatus(`[${i + 1}/${pairs.length}] ✓ Sent to ${nameTag}`);
      } else {
        failCount++;
        failedPairs.push({ index: i + 1, name: nameTag, number, message, capturedText: message, error: result.error });
        setStatus(`[${i + 1}/${pairs.length}] ✗ FAILED: ${nameTag} — ${result.error}`);
      }
    }

    if (!stopRequested && failedPairs.length) {
      setStatus(`Initial run done. Retrying ${failedPairs.length} failed…`);
      const remaining = await retryFailuresPostRun(
        failedPairs.map(f => ({ number: f.number, message: f.message, capturedText: f.capturedText, name: f.name, index: f.index, error: f.error })),
        'Paired'
      );
      successCount += (failedPairs.length - remaining.length);
      failCount     = remaining.length;
      if (remaining.length) showFailuresInUI(remaining);
    }

    const parts = [`${successCount} sent`, `${failCount} failed`];
    if (skipCount) parts.push(`${skipCount} skipped (duplicate)`);
    setStatus(`Done. ${parts.join(', ')}.`);
    toggleRunState(false);
  }

  /* ---------- Wire UI ---------- */
  function wireUI() {
    const startBtn  = document.getElementById(START_BTN_ID);
    const stopBtn   = document.getElementById(STOP_BTN_ID);
    const nextBtn   = document.getElementById(NEXT_BTN_ID);
    const numsBox   = document.getElementById(NUMS_ID);
    const msgBox    = document.getElementById(MSG_ID);
    const pairedBox = document.getElementById(PAIRED_ID);
    const tabBatch  = document.getElementById(TAB_BATCH_ID);
    const tabPaired = document.getElementById(TAB_PAIRED_ID);
    const minBtn    = document.getElementById(MIN_BTN_ID);
    const pill      = document.getElementById(PILL_ID);

    tabBatch.addEventListener('click',  () => switchTab('batch'));
    tabPaired.addEventListener('click', () => switchTab('paired'));

    minBtn.addEventListener('click', () => setMinimized(true));
    pill.addEventListener('click',   () => setMinimized(false));
    pill.addEventListener('keydown',  (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMinimized(false); }
    });

    startBtn.addEventListener('click', () => {
      if (isRunning) return;

      if (activeMode === 'batch') {
        const nums = parseNumbers(numsBox.value);
        if (!nums.length) return setStatus('Add at least one valid number (7+ digits).');
        if (!msgBox.innerText.trim() && !msgBox.querySelector('img')) return setStatus('Add content.');
        setStatus('Starting batch…');
        runBatch(nums);
      } else {
        let pairs;
        try {
          pairs = parsePairs(pairedBox.value);
        } catch (e) {
          return setStatus(`Parse error: ${e.message}`);
        }
        if (!pairs.length) return setStatus('No valid pairs found. Check your paste or format.');
        setStatus(`Starting paired send (${pairs.length} pairs)…`);
        runPaired(pairs);
      }
    });

    stopBtn.addEventListener('click', () => {
      if (!isRunning && !waitingForNext) return;
      stopRequested  = true;
      waitingForNext = false;
      setNextButtonEnabled(false);
      setStatus('Stop requested…');
      toggleRunState(false);
    });

    nextBtn.addEventListener('click', () => {
      if (nextBtn.disabled) return;
      if (!waitingForNext) return;
      waitingForNext = false;
      setNextButtonEnabled(false);
      updatePillIndicator();
      setStatus('Continuing…');
    });
  }

  function init() {
    addPanel();
    wireUI();
  }

  init();
})();
