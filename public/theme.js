(() => {
  'use strict';
  const key = 'l5z12-theme';
  const labels = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  const next = { auto: 'light', light: 'dark', dark: 'auto' };
  let theme = 'auto';
  try {
    const saved = localStorage.getItem(key);
    if (Object.hasOwn(labels, saved)) theme = saved;
  } catch { /* Storage may be unavailable; retain an in-memory preference. */ }
  function apply() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    const button = document.getElementById('theme-btn');
    if (button) {
      button.textContent = labels[theme];
      button.setAttribute('aria-label', `Theme: ${labels[theme]}. Switch to ${labels[next[theme]]}.`);
      button.title = `Theme: ${labels[theme]} — click to cycle`;
    }
  }
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('theme-btn').addEventListener('click', () => {
      theme = next[theme];
      apply();
      try { localStorage.setItem(key, theme); } catch { /* Keep the session preference. */ }
    });
  });
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) {
      theme = Object.hasOwn(labels, event.newValue) ? event.newValue : 'auto';
      apply();
    }
  });
})();
