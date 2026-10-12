// Admin → Poster: pick a size, set headline + channels, preview the exact server render, download real PNG/PDF files, or print.
(function () {
  const CSS = `
#tab-poster .gp-wrap{max-width:720px;margin:0 auto}
#tab-poster .gp-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px}
#tab-poster .gp-head h2{font-size:26px}
#tab-poster .gp-card{padding:16px}
#tab-poster .gp-card .f:first-child{margin-top:0}
#tab-poster select.t,#tab-poster input.t{min-height:44px;font-size:16px;width:100%;min-width:0}
#tab-poster .toggle{min-height:44px;margin-top:6px}
#tab-poster .gp-acts{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-top:16px}
#tab-poster .gp-acts .btn{min-height:44px;justify-content:center;width:100%}
#tab-poster .gp-status{min-height:22px;margin-top:10px;font-size:14px}
#tab-poster .gp-status.err{margin-top:10px}
#tab-poster .gp-prev{margin:18px auto 0;position:relative;max-width:100%}
#tab-poster .gp-prev img{display:block;width:100%;height:auto;border-radius:12px;box-shadow:0 1px 0 rgba(20,61,39,.08),0 12px 30px -14px rgba(20,61,39,.35);transition:opacity .2s}
#tab-poster .gp-prev.busy img{opacity:.45}
#tab-poster .gp-skel{aspect-ratio:var(--ar);width:100%;border-radius:12px;background:linear-gradient(100deg,#EFE6D2 30%,#F7F1E3 50%,#EFE6D2 70%);background-size:300% 100%;animation:gpS 1.3s linear infinite}
@keyframes gpS{to{background-position:-150% 0}}
#tab-poster .gp-dim{text-align:center;font-size:13px;margin-top:8px}
@media(max-width:520px){#tab-poster .gp-acts{grid-template-columns:1fr 1fr}#tab-poster .gp-acts .gp-print{grid-column:1/-1}#tab-poster .gp-card{padding:14px}}
@media print{
  body *{visibility:hidden!important}
  #tab-poster .gp-prev,#tab-poster .gp-prev *{visibility:visible!important}
  #tab-poster .gp-prev{position:fixed;inset:0;margin:0;max-width:none!important;display:flex;align-items:center;justify-content:center}
  #tab-poster .gp-prev img{box-shadow:none;border-radius:0;max-height:100vh;width:auto;max-width:100%;opacity:1!important}
  #tab-poster .gp-dim{display:none}
}`;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

  const opt = { preset: 'wall-a4', headline: 'Scan to order', wa: true, site: true };
  let presets = null, info = null, seq = 0, ctrl = null, previewUrl = '', debounce = 0, busyDl = false;
  const qs = format => '/api/admin/poster/export?' + new URLSearchParams({ preset: opt.preset, format, headline: opt.headline, wa: opt.wa ? '1' : '0', site: opt.site ? '1' : '0' });
  async function fetchBlob(url, signal) {
    const r = await fetch(url, { credentials: 'include', cache: 'no-store', signal });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(r.status === 401 ? 'Please log in again.' : d.error || `Could not make the poster (error ${r.status}).`); }
    return r.blob();
  }

  async function render(box, { api, esc, toast }) {
    box.innerHTML = '<div class="gp-wrap"><div class="gp-skel" style="--ar:3/1"></div></div>';
    try { [presets, info] = await Promise.all([presets || api('/api/admin/poster/presets'), api('/api/admin/poster')]); }
    catch (x) { box.innerHTML = `<div class="gp-wrap"><p class="err">${esc(x.message)}</p><button class="btn btn-o" id="gp-retry">Try again</button></div>`; box.querySelector('#gp-retry').onclick = () => render(box, { api, esc, toast }); return; }
    const waReady = !!info.whatsapp_ready;
    box.innerHTML = `<div class="gp-wrap">
      <div class="gp-head"><h2>Posters</h2><span class="muted">${esc(info.business_name)} · ${esc(info.tagline)}</span></div>
      <div class="card gp-card">
        <label class="f" for="gp-size">Size</label>
        <select class="t" id="gp-size">${presets.map(p => `<option value="${esc(p.id)}" ${p.id === opt.preset ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
        <label class="f" for="gp-headline">Headline</label>
        <input class="t" id="gp-headline" maxlength="60" value="${esc(opt.headline)}" autocomplete="off">
        <label class="toggle"><input type="checkbox" id="gp-wa" ${opt.wa && waReady ? 'checked' : ''} ${waReady ? '' : 'disabled'}> WhatsApp QR code</label>
        ${waReady ? '' : '<p class="muted" style="margin:0 0 4px;font-size:14px">Link a WhatsApp number in Settings to add this code. The order-page code is used instead.</p>'}
        <label class="toggle"><input type="checkbox" id="gp-site" ${opt.site || !(opt.wa && waReady) ? 'checked' : ''}> Order-page QR code</label>
        <div class="gp-acts">
          <button class="btn btn-p" id="gp-png">Download PNG</button>
          <button class="btn btn-g" id="gp-pdf">Download PDF</button>
          <button class="btn btn-o gp-print" id="gp-print">Print</button>
        </div>
        <div class="gp-status muted" id="gp-status" role="status" aria-live="polite"></div>
      </div>
      <div class="gp-prev" id="gp-prev"></div>
      <div class="gp-dim muted" id="gp-dim"></div></div>`;
    const $$ = s => box.querySelector(s), status = $$('#gp-status');
    const say = (m, err) => { status.textContent = m; status.className = 'gp-status ' + (err ? 'err' : 'muted'); };
    const sync = () => { // never zero codes
      if (!waReady) opt.wa = false;
      if (!opt.wa && !opt.site) opt.site = true;
      $$('#gp-wa').checked = opt.wa && waReady; $$('#gp-site').checked = opt.site;
    };
    sync();

    async function preview() {
      const my = ++seq; if (ctrl) ctrl.abort(); ctrl = new AbortController();
      const p = presets.find(x => x.id === opt.preset), prev = $$('#gp-prev');
      if (!prev) return;
      prev.style.width = Math.min(100, p.width / p.height >= 1 ? 100 : (p.width / p.height) * 100 * 1.15) + '%';
      prev.style.maxWidth = p.width >= p.height ? '720px' : '420px';
      if (!prev.querySelector('img')) prev.innerHTML = `<div class="gp-skel" style="--ar:${p.width}/${p.height}"></div>`;
      prev.classList.add('busy'); $$('#gp-dim').textContent = `${p.width} × ${p.height} px`;
      try {
        const blob = await fetchBlob(qs('svg'), ctrl.signal);
        if (my !== seq) return;
        const url = URL.createObjectURL(blob), old = previewUrl; previewUrl = url;
        const img = new Image(); img.alt = `Poster preview, ${p.label}`;
        img.onload = () => { if (my !== seq) return; prev.innerHTML = ''; prev.appendChild(img); prev.classList.remove('busy'); if (old) setTimeout(() => URL.revokeObjectURL(old), 1500); };
        img.onerror = () => { if (my === seq) { prev.classList.remove('busy'); say('Preview could not be shown.', true); } };
        img.src = url; if (!busyDl) say('');
      } catch (x) {
        if (x.name === 'AbortError' || my !== seq) return;
        prev.classList.remove('busy'); prev.innerHTML = ''; say(x.message, true);
      }
    }

    async function download(format, btn) {
      if (busyDl) return; busyDl = true;
      const btns = box.querySelectorAll('.gp-acts .btn'); btns.forEach(b => b.disabled = true);
      const label = btn.textContent; btn.textContent = format === 'pdf' ? 'Making PDF…' : 'Making PNG…'; say('Preparing your file…');
      try {
        const blob = await fetchBlob(qs(format));
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = `${(info.business_name || 'grinfud').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'grinfud'}-${opt.preset}.${format}`;
        a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000); // mobile browsers read the blob after click; keep it alive
        say(`${format.toUpperCase()} downloaded (${Math.round(blob.size / 1024)} KB).`); toast(`${format.toUpperCase()} ready`);
      } catch (x) { say(x.message, true); }
      finally { busyDl = false; btns.forEach(b => b.disabled = false); btn.textContent = label; }
    }

    $$('#gp-size').onchange = e => { opt.preset = e.target.value; $$('#gp-prev').innerHTML = ''; preview(); };
    $$('#gp-headline').oninput = e => { const v = e.target.value.replace(/[<>]/g, ''); if (v !== e.target.value) e.target.value = v; opt.headline = v.trim() || 'Scan to order'; clearTimeout(debounce); debounce = setTimeout(preview, 450); };
    $$('#gp-wa').onchange = e => { opt.wa = e.target.checked; sync(); preview(); };
    $$('#gp-site').onchange = e => { opt.site = e.target.checked; if (!opt.site && !(opt.wa && waReady)) { say('At least one QR code stays on the poster.'); } sync(); preview(); };
    $$('#gp-png').onclick = e => download('png', e.currentTarget);
    $$('#gp-pdf').onclick = e => download('pdf', e.currentTarget);
    $$('#gp-print').onclick = () => { if (!$$('#gp-prev img')) return say('Wait for the preview, then print.', true); window.print(); };
    preview();
  }
  window.GrinPoster = { render };
})();
