import { escapeHtml } from './layout.js';

// Transactional e-mails. Table layout with inline styles (Gmail, Outlook,
// Apple Mail), a bulletproof button with a VML fallback for Outlook on
// Windows, a hidden preheader, light/dark-aware colors where the client
// supports them, and a plain-text alternative. Each returns
// { subject, text, html }.
//
// Brand and base URL are set once at startup (configureEmails): the name in
// the header is the sender name (SMTP_FROM_NAME), so a deployment branded
// with its own sender name shows that name everywhere in the mail.
const brand = { name: 'BipTrix', url: '' };

export function configureEmails({ name, url }) {
  if (name) brand.name = name;
  brand.url = String(url || '').replace(/\/+$/, '');
}

const C = {
  bg: '#eef0f6',
  card: '#ffffff',
  border: '#e5e7ef',
  text: '#111827',
  body: '#374151',
  muted: '#6b7280',
  faint: '#9ca3af',
  brand: '#4f46e5',
  brandSoft: '#eef0ff',
  box: '#f7f8fc',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function button(label, url) {
  const href = escapeHtml(url);
  const text = escapeHtml(label);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 6px">
<tr><td align="center" bgcolor="${C.brand}" style="border-radius:10px">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${href}" style="height:48px;v-text-anchor:middle;width:260px" arcsize="20%" stroke="f" fillcolor="${C.brand}"><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">${text}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${href}" target="_blank" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:10px;background:${C.brand}">${text}</a><!--<![endif]-->
</td></tr></table>`;
}

// details: [[label, value], ...] — values are plain text.
function detailsBox(details) {
  const rows = details
    .filter(([, value]) => value)
    .map(
      ([label, value], i) => `<tr>
<td class="em-muted" style="padding:${i ? 10 : 0}px 12px 0 0;font-family:${FONT};font-size:13px;color:${C.muted};white-space:nowrap;vertical-align:top;width:1%">${escapeHtml(label)}</td>
<td class="em-strong" style="padding:${i ? 10 : 0}px 0 0;font-family:${FONT};font-size:14px;font-weight:600;color:${C.text};vertical-align:top">${escapeHtml(value)}</td>
</tr>`
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-box" style="background:${C.box};border:1px solid ${C.border};border-radius:12px;margin:4px 0 24px">
<tr><td style="padding:18px 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr></table>`;
}

function frame({ t, preheader, eyebrow, title, intro, details = [], quote = null, code = '', codeNote = '', action = null, outro = '' }) {
  const logo = brand.url ? `<img src="${escapeHtml(brand.url)}/img/email-logo.png" width="36" height="36" alt="" style="display:block;border:0;border-radius:9px">` : '';
  const host = brand.url ? brand.url.replace(/^https?:\/\//, '') : '';
  const html = `<!doctype html>
<html lang="${t.locale}" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
  @media (max-width: 620px) { .em-pad { padding: 28px 22px !important; } .em-code { font-size: 28px !important; letter-spacing: 6px !important; } }
  @media (prefers-color-scheme: dark) {
    .em-bg { background: #0f1117 !important; }
    .em-card { background: #171a23 !important; border-color: #2a2f3d !important; }
    .em-box { background: #1e2230 !important; border-color: #2a2f3d !important; }
    .em-strong, .em-title, .em-brand { color: #f3f4f6 !important; }
    .em-body { color: #cbd5e1 !important; }
    .em-muted { color: #9aa3b5 !important; }
    .em-divider { border-color: #2a2f3d !important; }
    .em-code { background: #23264a !important; color: #e0e7ff !important; border-color: #3b3f7a !important; }
  }
</style>
</head>
<body class="em-bg" style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader || '')}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-bg" style="background:${C.bg}">
<tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
    <tr><td style="padding:0 4px 18px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        ${logo ? `<td style="padding-right:10px">${logo}</td>` : ''}
        <td class="em-brand" style="font-family:${FONT};font-size:18px;font-weight:700;color:#1e1b4b;letter-spacing:-0.2px">${escapeHtml(brand.name)}</td>
      </tr></table>
    </td></tr>
    <tr><td class="em-card" style="background:${C.card};border:1px solid ${C.border};border-radius:16px;overflow:hidden">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="height:4px;line-height:4px;font-size:0;background:${C.brand};background-image:linear-gradient(90deg,#4f46e5,#22d3ee)">&nbsp;</td></tr>
        <tr><td class="em-pad" style="padding:36px 40px">
          ${eyebrow ? `<div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${C.brand};margin:0 0 10px">${escapeHtml(eyebrow)}</div>` : ''}
          <h1 class="em-title" style="font-family:${FONT};font-size:23px;line-height:1.3;font-weight:700;color:${C.text};margin:0 0 14px">${escapeHtml(title)}</h1>
          <p class="em-body" style="font-family:${FONT};font-size:15px;line-height:1.65;color:${C.body};margin:0 0 22px">${intro}</p>
          ${
            quote
              ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-box" style="background:${C.box};border-radius:12px;margin:0 0 24px"><tr>
              <td style="width:4px;background:${C.brand};border-radius:12px 0 0 12px"></td>
              <td style="padding:16px 20px;font-family:${FONT}"><div class="em-strong" style="font-size:13px;font-weight:700;color:${C.text};margin:0 0 6px">${escapeHtml(quote.author)}</div>
              <div class="em-body" style="font-size:15px;line-height:1.6;color:${C.body}">${escapeHtml(quote.text)}</div></td></tr></table>`
              : ''
          }
          ${
            code
              ? `<div class="em-code" style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:10px;text-align:center;color:#312e81;background:${C.brandSoft};border:1px dashed #c7cbff;border-radius:12px;padding:20px 12px;margin:0 0 10px">${escapeHtml(code)}</div>
              ${codeNote ? `<p class="em-muted" style="font-family:${FONT};font-size:13px;color:${C.muted};text-align:center;margin:0 0 24px">${escapeHtml(codeNote)}</p>` : ''}`
              : ''
          }
          ${details.length ? detailsBox(details) : ''}
          ${
            action
              ? `${button(action.label, action.url)}
              <p class="em-muted" style="font-family:${FONT};font-size:12px;line-height:1.5;color:${C.faint};margin:14px 0 0">${escapeHtml(t('email.buttonFallback'))}<br><a href="${escapeHtml(action.url)}" style="color:${C.brand};word-break:break-all;text-decoration:underline">${escapeHtml(action.url)}</a></p>`
              : ''
          }
          ${outro ? `<div class="em-divider" style="border-top:1px solid ${C.border};margin:26px 0 0;padding:18px 0 0"><p class="em-muted" style="font-family:${FONT};font-size:13px;line-height:1.6;color:${C.muted};margin:0">${outro}</p></div>` : ''}
        </td></tr>
      </table>
    </td></tr>
    <tr><td align="center" style="padding:20px 16px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.faint}">
      ${escapeHtml(t('email.sentBy', { brand: brand.name }))}${host ? ` · <a href="${escapeHtml(brand.url)}" style="color:${C.faint};text-decoration:underline">${escapeHtml(host)}</a>` : ''}<br>${escapeHtml(t('email.footer', { brand: brand.name }))}
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  const strip = (s) => String(s).replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [
    title,
    '',
    strip(intro),
    quote ? `\n${quote.author}:\n> ${quote.text}` : '',
    code ? `\n    ${code}\n${codeNote}` : '',
    details.filter(([, v]) => v).length ? `\n${details.filter(([, v]) => v).map(([l, v]) => `${l}: ${v}`).join('\n')}` : '',
    action ? `\n${action.label}:\n${action.url}` : '',
    outro ? `\n${strip(outro)}` : '',
    `\n—\n${t('email.sentBy', { brand: brand.name })}${host ? ` · ${host}` : ''}\n${t('email.footer', { brand: brand.name })}`,
  ]
    .filter((x) => x !== '')
    .join('\n');
  return { subject: title, text, html };
}

const ROLE = (t, role) => (role ? t(`roles.${role}`) : '');

export const orgInviteEmail = ({ t, org, inviter, url, role = '' }) =>
  frame({
    t,
    preheader: t('email.orgInviteIntro', { inviter, org }),
    eyebrow: t('email.eyebrow.invite'),
    title: t('email.orgInviteTitle', { org }),
    intro: escapeHtml(t('email.orgInviteIntro', { inviter, org })),
    details: [
      [t('email.labels.org'), org],
      [t('email.labels.invitedBy'), inviter],
      [t('email.labels.role'), ROLE(t, role)],
    ],
    action: { label: t('email.orgInviteButton'), url },
    outro: escapeHtml(t('email.expires7')),
  });

export const spaceInviteEmail = ({ t, org, inviter, space, url, days }) =>
  frame({
    t,
    preheader: t('email.spaceInviteIntro', { inviter, space, org }),
    eyebrow: t('email.eyebrow.collab'),
    title: t('email.spaceInviteTitle', { space, org }),
    intro: `${escapeHtml(t('email.spaceInviteIntro', { inviter, space, org }))} ${escapeHtml(t('email.spaceInviteScope'))}`,
    details: [
      [t('email.labels.space'), space],
      [t('email.labels.org'), org],
      [t('email.labels.invitedBy'), inviter],
      [t('email.labels.access'), days ? t('email.accessDays', { days }) : t('email.accessUnlimited')],
    ],
    action: { label: t('email.spaceInviteButton'), url },
    outro: escapeHtml(`${t('email.expires7')} ${t('email.noPasswordNeeded')}`),
  });

const meetingDetails = (t, { title, when, inviter, org }) => [
  [t('email.labels.meeting'), title],
  [t('email.labels.when'), when],
  [t('email.labels.organizer'), `${inviter} · ${org}`],
];

export const meetingInviteEmail = ({ t, org, inviter, title, when, url, otp }) =>
  frame({
    t,
    preheader: t('email.meetingInviteIntro', { inviter, org, title, when }),
    eyebrow: t('email.eyebrow.meeting'),
    title: t('email.meetingInviteTitle', { title }),
    intro: escapeHtml(t('email.meetingInviteLead', { inviter, org })),
    details: meetingDetails(t, { title, when, inviter, org }),
    action: { label: t('email.meetingInviteButton'), url },
    outro: escapeHtml(otp ? t('email.meetingInviteOtp') : t('email.meetingInviteNoOtp')),
  });

export const memberMeetingEmail = ({ t, org, inviter, title, when, url }) =>
  frame({
    t,
    preheader: t('email.meetingInviteIntro', { inviter, org, title, when }),
    eyebrow: t('email.eyebrow.meeting'),
    title: t('email.meetingInviteTitle', { title }),
    intro: escapeHtml(t('email.meetingInviteLead', { inviter, org })),
    details: meetingDetails(t, { title, when, inviter, org }),
    action: { label: t('email.meetingInviteButton'), url },
  });

export const otpEmail = ({ t, title, code }) =>
  frame({
    t,
    preheader: t('email.codePreheader', { code }),
    eyebrow: t('email.eyebrow.code'),
    title: t('email.otpTitle'),
    intro: escapeHtml(t('email.otpIntro', { title })),
    code,
    codeNote: t('email.codeExpires'),
    details: [[t('email.labels.meeting'), title]],
    outro: escapeHtml(t('email.codeIgnore')),
  });

export const loginCodeEmail = ({ t, code }) =>
  frame({
    t,
    preheader: t('email.codePreheader', { code }),
    eyebrow: t('email.eyebrow.login'),
    title: t('email.loginCodeTitle'),
    intro: escapeHtml(t('email.loginCodeIntro')),
    code,
    codeNote: t('email.codeExpires'),
    outro: escapeHtml(t('email.codeIgnore')),
  });

export const resetEmail = ({ t, url }) =>
  frame({
    t,
    preheader: t('email.resetIntro'),
    eyebrow: t('email.eyebrow.security'),
    title: t('email.resetTitle'),
    intro: escapeHtml(t('email.resetIntro')),
    action: { label: t('email.resetButton'), url },
    outro: escapeHtml(t('email.resetOutro')),
  });

export const mentionEmail = ({ t, org, author, conversation, preview, url }) =>
  frame({
    t,
    preheader: `${author}: ${preview}`,
    eyebrow: t('email.eyebrow.message'),
    title: t('email.mentionTitle', { author }),
    intro: escapeHtml(t('email.mentionLead', { conversation, org })),
    quote: { author, text: preview },
    details: [
      [t('email.labels.conversation'), conversation],
      [t('email.labels.org'), org],
    ],
    action: { label: t('email.mentionButton'), url },
  });
