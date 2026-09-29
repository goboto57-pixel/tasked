// Theme: light (default) / dark. Persisted in localStorage 'tasked_theme'.
(function () {
  const KEY = 'tasked_theme';
  function get() {
    try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; }
    catch (e) { return 'light'; }
  }
  function paintBtn() {
    document.querySelectorAll('[data-theme-btn]').forEach((b) => {
      const t = document.documentElement.dataset.theme || 'light';
      b.innerHTML = `<i data-icon="${t === 'light' ? 'moon' : 'sun'}"></i>`;
      b.title = t === 'light' ? 'Тёмная тема' : 'Светлая тема';
      b.setAttribute('aria-label', b.title);
      if (window.paintIcons) paintIcons(b);
    });
  }
  function apply(t) {
    document.documentElement.dataset.theme = t;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t === 'light' ? '#f3f5f7' : '#17222e';
    paintBtn();
  }
  window.toggleTheme = () => {
    const next = (document.documentElement.dataset.theme || 'light') === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch (e) {}
    apply(next);
  };
  document.addEventListener('DOMContentLoaded', () => apply(get()));
})();
