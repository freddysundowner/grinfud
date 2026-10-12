(() => {
  'use strict';
  const fab = document.getElementById('waFab'); if (!fab) return;
  const KEY = 'gf_tease_off';
  let off = false; try { off = sessionStorage.getItem(KEY) === '1'; } catch {}
  if (off) return;
  const Q = ['What’s for breakfast?', 'Need help choosing?', 'Ordering for the office?', 'Ready for a fresh start?'];
  const box = document.createElement('div'); box.className = 'gfl-tease';
  const q = document.createElement('button'); q.type = 'button'; q.className = 'gfl-q'; q.setAttribute('aria-haspopup', 'dialog');
  const x = document.createElement('button'); x.type = 'button'; x.className = 'gfl-x'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss suggestion');
  box.append(q, x); document.body.appendChild(box);
  let i = 0, held = false, timer = null;
  q.textContent = Q[0];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const paused = () => held || document.hidden || document.body.classList.contains('gfc-lock') || document.body.classList.contains('chat-disabled');
  function tick() {
    if (paused()) return;
    q.classList.add('fade');
    setTimeout(() => { i = (i + 1) % Q.length; q.textContent = Q[i]; q.classList.remove('fade'); }, 350);
  }
  if (!reduced) timer = setInterval(tick, 5000);
  box.addEventListener('mouseenter', () => held = true); box.addEventListener('mouseleave', () => held = false);
  box.addEventListener('focusin', () => held = true); box.addEventListener('focusout', () => held = false);
  q.onclick = () => { if (window.GrinFudChat) window.GrinFudChat.open(q); };
  x.onclick = () => { try { sessionStorage.setItem(KEY, '1'); } catch {} clearInterval(timer); box.remove(); fab.focus(); };
})();
