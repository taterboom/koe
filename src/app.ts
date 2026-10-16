import { handleAdmin } from './admin';
import { cleanCountry, cleanVersion, insertFeedback, parseSubmission, type FormValues } from './feedback';
import { BodyTooLarge, readForm, redirect, text } from './http';
import { pickLocale, supportedLocale, type FormError, type Locale } from './i18n';
import { notifyNew } from './notify';
import { feedbackPage, thanksPage, unavailablePage } from './pages';
import { isKnownProduct, type ProductConfig, type ProductMap } from './products';
import { verifyTurnstile } from './turnstile';

const browserLocale = (request: Request) => pickLocale(request.headers.get('Accept-Language'), null);

// Only `v` and `lang` are read from the link; anything else in it is ignored and never echoed.
function showForm(request: Request, env: Env, key: string, product: ProductConfig): Response {
  const params = new URL(request.url).searchParams;
  const locale = pickLocale(request.headers.get('Accept-Language'), params.get('lang'));
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) return unavailablePage(product, locale);
  return feedbackPage(key, product, locale, env.TURNSTILE_SITE_KEY, { version: cleanVersion(params.get('v')) });
}

async function submit(request: Request, env: Env, ctx: ExecutionContext, products: ProductMap, key: string): Promise<Response> {
  const product = products[key];
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) return unavailablePage(product, browserLocale(request));
  // Whitelist: these fields and nothing else are read from the form.
  const form = await readForm(request);
  const locale: Locale = supportedLocale(form.get('lang')) ?? browserLocale(request);
  const version = cleanVersion(form.get('v'));
  const values: FormValues = { kind: form.get('kind') ?? '', content: form.get('content') ?? '', email: form.get('email') ?? '' };
  const again = (error: FormError, status: number) =>
    feedbackPage(key, product, locale, env.TURNSTILE_SITE_KEY, { version, values, error, status });

  const parsed = parseSubmission(product, values);
  if (!parsed.ok) return again(parsed.error, 400);
  try {
    if (!(await verifyTurnstile(env.TURNSTILE_SECRET_KEY, form.get('cf-turnstile-response')))) return again('verify', 400);
    const record = await insertFeedback(env.DB, {
      product: key,
      ...parsed.submission,
      version,
      lang: locale,
      country: cleanCountry(request.cf?.country),
      created_at: Date.now(),
    });
    // Stored first; notifications run after the response and cannot lose it.
    ctx.waitUntil(notifyNew(env, products, record, new URL(request.url).origin));
  } catch (error) {
    console.error('submit_failed', key, error instanceof Error ? error.message : 'unknown');
    return again('server', 500);
  }
  return redirect(`/${key}/thanks?lang=${locale}`);
}

async function route(request: Request, env: Env, ctx: ExecutionContext, products: ProductMap): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'GET' && path === '/health') return Response.json({ service: 'koe', status: 'ok' });
  if (path === '/admin' || path.startsWith('/admin/')) return handleAdmin(request, env, products);
  const match = /^\/([a-z0-9_-]{1,64})(\/thanks)?$/.exec(path);
  if (!match || !isKnownProduct(products, match[1])) return text(404, 'Not found');
  const [, key, thanks] = match;
  if (request.method === 'GET' && !thanks) return showForm(request, env, key, products[key]);
  if (request.method === 'POST' && !thanks) return submit(request, env, ctx, products, key);
  if (request.method === 'GET' && thanks) {
    return thanksPage(products[key], pickLocale(request.headers.get('Accept-Language'), url.searchParams.get('lang')));
  }
  return text(405, 'Method not allowed');
}

export function createHandler(products: ProductMap): ExportedHandler<Env> {
  return {
    async fetch(request, env, ctx) {
      try {
        return await route(request, env, ctx, products);
      } catch (error) {
        if (error instanceof BodyTooLarge) return text(413, 'Payload too large');
        console.error('unhandled_error', new URL(request.url).pathname, error instanceof Error ? error.message : 'unknown');
        return text(500, 'Internal error');
      }
    },
  };
}
