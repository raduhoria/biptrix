// Admin/operator consoles and account page: local times and confirmations.
const fmt = new Intl.DateTimeFormat({ en: 'en-GB', ro: 'ro-RO', es: 'es-ES' }[document.documentElement.lang] || 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
for (const el of document.querySelectorAll('time[datetime]')) {
  const d = new Date(el.getAttribute('datetime'));
  if (!Number.isNaN(d.getTime())) el.textContent = fmt.format(d);
}

// <form data-confirm="..."> asks before submitting (no inline handlers: CSP).
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset?.confirm;
  if (msg && !confirm(msg)) e.preventDefault();
});

// <input data-autosubmit> submits its form when changed (switches).
document.addEventListener('change', (e) => {
  if (e.target.matches?.('[data-autosubmit]')) e.target.form.requestSubmit();
});
