// Room for 2,000 characters of CJK text percent-encoded, a Turnstile token and an email.
export const FORM_BODY_LIMIT = 32 * 1024;

export class BodyTooLarge extends Error {}

// Enforces the limit on bytes actually read, so a missing or false
// Content-Length cannot make us buffer an unbounded body.
async function readText(request: Request, maxBytes: number): Promise<string> {
  if (Number(request.headers.get('Content-Length')) > maxBytes) throw new BodyTooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** An application/x-www-form-urlencoded body, size-limited. */
export async function readForm(request: Request, maxBytes = FORM_BODY_LIMIT): Promise<URLSearchParams> {
  return new URLSearchParams(await readText(request, maxBytes));
}

export function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', ...headers } });
}
