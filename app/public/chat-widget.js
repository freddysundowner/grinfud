(() => {
  'use strict';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const WA_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2z"/></svg>';
  const MIC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z"/></svg>';
  const FILE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.5 6.5v10a4.5 4.5 0 0 1-9 0V5a3 3 0 0 1 6 0v10.5a1.5 1.5 0 0 1-3 0V6.5H9v9a3 3 0 0 0 6 0V5a4.5 4.5 0 0 0-9 0v11.5a6 6 0 0 0 12 0v-10z"/></svg>';
  const SEND_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 20.5 21 12 3 3.5v6.6l12 1.9-12 1.9z"/></svg>';

  const bg = el('div', 'gfc-bg'); bg.setAttribute('role', 'dialog'); bg.setAttribute('aria-modal', 'true');
  document.body.appendChild(bg);
  let returnFocus = null, view = null;
  let state = { messages: [], suggestions: [] }, sending = false, failed = null, loadErr = null, loading = false, pendingText = null;
  let channels = null, opening = false;
  const waUrl = m => typeof m.whatsapp_url === 'string' && /^https:\/\/wa\.me\/\d{9,15}(?:\?|$)/.test(m.whatsapp_url) ? m.whatsapp_url : '';
  function availability(m) {
    channels = m;
    const enabled = m.website_chat_enabled || m.whatsapp_chat_enabled;
    document.body.classList.toggle('chat-disabled', !enabled);
    const fab = document.getElementById('waFab'), footer = document.getElementById('waLink')?.closest('footer');
    if (fab) {
      fab.hidden = !enabled;
      fab.querySelector('span').textContent = m.whatsapp_chat_enabled ? 'WhatsApp' : 'Chat here';
      fab.setAttribute('aria-label', m.website_chat_enabled && m.whatsapp_chat_enabled ? 'Chat options: WhatsApp or chat here' : m.website_chat_enabled ? 'Chat here' : 'Open WhatsApp');
    }
    if (footer) footer.hidden = !enabled;
    if (view === 'chat' && !m.website_chat_enabled) close();
    if (!enabled && view) close();
  }
  async function fetchChannels() {
    const r = await fetch('/api/menu', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new Error('Could not load chat options. Please try again.');
    const m = await r.json(); availability(m); return m;
  }
  async function open(trigger) {
    if (opening) return;
    voiceReset();
    opening = true;
    if (trigger) returnFocus = trigger;
    const act = m => {
      if (!m.website_chat_enabled && !m.whatsapp_chat_enabled) return;
      if (m.website_chat_enabled && !m.whatsapp_chat_enabled) { if (view !== 'chat') openChat(); }
      else if (!m.website_chat_enabled && m.whatsapp_chat_enabled && waUrl(m)) { close(); window.location.assign(waUrl(m)); }
      else if (view !== 'choose') openChooser(m);
    };
    if (channels && channels.website_chat_enabled) { act(channels); opening = false; fetchChannels().catch(() => {}); return; }
    view = 'loading'; bg.classList.add('open'); lock(true); vv();
    const sk = el('div', 'gfc-choose gfc-skel'); sk.setAttribute('aria-busy', 'true'); sk.append(xBtn(), el('i'), el('i'), el('i')); bg.replaceChildren(sk);
    try {
      const m = await fetchChannels();
      if (!bg.classList.contains('open')) return;
      if (!m.website_chat_enabled && !m.whatsapp_chat_enabled) return;
      if (m.website_chat_enabled && !m.whatsapp_chat_enabled) openChat();
      else if (!m.website_chat_enabled && m.whatsapp_chat_enabled && waUrl(m)) {
        close(); window.location.assign(waUrl(m));
      } else openChooser(m);
    } catch (e) {
      if (!bg.classList.contains('open')) return;
      view = 'error'; bg.classList.add('open'); lock(true); bg.setAttribute('aria-label', 'Chat unavailable');
      const box = el('div', 'gfc-choose'); const retry = el('button', 'gfc-btn', 'Retry');
      retry.onclick = () => open();
      box.append(xBtn(), el('p', null, e.message), retry); bg.replaceChildren(box); retry.focus();
    } finally { opening = false; }
  }

  function lock(on) { document.body.classList.toggle('gfc-lock', on); document.documentElement.classList.toggle('gfc-lock', on); if (!on) { bg.style.removeProperty('--gfc-vh'); bg.style.removeProperty('--gfc-top'); } }
  function vv() {
    const v = window.visualViewport; if (!v || !bg.classList.contains('open')) return;
    bg.style.setProperty('--gfc-vh', v.height + 'px'); bg.style.setProperty('--gfc-top', Math.max(0, v.offsetTop) + 'px');
    if (log && view === 'chat' && document.activeElement === input) log.scrollTop = log.scrollHeight;
  }
  if (window.visualViewport) { visualViewport.addEventListener('resize', vv); visualViewport.addEventListener('scroll', vv); }
  function close() {
    voiceReset();
    bg.classList.remove('open', 'chat'); bg.replaceChildren(); view = null; lock(false);
    if (returnFocus && returnFocus.focus) returnFocus.focus(); returnFocus = null;
  }
  function focusables() { return [...bg.querySelectorAll('button:not([disabled]),a[href],textarea:not([disabled]),[tabindex="0"]')].filter(e => e.offsetParent !== null); }
  bg.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables(); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });

  function xBtn(label) { const b = el('button', 'gfc-x', '×'); b.type = 'button'; b.setAttribute('aria-label', label || 'Close'); b.onclick = close; return b; }

  // ---------- chooser ----------
  function openChooser(m) {
    view = 'choose'; bg.classList.remove('chat'); bg.classList.add('open'); lock(true); vv();
    bg.setAttribute('aria-labelledby', 'gfcTitle');
    const box = el('div', 'gfc-choose');
    const head = el('div', 'gfc-head'); const h = el('h2', null, m.website_chat_enabled ? 'How would you like to chat?' : 'WhatsApp unavailable'); h.id = 'gfcTitle';
    head.append(h, xBtn());
    const sub = el('p', 'gfc-sub', m.website_chat_enabled ? 'Order through WhatsApp, or right here in the page.' : 'Our WhatsApp number is not connected yet. You can still order from the menu.');

    const wa = el('a', 'gfc-opt'); wa.setAttribute('aria-disabled', 'true'); wa.setAttribute('role', 'link'); wa.tabIndex = 0;
    const waIc = el('span', 'gfc-ic whatsapp-icon'); waIc.innerHTML = WA_SVG;
    const waTx = el('span'); const waB = el('b', null, 'Open WhatsApp'); const waS = el('small', null, 'Checking connection…');
    waTx.append(waB, waS); wa.append(waIc, waTx);
    wa.addEventListener('click', e => { if (wa.getAttribute('aria-disabled') === 'true') e.preventDefault(); });

    const here = el('button', 'gfc-opt'); here.type = 'button';
    const hIc = el('span', 'gfc-ic here', 'G'); hIc.setAttribute('aria-hidden', 'true');
    const hTx = el('span'); hTx.append(el('b', null, 'Chat here'), el('small', null, 'Order step by step with our ordering assistant.'));
    here.append(hIc, hTx); here.onclick = openChat;

    box.append(head, sub);
    if (m.whatsapp_chat_enabled) box.append(wa);
    if (m.website_chat_enabled) box.append(here);
    bg.replaceChildren(box);
    (m.website_chat_enabled ? here : head.querySelector('button')).focus();
        const url = waUrl(m);
        if (url) {
          wa.href = url; wa.target = '_blank'; wa.rel = 'noopener'; wa.removeAttribute('aria-disabled'); wa.removeAttribute('role'); wa.removeAttribute('tabindex');
          waS.textContent = 'Opens the WhatsApp app with our number.';
        } else waS.textContent = 'WhatsApp is not connected right now.';
        if (m.whatsapp_demo === true) waTx.append(el('span', 'gfc-demo', 'Demo connection — real messaging is not verified'));
  }

  // ---------- chat ----------
  let log, qrs, input, sendBtn, micBtn, fileBtn, fileIn, vstrip, whoSub;
  // ---------- voice ----------
  const V = window.GrinFudVoice;
  let aiAvailable = false, vState = 'idle', vMsg = '', vSec = 0, recorder = null, vAbort = null, vGen = 0, retryAudio = null;
  function voiceReset() {
    retryAudio = null;
    vGen++; if (recorder) { recorder.cancel(); recorder = null; }
    if (vAbort) { vAbort.abort(); vAbort = null; }
    vState = 'idle'; vMsg = ''; vSec = 0; renderVoice();
  }
  const voiceBusy = () => vState === 'starting' || vState === 'recording' || vState === 'converting' || vState === 'uploading';
  function voiceBlockedReason() {
    if (!aiAvailable) return 'Voice notes are unavailable right now. Please type your message.';
    if (!V) return 'Voice notes are not supported in this browser.';
    return '';
  }
  function vErr(msg) { vState = 'error'; vMsg = msg; renderVoice(); }
  async function startVoice() {
    const why = voiceBlockedReason(); if (why) { vErr(why); return; }
    if (!V.supported()) { vErr('Voice recording is not supported in this browser.' + (V.decodeSupported() ? ' You can upload an audio file instead.' : '')); return; }
    voiceReset(); const g = vGen;
    vState = 'starting'; vMsg = 'Waiting for microphone permission…'; renderVoice();
    const r = V.createRecorder({ onTick: s => { if (g === vGen) { vSec = s; renderVoice(); } }, onAutoStop: () => { if (g === vGen) stopVoice(true); } });
    recorder = r;
    try { await r.start(); }
    catch (e) { if (g !== vGen || e.code === 'cancelled') return; recorder = null; vErr(e.message); return; }
    if (g !== vGen || view !== 'chat' || document.hidden) { r.cancel(); return; }
    vState = 'recording'; vSec = 0; vMsg = ''; renderVoice();
    const stopB = vstrip && vstrip.querySelector('.gfc-vstop'); if (stopB) stopB.focus();
  }
  async function stopVoice(auto) {
    if (vState !== 'recording' || !recorder) return;
    const g = vGen, r = recorder; recorder = null;
    vState = 'converting'; vMsg = auto ? 'Reached 60 seconds. Preparing voice note…' : 'Preparing voice note…'; renderVoice();
    let blob;
    try { blob = await r.stop(); } catch { if (g === vGen) vErr('Could not finish recording. Please try again.'); return; }
    if (g !== vGen) return;
    if (!blob || !blob.size) { vErr('No audio was recorded. Try again.'); return; }
    await processBlob(blob, g);
  }
  async function processBlob(blob, g) {
    retryAudio = blob;
    vState = 'converting'; if (!vMsg) vMsg = 'Preparing voice note…'; renderVoice();
    let wav;
    try { wav = await V.toWav(blob); } catch (e) { if (g === vGen) vErr(e.message || 'Could not prepare that audio.'); return; }
    if (g !== vGen) return;
    vState = 'uploading'; vMsg = 'Transcribing…'; renderVoice();
    const ctl = new AbortController(); vAbort = ctl;
    try {
      const fd = new FormData(); fd.append('audio', wav, 'voice.wav');
      const res = await fetch('/api/chat/transcribe', { method: 'POST', body: fd, credentials: 'same-origin', cache: 'no-store', signal: ctl.signal });
      let d = null; try { d = await res.json(); } catch {}
      if (g !== vGen) return;
      if (!res.ok) throw new Error((d && d.error) || `Transcription failed (${res.status}).`);
      const text = String((d && d.text) || '').trim();
      if (!text) { vErr('No speech was detected. Try again closer to the microphone.'); return; }
      vAbort = null;
      retryAudio = null;
      const cur = input.value.trim();
      input.value = (cur ? cur + ' ' : '') + text; if (input.value.length > 1000) input.value = input.value.slice(0, 1000);
      input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px';
      if (cur || /confirm|cancel|place.*order|order.*now/i.test(text)) {
        vState = 'review'; vMsg = 'Review this message, then press Send.'; renderVoice(); syncSend();
      } else {
        vState = 'idle'; vMsg = ''; renderVoice(); syncSend();
        await send(input.value.trim(), false, false);
      }
    } catch (e) {
      if (g !== vGen || e.name === 'AbortError') return;
      vErr(e instanceof TypeError ? 'Network problem. Check your connection and try again.' : e.message);
    } finally { if (vAbort === ctl) vAbort = null; }
  }
  function onFile() {
    const f = fileIn.files && fileIn.files[0]; fileIn.value = ''; if (!f) return;
    const why = voiceBlockedReason(); if (why) { vErr(why); return; }
    if (!V.decodeSupported()) { vErr('Audio files cannot be read in this browser.'); return; }
    if (f.size > V.MAX_FILE) { vErr('That audio file is larger than 8 MB.'); return; }
    voiceReset(); vMsg = 'Reading audio file…'; processBlob(f, vGen);
  }
  function renderVoice() {
    if (!vstrip) return;
    const why = voiceBlockedReason();
    const blocked = sending || loading || !!failed || !!loadErr;
    if (micBtn) {
      micBtn.disabled = blocked || voiceBusy();
      micBtn.setAttribute('aria-disabled', why ? 'true' : 'false');
      micBtn.classList.toggle('off', !!why);
      micBtn.setAttribute('aria-label', why ? 'Record voice note (unavailable)' : 'Record voice note');
      micBtn.title = why || 'Record voice note';
      fileBtn.disabled = micBtn.disabled; fileBtn.classList.toggle('off', !!why);
      fileBtn.setAttribute('aria-label', why ? 'Upload audio file (unavailable)' : 'Upload audio file, up to 60 seconds');
      fileBtn.title = why || 'Upload audio file';
    }
    if (whoSub) whoSub.textContent = aiAvailable ? 'AI ordering assistant' : 'Ordering assistant';
    if (vState === 'idle') { vstrip.hidden = true; vstrip.replaceChildren(); return; }
    vstrip.hidden = false; vstrip.className = 'gfc-vstrip ' + vState;
    const kids = [];
    const mk = (cls, txt, fn, label) => { const b = el('button', 'gfc-vbtn ' + cls, txt); b.type = 'button'; b.onclick = fn; if (label) b.setAttribute('aria-label', label); return b; };
    if (vState === 'recording') {
      const dot = el('span', 'gfc-vdot'); dot.setAttribute('aria-hidden', 'true');
      const t = el('span', 'gfc-vtime', `0:${String(vSec).padStart(2, '0')}`); t.setAttribute('aria-label', `${vSec} seconds recorded`);
      const info = el('span', 'gfc-vtxt'); info.append(el('b', null, 'Recording'), el('small', null, 'Max 60s. Voice notes are sent to Google for transcription.'));
      kids.push(dot, t, info, mk('gfc-vcancel', 'Cancel', voiceReset, 'Cancel recording'), mk('gfc-vstop', 'Send', () => stopVoice(false), 'Send voice note'));
    } else {
      const info = el('span', 'gfc-vtxt'); info.append(el('b', null, vMsg));
      if (vState === 'starting') info.append(el('small', null, 'Voice notes are sent to Google for transcription.'));
      if (vState === 'converting' || vState === 'uploading' || vState === 'starting') { const sp = el('span', 'gfc-vspin'); sp.setAttribute('aria-hidden', 'true'); kids.push(sp); }
      kids.push(info);
      if (vState === 'error') { if (!why && retryAudio) kids.push(mk('gfc-vretry', 'Retry voice note', () => processBlob(retryAudio, vGen))); else if (!why && V && V.supported()) kids.push(mk('gfc-vretry', 'Try again', startVoice)); kids.push(mk('gfc-vcancel', 'Dismiss', voiceReset)); }
      else if (vState === 'review') kids.push(mk('gfc-vcancel', 'OK', () => { voiceReset(); input.focus(); }, 'Dismiss review notice'));
      else kids.push(mk('gfc-vcancel', 'Cancel', voiceReset, 'Cancel voice note'));
    }
    vstrip.replaceChildren(...kids);
    vstrip.setAttribute('role', vState === 'error' ? 'alert' : 'status');
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && voiceBusy()) voiceReset(); });
  window.addEventListener('pagehide', voiceReset);
  function openChat() {
    view = 'chat'; bg.classList.add('open', 'chat'); lock(true); vv();
    bg.setAttribute('aria-labelledby', 'gfcChatTitle');
    const box = el('div', 'gfc-chat');
    const top = el('div', 'gfc-top');
    const back = el('button', 'gfc-x', '\u2039'); back.type = 'button'; back.setAttribute('aria-label', 'Back to choices'); back.title = 'Back to choices';
    back.onclick = () => open();
    back.hidden = !(channels?.website_chat_enabled && channels?.whatsapp_chat_enabled);
    const av = el('span', 'gfc-av', 'G'); av.setAttribute('aria-hidden', 'true');
    const who = el('div', 'gfc-who'); const wb = el('b', null, 'GrinFud'); wb.id = 'gfcChatTitle';
    whoSub = el('small', null, aiAvailable ? 'AI ordering assistant' : 'Ordering assistant');
    who.append(wb, whoSub); top.classList.add('gfc-wa');
    top.append(back, av, who, xBtn());
    log = el('div', 'gfc-log'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite'); log.tabIndex = 0;
    qrs = el('div', 'gfc-qrs');
    const comp = el('form', 'gfc-comp');
    input = el('textarea'); input.rows = 1; input.maxLength = 1000; input.placeholder = 'Type a message'; input.setAttribute('aria-label', 'Message');
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; syncSend(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); comp.requestSubmit(); } });
    sendBtn = el('button', 'gfc-send'); sendBtn.type = 'submit'; sendBtn.setAttribute('aria-label', 'Send'); sendBtn.innerHTML = SEND_SVG;
    micBtn = el('button', 'gfc-tool gfc-mic'); micBtn.type = 'button'; micBtn.innerHTML = MIC_SVG;
    micBtn.onclick = () => { if (micBtn.getAttribute('aria-disabled') === 'true') vErr(voiceBlockedReason()); else startVoice(); };
    fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = 'audio/*'; fileIn.hidden = true; fileIn.tabIndex = -1; fileIn.onchange = onFile;
    fileBtn = el('button', 'gfc-tool gfc-file'); fileBtn.type = 'button'; fileBtn.innerHTML = FILE_SVG;
    fileBtn.onclick = () => { const why = voiceBlockedReason(); if (why) vErr(why); else fileIn.click(); };
    vstrip = el('div', 'gfc-vstrip'); vstrip.hidden = true; vstrip.setAttribute('aria-live', 'polite');
    comp.append(input, fileBtn, micBtn, sendBtn, fileIn);
    comp.onsubmit = e => { e.preventDefault(); const t = input.value.trim(); if (t) send(t, false, true); };
    box.append(top, log, qrs, vstrip, comp);
    bg.replaceChildren(box);
    render(); log.focus({ preventScroll: true });
    if (!sending) loadChat();
  }
  function syncSend() { if (sendBtn) sendBtn.disabled = sending || loading || !!failed || !!loadErr || !input.value.trim(); }

  function apply(d) {
    if (d && typeof d.ai_available === 'boolean') aiAvailable = d.ai_available;
    state = { messages: Array.isArray(d && d.messages) ? d.messages : [], suggestions: Array.isArray(d && d.suggestions) ? d.suggestions : [] };
  }
  async function api(method, body) {
    const r = await fetch(method === 'GET' ? '/api/chat' : '/api/chat/messages', {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined
    });
    let d = null; try { d = await r.json(); } catch {}
    if (!r.ok) throw new Error((d && d.error) || `Request failed (${r.status}).`);
    return d;
  }
  async function loadChat() {
    loading = true; loadErr = null; render();
    try { apply(await api('GET')); failed = null; pendingText = null; } catch (e) { loadErr = 'Could not load the chat. ' + (e.message || ''); }
    loading = false; render();
  }
  async function send(text, retry, keepFocus) {
    if (sending || loading || loadErr) return;
    const request_id = retry ? failed.request_id : (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    failed = null; sending = true; pendingText = text;
    if (vState === 'review' || vState === 'error') voiceReset();
    if (!retry) { input.value = ''; input.style.height = 'auto'; }
    render();
    try { apply(await api('POST', { message: text, request_id })); pendingText = null; }
    catch (e) { failed = { text, request_id, error: e.message || 'Message not sent.' }; }
    sending = false; render();
    if (view === 'chat' && keepFocus && !input.disabled) input.focus({ preventScroll: true });
  }

  const LINK_RE = /(https:\/\/wa\.me\/[^\s<>"']+|https?:\/\/[^\s<>"']+\/t\/[^\s<>"']+|(?:^|(?<=\s))\/t\/[^\s<>"']+)/g;
  function safeHref(raw) {
    const s = raw.replace(/[.,!?)]+$/, '');
    if (s.startsWith('https://wa.me/')) { try { const u = new URL(s); if (u.host === 'wa.me') return { s, href: u.href, ext: true }; } catch {} return null; }
    try { const u = new URL(s, location.origin); if (u.origin === location.origin && u.pathname.startsWith('/t/')) return { s, href: u.pathname + u.search + u.hash, ext: false }; } catch {}
    return null;
  }
  function textNodes(parent, text) {
    let last = 0;
    for (const m of text.matchAll(LINK_RE)) {
      const link = safeHref(m[0]); if (!link) continue;
      parent.append(document.createTextNode(text.slice(last, m.index)));
      const a = el('a', null, link.s); a.href = link.href; if (link.ext) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      parent.append(a); last = m.index + link.s.length;
    }
    parent.append(document.createTextNode(text.slice(last)));
  }
  const fmtT = at => { const d = new Date(Number(at) || Date.now()); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  const fmtD = at => new Date(Number(at) || Date.now()).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

  function bubble(role, text, at, pending) {
    const b = el('div', 'gfc-m ' + (role === 'user' ? 'out' : 'in') + (pending ? ' pending' : ''));
    textNodes(b, String(text ?? ''));
    b.append(el('span', 'gfc-t', pending ? 'Sending…' : fmtT(at)));
    return b;
  }
  function render() {
    if (view !== 'chat' || !log) return;
    const frag = document.createDocumentFragment(); let day = '';
    if (loading && !state.messages.length && !sending) frag.append(typing());
    for (const m of state.messages) {
      const d = fmtD(m.at); if (d !== day) { day = d; frag.append(el('div', 'gfc-day', d)); }
      frag.append(bubble(m.role, m.text, m.at));
    }
    if (sending && pendingText) { frag.append(bubble('user', pendingText, Date.now(), true), typing()); }
    if (failed) {
      frag.append(bubble('user', failed.text, Date.now(), false));
      const er = el('div', 'gfc-err'); er.setAttribute('role', 'alert');
      er.append(el('span', null, 'Could not get a reply: ' + failed.error));
      const rb = el('button', 'gfc-btn', 'Retry'); rb.type = 'button'; rb.onclick = () => send(failed.text, true);
      const edit = el('button', 'gfc-btn', 'Edit message'); edit.type = 'button';
      edit.onclick = () => { const text = failed.text; failed = null; pendingText = null; input.value = text; render(); input.focus(); };
      er.append(rb, edit); frag.append(er);
    }
    if (loadErr) {
      const er = el('div', 'gfc-err'); er.setAttribute('role', 'alert'); er.append(el('span', null, loadErr));
      const rb = el('button', 'gfc-btn', 'Retry'); rb.type = 'button'; rb.onclick = loadChat; er.append(rb); frag.append(er);
    }
    log.replaceChildren(frag);
    qrs.replaceChildren(...(failed || loadErr ? [] : state.suggestions).map(s => {
      const b = el('button', 'gfc-qr', s.label); b.type = 'button'; b.disabled = sending || loading;
      b.onclick = () => send(String(s.value ?? s.label)); return b;
    }));
    input.disabled = !!failed; input.placeholder = failed ? 'Retry the failed message first' : 'Type a message';
    syncSend(); renderVoice();
    requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
  }
  function typing() { const t = el('div', 'gfc-typing'); t.setAttribute('aria-label', 'Assistant is typing'); t.append(el('i'), el('i'), el('i')); return t; }

  function bind(id) {
    const a = document.getElementById(id); if (!a) return;
    a.setAttribute('role', 'button'); a.setAttribute('aria-haspopup', 'dialog');
    a.addEventListener('click', e => { e.preventDefault(); open(a); });
  }
  bind('waFab'); bind('waLink');
  // Structured storefront hand-off: posts validated item lines into this browser's chat cart,
  // then opens the chat. Same request_id on retry is safe (server dedupes). Rejects on failure.
  let transferring = false;
  async function transfer(payload, trigger) {
    if (transferring) throw new Error('Already adding your items. Please wait.');
    transferring = true;
    try {
      const r = await fetch('/api/chat/cart', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: payload.request_id, lines: payload.lines }) });
      let d = null; try { d = await r.json(); } catch {}
      if (!r.ok) { const e = new Error((d && d.error) || `Could not add to chat (${r.status}).`); e.status = r.status; throw e; }
      if (d && Array.isArray(d.messages)) { apply(d); failed = null; pendingText = null; loadErr = null; }
      return d;
    } catch (e) { if (e instanceof TypeError) throw new Error('Network problem. Check your connection and try again.'); throw e; }
    finally { transferring = false; }
  }
  function openWebsiteChat(trigger) {
    voiceReset(); if (trigger) returnFocus = trigger;
    if (view !== 'chat') openChat(); else loadChat();
  }
  window.GrinFudChat = { open, close, channels: fetchChannels, transfer, openWebsiteChat, waUrl };
  fetchChannels().catch(() => {});
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchChannels().catch(() => {}); });
  setInterval(() => { if (!document.hidden && !opening) fetchChannels().catch(() => {}); }, 30000);
})();
