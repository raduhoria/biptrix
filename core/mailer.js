import { sendMail } from './smtp.js';

// createMailer: sends through the configured SMTP relay. Without SMTP_HOST
// (development) the mail is printed to the console instead, so OTP codes and
// invitation links can still be followed locally. `sent` keeps the last few
// for tests.
export function createMailer({ smtp, quiet = false }) {
  const sent = [];

  async function send({ to, subject, text, html }) {
    sent.push({ to, subject, text, html, at: Date.now() });
    if (sent.length > 50) sent.shift();
    if (!smtp.host) {
      if (!quiet) console.log(`\n[mail → ${to}] ${subject}\n${text}\n`);
      return { accepted: true, response: 'console' };
    }
    return sendMail(smtp, { to, subject, text, html });
  }

  // Fire-and-forget for request paths: a slow relay must not hold the HTTP
  // response; failures are logged.
  function queue(message) {
    send(message).catch((err) => console.error(`Mail to ${message.to} failed:`, err.message));
  }

  return { send, queue, sent, configured: () => !!smtp.host };
}
