// Theme: dark (default) / light. Persisted in localStorage 'tasked_theme'.
(function () {
  const KEY = 'tasked_theme';
  function get() {
    try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; }
    catch (e) { return 'dark'; }
  }
  function paintBtn() {
    document.querySelectorAll('[data-theme-btn]').forEach((b) => {
      const t = document.documentElement.dataset.theme || 'dark';
      b.innerHTML = `<i data-icon="${t === 'light' ? 'moon' : 'sun'}"></i>`;
      b.title = t === 'light' ? 'Тёмная тема' : 'Светлая тема';
      if (window.paintIcons) paintIcons(b);
    });
  }
  function apply(t) {
    document.documentElement.dataset.theme = t;
    paintBtn();
  }
  window.toggleTheme = () => {
    const next = (document.documentElement.dataset.theme || 'dark') === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch (e) {}
    apply(next);
  };
  document.addEventListener('DOMContentLoaded', () => apply(get()));
})();
