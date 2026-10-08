// Admin/operator consoles and account page: local times and confirmations.
const fmt = new Intl.DateTimeFormat(document.documentElement.lang === 'ro' ? 'ro-RO' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
for (const el of document.querySelectorAll('time[datetime]')) {
  const d = new Date(el.getAttribute('datetime'));
  if (!Number.isNaN(d.getTime())) el.textContent = fmt.format(d);
}

// <form data-confirm="..."> asks before submitting (no inline handlers: CSP).
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset?.confirm;
  if (msg && !confirm(msg)) e.preventDefault();
});
