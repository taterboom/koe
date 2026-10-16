const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN = 2048;

/**
 * Server-side Turnstile check. Tokens are single-use and expire after five
 * minutes; Cloudflare enforces both. A siteverify outage throws, so the caller
 * can tell "try again later" apart from "verification failed".
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
export async function verifyTurnstile(secret: string, token: unknown): Promise<boolean> {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) return false;
  const response = await fetch(SITEVERIFY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, response: token }),
  });
  if (!response.ok) throw new Error(`turnstile_${response.status}`);
  const result = (await response.json()) as { success?: unknown };
  return result.success === true;
}
