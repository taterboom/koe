import { randomNonce } from './crypto';

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface PageOptions {
  status?: number;
  lang: string;
  // Extra CSP sources beyond the nonce-only default.
  scriptSrc?: string[];
  frameSrc?: string[];
  imgSrc?: string[];
  headers?: Record<string, string>;
}

/** A complete HTML page. `body` receives the nonce for its inline <script> tags. */
export function htmlPage(title: string, style: string, body: (nonce: string) => string, options: PageOptions): Response {
  const nonce = randomNonce();
  const html = `<!doctype html><html lang="${options.lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${style}</style></head><body>
${body(nonce)}
</body></html>`;
  const list = (sources: string[] | undefined) => (sources?.length ? sources.join(' ') : "'none'");
  return new Response(html, {
    status: options.status ?? 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': [
        "default-src 'none'", [`script-src 'nonce-${nonce}'`, ...(options.scriptSrc ?? [])].join(' '),
        `style-src 'nonce-${nonce}'`, `img-src ${list(options.imgSrc)}`, `frame-src ${list(options.frameSrc)}`,
        "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'",
      ].join('; '),
      ...options.headers,
    },
  });
}
