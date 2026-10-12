// Storefront -> chat ordering hand-off. Follows the admin chat settings:
// one enabled channel opens directly, both offer a choice, none shows an honest notice.
// Pending lines live in localStorage (gf_pending) with a stable request id per batch,
// so a retry or a reload never adds the same items twice. Nothing here places an order.
(() => {
  'use strict';
  const PK = 'gf_pending', HK = 'gf_handoff', LK = 'gf_cart', AK = 'gf_chat_active';
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(16) + '-' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2));
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch { return d; } };
  const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let M = null, busy = false, lastErr = '', trigger = null;
  let batches = read(PK, []); if (!Array.isArray(batches)) batches = [];
  const money = n => `${M?.currency || 'KSh'} ${Number(n || 0).toLocaleString('en-KE')}`;
  const allLines = () => batches.flatMap(b => b.lines);
  const count = ls => ls.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const estimate = ls => ls.reduce((s, l) => s + (Number(l.unit) || 0) * (Number(l.qty) || 0), 0);
  const save = () => write(PK, batches.length ? batches : null);
  const optText = l => Object.entries(l.options || {}).flatMap(([g, v]) => Array.isArray(v) && v.length ? [`${g}: ${v.join(', ')}`] : []).join(' · ');
  const wire = l => ({ item_id: l.item_id, qty: l.qty, options: l.options || {}, note: l.note || '' });

  // Old basket from the previous checkout: never dropped silently. Becomes one pending batch.
  function adoptLegacy() {
    const old = read(LK, []);
    if (!Array.isArray(old) || !old.length) return;
    if (batches.some(b => b.legacy)) return;
    const lines = old.filter(l => l && Number.isInteger(Number(l.item_id))).map(l => ({ item_id: Number(l.item_id), name: String(l.name || 'Item'), qty: Number(l.qty) || 1, options: l.options || {}, note: String(l.note || ''), unit: Number(l.unit) || 0 }));
    if (!lines.length) return;
    batches.unshift({ id: 'legacy-' + rid(), lines, legacy: true }); save();
  }
  function ack(batch) {
    batches = batches.filter(b => b !== batch); save();
    if (batch.legacy) write(LK, null);
  }

  const sheet = () => $('#orderSheet'), body = () => $('#orderBody');
  function show(html) {
    body().innerHTML = `<button class="x" type="button" aria-label="Close" data-oh="close">×</button>${html}`;
    sheet().classList.add('open'); document.body.classList.add('sheet-open');
    const f = body().querySelector('[data-focus]') || body().querySelector('h2'); if (f) { f.tabIndex = f.tabIndex < 0 ? -1 : f.tabIndex; f.focus({ preventScroll: true }); }
  }
  function hide() {
    sheet().classList.remove('open');
    if (!document.querySelector('.sheet-bg.open')) document.body.classList.remove('sheet-open');
    if (trigger && trigger.focus && document.contains(trigger)) trigger.focus(); trigger = null;
    renderBar();
  }

  function linesHtml(editable) {
    return `<div class="oh-lines">${batches.map((b, bi) => `${b.legacy ? '<p class="oh-legacy">From your earlier basket on this device</p>' : ''}${b.lines.map((l, li) => `
      <div class="oh-line"><span class="oh-q">${l.qty}×</span><div class="oh-d"><b>${esc(l.name)}</b>${optText(l) ? `<small>${esc(optText(l))}</small>` : ''}${l.note ? `<small class="oh-n">Note: ${esc(l.note)}</small>` : ''}
      ${editable ? `<button type="button" class="oh-rm" data-oh="rm" data-b="${bi}" data-l="${li}">Remove</button>` : ''}</div><span class="oh-p">${l.unit ? money(l.unit * l.qty) : ''}</span></div>`).join('')}`).join('')}</div>
      <div class="oh-est"><span>Menu estimate${M?.delivery_fee ? ' + delivery' : ''}</span><b>${money(estimate(allLines()) + (M?.delivery_fee || 0))}</b></div>
      <p class="oh-fine">Final prices, discounts and delivery are checked in the chat. Nothing is ordered until you confirm there.</p>`;
  }
  function errHtml() { return lastErr ? `<div class="oh-err" role="alert">${esc(lastErr)}</div>` : ''; }

  // ---- views ----
  function viewChoose(m) {
    const web = m.website_chat_enabled, wa = m.whatsapp_chat_enabled && !!waBase(m);
    const n = count(allLines());
    let actions;
    if (web && wa) actions = `<p class="oh-k">Where would you like to finish?</p>
      <button type="button" class="oh-opt" data-oh="web" data-focus><span class="oh-ic">G</span><span><b>Chat here</b><small>Your items appear in the website chat. Add details and confirm there.</small></span></button>
      <button type="button" class="oh-opt" data-oh="wa"><span class="oh-ic wa">W</span><span><b>WhatsApp</b><small>Opens WhatsApp with your list written out. You press send.</small></span></button>`;
    else if (web) actions = `<button type="button" class="btn btn-primary oh-main" data-oh="web" data-focus ${busy ? 'disabled' : ''}>${busy ? 'Adding to chat…' : lastErr ? 'Retry · continue in chat' : 'Continue in chat'}</button>`;
    else if (wa) actions = `<button type="button" class="btn btn-primary oh-main" data-oh="wa" data-focus>Continue on WhatsApp</button>`;
    else actions = `<div class="oh-off" role="status"><b>Chat ordering is unavailable right now.</b><span>${m.whatsapp_chat_enabled && !m.website_chat_enabled ? 'Our WhatsApp number is not connected yet. ' : ''}Your items are kept on this device. Check back shortly, or try again.</span></div>
      <button type="button" class="btn btn-ghost oh-main" data-oh="go" data-focus>Check again</button>`;
    show(`<h2 id="ohTitle">Your order · ${n} item${n === 1 ? '' : 's'}</h2>${linesHtml(!busy)}${errHtml()}${actions}
      <button type="button" class="oh-later" data-oh="close">Keep for later</button>`);
  }
  function viewSending() {
    show(`<h2 id="ohTitle">Adding to your chat</h2><div class="oh-sending" aria-busy="true"><i></i><i></i><i></i></div><p class="oh-fine">Sending ${count(allLines())} item${count(allLines()) === 1 ? '' : 's'} to the order chat. Nothing is ordered yet.</p>`);
  }
  function waText(lines) {
    const rows = lines.map(l => `- ${l.qty} x ${l.name}${optText(l) ? ` (${optText(l)})` : ''}${l.note ? ` | Note: ${l.note}` : ''}`);
    const est = estimate(lines);
    return `Hello ${M?.business_name || 'GrinFud'}, I would like to order:\n${rows.join('\n')}${est ? `\n\nMenu estimate: ${money(est + (M?.delivery_fee || 0))}${M?.delivery_fee ? ' incl. delivery' : ''}. Please confirm the final total.` : ''}`.slice(0, 1500);
  }
  function waBase(m) { const g = window.GrinFudChat; const u = g && g.waUrl ? g.waUrl(m) : ''; return u ? u.split('?')[0] : ''; }
  function viewWa(m) {
    const base = waBase(m); if (!base) { lastErr = 'WhatsApp is not connected right now.'; return viewChoose(m); }
    const text = waText(allLines());
    show(`<h2 id="ohTitle">Continue on WhatsApp</h2>
      <p class="oh-k">This message opens in WhatsApp. Check it, then press send yourself. We only see your order after you send it.</p>
      <pre class="oh-msg">${esc(text)}</pre>
      <a class="btn btn-primary oh-main" data-oh="waopen" data-focus href="${esc(base + '?text=' + encodeURIComponent(text))}" target="_blank" rel="noopener noreferrer">Open WhatsApp</a>
      <button type="button" class="oh-later" data-oh="back">Edit items</button>`);
  }
  function viewDraft() {
    const h = read(HK, null); if (!h) return hide();
    const base = h.url || '';
    show(`<h2 id="ohTitle">WhatsApp draft</h2>
      <p class="oh-k">WhatsApp was opened with this message. If you have not pressed send there yet, we have not received it.</p>
      <pre class="oh-msg">${esc(h.text)}</pre>
      ${/^https:\/\/wa\.me\/\d{9,15}\?text=/.test(base) ? `<a class="btn btn-primary oh-main" href="${esc(base)}" target="_blank" rel="noopener noreferrer" data-focus>Open WhatsApp again</a>` : ''}
      <div class="oh-row"><button type="button" class="btn btn-ghost" data-oh="restore">Edit items</button><button type="button" class="btn btn-ghost" data-oh="clear">Clear draft</button></div>`);
  }

  async function channels() {
    if (!window.GrinFudChat) throw new Error('Chat is still loading. Please try again.');
    return window.GrinFudChat.channels();
  }
  async function go(choice) {
    if (busy) return;
    if (!batches.length) { if (read(HK, null)) return viewDraft(); return hide(); }
    let m;
    try { m = await channels(); } catch (e) { lastErr = e.message || 'Could not load chat options.'; return viewChoose({}); }
    M = { ...(M || {}), ...m };
    const web = m.website_chat_enabled, wa = m.whatsapp_chat_enabled && !!waBase(m);
    if (choice === 'web' && web) return sendWeb();
    if (choice === 'wa' && wa) return viewWa(m);
    if (!choice && web && !wa && !lastErr) return sendWeb();
    if (!choice && wa && !web) return viewWa(m);
    viewChoose(m);
  }
  async function sendWeb() {
    if (busy || !batches.length) return;
    busy = true; lastErr = ''; viewSending();
    try {
      for (const b of [...batches]) {
        await window.GrinFudChat.transfer({ request_id: b.id, lines: b.lines.map(wire) });
        ack(b);
      }
      busy = false;
      try { sessionStorage.setItem(AK, '1'); } catch {}
      sheet().classList.remove('open'); document.body.classList.remove('sheet-open'); renderBar();
      window.GrinFudChat.openWebsiteChat(trigger || $('#barBtn'));
      trigger = null;
    } catch (e) {
      busy = false; lastErr = (e.message || 'Could not add to chat.') + ' Your items are still saved here.';
      let m = {}; try { m = await channels(); } catch {}
      viewChoose(m);
    }
  }

  document.addEventListener('click', e => {
    const t = e.target.closest('[data-oh]'); if (!t || !sheet().contains(t)) { if (e.target === sheet() && !busy) hide(); return; }
    const a = t.dataset.oh;
    if (a === 'close') { if (!busy) hide(); }
    else if (a === 'web') go('web');
    else if (a === 'wa') go('wa');
    else if (a === 'go') { lastErr = ''; go(); }
    else if (a === 'back') { lastErr = ''; channels().then(viewChoose, () => viewChoose({})); }
    else if (a === 'rm') {
      const b = batches[Number(t.dataset.b)]; if (!b || busy) return;
      b.lines.splice(Number(t.dataset.l), 1);
      // Editing a batch makes it a new request; an empty legacy batch means the old basket is resolved.
      if (!b.lines.length) ack(b); else { b.id = (b.legacy ? 'legacy-' : '') + rid(); if (b.legacy) write(LK, b.lines); save(); }
      renderBar(); batches.length ? channels().then(viewChoose, () => viewChoose({})) : hide();
    }
    else if (a === 'waopen') {
      // User chose to hand off: keep an honest draft until they clear it.
      write(HK, { lines: allLines(), text: waText(allLines()), url: t.href, at: Date.now() });
      for (const b of [...batches]) ack(b);
      setTimeout(viewDraft, 0);
    }
    else if (a === 'restore') {
      const h = read(HK, null); if (h && Array.isArray(h.lines) && h.lines.length) { batches.push({ id: rid(), lines: h.lines }); save(); }
      write(HK, null); lastErr = ''; channels().then(viewChoose, () => viewChoose({}));
    }
    else if (a === 'clear') { write(HK, null); hide(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet()?.classList.contains('open') && !busy && !document.body.classList.contains('gfc-lock')) hide(); });

  function renderBar() {
    const bar = $('#bar'), btn = $('#barBtn'); if (!bar || !btn) return;
    const n = count(allLines()), draft = read(HK, null);
    let active = false; try { active = sessionStorage.getItem(AK) === '1'; } catch {}
    const webOn = !document.body.classList.contains('chat-disabled');
    let label = '', meta = '', mode = '';
    if (n) { mode = 'go'; label = batches.some(b => b.legacy) ? 'Continue earlier basket in chat' : 'Continue in chat'; meta = `${n} item${n === 1 ? '' : 's'}`; }
    else if (draft) { mode = 'draft'; label = 'WhatsApp order draft'; meta = 'View'; }
    else if (active && webOn) { mode = 'chat'; label = 'Open order chat'; meta = ''; }
    bar.hidden = !mode; if (document.body.classList.contains('has-bar') !== !!mode) document.body.classList.toggle('has-bar', !!mode);
    if (btn.dataset.mode === mode && btn.dataset.sig === label + meta) return; btn.dataset.sig = label + meta;
    btn.dataset.mode = mode;
    btn.innerHTML = `<span>${esc(label)}</span>${meta ? `<b>${esc(meta)}</b>` : ''}`;
  }

  window.GFOrder = {
    init(menu) { M = menu; adoptLegacy(); renderBar(); },
    // Called by the item sheet. Stores the line first, so a failure never loses it.
    add(line, from) {
      batches.push({ id: rid(), lines: [line] }); save(); renderBar();
      trigger = from || null; lastErr = ''; go();
    },
    open(from) {
      const mode = $('#barBtn')?.dataset.mode; trigger = from || null;
      if (mode === 'go') { lastErr = ''; go(); }
      else if (mode === 'draft') viewDraft();
      else if (mode === 'chat' && window.GrinFudChat) window.GrinFudChat.openWebsiteChat(from);
    },
    renderBar,
  };
  adoptLegacy();
  new MutationObserver(renderBar).observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();
