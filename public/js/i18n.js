// Language: RU / KK chooser + minimal i18n. Stored in localStorage 'tasked_lang'.
(function () {
  const KEY = 'tasked_lang';
  const STR = {
    ru: {
      catalog: 'Каталог', nav: 'Навигация', account: 'Аккаунт',
      allTopics: 'Все темы', searchPh: 'Поиск тем…',
      heroEyebrow: 'Адаптивное обучение с ИИ',
      heroH: 'Выбери тему — остальное сделает ИИ',
      heroP: 'Короткая теория, задания под твой уровень и голосовой разбор. Прогресс сохраняется в твоём аккаунте.',
      heroCta: 'Выбрать тему', howItWorks: 'Как это работает',
      step1t: 'Выбери тему', step1d: 'Открой любую тему из каталога ниже',
      step2t: 'Изучи теорию', step2d: 'ИИ объяснит тему простыми словами',
      step3t: 'Решай задания', step3d: 'Сложность подстроится под твои ответы',
      cardMeta: 'Теория + задания + голос',
      start: 'Начать', howP: 'ИИ даёт теорию и задания. Каждое новое задание подстраивается под предыдущий ответ.',
      emptyT: 'Тем пока нет', emptyP: 'Темы создаёт учитель в панели управления.',
      openDash: 'Открыть панель учителя',
      login: 'Войти', logout: 'Выйти', student: 'Ученик', home: 'Главная',
      loginAsStudent: 'Войти как ученик',
      continueT: 'Продолжить', allTopicsBtn: 'Все темы',
      streakLbl: 'Верных подряд до завершения',
      copyLink: 'Ссылка', copied: 'Скопировано',
      footerTag: 'Адаптивное обучение с ИИ',
      teacherDash: 'Панель учителя', backCatalog: 'Назад в каталог',
      voiceAsst: 'Голосовой помощник', listen: 'Слушаю…',
      gateTitle: 'Тілді таңдаңыз / Выберите язык',
      gateSub: 'Интерфейс, озвучка и распознавание речи будут на выбранном языке.',
      theoryK: 'Шаг 1 · Теория', taskK: 'Шаг 2 · Задание',
      stTheory: 'Теория', stTask: 'Задание', stDone: 'Готово',
      yourAnswer: 'Твой ответ', answerPh: 'Напиши ответ или нажми «Диктовать»',
      check: 'Проверить', dictate: 'Диктовать',
      voiceHint: 'Не понял тему? Нажми «Голосовой помощник» — спроси учителя, он ответит голосом.',
      speakBtn: 'Озвучить', stopBtn: 'Стоп',
      check: 'Проверить', level: 'Уровень', attempts: 'История попыток',
      noAttempts: 'Здесь появятся твои попытки: верные и неверные.',
      askTeacher: 'Спросить ИИ-учителя', askPh: 'Спросить что-нибудь…',
      close: 'Закрыть', testVoice: 'Проверить голос',
    },
    kk: {
      catalog: 'Каталог', nav: 'Навигация', account: 'Аккаунт',
      allTopics: 'Барлық тақырыптар', searchPh: 'Тақырып іздеу…',
      heroEyebrow: 'ЖИ-мен бейімделген оқыту',
      heroH: 'Тақырып таңда — қалғанын ЖИ жасайды',
      heroP: 'Қысқа теория, деңгейіңе сай тапсырмалар және дауысты талдау. Прогресс аккаунтыңда сақталады.',
      heroCta: 'Тақырып таңдау', howItWorks: 'Бұл қалай жұмыс істейді',
      step1t: 'Тақырып таңда', step1d: 'Төмендегі каталогтан кез келген тақырыпты аш',
      step2t: 'Теорияны оқы', step2d: 'ЖИ тақырыпты қарапайым сөзбен түсіндіреді',
      step3t: 'Тапсырма орында', step3d: 'Күрделілік жауаптарыңа бейімделеді',
      cardMeta: 'Теория + тапсырма + дауыс',
      start: 'Бастау', howP: 'ЖИ теория мен тапсырма береді. Әр жаңа тапсырма алдыңғы жауапқа бейімделеді.',
      emptyT: 'Әзірге тақырып жоқ', emptyP: 'Тақырыптарды мұғалім басқару панелінде жасайды.',
      openDash: 'Мұғалім панелін ашу',
      login: 'Кіру', logout: 'Шығу', student: 'Оқушы', home: 'Басты бет',
      loginAsStudent: 'Оқушы ретінде кіру',
      continueT: 'Жалғастыру', allTopicsBtn: 'Барлық тақырыптар',
      streakLbl: 'Аяқтауға дейін қатарынан дұрыс',
      copyLink: 'Сілтеме', copied: 'Көшірілді',
      footerTag: 'ЖИ-мен бейімделген оқыту',
      teacherDash: 'Мұғалім панелі', backCatalog: 'Каталогқа қайту',
      voiceAsst: 'Дауыс көмекшісі', listen: 'Тыңдап тұрмын…',
      gateTitle: 'Тілді таңдаңыз / Выберите язык',
      gateSub: 'Интерфейс, дыбыстау және сөйлеуді тану таңдалған тілде болады.',
      theoryK: '1-қадам · Теория', taskK: '2-қадам · Тапсырма',
      stTheory: 'Теория', stTask: 'Тапсырма', stDone: 'Дайын',
      yourAnswer: 'Жауабың', answerPh: 'Жауапты жаз немесе «Айту» түймесін бас',
      check: 'Тексеру', dictate: 'Айту',
      voiceHint: 'Тақырыпты түсінбедің бе? «Дауыс көмекшісін» бас — мұғалімнен сұра, ол дауыстап жауап береді.',
      speakBtn: 'Дыбыстау', stopBtn: 'Тоқтату',
      level: 'Деңгей', attempts: 'Әрекеттер тарихы',
      noAttempts: 'Мұнда әрекеттерің көрінеді: дұрыс және қате.',
      askTeacher: 'ЖИ-мұғалімнен сұрау', askPh: 'Бірдеңе сұраңыз…',
      close: 'Жабу', testVoice: 'Дауысты тексеру',
    },
  };

  function get() {
    const v = localStorage.getItem(KEY);
    return v === 'kk' ? 'kk' : v === 'ru' ? 'ru' : null;
  }
  function set(l) {
    localStorage.setItem(KEY, l);
    document.documentElement.lang = l === 'kk' ? 'kk' : 'ru';
    apply(l);
    updateSwitcher(l);
  }
  function t(k) {
    const l = get() || 'ru';
    return (STR[l] && STR[l][k]) || STR.ru[k] || k;
  }
  function apply(l) {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const v = STR[l][el.getAttribute('data-i18n')];
      if (v) el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      const v = STR[l][el.getAttribute('data-i18n-ph')];
      if (v) el.placeholder = v;
    });
  }
  function updateSwitcher(l) {
    document.querySelectorAll('.lang-switch button').forEach((b) => {
      b.classList.toggle('active', b.dataset.lang === l);
    });
  }
  function ensureGate() {
    if (get()) { set(get()); return; }
    const g = document.getElementById('langGate');
    if (!g) { set('ru'); return; }
    g.style.display = 'flex';
  }
  window.i18n = { get, set, t, apply, ensureGate };
  document.addEventListener('DOMContentLoaded', () => {
    const cur = get() || 'ru';
    document.documentElement.lang = cur;
    apply(cur);
    updateSwitcher(cur);
    ensureGate();
    window.paintIcons && paintIcons(document);
  });
  window.setLang = (l) => {
    set(l);
    const g = document.getElementById('langGate');
    if (g) g.style.display = 'none';
    if (window.onLangChange) window.onLangChange(l);
  };
})();
