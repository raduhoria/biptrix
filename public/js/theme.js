// Loaded in <head> (not deferred) so the theme is set before first paint.
// Saved choice, else the OS preference. Toggle buttons: .theme-toggle.
(() => {
  const saved = localStorage.getItem('theme');
  const theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.bsTheme = theme;
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.theme-toggle')) return;
    const next = document.documentElement.dataset.bsTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.bsTheme = next;
    localStorage.setItem('theme', next);
  });
})();

// The browser's install offer (Chrome, Edge, Samsung Internet) comes once,
// often before the page's modules run: kept here for the chat page's own
// install banner (public/js/push.js), instead of the browser's mini-bar,
// which shows only now and then.
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  // Offered again: not (or no longer) installed.
  localStorage.removeItem('app.installed');
  window.installPrompt = e;
  dispatchEvent(new Event('installchange'));
});
addEventListener('appinstalled', () => {
  window.installPrompt = null;
  localStorage.setItem('app.installed', '1');
  dispatchEvent(new Event('installchange'));
});
