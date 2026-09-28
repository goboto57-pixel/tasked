// Voice layer: Fish Audio (primary, female voice, s2.1-pro-free via server proxy)
// + browser TTS fallback + Azure Speech STT (ru-RU / kk-KZ).
(function () {
  let audioEl = null;
  let voicesLoaded = [];

  function lang() {
    return (window.i18n && i18n.get()) || 'ru';
  }
  function sttLang() {
    return lang() === 'kk' ? 'kk-KZ' : 'ru-RU';
  }

  function stopAll() {
    try { if (audioEl) { audioEl.pause(); audioEl.src = ''; } } catch (e) {}
    try { speechSynthesis && speechSynthesis.cancel(); } catch (e) {}
  }

  async function fishSpeak(text) {
    const r = await fetch('/api/voice/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 1000), lang: lang() }),
    });
    if (!r.ok) throw new Error('fish ' + r.status);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    stopAll();
    audioEl = new Audio(url);
    await audioEl.play();
    return true;
  }

  function browserSpeak(text) {
    return new Promise((resolve) => {
      try {
        if (typeof speechSynthesis === 'undefined') return resolve(false);
        const target = lang() === 'kk' ? 'kk' : 'ru';
        const vs = speechSynthesis.getVoices();
        const match = vs.filter((v) => (v.lang || '').toLowerCase().startsWith(target))[0]
          || vs.filter((v) => (v.lang || '').toLowerCase().startsWith('ru'))[0];
        if (!match && !vs.length) return resolve(false);
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        if (match) { u.voice = match; u.lang = match.lang; }
        else u.lang = target === 'kk' ? 'kk-KZ' : 'ru-RU';
        u.rate = 1;
        u.onend = () => resolve(true);
        u.onerror = () => resolve(false);
        speechSynthesis.speak(u);
        // safety: if no voices at all, resolve true anyway (no crash)
        setTimeout(() => resolve(true), 300);
      } catch (e) { resolve(false); }
    });
  }

  if (typeof speechSynthesis !== 'undefined') {
    const load = () => { voicesLoaded = speechSynthesis.getVoices(); };
    load();
    speechSynthesis.onvoiceschanged = load;
  }

  async function azureSpeak(text) {
    try {
      const cfg = await (await fetch('/api/speech/config')).json();
      if (!window.SpeechSDK || !cfg.key) return false;
      const sc = SpeechSDK.SpeechConfig.fromSubscription(cfg.key, cfg.region);
      sc.speechSynthesisVoiceName = (cfg.voices && cfg.voices[lang()]) || 'ru-RU-SvetlanaNeural';
      const syn = new SpeechSDK.SpeechSynthesizer(sc, null);
      await new Promise((res) => syn.speakTextAsync(text, () => { syn.close(); res(); }, () => res()));
      return true;
    } catch (e) { return false; }
  }

  // Public: speak text in current language. Fish first, then browser, then Azure.
  async function speak(text, opts) {
    if (!text || (opts && opts.silent)) return;
    try { await fishSpeak(text); return; } catch (e) {}
    const ok = await browserSpeak(text);
    if (!ok) azureSpeak(text);
  }

  window.Voice = { speak, stopAll, sttLang, lang, fishSpeak };
})();
