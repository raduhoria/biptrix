import { escapeHtml } from './layout.js';

// Transactional e-mails: table layout with inline styles (Outlook/Gmail),
// plain-text alternative always included. Each returns { subject, text, html }.
function frame({ t, title, intro, button, buttonUrl, outro = '', code = '' }) {
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Segoe UI,Arial,sans-serif;color:#1f2430">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:#4f46e5;padding:18px 28px;color:#fff;font-size:18px;font-weight:700">${escapeHtml(t('app.name'))}</td></tr>
<tr><td style="padding:28px">
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>
<p style="font-size:15px;line-height:1.55;margin:0 0 20px">${intro}</p>
${code ? `<div style="font-size:32px;letter-spacing:8px;font-weight:700;text-align:center;background:#f1f2ff;border-radius:10px;padding:16px;margin:0 0 20px">${escapeHtml(code)}</div>` : ''}
${button ? `<p style="margin:0 0 20px"><a href="${escapeHtml(buttonUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:600">${escapeHtml(button)}</a></p>
<p style="font-size:12px;color:#6b7280;word-break:break-all;margin:0 0 16px">${escapeHtml(buttonUrl)}</p>` : ''}
${outro ? `<p style="font-size:13px;color:#6b7280;line-height:1.5;margin:0">${outro}</p>` : ''}
</td></tr></table>
<p style="font-size:11px;color:#9aa0aa;margin-top:16px">${escapeHtml(t('email.footer'))}</p>
</td></tr></table></body></html>`;
  const strip = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [title, '', strip(intro), code ? `\n${code}\n` : '', buttonUrl ? `${button}: ${buttonUrl}` : '', outro ? `\n${strip(outro)}` : ''].join('\n');
  return { subject: title, text, html };
}

export const orgInviteEmail = ({ t, org, inviter, url }) =>
  frame({
    t,
    title: t('email.orgInviteTitle', { org }),
    intro: escapeHtml(t('email.orgInviteIntro', { inviter, org })),
    button: t('email.orgInviteButton'),
    buttonUrl: url,
    outro: escapeHtml(t('email.expires7')),
  });

export const meetingInviteEmail = ({ t, org, inviter, title, when, url, otp }) =>
  frame({
    t,
    title: t('email.meetingInviteTitle', { title }),
    intro: escapeHtml(t('email.meetingInviteIntro', { inviter, org, title, when })),
    button: t('email.meetingInviteButton'),
    buttonUrl: url,
    outro: escapeHtml(otp ? t('email.meetingInviteOtp') : t('email.meetingInviteNoOtp')),
  });

export const memberMeetingEmail = ({ t, org, inviter, title, when, url }) =>
  frame({
    t,
    title: t('email.meetingInviteTitle', { title }),
    intro: escapeHtml(t('email.meetingInviteIntro', { inviter, org, title, when })),
    button: t('email.meetingInviteButton'),
    buttonUrl: url,
  });

export const otpEmail = ({ t, title, code }) =>
  frame({ t, title: t('email.otpTitle'), intro: escapeHtml(t('email.otpIntro', { title })), code, outro: escapeHtml(t('email.otpOutro')) });

export const resetEmail = ({ t, url }) =>
  frame({ t, title: t('email.resetTitle'), intro: escapeHtml(t('email.resetIntro')), button: t('email.resetButton'), buttonUrl: url, outro: escapeHtml(t('email.resetOutro')) });

export const mentionEmail = ({ t, org, author, conversation, preview, url }) =>
  frame({
    t,
    title: t('email.mentionTitle', { author }),
    intro: `${escapeHtml(t('email.mentionIntro', { author, conversation, org }))}<br><br><em>${escapeHtml(preview)}</em>`,
    button: t('email.mentionButton'),
    buttonUrl: url,
  });

export const spaceInviteEmail = ({ t, org, inviter, space, url, days }) =>
  frame({
    t,
    title: t('email.spaceInviteTitle', { space, org }),
    intro: escapeHtml(t('email.spaceInviteIntro', { inviter, space, org })),
    button: t('email.spaceInviteButton'),
    buttonUrl: url,
    outro: escapeHtml(`${t('email.expires7')} ${days ? t('email.spaceAccessDays', { days }) : ''}`.trim()),
  });

export const loginCodeEmail = ({ t, code }) =>
  frame({ t, title: t('email.loginCodeTitle'), intro: escapeHtml(t('email.loginCodeIntro')), code, outro: escapeHtml(t('email.otpOutro')) });
