import { LOCALES } from '../core/i18n.js';
import { qrSvg } from '../core/qr.js';
import { alerts, authPage, escapeHtml, fmtDate, icon, page } from './layout.js';

// Each language is named in itself, so anyone can find their own.
const LANGUAGE_NAMES = { en: 'English', ro: 'Română', es: 'Español' };

const field = ({ label, name, type = 'text', value = '', required = true, autocomplete = '', attrs = '', help = '' }) => `
  <div class="mb-3">
    <label class="form-label" for="f-${name}">${escapeHtml(label)}</label>
    <input class="form-control form-control-lg" id="f-${name}" name="${name}" type="${type}" value="${escapeHtml(value)}"${required ? ' required' : ''}${autocomplete ? ` autocomplete="${autocomplete}"` : ''} ${attrs}>
    ${help ? `<div class="form-text">${escapeHtml(help)}</div>` : ''}
  </div>`;

const submit = (label) => `<button class="btn btn-primary btn-lg w-100" type="submit">${escapeHtml(label)}</button>`;

export function loginView({ t, email = '', next = '', error = '', notice = '' }) {
  return authPage({
    t,
    title: t('auth.signInTitle'),
    subtitle: escapeHtml(t('auth.signInSubtitle')),
    path: '/login',
    body: `${alerts({ notice, error })}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${escapeHtml(next)}">
        ${field({ label: t('auth.email'), name: 'email', type: 'email', value: email, autocomplete: 'username', attrs: 'autofocus' })}
        ${field({ label: t('auth.password'), name: 'password', type: 'password', autocomplete: 'current-password' })}
        ${submit(t('auth.signIn'))}
      </form>
      <div class="auth-or"><span>${escapeHtml(t('auth.or'))}</span></div>
      <a class="btn btn-outline-primary btn-lg w-100" href="/login/code${next ? `?next=${encodeURIComponent(next)}` : ''}">${escapeHtml(t('auth.useCode'))}</a>
      <div class="text-center mt-3"><a href="/forgot">${escapeHtml(t('auth.forgot'))}</a></div>`,
  });
}

// Passwordless sign-in: e-mail, then the 6-digit code.
export function codeLoginView({ t, email = '', next = '', step = 'email', error = '', notice = '' }) {
  const body =
    step === 'code'
      ? `<form method="post" action="/login/code/verify">
          <input type="hidden" name="next" value="${escapeHtml(next)}"><input type="hidden" name="email" value="${escapeHtml(email)}">
          <label class="form-label" for="f-code">${escapeHtml(t('guest.codeLabel'))}</label>
          <input class="form-control form-control-lg text-center otp-input mb-3" id="f-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required autofocus>
          ${submit(t('auth.signIn'))}
        </form>
        <form method="post" action="/login/code" class="text-center mt-3"><input type="hidden" name="next" value="${escapeHtml(next)}"><input type="hidden" name="email" value="${escapeHtml(email)}"><button class="btn btn-link">${escapeHtml(t('guest.resend'))}</button></form>`
      : `<form method="post" action="/login/code">
          <input type="hidden" name="next" value="${escapeHtml(next)}">
          ${field({ label: t('auth.email'), name: 'email', type: 'email', value: email, autocomplete: 'username', attrs: 'autofocus' })}
          ${submit(t('auth.sendCode'))}
        </form>`;
  return authPage({
    t,
    title: t('auth.codeTitle'),
    subtitle: escapeHtml(t('auth.codeSubtitle')),
    path: '/login/code',
    body: `${alerts({ notice, error })}${body}<div class="text-center mt-3"><a href="/login${next ? `?next=${encodeURIComponent(next)}` : ''}">${escapeHtml(t('auth.usePassword'))}</a></div>`,
  });
}

export function mfaLoginView({ t, next = '', error = '' }) {
  return authPage({
    t,
    title: t('auth.mfaTitle'),
    subtitle: escapeHtml(t('auth.mfaSubtitle')),
    path: '/login/mfa',
    body: `${alerts({ error })}
      <form method="post" action="/login/mfa">
        <input type="hidden" name="next" value="${escapeHtml(next)}">
        ${field({ label: t('auth.code'), name: 'code', autocomplete: 'one-time-code', attrs: 'inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autofocus' })}
        ${submit(t('auth.verify'))}
      </form>
      <form method="post" action="/logout" class="text-center mt-3"><button class="btn btn-link">${escapeHtml(t('auth.signOut'))}</button></form>`,
  });
}

export function setupView({ t, values = {}, error = '', token = '' }) {
  return authPage({
    t,
    title: t('setup.title'),
    subtitle: escapeHtml(t('setup.subtitle')),
    path: '/setup',
    body: `${alerts({ error })}
      <form method="post" action="/setup">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        ${field({ label: t('setup.orgName'), name: 'org_name', value: values.org_name, attrs: 'autofocus' })}
        ${field({ label: t('auth.name'), name: 'name', value: values.name, autocomplete: 'name' })}
        ${field({ label: t('auth.email'), name: 'email', type: 'email', value: values.email, autocomplete: 'username' })}
        ${field({ label: t('auth.newPassword'), name: 'password', type: 'password', autocomplete: 'new-password', help: t('auth.passwordRule'), attrs: 'minlength="10"' })}
        ${submit(t('setup.create'))}
      </form>`,
  });
}

export function forgotView({ t, sent = false, error = '' }) {
  return authPage({
    t,
    title: t('auth.forgotTitle'),
    subtitle: escapeHtml(t('auth.forgotSubtitle')),
    path: '/forgot',
    body: sent
      ? `<div class="alert alert-success">${escapeHtml(t('auth.forgotSent'))}</div><a class="btn btn-outline-secondary w-100" href="/login">${escapeHtml(t('common.back'))}</a>`
      : `${alerts({ error })}<form method="post" action="/forgot">
          ${field({ label: t('auth.email'), name: 'email', type: 'email', autocomplete: 'username', attrs: 'autofocus' })}
          ${submit(t('auth.sendLink'))}
        </form>`,
  });
}

export function resetView({ t, token, error = '' }) {
  return authPage({
    t,
    title: t('auth.resetTitle'),
    path: `/reset/${token}`,
    body: `${alerts({ error })}<form method="post" action="/reset/${escapeHtml(token)}">
      ${field({ label: t('auth.newPassword'), name: 'password', type: 'password', autocomplete: 'new-password', help: t('auth.passwordRule'), attrs: 'minlength="10" autofocus' })}
      ${submit(t('auth.savePassword'))}
    </form>`,
  });
}

// Organization invitation: new people create their account here; someone
// already signed in with the invited e-mail just joins.
export function inviteView({ t, invite, token, user, error = '' }) {
  const sameUser = user && user.email === invite.email;
  const body = sameUser
    ? `<form method="post" action="/invite/${escapeHtml(token)}">${submit(t('invite.join', { org: invite.org_name }))}</form>`
    : user
      ? `<div class="alert alert-warning">${escapeHtml(t('invite.otherAccount', { email: user.email }))}</div>
         <form method="post" action="/logout"><input type="hidden" name="next" value="/invite/${escapeHtml(token)}"><button class="btn btn-outline-secondary w-100">${escapeHtml(t('auth.signOut'))}</button></form>`
      : invite.has_account
        ? `<p>${escapeHtml(t('invite.signInFirst'))}</p><a class="btn btn-primary btn-lg w-100" href="/login/code?next=${encodeURIComponent(`/invite/${token}`)}&email=${encodeURIComponent(invite.email)}">${escapeHtml(t('auth.useCode'))}</a>
           <a class="btn btn-link w-100 mt-1" href="/login?next=${encodeURIComponent(`/invite/${token}`)}&email=${encodeURIComponent(invite.email)}">${escapeHtml(t('auth.usePassword'))}</a>`
        : `<form method="post" action="/invite/${escapeHtml(token)}">
            ${field({ label: t('auth.email'), name: 'email_display', value: invite.email, required: false, attrs: 'disabled' })}
            ${field({ label: t('auth.name'), name: 'name', autocomplete: 'name', attrs: 'autofocus' })}
            ${field({ label: t('invite.passwordOptional'), name: 'password', type: 'password', required: false, autocomplete: 'new-password', help: t('invite.passwordHelp'), attrs: 'minlength="10"' })}
            ${submit(t('invite.create'))}
          </form>`;
  const external = invite.role === 'external';
  return authPage({
    t,
    title: invite.space_name ? t('invite.spaceTitle', { space: invite.space_name, org: invite.org_name }) : t('invite.title', { org: invite.org_name }),
    subtitle: escapeHtml(`${t('invite.subtitle', { email: invite.email })}${external ? ` ${t('invite.externalNote')}` : ''}`),
    path: `/invite/${token}`,
    body: alerts({ error }) + body,
  });
}

// Notifications on devices (Web Push): enable this one, the subscribed
// devices (each removable), a test, and whether the message text is shown.
function pushSection(t, user, push) {
  const rows = push.devices
    .map(
      (d) => `<li class="list-group-item d-flex justify-content-between align-items-center gap-2">
        <div class="small"><div>${icon('bell')} ${escapeHtml(d.device || '—')}${d.active ? '' : ` <span class="badge text-bg-secondary">${escapeHtml(t('account.pushSignedOut'))}</span>`}</div>
          <div class="text-body-secondary">${escapeHtml(t('account.pushSince', { date: fmtDate(d.created_at) }))}${d.last_sent_at ? ` · ${escapeHtml(t('account.pushLast', { date: fmtDate(d.last_sent_at) }))}` : ''}</div></div>
        <form method="post" action="/account/push/remove"><input type="hidden" name="endpoint" value="${escapeHtml(d.endpoint)}"><button class="btn btn-sm btn-outline-danger">${escapeHtml(t('account.pushRemove'))}</button></form>
      </li>`
    )
    .join('');
  return `<section class="card mb-4" id="push"><div class="card-body">
    <h2 class="h6 text-uppercase text-body-secondary mb-2">${escapeHtml(t('account.push'))}</h2>
    <p class="small text-body-secondary">${escapeHtml(t('account.pushWhy'))}</p>
    <div class="d-flex flex-wrap gap-2 mb-3">
      <button type="button" class="btn btn-primary btn-sm" data-push-enable data-key="${escapeHtml(push.key)}">${icon('bell')} ${escapeHtml(t('account.pushEnable'))}</button>
      <form method="post" action="/account/push/test"><button class="btn btn-outline-secondary btn-sm">${escapeHtml(t('account.pushTest'))}</button></form>
    </div>
    ${rows ? `<ul class="list-group mb-3">${rows}</ul>` : `<p class="small text-body-secondary">${escapeHtml(t('account.pushNone'))}</p>`}
    <form method="post" action="/account/push/preview" class="form-check form-switch">
      <input type="hidden" name="preview" value="${user.push_preview ? '0' : '1'}">
      <input class="form-check-input" type="checkbox" role="switch" id="push-preview"${user.push_preview ? ' checked' : ''} data-autosubmit>
      <label class="form-check-label small" for="push-preview">${escapeHtml(t('account.pushPreview'))}</label>
    </form>
    <p class="small text-body-secondary mt-2 mb-0">${escapeHtml(t('account.pushHint'))}</p>
  </div></section>`;
}

// Account: profile, language, password, MFA, sessions.
export function accountView({ t, user, orgs, sessions, currentHash, notice = '', error = '', mfaSetup = null, next = '', hasPassword = true, codeSent = false, push = null }) {
  const back = orgs[0] ? `/o/${orgs[0].slug}` : '/';
  const mfa = user.mfa_enabled
    ? `<p class="mb-3"><span class="badge text-bg-success">${icon('shield')} ${escapeHtml(t('account.mfaOn'))}</span></p>
       <form method="post" action="/account/mfa/disable" class="row g-2 align-items-end">
         <div class="col-sm-4"><label class="form-label" for="dis-pass">${escapeHtml(t('account.currentPassword'))}</label><input class="form-control" id="dis-pass" type="password" name="password" autocomplete="current-password" required></div>
         <div class="col-sm-4"><label class="form-label" for="dis-code">${escapeHtml(t('auth.code'))}</label><input class="form-control" id="dis-code" name="code" inputmode="numeric" required></div>
         <div class="col-sm-4"><button class="btn btn-outline-danger w-100">${escapeHtml(t('account.mfaDisable'))}</button></div>
       </form>`
    : mfaSetup
      ? `<ol class="small ps-3">
           <li>${escapeHtml(t('account.mfaStep1'))}</li>
           <li>${escapeHtml(t('account.mfaScan'))}
             <div class="mfa-qr my-2">${qrSvg(mfaSetup.uri, { label: t('account.mfaScan') })}</div>
             <div class="small text-body-secondary">${escapeHtml(t('account.mfaStep2'))}</div>
             <div class="font-monospace fs-5 user-select-all bg-body-tertiary rounded p-2 my-2 text-break">${escapeHtml(mfaSetup.secret.match(/.{1,4}/g).join(' '))}</div>
             <a class="small" href="${escapeHtml(mfaSetup.uri)}">${escapeHtml(t('account.mfaOpenApp'))}</a></li>
           <li>${escapeHtml(t('account.mfaStep3'))}</li>
         </ol>
         <form method="post" action="/account/mfa/enable" class="row g-2 align-items-end">
           <input type="hidden" name="next" value="${escapeHtml(next)}">
           <div class="col-sm-4"><label class="form-label" for="en-pass">${escapeHtml(t('account.currentPassword'))}</label><input class="form-control" id="en-pass" type="password" name="password" autocomplete="current-password" required></div>
           <div class="col-sm-4"><label class="form-label" for="en-code">${escapeHtml(t('auth.code'))}</label><input class="form-control" id="en-code" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus></div>
           <div class="col-sm-4"><button class="btn btn-primary w-100">${escapeHtml(t('account.mfaEnable'))}</button></div>
         </form>`
      : `<p class="text-body-secondary small">${escapeHtml(t('account.mfaWhy'))}</p><a class="btn btn-primary" href="/account/mfa${next ? `?next=${encodeURIComponent(next)}` : ''}">${escapeHtml(t('account.mfaSetup'))}</a>`;

  const sessionRows = sessions
    .map(
      (s) => `<li class="list-group-item d-flex justify-content-between align-items-center gap-2">
        <div class="small"><div class="text-truncate" style="max-width: 32rem">${escapeHtml(s.user_agent || '—')}</div><div class="text-body-secondary">${escapeHtml(s.ip || '')} · ${fmtDate(s.last_seen_at)}</div></div>
        ${s.id_hash === currentHash ? `<span class="badge text-bg-primary">${escapeHtml(t('account.thisDevice'))}</span>` : ''}
      </li>`
    )
    .join('');

  return page({
    t,
    title: t('account.title'),
    bodyClass: 'console-body',
    scripts: push ? ['console.js', 'push.js'] : ['console.js'],
    body: `<main class="container py-4" style="max-width: 760px">
  <a class="btn btn-sm btn-link px-0 mb-2" href="${escapeHtml(back)}">${icon('chevron-left')} ${escapeHtml(t('common.back'))}</a>
  <h1 class="h4 mb-4">${escapeHtml(t('account.title'))}</h1>
  ${alerts({ notice, error })}
  <section class="card mb-4"><div class="card-body">
    <h2 class="h6 text-uppercase text-body-secondary mb-3">${escapeHtml(t('account.profile'))}</h2>
    <form method="post" action="/account/profile" class="row g-3">
      <div class="col-md-6"><label class="form-label" for="p-name">${escapeHtml(t('auth.name'))}</label><input class="form-control" id="p-name" name="name" value="${escapeHtml(user.name)}" required maxlength="80"></div>
      <div class="col-md-6"><label class="form-label">${escapeHtml(t('auth.email'))}</label><input class="form-control" value="${escapeHtml(user.email)}" disabled></div>
      <div class="col-md-6"><label class="form-label" for="p-lang">${escapeHtml(t('account.language'))}</label>
        <select class="form-select" id="p-lang" name="locale">${LOCALES.map((code) => `<option value="${code}" lang="${code}"${(user.locale || t.locale) === code ? ' selected' : ''}>${escapeHtml(LANGUAGE_NAMES[code] || code)}</option>`).join('')}</select>
        <div class="form-text">${escapeHtml(t('account.languageHelp'))}</div></div>
      <div class="col-12"><button class="btn btn-primary">${escapeHtml(t('common.save'))}</button></div>
    </form>
  </div></section>
  <section class="card mb-4"><div class="card-body">
    <h2 class="h6 text-uppercase text-body-secondary mb-3">${escapeHtml(t('account.password'))}</h2>
    ${hasPassword ? '' : `<p class="small text-body-secondary">${escapeHtml(t('account.noPassword'))}</p>`}
    ${
      hasPassword || codeSent
        ? `<form method="post" action="/account/password" class="row g-3">
      ${
        hasPassword
          ? `<div class="col-md-6"><label class="form-label" for="p-cur">${escapeHtml(t('account.currentPassword'))}</label><input class="form-control" id="p-cur" type="password" name="current" autocomplete="current-password" required></div>`
          : `<div class="col-md-6"><label class="form-label" for="p-code">${escapeHtml(t('account.emailCode'))}</label><input class="form-control" id="p-code" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus></div>`
      }
      <div class="col-md-6"><label class="form-label" for="p-new">${escapeHtml(t('auth.newPassword'))}</label><input class="form-control" id="p-new" type="password" name="password" autocomplete="new-password" minlength="10" required><div class="form-text">${escapeHtml(t('auth.passwordRule'))}</div></div>
      <div class="col-12"><button class="btn btn-primary">${escapeHtml(t(hasPassword ? 'account.changePassword' : 'account.setPassword'))}</button></div>
    </form>`
        : `<form method="post" action="/account/password/code"><button class="btn btn-primary">${escapeHtml(t('account.sendCode'))}</button></form>`
    }
  </div></section>
  <section class="card mb-4" id="mfa"><div class="card-body">
    <h2 class="h6 text-uppercase text-body-secondary mb-3">${escapeHtml(t('account.mfa'))}</h2>
    ${mfa}
  </div></section>
  ${push ? pushSection(t, user, push) : ''}
  <section class="card mb-4"><div class="card-body">
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h2 class="h6 text-uppercase text-body-secondary mb-0">${escapeHtml(t('account.sessions'))}</h2>
      <form method="post" action="/account/sessions/revoke"><button class="btn btn-sm btn-outline-danger">${escapeHtml(t('account.signOutOthers'))}</button></form>
    </div>
    <ul class="list-group">${sessionRows}</ul>
  </div></section>
  <form method="post" action="/logout"><button class="btn btn-outline-secondary">${icon('logout')} ${escapeHtml(t('auth.signOut'))}</button></form>
</main>`,
  });
}

// Organization picker (/) for people in several organizations.
export function orgPickerView({ t, user, orgs, isOperator }) {
  const items = orgs
    .map(
      (o) => `<a class="list-group-item list-group-item-action d-flex align-items-center gap-3 py-3" href="/o/${escapeHtml(o.slug)}">
        <span class="org-avatar" style="--org:${escapeHtml(o.brand_color || '#4f46e5')}">${escapeHtml(o.name.slice(0, 2).toUpperCase())}</span>
        <span class="flex-grow-1"><strong>${escapeHtml(o.name)}</strong><br><small class="text-body-secondary">${escapeHtml(t(`roles.${o.role}`))}${o.status !== 'active' ? ` · ${escapeHtml(t('org.suspended'))}` : ''}</small></span>
        ${icon('chevron-left', 'flip')}
      </a>`
    )
    .join('');
  return authPage({
    t,
    title: t('org.pickTitle'),
    subtitle: escapeHtml(t('org.pickSubtitle', { name: user.name })),
    body: `${orgs.length ? `<div class="list-group mb-3">${items}</div>` : `<div class="alert alert-info">${escapeHtml(t('org.none'))}</div>`}
      ${isOperator ? `<a class="btn btn-outline-warning w-100 mb-2" href="/platform">${icon('building')} ${escapeHtml(t('platform.title'))}</a>` : ''}
      <div class="d-flex gap-2"><a class="btn btn-outline-secondary flex-fill" href="/account">${icon('user')} ${escapeHtml(t('account.title'))}</a>
      <form method="post" action="/logout" class="flex-fill"><button class="btn btn-outline-secondary w-100">${icon('logout')} ${escapeHtml(t('auth.signOut'))}</button></form></div>`,
  });
}
