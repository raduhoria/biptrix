import { sendMail } from './smtp.js';

// The sender of mail about an organization: its own address if it has one
// (set in its admin console), otherwise the platform's (undefined).
export const orgSender = (org) => (org?.email_from ? { email: org.email_from, name: org.email_from_name || org.name } : undefined);

// createMailer: sends through the configured SMTP relay. Without SMTP_HOST
// (development) the mail is printed to the console instead, so OTP codes and
// invitation links can still be followed locally. `sent` keeps the last few
// for tests. `sender` ({ email, name }, see orgSender) replaces the platform
// sender for that message; the relay must accept that domain (Google
// Workspace SMTP relay: "only addresses in my domains").
export function createMailer({ smtp, quiet = false }) {
  const sent = [];

  async function send({ to, subject, text, html, sender }) {
    const from = sender?.email ? { fromEmail: sender.email, fromName: sender.name || smtp.fromName } : {};
    sent.push({ to, subject, text, html, from: from.fromEmail || smtp.fromEmail, fromName: from.fromName || smtp.fromName, at: Date.now() });
    if (sent.length > 50) sent.shift();
    if (!smtp.host) {
      if (!quiet) console.log(`\n[mail → ${to}] ${subject}\n${text}\n`);
      return { accepted: true, response: 'console' };
    }
    return sendMail({ ...smtp, ...from }, { to, subject, text, html });
  }

  // Fire-and-forget for request paths: a slow relay must not hold the HTTP
  // response; failures are logged.
  function queue(message) {
    send(message).catch((err) => console.error(`Mail to ${message.to} failed:`, err.message));
  }

  return { send, queue, sent, configured: () => !!smtp.host };
}
