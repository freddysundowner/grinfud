(() => {
  'use strict';
  // Audio capture + PCM WAV encoding only. No speech recognition/synthesis.
  const MAX_SEC = 60, MAX_FILE = 8 * 1024 * 1024, MAX_WAV = 2 * 1024 * 1024, RATE = 16000;
  const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder &&
    (window.AudioContext || window.webkitAudioContext) && window.OfflineAudioContext);
  const decodeSupported = () => !!((window.AudioContext || window.webkitAudioContext) && window.OfflineAudioContext);
  function pickMime() {
    const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/aac'];
    for (const t of c) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch {} }
    return '';
  }
  class VErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  async function toWav(blob) {
    if (blob.size > MAX_FILE) throw new VErr('too_big', 'That audio file is larger than 8 MB.');
    const buf = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    let audio;
    try {
      audio = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
    } catch { throw new VErr('decode', 'This audio format could not be read.'); }
    finally { try { ctx.close(); } catch {} }
    if (audio.duration > MAX_SEC + 0.5) throw new VErr('too_long', 'Voice notes can be up to 60 seconds.');
    if (audio.duration < 0.3) throw new VErr('no_speech', 'The recording was too short. Try again.');
    const len = Math.max(1, Math.ceil(Math.min(audio.duration, MAX_SEC) * RATE));
    const off = new OfflineAudioContext(1, len, RATE);
    const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start(0);
    const out = (await off.startRendering()).getChannelData(0);
    let peak = 0; for (let i = 0; i < out.length; i += 8) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
    if (peak < 0.01) throw new VErr('no_speech', 'No sound was picked up. Check your microphone and try again.');
    const ab = new ArrayBuffer(44 + out.length * 2), v = new DataView(ab);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + out.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, out.length * 2, true);
    for (let i = 0, o = 44; i < out.length; i++, o += 2) { const s = Math.max(-1, Math.min(1, out[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    const wav = new Blob([ab], { type: 'audio/wav' });
    if (wav.size > MAX_WAV) throw new VErr('too_big', 'The converted voice note is over 2 MB.');
    return wav;
  }
  // Recorder session; cancel() is safe at any time, including before permission resolves.
  function createRecorder({ onTick, onAutoStop }) {
    let stream = null, rec = null, chunks = [], timer = null, t0 = 0, dead = false, stopResolve = null;
    const release = () => { clearInterval(timer); timer = null; if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; };
    async function start() {
      if (!supported()) throw new VErr('unsupported', 'Voice notes are not supported in this browser.');
      let s;
      try { s = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
      catch (e) {
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw new VErr('denied', 'Microphone access was blocked. Allow it in your browser settings, or type instead.');
        if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) throw new VErr('nodevice', 'No microphone was found on this device.');
        throw new VErr('unsupported', 'The microphone could not be started.');
      }
      if (dead) { s.getTracks().forEach(t => t.stop()); throw new VErr('cancelled', ''); }
      stream = s;
      const mime = pickMime();
      rec = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => { release(); const r = stopResolve; stopResolve = null; if (r) r(dead ? null : new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' })); };
      rec.start(250); t0 = Date.now();
      timer = setInterval(() => {
        const sec = (Date.now() - t0) / 1000; onTick && onTick(Math.floor(sec));
        if (sec >= MAX_SEC) { onAutoStop && onAutoStop(); }
      }, 250);
    }
    function stop() {
      return new Promise(res => {
        if (!rec || rec.state === 'inactive') { release(); return res(null); }
        stopResolve = res; clearInterval(timer); timer = null; rec.stop();
      });
    }
    function cancel() {
      dead = true; clearInterval(timer); timer = null;
      if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch {} }
      release();
      if (stopResolve) { const r = stopResolve; stopResolve = null; r(null); }
    }
    return { start, stop, cancel };
  }
  window.GrinFudVoice = { supported, decodeSupported, createRecorder, toWav, MAX_SEC, MAX_FILE };
})();
