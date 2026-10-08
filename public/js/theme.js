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
