// Receipt PDFs: window.GFReceipt. Links keep a real same-origin href; clicks fetch as a blob so
// server errors show as readable text instead of a raw JSON page.
(function () {
  const LABEL = { order: 'Order summary PDF', payment: 'M-Pesa payment receipt PDF', delivery: 'Delivery note PDF' };
  const types = t => { const a = Array.isArray(t) ? t.filter(x => LABEL[x]) : []; if (!a.includes('order')) a.unshift('order'); return a; };
  const trackUrl = (token, type) => '/api/track/' + encodeURIComponent(token) + '/receipt.pdf?type=' + encodeURIComponent(type);
  const adminUrl = (code, type) => '/api/admin/orders/' + encodeURIComponent(code) + '/receipt.pdf?type=' + encodeURIComponent(type);
  async function download(url, fallback) {
    let r;
    try { r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' }); }
    catch { throw new Error('Could not download. Check your connection and try again.'); }
    if (!r.ok) {
      let m = ''; try { const d = await r.json(); m = d && d.error; } catch {}
      throw new Error(m || (r.status === 401 ? 'Please log in again to download this.' : r.status === 404 ? 'This receipt is not available for this order yet.' : r.status === 429 ? 'Too many downloads. Wait a minute and try again.' : 'Could not download the PDF.'));
    }
    const blob = await r.blob();
    if (blob.type && !/pdf|octet/i.test(blob.type)) throw new Error('The server did not return a PDF. Try again shortly.');
    const cd = r.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    let name = fallback || 'receipt.pdf'; try { if (m) name = decodeURIComponent(m[1]); } catch {}
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.rel = 'noopener'; a.style.display = 'none';
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  document.addEventListener('click', async e => {
    const a = e.target.closest && e.target.closest('a[data-receipt]'); if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault(); if (a.getAttribute('aria-busy') === 'true') return;
    const box = a.closest('[data-rcpt-box]'), out = box && box.querySelector('.rcpt-err');
    const old = a.textContent; a.setAttribute('aria-busy', 'true'); a.textContent = 'Preparing…'; if (out) out.textContent = '';
    try { await download(a.getAttribute('href'), a.dataset.receipt || 'receipt.pdf'); }
    catch (x) { if (out) out.textContent = x.message; else alert(x.message); }
    finally { a.textContent = old; a.removeAttribute('aria-busy'); }
  });
  window.GFReceipt = { LABEL, types, trackUrl, adminUrl, download };
})();
// Compact M-Pesa (SunPay) panel. window.GFPay.mount(host, token) -> { destroy() }
// window.GFPay.tokenFromUrl(url) extracts the private token from /t/<token>.
// Never charges on its own: STK push only on an explicit button press.
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const POLL_MS = 5000, POLL_MAX = 120000;
  function tokenFromUrl(u) {
    try { const m = new URL(u, location.href).pathname.match(/\/t\/([^/?#]+)/); return m ? decodeURIComponent(m[1]) : null; } catch { return null; }
  }
  function mount(host, token) {
    if (!host || !token) return { destroy() {} };
    const url = '/api/track/' + encodeURIComponent(token) + '/payment';
    let P = null, busy = false, err = '', pollT = null, pollStart = 0, pollExpired = false, dead = false, phoneTyped = null;
    const el = document.createElement('section'); el.className = 'gfp'; el.setAttribute('aria-live', 'polite'); el.hidden = true;
    host.append(el);
    const money = n => 'KSh ' + Number(n || 0).toLocaleString('en-KE');
    const localPhone = p => { p = String(p || ''); return /^254\d{9}$/.test(p) ? '0' + p.slice(3) : p; };
    async function call(method, body) {
      const r = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(d.error || (r.status === 429 ? 'Too many attempts. Wait a minute and try again.' : r.status === 503 ? 'M-Pesa payments are not available right now.' : 'Could not reach M-Pesa payments.')); e.status = r.status; throw e; }
      return d;
    }
    const pending = () => P && (P.status === 'pending' || P.status === 'initiating');
    function stopPoll() { clearTimeout(pollT); pollT = null; }
    function schedule() {
      stopPoll(); if (dead || !pending()) return;
      if (Date.now() - pollStart >= POLL_MAX) { pollExpired = true; render(); return; }
      pollT = setTimeout(() => { if (dead) return; if (document.hidden) return schedule(); refresh(false); }, POLL_MS);
    }
    function startPoll() { pollStart = Date.now(); pollExpired = false; schedule(); }
    function onVis() { if (!document.hidden && pending() && !pollExpired && !pollT) schedule(); }
    document.addEventListener('visibilitychange', onVis);
    async function refresh(manual) {
      if (dead) return; if (manual) { busy = true; err = ''; render(); }
      try { P = await call('GET'); err = ''; } catch (e) { err = e.message; }
      busy = false; if (dead) return; render();
      if (pending()) { if (manual || !pollT) startPoll(); else schedule(); } else stopPoll();
    }
    async function pay() {
      if (busy || !P || !P.can_pay) return;
      const phone = (el.querySelector('#gfp-phone') || {}).value || '';
      if (!phone.trim()) { err = 'Enter the M-Pesa phone number to pay from.'; render(); return; }
      busy = true; err = ''; render();
      try { P = await call('POST', { phone: phone.trim() }); phoneTyped = null; }
      catch (e) {
        err = e.message;
        P = { ...P, status: 'unknown', can_pay: false };
        try { P = await call('GET'); } catch {}
      }
      busy = false; if (dead) return; render();
      if (pending()) startPoll();
    }
    function render() {
      if (dead) return;
      if (!P) { el.hidden = !err; el.innerHTML = err ? `<div class="gfp-lbl">M-Pesa payment</div><div class="gfp-msg bad">${esc(err)}</div><button class="gfp-btn o" data-a="check">Check payment status</button>` : ''; bind(); return; }
      const done = P.status === 'completed';
      if (!P.enabled && !done && !['initiating','pending','unknown'].includes(P.status)) { el.hidden = true; el.innerHTML = ''; return; }
      el.hidden = false;
      const badge = { completed: ['ok', 'Paid'], pending: ['wait', 'Awaiting M-Pesa'], initiating: ['wait', 'Sending prompt'], unknown: ['wait', 'Checking'], failed: ['bad', 'Not paid'], unpaid: ['', 'Unpaid'] }[P.status] || ['', 'Unpaid'];
      let body = '';
      if (done) body = `<div class="gfp-msg ok">Payment confirmed by M-Pesa.${P.receipt ? ` Receipt <span class="gfp-rc">${esc(P.receipt)}</span>` : ''}</div>
        <div data-rcpt-box style="margin-top:8px"><a class="gfp-btn o" data-receipt="payment-receipt.pdf" href="${esc(window.GFReceipt.trackUrl(token, 'payment'))}" style="display:inline-flex;align-items:center;justify-content:center;text-decoration:none">Payment receipt (PDF)</a><div class="rcpt-err" role="alert" style="color:#7A2717;font-weight:700;font-size:14px;margin-top:6px"></div></div>`;
      else if (pending()) body = `<div class="gfp-msg wait">${esc(P.message || 'Check your phone for the M-Pesa prompt and enter your PIN there.')} This order is not paid until M-Pesa confirms.</div>
        ${pollExpired ? '<div class="gfp-note">Still waiting. Tap Check payment status after you respond to the prompt.</div>' : '<div class="gfp-note">Checking automatically…</div>'}
        <button class="gfp-btn o" data-a="check" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Check payment status'}</button>`;
      else if (P.status === 'unknown') body = `<div class="gfp-msg wait">${esc(P.message || 'We could not confirm this payment yet.')} Do not pay again yet. Check your M-Pesa messages, then tap Check payment status.</div>
        <button class="gfp-btn o" data-a="check" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Check payment status'}</button>`;
      else {
        if (P.status === 'failed') body += `<div class="gfp-msg bad">${esc(P.message || 'The M-Pesa payment did not go through.')}</div>`;
        if (P.can_pay) {
          const ph = phoneTyped != null ? phoneTyped : localPhone(P.phone);
          body += `<label class="gfp-f" for="gfp-phone">M-Pesa phone number</label>
            <input class="gfp-in" id="gfp-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0712 345 678" value="${esc(ph)}" ${busy ? 'disabled' : ''}>
            <button class="gfp-btn p" data-a="pay" ${busy ? 'disabled' : ''}>${busy ? 'Sending prompt…' : (P.status === 'failed' ? 'Try M-Pesa again' : 'Pay with M-Pesa') + ' · ' + money(P.amount)}</button>
            <div class="gfp-note">We send a prompt to this phone. Enter your M-Pesa PIN only on that phone prompt. Never type your PIN on this website.</div>`;
        } else if (P.message) body += `<div class="gfp-note">${esc(P.message)}</div><button class="gfp-btn o" data-a="check" ${busy ? 'disabled' : ''}>Check payment status</button>`;
      }
      el.innerHTML = `<div class="gfp-h"><span class="gfp-lbl">M-Pesa payment</span><span class="gfp-badge ${badge[0]}">${badge[1]}</span></div>
        <div class="gfp-amt">${money(P.amount)}</div>${body}${err ? `<div class="gfp-msg bad" role="alert">${esc(err)}</div>` : ''}`;
      bind();
    }
    function bind() {
      el.querySelectorAll('[data-a]').forEach(b => b.onclick = () => b.dataset.a === 'pay' ? pay() : refresh(true));
      const i = el.querySelector('#gfp-phone'); if (i) { i.oninput = () => { phoneTyped = i.value; }; i.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); pay(); } }; }
    }
    refresh(false);
    return { destroy() { dead = true; stopPoll(); document.removeEventListener('visibilitychange', onVis); el.remove(); } };
  }
  window.GFPay = { mount, tokenFromUrl };
})();
