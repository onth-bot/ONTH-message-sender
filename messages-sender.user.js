// ==UserScript==
// @name         Messages Sender
// @namespace    http://tampermonkey.net/
// @version      6.2
// @description  Batch-prep chats. v6.2: persistent 24hr no-double-send registry + onth-bot shared UI.
// @author       You
// @match        https://messages.google.com/*
// @require      https://cdn.jsdelivr.net/gh/onth-bot/dsp-shared-ui@main/dsp-ui-core.js
// @downloadURL  https://raw.githubusercontent.com/onth-bot/ONTH-message-sender/main/messages-sender.user.js
// @updateURL    https://raw.githubusercontent.com/onth-bot/ONTH-message-sender/main/messages-sender.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self) return;

  const T = (window.DSP_UI && window.DSP_UI.theme) ? window.DSP_UI.theme : {
    accent: '#00d4ff', accent2: '#40e4ff', accentDim: '#006e85',
    bg: '#070a0f', card: '#101722', text: '#e8edf5', textMuted: '#8b98aa',
    border: '#243044', success: '#22d98a', warning: '#ffb020', danger: '#ff4d6a',
    fontBody: "'DM Sans', sans-serif", fontDisplay: "'Bebas Neue', Impact, sans-serif",
    fontMono: "'DM Mono', monospace",
  };

  const C = {
    pageBg: T.bg, panelBg: T.card, cardBg: T.card, border: T.border,
    cyan: T.accent, cyanDim: T.accentDim, cyanBorder: 'rgba(0,212,255,.25)',
    cyanHover: 'rgba(0,212,255,.10)', textPrimary: T.text, textBody: T.text,
    textMuted: T.textMuted, danger: T.danger, dangerBg: 'rgba(255,77,106,.10)',
    warning: T.warning, success: T.success, info: T.accent2,
  };

  const PANEL_ID       = '__gm_batch_panel';
  const START_BTN_ID   = '__gm_batch_start';
  const STOP_BTN_ID    = '__gm_batch_stop';
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

  const SENT_KEY = '__gm_batch_sent_registry_v2';
  const DEDUPE_HOURS = 24;
  const MAX_SENT_KEYS = 2000;

  let stopRequested = false;
  let isRunning = false;
  let activeMode = 'batch';
  let isMinimized = false;

  const sleep  = ms => new Promise(r => setTimeout(r, ms));
  const digits = s  => (s || '').replace(/\D+/g, '');

  function normalizeMsg(msg) {
    return String(msg || '').trim().replace(/\s+/g, ' ');
  }

  function getSignature(num, msg) {
    return `${digits(num)}|${normalizeMsg(msg)}`;
  }

  function loadSentRegistry() {
    try {
      const raw = JSON.parse(localStorage.getItem(SENT_KEY) || '{}');
      const now = Date.now();
      const maxAge = DEDUPE_HOURS * 60 * 60 * 1000;
      const clean = {};

      Object.entries(raw).forEach(([sig, ts]) => {
        if (typeof ts === 'number' && now - ts <= maxAge) clean[sig] = ts;
      });

      localStorage.setItem(SENT_KEY, JSON.stringify(clean));
      return clean;
    } catch {
      return {};
    }
  }

  let sentRegistry = loadSentRegistry();

  function saveSentRegistry() {
    const entries = Object.entries(sentRegistry)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SENT_KEYS);

    sentRegistry = Object.fromEntries(entries);
    localStorage.setItem(SENT_KEY, JSON.stringify(sentRegistry));
  }

  function wasSent(num, msg) {
    const sig = getSignature(num, msg);
    const ts = sentRegistry[sig];
    if (!ts) return false;

    const maxAge = DEDUPE_HOURS * 60 * 60 * 1000;
    if (Date.now() - ts > maxAge) {
      delete sentRegistry[sig];
      saveSentRegistry();
      return false;
    }

    return true;
  }

  function markSent(num, msg) {
    sentRegistry[getSignature(num, msg)] = Date.now();
    saveSentRegistry();
  }

  window.GM_BATCH_SENDER = {
    clearSentMemory() {
      sentRegistry = {};
      localStorage.removeItem(SENT_KEY);
      console.log('✅ GM Batch Sender sent-memory cleared.');
    },
    sentMemoryCount() {
      return Object.keys(sentRegistry).length;
    }
  };

  // Modified to wait indefinitely instead of timing out
  async function waitFor(fn, { timeout = 8000, interval = 50, label = '' } = {}) {
    while (true) {
      if (stopRequested) throw new Error('Stopped');
      const r = fn();
      if (r) return r;
      await sleep(interval);
    }
  }

  const onNewPage = () => location.pathname.endsWith('/new');
  const inConv    = () => location.pathname.includes('/conversations/') && !location.pathname.endsWith('/new');
  const getContactInput = () => document.querySelector('[data-e2e-contact-input]');
  const getSendToBtn    = () => document.querySelector('[data-e2e-send-to-button]');
  const getComposer     = () => {
    const el = document.querySelector('[data-e2e-message-input-box]');
    return (el && inConv()) ? el : null;
  };
  const getSendBtnInConv = () => {
    const el = document.querySelector('[data-e2e-send-text-button]');
    return (el && inConv()) ? el : null;
  };

  async function goToNewChat() {
    if (onNewPage()) return;
    const btn = document.querySelector('[data-e2e-start-button]');
    if (!btn) throw new Error('Start button not found');
    btn.click();
    await waitFor(onNewPage, { timeout: 8000, interval: 80, label: 'navigate to /new' });
    await sleep(300);
  }

  const setVal = (el, val) => {
    if (!el) return;
    const ns = el.tagName === 'TEXTAREA'
      ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

    if (ns) ns.call(el, val);
    else el.value = val;

    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  function setStatus(txt) {
    const el = document.getElementById(STATUS_ID);
    if (el) el.textContent = txt;

    const pill = document.getElementById(PILL_STATUS_ID);
    if (pill) pill.textContent = txt;

    console.log('[BatchSender]', txt);
  }

  function showFailuresInUI(items) {
    const box = document.getElementById(FAILURES_ID);
    if (!box) return;

    if (!items?.length) {
      box.style.display = 'none';
      box.textContent = '';
      return;
    }

    box.style.display = 'block';
    box.textContent = '';

    const hdr = document.createElement('div');
    Object.assign(hdr.style, {
      color: C.danger,
      fontFamily: T.fontMono,
      marginBottom: '6px',
      fontSize: '10px',
      textTransform: 'uppercase'
    });
    hdr.textContent = `⚠ ${items.length} FAILED — copy numbers below:`;

    const list = document.createElement('div');
    Object.assign(list.style, {
      fontFamily: T.fontMono,
      fontSize: '10px',
      color: C.textBody,
      lineHeight: '1.7',
      userSelect: 'all'
    });
    list.textContent = items.map(f => f.number).join('\n');

    box.appendChild(hdr);
    box.appendChild(list);
  }

  function toggleRunState(running) {
    isRunning = running;
    const btn = document.getElementById(START_BTN_ID);

    if (btn) {
      btn.disabled = running;
      btn.style.opacity = running ? '0.5' : '1';
      btn.style.cursor = running ? 'not-allowed' : 'pointer';
      btn.textContent = running ? 'Running…' : 'Start Batch';
    }

    updatePillIndicator();
  }

  function updatePillIndicator() {
    const pill = document.getElementById(PILL_ID);
    if (!pill) return;

    const dot = pill.querySelector('.__gm_pill_dot');
    if (!dot) return;

    dot.style.background = isRunning ? C.cyan : C.textMuted;
    dot.style.animation = isRunning ? '__gm_pulse 1.2s infinite' : 'none';
  }

  function setMinimized(v) {
    isMinimized = v;
    const panel = document.getElementById(PANEL_ID);
    const pill = document.getElementById(PILL_ID);

    if (!panel || !pill) return;

    panel.style.display = v ? 'none' : 'block';
    pill.style.display = v ? 'flex' : 'none';

    if (v) updatePillIndicator();
  }

  let _cachedText = null;
  let _cachedImageBlobs = null;

  function extractMessageContent() {
    const box = document.getElementById(MSG_ID);
    if (!box) return false;

    let text = '';
    const walker = document.createTreeWalker(
      box,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: n =>
          n.nodeType === Node.ELEMENT_NODE && n.tagName === 'IMG'
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT
      }
    );

    let node;
    let lastBR = false;

    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent) {
          text += node.textContent;
          lastBR = false;
        }
      } else if (node.tagName === 'BR') {
        if (!lastBR) {
          text += '\n';
          lastBR = true;
        }
      } else if (node.tagName === 'DIV' || node.tagName === 'P') {
        if (text && !text.endsWith('\n')) text += '\n';
        lastBR = false;
      }
    }

    _cachedText = text.trim();
    _cachedImageBlobs = null;

    return box.querySelectorAll('img').length > 0;
  }

  async function ensureImageBlobs() {
    if (_cachedImageBlobs !== null) return _cachedImageBlobs;

    const imgs = document.getElementById(MSG_ID)?.querySelectorAll('img') || [];
    const blobs = await Promise.all([...imgs].map(async img => {
      try {
        return await (await fetch(img.src)).blob();
      } catch {
        return null;
      }
    }));

    _cachedImageBlobs = blobs.filter(Boolean);
    return _cachedImageBlobs;
  }

  async function transferContent(composer, textOverride = null) {
    composer.focus();

    const text = textOverride !== null ? textOverride : _cachedText;

    if (text) {
      setVal(composer, text);
      await sleep(150);
    }

    if (textOverride === null) {
      const blobs = await ensureImageBlobs();

      if (blobs?.length) {
        const dt = new DataTransfer();
        for (const blob of blobs) {
          dt.items.add(new File([blob], 'image.png', { type: blob.type }));
        }

        composer.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true
        }));

        await sleep(500);
      }
    }
  }

  async function prepAndWaitSend(number, index, total, textOverride = null) {
    const tag = `[${index + 1}/${total}]`;

    setStatus(`${tag} Opening new chat…`);
    await goToNewChat();

    setStatus(`${tag} Waiting for contact input…`);
    await waitFor(() => {
      const el = getContactInput();
      return (el && el.value === '') ? el : null;
    }, { timeout: 6000, interval: 80, label: 'contact input' });

    await sleep(100);

    setStatus(`${tag} Entering number…`);
    const input = getContactInput();

    const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeInputSetter) nativeInputSetter.call(input, number);
    else input.value = number;

    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);

    setStatus(`${tag} Waiting for Send To button…`);
    await waitFor(() => getSendToBtn() || inConv(), {
      timeout: 8000,
      interval: 80,
      label: 'send-to or auto-nav'
    });

    if (!inConv()) {
      getSendToBtn().click();

      setStatus(`${tag} Waiting for conversation…`);
      await waitFor(inConv, {
        timeout: 8000,
        interval: 80,
        label: 'conversation URL'
      });
    }

    await sleep(500);

    setStatus(`${tag} Waiting for composer…`);
    const composer = await waitFor(getComposer, {
      timeout: 6000,
      interval: 80,
      label: 'composer'
    });

    await sleep(200);

    setStatus(`${tag} Injecting message…`);
    await transferContent(composer, textOverride);

    setStatus(`${tag} Finding send button…`);
    const sendBtn = await waitFor(getSendBtnInConv, {
      timeout: 10000,
      interval: 100,
      label: 'send button'
    });

    sendBtn.style.outline = `3px solid ${C.cyan}`;
    sendBtn.style.outlineOffset = '2px';
    sendBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });

    setStatus(`${tag} ✋ Click Send when ready…`);

    let messageSent = false;

    await sleep(150);

    // Modified to wait indefinitely for the message to send
    while (true) {
      if (stopRequested) throw new Error('Stopped');

      const currentBtn = document.querySelector('[data-e2e-send-text-button]');
      if (!currentBtn || currentBtn.disabled) {
        messageSent = true;
        break;
      }

      await sleep(80);
    }

    sendBtn.style.outline = '';
    sendBtn.style.outlineOffset = '';

    setStatus(`${tag} ✓ Sent`);
    await sleep(300);
  }

  async function attemptWithRetries({ number, message, index, total, modeLabel }) {
    let lastErr;

    for (let attempt = 1; attempt <= 2; attempt++) {
      if (stopRequested) throw new Error('Stopped');

      try {
        setStatus(`[${index + 1}/${total}] ${modeLabel} attempt ${attempt}/2…`);
        await prepAndWaitSend(number, index, total, message);
        return { ok: true };
      } catch (e) {
        lastErr = e;

        if (e.message === 'Stopped') throw e;

        console.error('[BatchSender] attempt failed', attempt, number, e.message);
        await sleep(600);
      }
    }

    return { ok: false, error: lastErr?.message || 'Unknown' };
  }

  async function retryFailures(failed, label) {
    if (!failed.length || stopRequested) return failed;

    setStatus(`${label}: Retry pass…`);

    const next = [];

    for (let i = 0; i < failed.length; i++) {
      if (stopRequested) break;

      const item = failed[i];
      const msg = item.message ?? item.capturedText ?? '';

      if (wasSent(item.number, msg)) continue;

      const r = await attemptWithRetries({
        number: item.number,
        message: item.message ?? null,
        index: i,
        total: failed.length,
        modeLabel: 'Retry'
      });

      if (r.ok) markSent(item.number, msg);
      else next.push({ ...item, error: r.error });
    }

    return next;
  }

  async function runBatch(numbers) {
    stopRequested = false;
    toggleRunState(true);
    showFailuresInUI([]);

    const hasImages = extractMessageContent();

    if (hasImages) {
      setStatus('Pre-loading images…');
      await ensureImageBlobs();
    }

    const textSnapshot = _cachedText || '';

    let ok = 0;
    let fail = 0;
    let skip = 0;

    const failed = [];

    for (let i = 0; i < numbers.length; i++) {
      if (stopRequested) {
        setStatus('Stopped.');
        break;
      }

      const num = numbers[i];

      if (wasSent(num, textSnapshot)) {
        skip++;
        setStatus(`[${i + 1}/${numbers.length}] Skipping duplicate ${num}.`);
        continue;
      }

      const r = await attemptWithRetries({
        number: num,
        message: null,
        index: i,
        total: numbers.length,
        modeLabel: 'Batch'
      });

      if (r.ok) {
        markSent(num, textSnapshot);
        ok++;
      } else {
        fail++;
        failed.push({
          number: num,
          message: null,
          capturedText: textSnapshot,
          error: r.error
        });
      }
    }

    if (!stopRequested && failed.length) {
      const remaining = await retryFailures(failed, 'Batch');
      ok += failed.length - remaining.length;
      fail = remaining.length;

      if (remaining.length) showFailuresInUI(remaining);
    }

    const parts = [`${ok} sent`, `${fail} failed`];
    if (skip) parts.push(`${skip} skipped duplicate`);

    setStatus(`Done. ${parts.join(', ')}.`);
    toggleRunState(false);
  }

  async function runPaired(pairs) {
    stopRequested = false;
    toggleRunState(true);
    showFailuresInUI([]);

    _cachedText = null;
    _cachedImageBlobs = [];

    let ok = 0;
    let fail = 0;
    let skip = 0;

    const failed = [];

    for (let i = 0; i < pairs.length; i++) {
      if (stopRequested) {
        setStatus('Stopped.');
        break;
      }

      const { number, message } = pairs[i];
      const nameMatch = message.match(/^Hey\s+(\w+)/i);
      const nameTag = nameMatch ? nameMatch[1] : number;

      if (wasSent(number, message)) {
        skip++;
        setStatus(`[${i + 1}/${pairs.length}] Skipping duplicate ${nameTag}.`);
        continue;
      }

      const r = await attemptWithRetries({
        number,
        message,
        index: i,
        total: pairs.length,
        modeLabel: 'Paired'
      });

      if (r.ok) {
        markSent(number, message);
        ok++;
        setStatus(`[${i + 1}/${pairs.length}] ✓ ${nameTag}`);
      } else {
        fail++;
        failed.push({
          number,
          message,
          capturedText: message,
          name: nameTag,
          error: r.error
        });
      }
    }

    if (!stopRequested && failed.length) {
      const remaining = await retryFailures(failed, 'Paired');
      ok += failed.length - remaining.length;
      fail = remaining.length;

      if (remaining.length) showFailuresInUI(remaining);
    }

    const parts = [`${ok} sent`, `${fail} failed`];
    if (skip) parts.push(`${skip} skipped duplicate`);

    setStatus(`Done. ${parts.join(', ')}.`);
    toggleRunState(false);
  }

  function parseNumbers(raw) {
    const seen = new Set();

    return raw.split(/[\n,]+/)
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
    const lines = raw.split('\n');
    let i = 0;

    const startsWithNumber = l =>
      /^\s*"?\s*[\+\(\)\-\d][\d\s\-\+\(\)]{6,}/.test(l || '');

    while (i < lines.length) {
      const line = lines[i];

      if (!line?.replace(/["\s]/g, '')) {
        i++;
        continue;
      }

      if (!startsWithNumber(line)) {
        throw new Error(`Line ${i + 1} doesn't start with a phone number.`);
      }

      const tabIdx = line.indexOf('\t');
      const pipeIdx = line.indexOf('|');

      let num = '';
      let msg = '';

      if (tabIdx !== -1) {
        num = digits(line.slice(0, tabIdx).trim());

        let right = line.slice(tabIdx + 1);
        const trimmed = right.trimStart();

        if (trimmed.startsWith('"')) {
          let field = trimmed;

          const isClosed = s => {
            let q = false;

            for (let k = 0; k < s.length; k++) {
              if (s[k] === '"') {
                const n = s[k + 1];
                if (q && n === '"') k++;
                else q = !q;
              }
            }

            return !q;
          };

          while (!isClosed(field)) {
            i++;
            if (i >= lines.length) break;
            field += '\n' + lines[i];
          }

          msg = field.trim().slice(1, -1).replace(/""/g, '"');
        } else {
          msg = right.trim();
        }
      } else if (pipeIdx !== -1) {
        num = digits(line.slice(0, pipeIdx).trim());
        msg = line.slice(pipeIdx + 1).trim();

        if (msg.startsWith('"') && msg.endsWith('"')) {
          msg = msg.slice(1, -1).replace(/""/g, '"');
        }
      } else {
        throw new Error(`Line ${i + 1}: missing tab separator.`);
      }

      if (num.length < 7) throw new Error(`Line ${i + 1}: invalid number.`);
      if (!msg) throw new Error(`Line ${i + 1}: empty message.`);

      pairs.push({ number: num, message: msg });
      i++;
    }

    const seen = new Set();

    for (const p of pairs) {
      if (seen.has(p.number)) throw new Error(`Duplicate: ${p.number}`);
      seen.add(p.number);
    }

    return pairs;
  }

  function addPanel() {
    if (document.getElementById(PANEL_ID)) return;

    if (window.DSP_UI) DSP_UI.injectTheme();

    const style = document.createElement('style');
    style.textContent = `
      @keyframes __gm_pulse{0%,100%{opacity:1}50%{opacity:.4}}
      #${MSG_ID} img{max-height:150px;max-width:100%;display:block;margin:4px 0;border-radius:4px;border:1px solid ${C.border};}
      #${START_BTN_ID}:hover:not(:disabled){background:${C.cyan}!important;color:${C.pageBg}!important;transform:translateY(-1px);}
      #${STOP_BTN_ID}:hover{background:${C.dangerBg}!important;border-color:${C.danger}!important;color:${C.danger}!important;}
      #${START_BTN_ID},#${STOP_BTN_ID}{transition:all .2s ease;}
      #${MIN_BTN_ID}{background:transparent;border:1px solid ${C.border};color:${C.textMuted};width:24px;height:24px;border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;font-size:14px;line-height:1;transition:all .15s ease;}
      #${MIN_BTN_ID}:hover{border-color:${C.cyanBorder};color:${C.cyan};background:${C.cyanHover};}
      #${PILL_ID}{position:fixed;top:16px;right:16px;z-index:2147483647;display:none;align-items:center;gap:8px;padding:8px 12px;background:${C.panelBg};border:1px solid ${C.border};border-radius:6px;cursor:pointer;font-family:${T.fontBody};font-size:11px;color:${C.textBody};box-shadow:0 8px 24px rgba(8,10,13,.9);transition:all .2s;}
      #${PILL_ID}:hover{border-color:${C.cyanBorder};transform:translateY(-1px);}
      #${PILL_ID} .__gm_pill_dot{width:8px;height:8px;border-radius:50%;background:${C.textMuted};flex-shrink:0;transition:all .2s;}
      #${PILL_ID} .__gm_pill_label{color:${C.cyan};font-weight:700;letter-spacing:.04em;text-transform:uppercase;font-size:10px;font-family:${T.fontMono};flex-shrink:0;}
      #${PILL_STATUS_ID}{color:${C.textMuted};font-family:${T.fontMono};font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;}
      .__gm_tab{flex:1;padding:9px 0;background:transparent;color:${C.textMuted};border:none;border-bottom:2px solid transparent;cursor:pointer;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.08em;transition:all .2s;font-family:${T.fontMono};}
      .__gm_tab:hover{color:${C.textBody};}
      .__gm_tab.__gm_tab_active{color:${C.cyan};border-bottom-color:${C.cyan};}
      #${PREVIEW_ID}{margin-top:8px;max-height:80px;overflow-y:auto;font-size:10px;font-family:${T.fontMono};color:${C.textMuted};padding:8px 10px;background:${C.pageBg};border-radius:4px;border:1px solid ${C.border};line-height:1.5;}
      #${PREVIEW_ID} .pair-row{display:flex;gap:6px;padding:2px 0;}
      #${PREVIEW_ID} .pair-num{color:${C.textBody};flex-shrink:0;min-width:75px;}
      #${PREVIEW_ID} .pair-arrow{color:${C.cyan};flex-shrink:0;}
      #${PREVIEW_ID} .pair-msg{color:${C.textMuted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      #${FAILURES_ID}{display:none;margin-top:10px;padding:10px;background:${C.dangerBg};border:1px solid rgba(255,77,106,.3);border-radius:4px;max-height:120px;overflow-y:auto;}
      #${PANEL_ID} ::-webkit-scrollbar{width:4px;}
      #${PANEL_ID} ::-webkit-scrollbar-thumb{background:${C.border};border-radius:4px;}
      .__gm_input:focus{border-color:${C.cyan}!important;box-shadow:0 0 0 3px ${C.cyanBorder}!important;outline:none;}
      .__gm_header::after{content:'';position:absolute;bottom:0;left:0;width:100%;height:2px;background:linear-gradient(90deg,transparent,${C.cyan},transparent);}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed',
      top: '16px',
      right: '16px',
      width: '260px',
      padding: '12px',
      background: C.panelBg,
      color: C.textPrimary,
      border: `1px solid ${C.border}`,
      borderRadius: '6px',
      boxShadow: '0 20px 50px rgba(8,10,13,.9)',
      zIndex: '2147483647',
      fontFamily: T.fontBody,
      fontSize: '12px',
      lineHeight: '1.4'
    });

    const header = document.createElement('div');
    header.className = '__gm_header';
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingBottom: '12px',
      marginBottom: '12px',
      position: 'relative'
    });

    const title = document.createElement('div');
    title.textContent = 'Batch Sender';
    Object.assign(title.style, {
      fontFamily: T.fontDisplay,
      fontSize: '18px',
      color: C.cyan,
      letterSpacing: '1px'
    });

    const minBtn = document.createElement('button');
    minBtn.id = MIN_BTN_ID;
    minBtn.type = 'button';
    minBtn.title = 'Minimize';
    minBtn.textContent = '–';

    header.appendChild(title);
    header.appendChild(minBtn);

    const body = document.createElement('div');

    const tabRow = document.createElement('div');
    Object.assign(tabRow.style, {
      display: 'flex',
      marginBottom: '14px',
      borderBottom: `1px solid ${C.border}`
    });

    const tabBatch = document.createElement('button');
    tabBatch.id = TAB_BATCH_ID;
    tabBatch.className = '__gm_tab __gm_tab_active';
    tabBatch.textContent = 'Same Message';
    tabBatch.type = 'button';

    const tabPaired = document.createElement('button');
    tabPaired.id = TAB_PAIRED_ID;
    tabPaired.className = '__gm_tab';
    tabPaired.textContent = 'Paired';
    tabPaired.type = 'button';

    tabRow.appendChild(tabBatch);
    tabRow.appendChild(tabPaired);

    const inputBase = {
      width: '100%',
      background: C.cardBg,
      color: C.textPrimary,
      border: `1px solid ${C.border}`,
      borderRadius: '4px',
      padding: '8px',
      boxSizing: 'border-box',
      fontSize: '10px',
      fontFamily: T.fontMono,
      outline: 'none',
      transition: 'all .2s ease'
    };

    const labelBase = {
      marginBottom: '6px',
      fontSize: '10px',
      fontFamily: T.fontMono,
      color: C.cyan,
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      opacity: '0.85',
      display: 'block'
    };

    const viewBatch = document.createElement('div');
    viewBatch.id = VIEW_BATCH_ID;

    const numsLabel = document.createElement('div');
    numsLabel.textContent = 'Phone Numbers';
    Object.assign(numsLabel.style, labelBase);

    const numsBox = document.createElement('textarea');
    numsBox.id = NUMS_ID;
    numsBox.className = '__gm_input';
    numsBox.placeholder = '5597409248\n5597409249\n...';
    Object.assign(numsBox.style, {
      ...inputBase,
      height: '55px',
      resize: 'vertical'
    });

    const msgLabel = document.createElement('div');
    msgLabel.textContent = 'Message Content';
    Object.assign(msgLabel.style, {
      ...labelBase,
      marginTop: '12px'
    });

    const msgBox = document.createElement('div');
    msgBox.id = MSG_ID;
    msgBox.contentEditable = 'true';
    msgBox.className = '__gm_input';
    Object.assign(msgBox.style, {
      ...inputBase,
      minHeight: '45px',
      maxHeight: '80px',
      overflowY: 'auto',
      whiteSpace: 'pre-wrap',
      wordWrap: 'break-word'
    });

    viewBatch.appendChild(numsLabel);
    viewBatch.appendChild(numsBox);
    viewBatch.appendChild(msgLabel);
    viewBatch.appendChild(msgBox);

    const viewPaired = document.createElement('div');
    viewPaired.id = VIEW_PAIRED_ID;
    viewPaired.style.display = 'none';

    const pairedLabel = document.createElement('div');
    pairedLabel.textContent = 'Paste from Sheets';
    Object.assign(pairedLabel.style, labelBase);

    const pairedBox = document.createElement('textarea');
    pairedBox.id = PAIRED_ID;
    pairedBox.className = '__gm_input';
    Object.assign(pairedBox.style, {
      ...inputBase,
      height: '100px',
      resize: 'vertical',
      lineHeight: '1.6'
    });

    const preview = document.createElement('div');
    preview.id = PREVIEW_ID;
    preview.textContent = 'Parsed pairs will appear here…';

    pairedBox.addEventListener('input', updatePreview);
    pairedBox.addEventListener('paste', () => setTimeout(updatePreview, 50));

    viewPaired.appendChild(pairedLabel);
    viewPaired.appendChild(pairedBox);
    viewPaired.appendChild(preview);

    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, {
      display: 'flex',
      gap: '8px',
      marginTop: '14px'
    });

    const startBtn = document.createElement('button');
    startBtn.id = START_BTN_ID;
    startBtn.type = 'button';
    startBtn.textContent = 'Start Batch';
    Object.assign(startBtn.style, {
      flex: '1',
      padding: '8px 10px',
      background: C.cyanDim,
      color: '#fff',
      border: `1px solid ${C.cyan}`,
      borderRadius: '4px',
      cursor: 'pointer',
      fontFamily: T.fontBody,
      fontWeight: '600',
      fontSize: '12px'
    });

    const stopBtn = document.createElement('button');
    stopBtn.id = STOP_BTN_ID;
    stopBtn.type = 'button';
    stopBtn.textContent = 'Stop';
    Object.assign(stopBtn.style, {
      width: '70px',
      padding: '10px',
      background: C.pageBg,
      color: C.textMuted,
      border: `1px solid ${C.border}`,
      borderRadius: '4px',
      cursor: 'pointer',
      fontFamily: T.fontBody,
      fontWeight: '600',
      fontSize: '12px'
    });

    btnRow.appendChild(startBtn);
    btnRow.appendChild(stopBtn);

    const statusEl = document.createElement('div');
    statusEl.id = STATUS_ID;
    statusEl.textContent = 'Ready';
    Object.assign(statusEl.style, {
      marginTop: '12px',
      color: C.textMuted,
      minHeight: '18px',
      fontSize: '11px',
      padding: '8px 10px',
      background: C.pageBg,
      borderRadius: '4px',
      border: `1px solid ${C.border}`,
      fontFamily: T.fontMono
    });

    const failuresBox = document.createElement('div');
    failuresBox.id = FAILURES_ID;

    body.appendChild(tabRow);
    body.appendChild(viewBatch);
    body.appendChild(viewPaired);
    body.appendChild(btnRow);
    body.appendChild(statusEl);
    body.appendChild(failuresBox);

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    const pill = document.createElement('div');
    pill.id = PILL_ID;
    pill.setAttribute('role', 'button');
    pill.setAttribute('tabindex', '0');
    pill.title = 'Expand Batch Sender';

    const pillDot = document.createElement('div');
    pillDot.className = '__gm_pill_dot';

    const pillLabel = document.createElement('span');
    pillLabel.className = '__gm_pill_label';
    pillLabel.textContent = 'Batch';

    const pillStatusEl = document.createElement('span');
    pillStatusEl.id = PILL_STATUS_ID;
    pillStatusEl.textContent = 'Ready';

    pill.appendChild(pillDot);
    pill.appendChild(pillLabel);
    pill.appendChild(pillStatusEl);
    document.body.appendChild(pill);

    if (window.DSP_UI?.makeDraggable) {
      DSP_UI.makeDraggable(panel, header);
    } else {
      let dragging = false;
      let dx = 0;
      let dy = 0;
      let sx = 0;
      let sy = 0;

      header.style.cursor = 'move';

      header.addEventListener('mousedown', e => {
        if (e.target.closest('button')) return;

        dragging = true;
        dx = e.clientX;
        dy = e.clientY;

        const r = panel.getBoundingClientRect();
        sx = r.left;
        sy = r.top;

        panel.style.right = 'auto';
        panel.style.left = sx + 'px';
        panel.style.top = sy + 'px';

        e.preventDefault();
      });

      document.addEventListener('mousemove', e => {
        if (!dragging) return;

        panel.style.left = Math.max(0, Math.min(innerWidth - panel.offsetWidth, sx + e.clientX - dx)) + 'px';
        panel.style.top = Math.max(0, Math.min(innerHeight - panel.offsetHeight, sy + e.clientY - dy)) + 'px';
      });

      document.addEventListener('mouseup', () => {
        dragging = false;
      });
    }
  }

  function switchTab(mode) {
    activeMode = mode;

    document.getElementById(TAB_BATCH_ID).classList.toggle('__gm_tab_active', mode === 'batch');
    document.getElementById(TAB_PAIRED_ID).classList.toggle('__gm_tab_active', mode === 'paired');

    document.getElementById(VIEW_BATCH_ID).style.display = mode === 'batch' ? 'block' : 'none';
    document.getElementById(VIEW_PAIRED_ID).style.display = mode === 'paired' ? 'block' : 'none';
  }

  function updatePreview() {
    const previewEl = document.getElementById(PREVIEW_ID);
    const pairedBox = document.getElementById(PAIRED_ID);

    if (!previewEl || !pairedBox) return;

    previewEl.textContent = '';

    let pairs = [];

    try {
      pairs = parsePairs(pairedBox.value);
    } catch {}

    if (!pairs.length) {
      previewEl.textContent = 'No valid pairs yet…';
      return;
    }

    const hdr = document.createElement('div');
    Object.assign(hdr.style, {
      color: C.info,
      marginBottom: '4px',
      fontSize: '9px',
      fontWeight: '600'
    });
    hdr.textContent = `${pairs.length} pair${pairs.length !== 1 ? 's' : ''} found`;
    previewEl.appendChild(hdr);

    for (const p of pairs.slice(0, 20)) {
      const row = document.createElement('div');
      row.className = 'pair-row';

      const n = document.createElement('span');
      n.className = 'pair-num';
      n.textContent = p.number.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');

      const a = document.createElement('span');
      a.className = 'pair-arrow';
      a.textContent = '→';

      const m = document.createElement('span');
      m.className = 'pair-msg';
      m.textContent = p.message.split('\n')[0].slice(0, 40);

      row.appendChild(n);
      row.appendChild(a);
      row.appendChild(m);
      previewEl.appendChild(row);
    }

    if (pairs.length > 20) {
      const more = document.createElement('div');
      more.style.color = C.textMuted;
      more.textContent = `…and ${pairs.length - 20} more`;
      previewEl.appendChild(more);
    }
  }

  function wireUI() {
    document.getElementById(TAB_BATCH_ID).addEventListener('click', () => switchTab('batch'));
    document.getElementById(TAB_PAIRED_ID).addEventListener('click', () => switchTab('paired'));

    document.getElementById(MIN_BTN_ID).addEventListener('click', () => setMinimized(true));
    document.getElementById(PILL_ID).addEventListener('click', () => setMinimized(false));

    document.getElementById(PILL_ID).addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setMinimized(false);
      }
    });

    document.getElementById(START_BTN_ID).addEventListener('click', () => {
      if (isRunning) return;

      if (activeMode === 'batch') {
        const nums = parseNumbers(document.getElementById(NUMS_ID).value);
        const msgBox = document.getElementById(MSG_ID);

        if (!nums.length) return setStatus('Add at least one valid number.');
        if (!msgBox.innerText.trim() && !msgBox.querySelector('img')) return setStatus('Add message content.');

        runBatch(nums);
      } else {
        let pairs;

        try {
          pairs = parsePairs(document.getElementById(PAIRED_ID).value);
        } catch (e) {
          return setStatus(`Parse error: ${e.message}`);
        }

        if (!pairs.length) return setStatus('No valid pairs found.');

        runPaired(pairs);
      }
    });

    document.getElementById(STOP_BTN_ID).addEventListener('click', () => {
      if (!isRunning) return;

      stopRequested = true;
      setStatus('Stopping…');
      toggleRunState(false);
    });
  }

  addPanel();
  wireUI();
})();
