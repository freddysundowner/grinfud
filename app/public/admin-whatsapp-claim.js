window.mountWhatsAppClaim = function (host, pending, reload) {
  host.innerHTML = `<h3>Connect a Lead Intel number</h3>
    <p class="muted">Verify ownership by SMS—no Meta setup. After verification, new customer chats come here. Replies from existing Lead Intel leads still go to that business.</p>
    <form data-claim><div data-fields></div><p role="status" data-message></p>
    <button class="btn btn-p" data-go>Check number</button>
    <button class="btn btn-o" type="button" data-back>Back / refresh</button></form>`;
  const form = host.querySelector('form'), fields = host.querySelector('[data-fields]');
  const message = host.querySelector('[data-message]'), go = host.querySelector('[data-go]');
  host.querySelector('[data-back]').onclick = reload;
  let phase, phone;
  function render() {
    const usable = pending && !['expired', 'failed'].includes(pending.status);
    phase = usable ? (pending.status === 'code_sent' ? 'verify' : 'unknown') : 'lookup';
    fields.innerHTML = phase === 'verify'
      ? '<label class="f" for="claim-code">Six-digit SMS code</label><input class="t" id="claim-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>'
      : phase === 'lookup' ? '<label class="f" for="claim-phone">WhatsApp number</label><input class="t" id="claim-phone" type="tel" placeholder="+254…" autocomplete="tel" required>' : '';
    go.textContent = phase === 'verify' ? 'Verify & connect' : 'Check number';
    go.hidden = phase === 'unknown';
    go.style.display = phase === 'unknown' ? 'none' : '';
    go.disabled = phase === 'unknown';
    message.textContent = phase === 'verify' ? `Code sent to ${pending.phone}. Expires ${new Date(pending.expires_at).toLocaleTimeString()}. Up to ${pending.attempts_left} attempts remaining.`
      : phase === 'unknown' ? 'Code sending could not be confirmed. Wait for the ten-minute expiry, then refresh before trying again.'
      : pending ? 'The previous code is no longer usable. Check the number to send a new code.' : '';
  }
  render();
  async function request(action, body) {
    const r = await fetch('/api/admin/whatsapp/claims/' + action, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) { const e = new Error(data.error || 'Could not connect this number.'); e.status = r.status; throw e; }
    return data;
  }
  form.onsubmit = async e => {
    e.preventDefault();
    go.disabled = true;
    try {
      if (phase === 'lookup') {
        phone = host.querySelector('#claim-phone').value.trim();
        const checked = await request('lookup', { phone });
        if (!checked.claimable) throw new Error('This number is not claimable. It may belong to another platform connection.');
        phase = 'send';
        host.querySelector('#claim-phone').readOnly = true;
        go.textContent = 'Send SMS verification code';
        message.textContent = 'This number can be connected. Send a code to its SIM, then enter it here to route new customer chats to this site.';
      } else if (phase === 'send') {
        pending = await request('start', { phone });
        render();
      } else if (phase === 'verify') {
        await request('verify', { code: host.querySelector('#claim-code').value });
        await reload();
      }
    } catch (error) {
      if (error.status === 410) { pending = { status: 'expired' }; render(); }
      if (phase === 'send' && error.status >= 500) {
        phase = 'unknown'; go.hidden = true; go.style.display = 'none';
      }
      message.textContent = error.message;
    } finally { go.disabled = phase === 'unknown'; }
  };
};
