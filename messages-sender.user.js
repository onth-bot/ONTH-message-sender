// ==UserScript==
// @name         Messages Sender
// @namespace    http://tampermonkey.net/
// @version      4.2
// @description  Batch-prep chats: handles numbers, text, and images. Premium gold-on-black UI. Prevents duplicate sends. Fully event-driven — zero wasted time.
// @author       You
// @match        https://messages.google.com/*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/onth-bot/ONTH-message-sender/main/messages-sender.user.js
// @updateURL    https://raw.githubusercontent.com/onth-bot/ONTH-message-sender/main/messages-sender.user.js
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

  let stopRequested  = false;
  let waitingForNext = false;

  const sentNumbers = new Set();

  const sleep   = (ms) => new Promise(r => setTimeout(r, ms));
  const digits  = (s) => (s || '').replace(/\D+/g, '');

  /* ---------- Theme tokens ---------- */
  const T = {
    pageBg:       '#0a0a0a',
    panelBg:      '#111214',
    cardBg:       '#18191d',
    border:       '#2a2c31',
    gold:         '#f5c518',
    goldDim:      'rgba(245,197,24,0.08)',
    goldBorder:   'rgba(245,197,24,0.22)',
    goldHover:    'rgba(245,197,24,0.15)',
    textPrimary:  '#f0efe8',
    textBody:     '#c8c8c8',
    textMuted:    '#78797f',
    danger:       '#f0a0a0',
    warning:      '#f5b880',
    success:      '#72dda0',
    info:         '#e0cc78',
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
    const nativeInputValueSetter    = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (el.tagName === 'TEXTAREA' && nativeTextAreaValueSetter) {
      nativeTextAreaValueSetter.call(el, val);
    } else if (el.tagName === 'INPUT' && nativeInputValueSetter) {
      nativeInputValueSetter.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const strongClick = (el) => {
    if (!el) return;
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.focus?.();
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(type =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, buttons: 1 }))
    );
  };

  function setStatus(txt) {
    const el = document.getElementById(STATUS_ID);
    if (el) el.textContent = txt;
    console.log('[BatchSender]', txt);
  }

  function composerIsVisible() {
    return !!cachedDeepFind('composer', isComposerTextarea);
  }

  function hasAttachment() {
    return !!document.querySelector('mw-attachment-view, [data-e2e-attached-media]');
  }

  /* ---------- Element finders ---------- */

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

  /* ---------- UI Panel ---------- */

  function addPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const style = document.createElement('style');
    style.textContent = `
      #${MSG_ID} img {
        max-height: 150px;
        max-width: 100%;
        height: auto;
        width: auto;
        display: block;
        margin: 4px 0;
        border-radius: 4px;
        border: 1px solid ${T.border};
      }
      #${START_BTN_ID}:hover {
        background: ${T.gold} !important;
        color: ${T.pageBg} !important;
        transform: translateY(-1px);
        box-shadow: 0 6px 24px rgba(245, 197, 24, 0.25);
      }
      #${STOP_BTN_ID}:hover {
        background: rgba(240, 160, 160, 0.1) !important;
        border-color: ${T.danger} !important;
        color: ${T.danger} !important;
        transform: translateY(-1px);
      }
      #${NEXT_BTN_ID}:hover {
        background: ${T.goldHover} !important;
        border-color: ${T.gold} !important;
        color: ${T.gold} !important;
        transform: translateY(-1px);
        box-shadow: 0 4px 16px rgba(245, 197, 24, 0.12);
      }
      #${START_BTN_ID}, #${STOP_BTN_ID}, #${NEXT_BTN_ID} {
        transition: all 0.2s ease;
      }
      /* Scrollbar styling */
      #${PANEL_ID} ::-webkit-scrollbar { width: 4px; }
      #${PANEL_ID} ::-webkit-scrollbar-track { background: transparent; }
      #${PANEL_ID} ::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 4px; }
      #${PANEL_ID} ::-webkit-scrollbar-thumb:hover { background: ${T.textMuted}; }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position:       'fixed',
      top:            '16px',
      right:          '16px',
      width:          '300px',
      padding:        '16px',
      background:     T.panelBg,
      color:          T.textPrimary,
      border:         `1px solid ${T.border}`,
      borderRadius:   '14px',
      boxShadow:      '0 24px 64px rgba(0,0,0,0.8), 0 0 0 1px rgba(245,197,24,0.06)',
      zIndex:         '2147483647',
      fontFamily:     '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      fontSize:       '13px',
      lineHeight:     '1.4',
    });

    const title = document.createElement('div');
    title.textContent = 'Batch Sender';
    Object.assign(title.style, {
      fontWeight:     '700',
      marginBottom:   '12px',
      fontSize:       '15px',
      color:          T.gold,
      letterSpacing:  '-0.01em',
    });

    const view = document.createElement('div');

    const numsLabel = document.createElement('div');
    numsLabel.textContent = 'Phone Numbers';
    Object.assign(numsLabel.style, {
      marginBottom:    '6px',
      fontSize:        '10px',
      fontWeight:      '600',
      color:           T.gold,
      textTransform:   'uppercase',
      letterSpacing:   '0.06em',
      opacity:         '0.85',
    });

    const inputStyles = {
      width:        '100%',
      background:   T.cardBg,
      color:        T.textPrimary,
      border:       `1px solid ${T.border}`,
      borderRadius: '8px',
      padding:      '10px',
      boxSizing:    'border-box',
      fontSize:     '12px',
      fontFamily:   'Monaco, "Courier New", monospace',
      transition:   'all 0.2s ease',
      outline:      'none',
    };

    const focusHandler = function () {
      this.style.border    = `1px solid ${T.goldBorder}`;
      this.style.boxShadow = `0 0 0 3px ${T.goldDim}`;
    };
    const blurHandler = function () {
      this.style.border    = `1px solid ${T.border}`;
      this.style.boxShadow = 'none';
    };

    const numsBox = document.createElement('textarea');
    numsBox.id = NUMS_ID;
    Object.assign(numsBox.style, { ...inputStyles, height: '70px', resize: 'vertical' });
    numsBox.placeholder = '5597409248\n5597409249\n...';
    numsBox.addEventListener('focus', focusHandler);
    numsBox.addEventListener('blur', blurHandler);

    const msgLabel = document.createElement('div');
    msgLabel.textContent = 'Message Content';
    Object.assign(msgLabel.style, {
      margin:         '12px 0 6px 0',
      fontSize:       '10px',
      fontWeight:     '600',
      color:          T.gold,
      textTransform:  'uppercase',
      letterSpacing:  '0.06em',
      opacity:        '0.85',
    });

    const msgBox = document.createElement('div');
    msgBox.id = MSG_ID;
    msgBox.contentEditable = 'true';
    Object.assign(msgBox.style, {
      width:         '100%',
      minHeight:     '55px',
      maxHeight:     '100px',
      overflowY:     'auto',
      background:    T.cardBg,
      color:         T.textPrimary,
      border:        `1px solid ${T.border}`,
      borderRadius:  '8px',
      padding:       '10px',
      boxSizing:     'border-box',
      outline:       'none',
      fontSize:      '12px',
      transition:    'all 0.2s ease',
      whiteSpace:    'pre-wrap',
      wordWrap:      'break-word',
    });
    msgBox.addEventListener('focus', focusHandler);
    msgBox.addEventListener('blur', blurHandler);

    view.appendChild(numsLabel);
    view.appendChild(numsBox);
    view.appendChild(msgLabel);
    view.appendChild(msgBox);

    /* ---- Buttons ---- */
    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, {
      display:   'flex',
      gap:       '8px',
      marginTop: '14px'
    });

    const startBtn       = document.createElement('button');
    startBtn.id          = START_BTN_ID;
    startBtn.type        = 'button';
    startBtn.textContent = 'Start Batch';
    Object.assign(startBtn.style, {
      flex:        '1',
      padding:     '10px 14px',
      background:  T.gold,
      color:       T.pageBg,
      border:      'none',
      borderRadius:'8px',
      cursor:      'pointer',
      fontWeight:  '700',
      fontSize:    '12px',
      letterSpacing: '0.02em',
      boxShadow:   '0 2px 12px rgba(245, 197, 24, 0.2)',
    });

    const stopBtn       = document.createElement('button');
    stopBtn.id          = STOP_BTN_ID;
    stopBtn.type        = 'button';
    stopBtn.textContent = 'Stop';
    Object.assign(stopBtn.style, {
      width:        '70px',
      padding:      '10px',
      background:   'transparent',
      color:        T.textMuted,
      border:       `1px solid ${T.border}`,
      borderRadius: '8px',
      cursor:       'pointer',
      fontWeight:   '600',
      fontSize:     '12px',
    });

    const nextBtn       = document.createElement('button');
    nextBtn.id          = NEXT_BTN_ID;
    nextBtn.type        = 'button';
    nextBtn.textContent = 'Continue';
    Object.assign(nextBtn.style, {
      marginTop:    '8px',
      width:        '100%',
      padding:      '10px',
      background:   T.goldDim,
      color:        T.gold,
      border:       `1px solid ${T.goldBorder}`,
      borderRadius: '8px',
      cursor:       'pointer',
      fontWeight:   '600',
      fontSize:     '12px',
      letterSpacing: '0.02em',
    });

    const status = document.createElement('div');
    status.id    = STATUS_ID;
    status.textContent = 'Ready';
    Object.assign(status.style, {
      marginTop:   '12px',
      color:       T.textMuted,
      minHeight:   '18px',
      fontSize:    '11px',
      padding:     '8px 10px',
      background:  T.pageBg,
      borderRadius:'8px',
      border:      `1px solid ${T.border}`,
      fontFamily:  'Monaco, "Courier New", monospace',
    });

    btnRow.appendChild(startBtn);
    btnRow.appendChild(stopBtn);

    panel.appendChild(title);
    panel.appendChild(view);
    panel.appendChild(btnRow);
    panel.appendChild(nextBtn);
    panel.appendChild(status);
    document.body.appendChild(panel);
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

  /* ---------- Reset to main view ---------- */
  async function resetToMainView() {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!composerIsVisible() && !deepFind(el =>
        el.tagName === 'INPUT' && el.offsetParent !== null &&
        el.closest('[data-e2e-new-conversation], [role="dialog"]')
      )) {
        await sleep(50);
        return;
      }

      for (const target of [document.activeElement, document.body, document]) {
        if (!target) continue;
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true
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
        } catch {
          // Try next attempt
        }
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
    input.dispatchEvent(new KeyboardEvent('keydown',  { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup',    { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true }));
    setVal(input, '');

    setVal(input, phone);

    try {
      await waitFor(() => {
        return deepFind(el =>
          (el.getAttribute('role') === 'listbox' ||
           el.getAttribute('role') === 'option' ||
           el.classList.contains('autocomplete-list') ||
           el.classList.contains('suggestion')) &&
          el.offsetParent !== null
        );
      }, { timeout: 1000, interval: 30, label: 'contact suggestions' });
    } catch {
      await sleep(50);
    }
  }

  async function selectContactWithRetry(input, phone, phoneDigits, tag) {
    const MAX_CONTACT_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_CONTACT_ATTEMPTS; attempt++) {
      setStatus(`${tag} Selecting contact (attempt ${attempt})…`);

      ['keydown','keypress','keyup'].forEach(type => {
        input.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
        }));
      });

      const candidatePred = (el) => {
        const txt   = (el.textContent || '').trim();
        const aria  = (el.getAttribute('aria-label') || '').trim();
        const combined  = (txt + ' ' + aria).toLowerCase();
        const hasDigits = digits(txt).includes(phoneDigits) || digits(aria).includes(phoneDigits);
        const looksLikeSendTo = /send to/i.test(combined);
        const isOption   = el.getAttribute('role') === 'option';
        const isButtonish = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'LI' || el.tagName === 'DIV';
        const visible    = el.offsetParent !== null;
        return visible && isButtonish && (hasDigits || looksLikeSendTo || isOption);
      };

      let contact = null;
      try {
        contact = await waitFor(() => deepFind(candidatePred), {
          timeout: 1500, interval: 40, label: 'contact dropdown'
        });
      } catch {
        // No dropdown item found
      }

      if (contact) {
        strongClick(contact);
      } else {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }

      try {
        await waitFor(() => composerIsVisible(), {
          timeout: 3000, interval: 40, label: 'composer after contact select'
        });
        return true;
      } catch {
        // Composer didn't appear
      }

      if (attempt < MAX_CONTACT_ATTEMPTS) {
        setStatus(`${tag} Conversation didn't open, retrying…`);
        await resetToMainView();

        const startBtn = findStartChatButton();
        if (startBtn) {
          strongClick(startBtn);
          try {
            const newInput = await waitFor(() => findNumberInput(), {
              timeout: 3000, interval: 40, label: 'number input retry'
            });
            input = newInput;
          } catch {
            // Fall through to next attempt with existing input
          }
        }
        await clearAndSetInput(input, phone);
      }
    }
    throw new Error('Could not enter conversation after clicking contact');
  }

  /* ---------- Pre-extract message content once per batch ---------- */
  let _cachedText = null;
  let _cachedImageBlobs = null;

  function extractMessageContent() {
    const richBox = document.getElementById(MSG_ID);

    let text = '';
    const walker = document.createTreeWalker(
      richBox,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let node;
    let lastWasBR = false;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const content = node.textContent;
        if (content) {
          text += content;
          lastWasBR = false;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'BR') {
          if (!lastWasBR) {
            text += '\n';
            lastWasBR = true;
          }
        } else if (node.tagName === 'DIV' || node.tagName === 'P') {
          if (text && !text.endsWith('\n')) {
            text += '\n';
          }
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
    const richBox = document.getElementById(MSG_ID);
    const imgs = richBox.querySelectorAll('img');
    _cachedImageBlobs = [];
    const promises = Array.from(imgs).map(async (img) => {
      try {
        const res  = await fetch(img.src);
        return await res.blob();
      } catch (e) {
        console.error('[BatchSender] Image prepare fail', e);
        return null;
      }
    });
    _cachedImageBlobs = (await Promise.all(promises)).filter(Boolean);
    return _cachedImageBlobs;
  }

  async function transferContent(composer) {
    composer.focus();

    const textToSend = _cachedText;

    if (textToSend) {
      composer.focus();
      composer.select?.();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);

      const inserted = document.execCommand('insertText', false, textToSend);

      if (!inserted) {
        setVal(composer, textToSend);
      }

      await sleep(100);
    }

    const blobs = await ensureImageBlobs();
    if (blobs && blobs.length > 0) {
      const dt = new DataTransfer();
      for (const blob of blobs) {
        const file = new File([blob], 'image.png', { type: blob.type });
        dt.items.add(file);
      }
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles:       true,
        cancelable:    true
      });
      composer.dispatchEvent(pasteEvent);

      try {
        await waitFor(() => hasAttachment(), {
          timeout: 3000, interval: 50, label: 'attachment after paste'
        });
      } catch {
        // continue anyway
      }
    }
  }

  /* ---------- Main per-number flow ---------- */

  async function prepAndWaitSend(phone, index, total) {
    const tag         = `[${index + 1}/${total}]`;
    const phoneDigits = digits(phone);

    _deepFindCache.delete('composer');
    _deepFindCache.delete('sendBtn');
    _deepFindCache.delete('startChat');
    await resetToMainView();

    setStatus(`${tag} Opening chat…`);
    const startBtn = await waitFor(() => findStartChatButton(), {
      timeout: 5000, interval: 50, label: 'start chat button'
    });
    strongClick(startBtn);

    setStatus(`${tag} Waiting for input…`);
    const input = await waitFor(() => findNumberInput(), {
      timeout: 3000, interval: 30, label: 'number input'
    });

    setStatus(`${tag} Entering number…`);
    await clearAndSetInput(input, phone);

    await selectContactWithRetry(input, phone, phoneDigits, tag);

    setStatus(`${tag} Finding composer…`);
    const composer = await waitFor(() => cachedDeepFind('composer', isComposerTextarea), {
      timeout: 3000, interval: 30, label: 'composer'
    });

    setVal(composer, '');
    composer.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    setStatus(`${tag} Pasting content…`);
    await transferContent(composer);

    const sendBtn = await waitFor(() => cachedDeepFind('sendBtn', isSendButton), {
      timeout: 3000, interval: 30, label: 'send button'
    });

    sendBtn.style.outline       = `3px solid ${T.gold}`;
    sendBtn.style.outlineOffset = '2px';
    sendBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });

    setStatus(`${tag} Click Send. Waiting…`);
    waitingForNext = true;

    const sendDeadline = Date.now() + 300000;
    let messageSent = false;

    await sleep(150);

    while (waitingForNext && Date.now() < sendDeadline) {
      const currentSendBtn = cachedDeepFind('sendBtn', isSendButton);
      if (!currentSendBtn || currentSendBtn.disabled) {
        messageSent = true;
        break;
      }
      await sleep(80);
      if (stopRequested) throw new Error('Stopped');
    }

    waitingForNext = false;

    sendBtn.style.outline       = '';
    sendBtn.style.outlineOffset = '';

    if (!messageSent) {
      throw new Error('Send timed out — message was NOT sent. Retry this one.');
    }

    try {
      await waitFor(() => {
        const composerEmpty = !(composer.value || '').trim();
        const noAttachment  = !hasAttachment();
        return composerEmpty && noAttachment;
      }, { timeout: 3000, interval: 40, label: 'message flush' });
    } catch {
      // proceed anyway
    }

    await sleep(300);

    setStatus(`${tag} Done, moving on…`);
  }

  /* ---------- Batch runner (same message) ---------- */

  async function runBatch(numbers) {
    stopRequested  = false;
    waitingForNext = false;

    const hasImages = extractMessageContent();
    if (hasImages) {
      setStatus('Pre-loading images…');
      await ensureImageBlobs();
    }

    let successCount = 0;
    let failCount    = 0;
    let skipCount    = 0;

    for (let i = 0; i < numbers.length; i++) {
      if (stopRequested) { setStatus('Stopped.'); break; }

      const num = numbers[i];

      if (sentNumbers.has(num)) {
        skipCount++;
        setStatus(`[${i + 1}/${numbers.length}] Skipping ${num} (already sent).`);
        continue;
      }

      try {
        await prepAndWaitSend(num, i, numbers.length);
        sentNumbers.add(num);
        successCount++;
      } catch (e) {
        console.error(e);
        failCount++;
        setStatus(`Error on ${num}: ${e.message}`);
        waitingForNext = false;
        await resetToMainView();
        await sleep(300);
      }
    }
    const parts = [`${successCount} sent`, `${failCount} failed`];
    if (skipCount) parts.push(`${skipCount} skipped (duplicate)`);
    setStatus(`Done. ${parts.join(', ')}.`);
  }

  /* ---------- Wire UI ---------- */

  function wireUI() {
    const startBtn  = document.getElementById(START_BTN_ID);
    const stopBtn   = document.getElementById(STOP_BTN_ID);
    const nextBtn   = document.getElementById(NEXT_BTN_ID);
    const numsBox   = document.getElementById(NUMS_ID);
    const msgBox    = document.getElementById(MSG_ID);

    startBtn.addEventListener('click', () => {
      const nums = parseNumbers(numsBox.value);
      if (!nums.length) return setStatus('Add at least one valid number (7+ digits).');
      if (!msgBox.innerText.trim() && !msgBox.querySelector('img')) return setStatus('Add content.');
      setStatus('Starting batch…');
      runBatch(nums);
    });

    stopBtn.addEventListener('click', () => {
      stopRequested  = true;
      waitingForNext = false;
      setStatus('Stop requested…');
    });

    nextBtn.addEventListener('click', () => {
      waitingForNext = false;
      setStatus('Continuing…');
    });
  }

  function init() {
    addPanel();
    wireUI();
  }

  init();
})();
