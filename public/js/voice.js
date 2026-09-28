// Speech output prefers the configured Fish voice, then the matching Azure
// neural voice. Browser speech is the final fallback and only uses a known
// feminine Russian/Kazakh system voice.
(function () {
  let audioEl = null;
  let audioUrl = null;
  let ttsController = null;
  let azureSynth = null;
  let speechRun = 0;
  let voicesLoaded = [];

  function lang() {
    return (window.i18n && i18n.get()) || 'ru';
  }
  function sttLang() {
    return lang() === 'kk' ? 'kk-KZ' : 'ru-RU';
  }
  function getSpeed() {
    try {
      const value = Number(localStorage.getItem('tasked_speed'));
      return Number.isFinite(value) && value > 0 ? Math.min(1.5, Math.max(.5, value)) : 1;
    } catch (e) { return 1; }
  }
  function showCaption(text) {
    const el = document.getElementById('caption');
    if (!el) return;
    el.textContent = String(text).slice(0, 240);
    el.style.display = 'block';
  }
  function hideCaption() {
    const el = document.getElementById('caption');
    if (el) el.style.display = 'none';
  }
  function releaseAudio(expected) {
    if (expected && audioEl !== expected) return;
    const old = audioEl;
    audioEl = null;
    if (old) {
      old.onended = old.onerror = null;
      try { old.pause(); old.removeAttribute('src'); old.load(); } catch (e) {}
    }
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    }
  }
  function stopAll() {
    speechRun++;
    if (ttsController) { ttsController.abort(); ttsController = null; }
    releaseAudio();
    try { if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); } catch (e) {}
    if (azureSynth) {
      const old = azureSynth;
      azureSynth = null;
      try { old.close(); } catch (e) {}
    }
    hideCaption();
  }

  async function fishSpeak(text, run) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    ttsController = controller;
    try {
      const response = await fetch('/api/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: String(text).slice(0, 1000), lang: lang(), speed: getSpeed() }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('fish tts unavailable');
      const blob = await response.blob();
      if (!blob.size) throw new Error('empty fish audio');
      const url = URL.createObjectURL(blob);
      if (run !== speechRun) { URL.revokeObjectURL(url); return false; }
      releaseAudio();
      audioUrl = url;
      const player = new Audio(url);
      audioEl = player;
      player.preload = 'auto';
      player.onended = () => {
        if (run === speechRun) hideCaption();
        releaseAudio(player);
      };
      player.onerror = () => {
        if (run === speechRun) hideCaption();
        releaseAudio(player);
      };
      showCaption(text);
      await player.play();
      return true;
    } finally {
      clearTimeout(timeout);
      if (ttsController === controller) ttsController = null;
    }
  }

  async function getAzureConfig() {
    try {
      const response = await fetch('/api/speech/config');
      if (!response.ok) return null;
      const config = await response.json();
      return config.key && config.region ? config : null;
    } catch (e) { return null; }
  }

  async function azureSpeak(text, run) {
    try {
      const config = await getAzureConfig();
      if (run !== speechRun || !config || !window.SpeechSDK) return false;
      const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(config.key, config.region);
      speechConfig.speechSynthesisVoiceName = (config.voices && config.voices[lang()])
        || (lang() === 'kk' ? 'kk-KZ-AigulNeural' : 'ru-RU-SvetlanaNeural');
      const synthesizer = new SpeechSDK.SpeechSynthesizer(speechConfig, null);
      azureSynth = synthesizer;
      showCaption(text);
      return await new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => finish(false), 45000);
        function finish(ok) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (azureSynth === synthesizer) azureSynth = null;
          try { synthesizer.close(); } catch (e) {}
          if (run === speechRun) {
            if (!ok) hideCaption();
          }
          resolve(ok && run === speechRun);
        }
        synthesizer.speakTextAsync(text, (result) => {
          finish(result && result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted);
        }, () => finish(false));
      });
    } catch (e) {
      if (run === speechRun) hideCaption();
      return false;
    }
  }

  function waitForBrowserVoices() {
    if (typeof speechSynthesis === 'undefined') return Promise.resolve([]);
    const available = speechSynthesis.getVoices();
    if (available.length) return Promise.resolve(available);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        speechSynthesis.removeEventListener?.('voiceschanged', finish);
        resolve(speechSynthesis.getVoices());
      };
      const timer = setTimeout(finish, 1800);
      speechSynthesis.addEventListener?.('voiceschanged', finish, { once: true });
    });
  }

  async function browserSpeak(text, run) {
    if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return false;
    const locale = lang() === 'kk' ? 'kk' : 'ru';
    const voices = await waitForBrowserVoices();
    if (run !== speechRun) return false;
    const feminineName = /female|milena|svetlana|sveta|elena|yelena|anna|irina|polina|alena|alina|olga|katya|oksana|yulia|julia|marina|aigul|gul|айгул|светлана|елен|анна|ирина|полина|алена|алина|ольга|кат|оксана|юли|марина/i;
    const voice = voices.find((item) => (item.lang || '').toLowerCase().startsWith(locale)
      && feminineName.test((item.name || '') + ' ' + (item.voiceURI || '')));
    if (!voice) return false;
    try {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(String(text).slice(0, 1000));
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.rate = getSpeed();
      utterance.pitch = 1;
      showCaption(text);
      return await new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => finish(false), Math.min(90000, Math.max(15000, text.length * 100)));
        function finish(ok) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (run === speechRun && !ok) hideCaption();
          resolve(ok && run === speechRun);
        }
        utterance.onend = () => finish(true);
        utterance.onerror = () => finish(false);
        speechSynthesis.speak(utterance);
      });
    } catch (e) { return false; }
  }

  if (typeof speechSynthesis !== 'undefined') {
    const load = () => { voicesLoaded = speechSynthesis.getVoices(); };
    load();
    speechSynthesis.addEventListener?.('voiceschanged', load);
  }

  async function speak(text, opts) {
    const content = String(text || '').trim();
    if (!content || (opts && opts.silent)) return false;
    stopAll();
    const run = speechRun;
    try { if (await fishSpeak(content, run)) return true; } catch (e) {}
    if (run !== speechRun) return false;
    if (await azureSpeak(content, run)) return true;
    if (run !== speechRun) return false;
    return browserSpeak(content, run);
  }

  window.Voice = { speak, stopAll, sttLang, lang, fishSpeak };
})();
