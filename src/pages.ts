import { MAX_CONTENT, type FormValues } from './feedback';
import { escapeHtml, htmlPage } from './html';
import { HTML_LANG, localized, STRINGS, TURNSTILE_LANG, type FormError, type Locale } from './i18n';
import type { ProductConfig } from './products';

// The feedback form is a plain HTML form: Turnstile puts its token into a hidden
// field, the browser posts, and the server answers with a redirect to the thanks
// page or the form again with the user's text kept. The only script enables the
// button once Turnstile has a token and stops double submits.

const TURNSTILE = 'https://challenges.cloudflare.com';

const STYLE = `:root{font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans",sans-serif;color:#292d25;background:#f7f6f0}
body{max-width:560px;margin:56px auto;padding:0 20px 48px}img{width:56px;height:56px}
h1{font-size:26px;line-height:1.35;margin:12px 0 6px;text-wrap:balance}.intro{margin:0 0 22px;color:#5b6152}
form{display:grid;gap:20px}fieldset{border:0;margin:0;padding:0}legend{font-weight:600;padding:0;margin-bottom:8px}
.kinds{display:flex;flex-wrap:wrap;gap:8px}.kinds label{position:relative}.kinds input{position:absolute;inset:0;margin:0;opacity:0;cursor:pointer}
.kinds span{display:inline-block;padding:5px 14px;border:1px solid #cfd6c4;border-radius:999px;background:#fff}
.kinds input:checked+span{background:#292d25;border-color:#292d25;color:#fff}.kinds input:focus-visible+span{outline:2px solid #6b8f3a;outline-offset:2px}
.field{display:grid;gap:6px}.field>span{font-weight:600}
textarea,input[type=email]{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid #d7dbcf;border-radius:10px;background:#fff;color:inherit;font:inherit}
textarea{min-height:168px;resize:vertical}textarea:focus,input[type=email]:focus{outline:2px solid #6b8f3a;outline-offset:1px}
small,.note{color:#6b7062;font-size:13px}.note{margin:0}
button{justify-self:start;padding:9px 30px;border:0;border-radius:10px;background:#292d25;color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.45;cursor:default}.cf-turnstile{min-height:65px}
.error{margin:0 0 18px;padding:10px 14px;border-radius:10px;background:#fbeae5;color:#8a2c17}a{color:#3f6212}`;

const SCRIPT = `
const form = document.querySelector('form');
const button = form.querySelector('button');
window.koeVerified = () => { if (!button.dataset.sent) button.disabled = false; };
window.koeExpired = () => { button.disabled = true; };
form.addEventListener('submit', (event) => {
  if (button.dataset.sent) { event.preventDefault(); return; }
  button.dataset.sent = '1';
  setTimeout(() => { button.disabled = true; });
});
`;

function productName(product: ProductConfig, locale: Locale): string {
  return localized(product.display_name, locale) ?? product.name;
}

function logo(product: ProductConfig, name: string): { html: string; origin: string | null } {
  try {
    if (product.logo_url) return { html: `<img src="${escapeHtml(product.logo_url)}" alt="${escapeHtml(name)}">`, origin: new URL(product.logo_url).origin };
  } catch { /* no logo */ }
  return { html: '', origin: null };
}

const localeHeaders = (locale: Locale) => ({ 'Content-Language': HTML_LANG[locale], Vary: 'Accept-Language' });

export interface FormState {
  version: string | null;
  values?: FormValues;
  error?: FormError;
  status?: number;
}

export function feedbackPage(key: string, product: ProductConfig, locale: Locale, siteKey: string, state: FormState): Response {
  const t = STRINGS[locale];
  const name = productName(product, locale);
  const mark = logo(product, name);
  const chosen = state.values?.kind && (product.kinds as string[]).includes(state.values.kind) ? state.values.kind : product.kinds[0];
  const kinds = product.kinds
    .map((kind) => `<label><input type="radio" name="kind" value="${kind}"${kind === chosen ? ' checked' : ''} required><span>${escapeHtml(t.kinds[kind])}</span></label>`)
    .join('');
  return htmlPage(t.title(name), STYLE, (nonce) => `${mark.html}
<h1>${escapeHtml(t.title(name))}</h1>
<p class="intro">${escapeHtml(t.intro)}</p>
${state.error ? `<p class="error" role="alert">${escapeHtml(t.errors[state.error](MAX_CONTENT))}</p>` : ''}
<form method="post" action="/${escapeHtml(key)}">
<input type="hidden" name="lang" value="${locale}">${state.version ? `<input type="hidden" name="v" value="${escapeHtml(state.version)}">` : ''}
<fieldset><legend>${escapeHtml(t.kind)}</legend><div class="kinds">${kinds}</div></fieldset>
<label class="field"><span>${escapeHtml(t.content)}</span><textarea name="content" maxlength="${MAX_CONTENT}" required>${escapeHtml(state.values?.content ?? '')}</textarea><small>${escapeHtml(t.contentHint(MAX_CONTENT))}</small></label>
<label class="field"><span>${escapeHtml(t.email)}</span><input type="email" name="email" maxlength="254" autocomplete="email" value="${escapeHtml(state.values?.email ?? '')}"><small>${escapeHtml(t.emailHint)}</small></label>
<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-language="${TURNSTILE_LANG[locale]}" data-theme="light" data-size="flexible" data-callback="koeVerified" data-expired-callback="koeExpired" data-error-callback="koeExpired"></div>
<button type="submit" disabled>${escapeHtml(t.submit)}</button>
<p class="note">${escapeHtml(t.privacy)}</p>
</form>
<script nonce="${nonce}">${SCRIPT}</script>
<script nonce="${nonce}" src="${TURNSTILE}/turnstile/v0/api.js" async defer></script>`, {
    status: state.status,
    lang: HTML_LANG[locale],
    scriptSrc: [TURNSTILE],
    frameSrc: [TURNSTILE],
    imgSrc: mark.origin ? [mark.origin] : [],
    headers: localeHeaders(locale),
  });
}

export function thanksPage(product: ProductConfig, locale: Locale): Response {
  const t = STRINGS[locale];
  const name = productName(product, locale);
  const mark = logo(product, name);
  return htmlPage(`${t.thanksTitle} · ${name}`, STYLE, () => `${mark.html}
<h1>${escapeHtml(t.thanksTitle)}</h1>
<p>${escapeHtml(t.thanksBody)}</p>
<p>${escapeHtml(t.thanksReply)}</p>`, {
    lang: HTML_LANG[locale],
    imgSrc: mark.origin ? [mark.origin] : [],
    headers: localeHeaders(locale),
  });
}

export function unavailablePage(product: ProductConfig, locale: Locale): Response {
  const t = STRINGS[locale];
  const name = productName(product, locale);
  return htmlPage(t.title(name), STYLE, () => `<h1>${escapeHtml(t.title(name))}</h1>
<p>${escapeHtml(t.unavailable)}</p>`, { status: 503, lang: HTML_LANG[locale], headers: localeHeaders(locale) });
}
