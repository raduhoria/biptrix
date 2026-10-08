// Copied from altbet-ai-knowledge-base/chatbot/core/smtp.js — keep the two in sync.
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

// Minimal SMTP client (RFC 5321) on node:net / node:tls — enough to send
// transactional mail through a provider or relay, with no npm dependency:
//   - secure: true  → implicit TLS from the first byte (usually port 465)
//   - secure: false → plain connection upgraded with STARTTLS when the server
//     offers it (usually 587); credentials are never sent unencrypted
//   - AUTH PLAIN or LOGIN when a user is set; none for open relays
// Messages are multipart/alternative (text + HTML), UTF-8, base64 encoded.

// Only a mail server on this machine may be used without TLS.
export function isLocalHost(host) {
  return /^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(String(host));
}

function encodeHeader(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function formatAddress({ email, name }) {
  return name ? `${encodeHeader(name.replace(/["\\]/g, ''))} <${email}>` : `<${email}>`;
}

function base64Lines(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
}

export function buildMessage({ from, to, subject, text, html, messageIdDomain }) {
  const boundary = `alt-${randomBytes(12).toString('hex')}`;
  const domain = messageIdDomain || from.email.split('@')[1] || 'localhost';
  return [
    `From: ${formatAddress(from)}`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

// One SMTP session: reads multi-line replies ("250-…" … "250 …") and sends
// commands, failing on any unexpected reply code.
function createSession(socket, timeoutMs) {
  let current = socket;
  let buffer = '';
  let waiter = null;
  let failure = null;

  function attach(sock) {
    current = sock;
    sock.setEncoding('utf8');
    sock.setTimeout(timeoutMs, () => fail(new Error('SMTP server timed out')));
    sock.on('data', (chunk) => {
      buffer += chunk;
      flush();
    });
    sock.on('error', fail);
  }

  function fail(err) {
    failure = failure || err;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(failure);
    }
    current.destroy();
  }

  function flush() {
    if (!waiter) return;
    const lines = buffer.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const reply = lines.slice(0, i + 1);
        buffer = lines.slice(i + 1).join('\r\n');
        const w = waiter;
        waiter = null;
        w.resolve({ code: Number(reply[i].slice(0, 3)), lines: reply.map((l) => l.slice(4)) });
        return;
      }
    }
  }

  function read() {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      waiter = { resolve, reject };
      flush();
    });
  }

  async function command(line, expected, label = line.split(' ')[0]) {
    if (line !== null) current.write(`${line}\r\n`);
    const reply = await read();
    if (!expected.includes(reply.code)) {
      throw new Error(`SMTP ${label} failed: ${reply.code} ${reply.lines.join(' ')}`.trim());
    }
    return reply;
  }

  attach(socket);
  return {
    command,
    write: (data) => current.write(data),
    // STARTTLS: wrap the existing socket and keep talking over TLS.
    upgrade(options) {
      return new Promise((resolve, reject) => {
        current.removeAllListeners('data');
        const secured = tls.connect({ ...options, socket: current }, () => {
          attach(secured);
          resolve();
        });
        secured.once('error', reject);
      });
    },
    close: () => current.end(),
  };
}

function connect({ host, port, secure, timeoutMs, tlsOptions }) {
  return new Promise((resolve, reject) => {
    const options = { host, port, servername: host, ...tlsOptions };
    const socket = secure ? tls.connect(options) : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Could not connect to ${host}:${port} (timeout)`));
    }, timeoutMs);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not connect to ${host}:${port}: ${err.message}`));
    });
  });
}

// sendMail: resolves with { accepted: true, response } or rejects with the
// server's reply in the error message.
export async function sendMail(config, { to, subject, text, html }) {
  const { host, port, secure, user, password, fromEmail, fromName, timeoutMs = 20_000, tlsOptions = {} } = config;
  if (!host || !fromEmail) throw new Error('SMTP is not configured');
  for (const addr of [to, fromEmail]) {
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(String(addr))) throw new Error(`Invalid email address: ${addr}`);
  }
  const session = createSession(await connect({ host, port, secure, timeoutMs, tlsOptions }), timeoutMs);
  // EHLO with the sender's domain: relays such as smtp-relay.gmail.com use it
  // to tell which Workspace domain the mail belongs to (a bare machine name
  // like a WSL hostname is not accepted as one).
  const helo = fromEmail.split('@')[1] || os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  try {
    await session.command(null, [220], 'greeting');
    let ehlo = await session.command(`EHLO ${helo}`, [250]);
    let encrypted = !!secure;
    if (!encrypted && ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) {
      await session.command('STARTTLS', [220]);
      await session.upgrade({ servername: host, ...tlsOptions });
      encrypted = true;
      ehlo = await session.command(`EHLO ${helo}`, [250]);
    }
    // Sign-in codes and invitations must not cross the network in clear,
    // with or without SMTP AUTH (relays included). Only a server on this
    // machine may be used without TLS.
    if (!encrypted && !isLocalHost(host)) {
      throw new Error('The SMTP server does not offer TLS; refusing to send mail unencrypted. Use port 465 with SSL/TLS or a server with STARTTLS.');
    }
    if (user) {
      const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l)) || '';
      if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
        await session.command(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString('base64')}`, [235], 'AUTH');
      } else {
        await session.command('AUTH LOGIN', [334], 'AUTH');
        await session.command(Buffer.from(user).toString('base64'), [334], 'AUTH user');
        await session.command(Buffer.from(password).toString('base64'), [235], 'AUTH');
      }
    }
    await session.command(`MAIL FROM:<${fromEmail}>`, [250]);
    await session.command(`RCPT TO:<${to}>`, [250, 251]);
    await session.command('DATA', [354]);
    const message = buildMessage({ from: { email: fromEmail, name: fromName }, to, subject, text, html });
    // Dot-stuffing: a line starting with "." gets a second one.
    session.write(message.replace(/(^|\r\n)\./g, '$1..') + '\r\n.\r\n');
    const done = await session.command(null, [250], 'DATA');
    await session.command('QUIT', [221]).catch(() => {});
    return { accepted: true, response: done.lines.join(' ') };
  } finally {
    session.close();
  }
}
