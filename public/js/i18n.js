// Language: RU / KK chooser + minimal i18n. Stored in localStorage 'tasked_lang'.
(function () {
  const KEY = 'tasked_lang';
  const STR = {
    ru: {
      catalog: 'Каталог', allTopics: 'Все темы', searchPh: 'Поиск тем…',
      heroChip: 'Персонализация на базе ИИ', heroH: 'Учитесь умнее, а не дольше',
      heroP: 'Система подстраивает теорию, сложность и темп под ваши ответы в реальном времени. Выберите тему ниже.',
      start: 'Начать', howItWorks: 'Как это работает',
      howP: 'ИИ даёт теорию и задания. Каждое новое задание подстраивается под предыдущий ответ.',
      empty: 'Пока нет тем — их создаёт учитель в дэшборде.',
      login: 'Войти', logout: 'Выйти', student: 'Ученик', home: 'Главная',
      teacherDash: 'Дэшборд учителя', backCatalog: 'В каталог',
      voiceAsst: 'Голосовой помощник', listen: 'Слушаю…',
      gateTitle: 'Тілді таңдаңыз / Выберите язык',
      gateSub: 'Интерфейс, озвучка и распознавание речи будут на выбранном языке.',
      theory: 'Теория', task: 'Задание от ИИ', yourAnswer: 'Твой ответ',
      check: 'Проверить', level: 'Уровень', attempts: 'История попыток',
      askTeacher: 'Спросить ИИ-учителя', askPh: 'Спросить что-нибудь…',
      close: 'Закрыть', testVoice: 'Проверить голос',
    },
    kk: {
      catalog: 'Каталог', allTopics: 'Барлық тақырыптар', searchPh: 'Тақырып іздеу…',
      heroChip: 'ЖИ негізінде дербестендіру', heroH: 'Көп емес, ақылды оқы',
      heroP: 'Жүйе теорияны, күрделілікті және қарқынды жауаптарыңызға нақты уақытта бейімдейді. Төменнен тақырып таңдаңыз.',
      start: 'Бастау', howItWorks: 'Бұл қалай жұмыс істейді',
      howP: 'ЖИ теория мен тапсырма береді. Әр жаңа тапсырма алдыңғы жауапқа бейімделеді.',
      empty: 'Әзірге тақырып жоқ — оларды мұғалім дэшбордта жасайды.',
      login: 'Кіру', logout: 'Шығу', student: 'Оқушы', home: 'Басты бет',
      teacherDash: 'Мұғалім панелі', backCatalog: 'Каталогқа',
      voiceAsst: 'Дауыс көмекшісі', listen: 'Тыңдап тұрмын…',
      gateTitle: 'Тілді таңдаңыз / Выберите язык',
      gateSub: 'Интерфейс, дыбыстау және сөйлеуді тану таңдалған тілде болады.',
      theory: 'Теория', task: 'ЖИ тапсырмасы', yourAnswer: 'Жауабың',
      check: 'Тексеру', level: 'Деңгей', attempts: 'Әрекеттер тарихы',
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
  document.addEventListener('DOMContentListener' in window ? 'DOMContentLoaded' : 'DOMContentLoaded', () => {
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
  };
})();
