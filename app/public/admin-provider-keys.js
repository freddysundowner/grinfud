window.mountProviderKeys = async function (host) {
  host.innerHTML = '<h3>API keys</h3><p role="status">Loading key status…</p>';
  async function request(path, init) {
    const r = await fetch('/api/admin/provider-keys' + path, { credentials: 'same-origin', cache: 'no-store', ...init });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not update API keys.');
    return data;
  }
  let state;
  try { state = await request(''); }
  catch (e) { host.querySelector('p').textContent = e.message; return; }
  if (!host.isConnected) return;
  host.innerHTML = '<h3>API keys</h3><p class="muted">Keys stay on the server. Leave a field blank to keep its current key.</p>';
  if (state.demo) {
    const note = document.createElement('p'); note.className = 'muted';
    note.textContent = 'Demo mode: Gemini calls Google directly. Your saved LeadsIntel key will be used when demo mode is turned off; WhatsApp currently uses the simulator.';
    host.append(note);
  }
  for (const [provider, name] of [['gemini', 'Google Gemini'], ['leadsintel', 'LeadsIntel'], ['sunpay', 'SunPay']].filter(([p]) => state[p])) {
    const form = document.createElement('form'); form.style.marginTop = '18px';
    form.innerHTML = `<label class="f" for="key-${provider}">${name} API key</label>
      <p class="muted" data-status style="margin:4px 0 8px"></p>
      <input class="t" id="key-${provider}" name="api-key" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="none" maxlength="512">
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px"><button class="btn btn-p">Save ${name} key</button><button class="btn btn-o" type="button" data-remove>Remove key</button></div>
      <p role="status" aria-live="polite" data-message style="margin-top:8px;overflow-wrap:anywhere"></p>`;
    host.append(form);
    const input = form.querySelector('input'), status = form.querySelector('[data-status]'), message = form.querySelector('[data-message]'), remove = form.querySelector('[data-remove]');
    function render(s) {
      status.textContent = s.source === 'unreadable' ? 'Saved key cannot be decrypted. Replace it to restore access.' :
        s.source === 'disabled' ? 'Key removed. This service is disabled.' : s.configured ?
          (s.source === 'admin' ? 'Saved by admin.' : provider === 'leadsintel' && state.demo ? 'Demo key configured on server.' : 'Configured on server. Add a key here to replace it.') : 'No key configured.';
      input.placeholder = s.configured ? 'Enter a new key to replace the current key' : 'Enter your API key';
      remove.disabled = !s.configured && s.source !== 'unreadable';
    }
    render(state[provider]);
    let pending = false;
    async function save(removeKey) {
      if (pending) return;
      if (!removeKey && !input.value.trim()) { message.textContent = 'No changes. The current key was kept.'; return; }
      pending = true;
      form.querySelectorAll('button').forEach(b => b.disabled = true);
      message.textContent = 'Saving…';
      try {
        state[provider] = await request('/' + provider, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(removeKey ? { remove: true } : { key: input.value.trim() })
        });
        input.value = '';
        message.textContent = removeKey ? 'Key removed. This service is disabled.' : 'Key saved. It has not been tested with the provider yet.';
      } catch (e) { message.textContent = e.message; }
      finally {
        pending = false; form.querySelectorAll('button').forEach(b => b.disabled = false);
        render(state[provider]);
      }
    }
    form.onsubmit = e => { e.preventDefault(); save(false); };
    remove.onclick = () => {
      if (window.confirm(`Remove the ${name} key? This disables ${provider === 'gemini' ? 'AI understanding and voice transcription' : provider === 'sunpay' ? 'M-Pesa payments for customers (the pay button is hidden; past receipts stay visible)' : 'WhatsApp API operations'} until a new key is saved.`)) save(true);
    };
  }
};
