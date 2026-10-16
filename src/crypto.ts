const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: string, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
}

export async function hmacHex(key: string, message: string): Promise<string> {
  return toHex(await hmac(key, message));
}

export async function hmacBase64(key: string, message: string): Promise<string> {
  return btoa(String.fromCharCode(...(await hmac(key, message))));
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}

// Constant-time comparison to avoid leaking bytes through timing.
export function timingSafeEqual(a: string, b: string): boolean {
  const bytesA = encoder.encode(a);
  const bytesB = encoder.encode(b);
  if (bytesA.length !== bytesB.length) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}

// 128-bit random, hex: CSP nonces.
export function randomNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}
