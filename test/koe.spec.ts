import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandler } from '../src/app';
import { hmacBase64, hmacHex } from '../src/crypto';
import type { ProductMap } from '../src/products';

const PRODUCTS: ProductMap = {
  alpha: { name: 'Alpha', display_name: { en: 'Alpha App', ja: 'アルファ' }, logo_url: 'https://cdn.example/logo.svg', kinds: ['feature', 'bug', 'other'] },
  beta: { name: 'Beta', kinds: ['bug'] },
};
const app = createHandler(PRODUCTS);
const ORIGIN = 'https://koe.test';
const FEISHU = 'https://open.feishu.cn/open-apis/bot/v2/hook/0123abcd-4567-89ef-0123-456789abcdef';

// The outside world: Turnstile siteverify, Feishu webhooks and the email binding.
const world = {
  turnstile: 'pass' as 'pass' | 'fail' | 'down',
  siteverifyCalls: 0,
  feishu: [] as { url: string; body: Record<string, any> }[],
  feishuReply: { code: 0, msg: 'success' } as Record<string, unknown>,
  feishuDown: false,
  emails: [] as EmailMessageBuilder[],
  emailFails: false,
};

const testEnv = {
  ...env,
  EMAIL: {
    async send(message: EmailMessageBuilder) {
      if (world.emailFails) throw Object.assign(new Error('recipient not allowed'), { code: 'E_RECIPIENT_NOT_ALLOWED' });
      world.emails.push(message);
      return { messageId: 'test' };
    },
  },
} as unknown as Env;

beforeEach(() => {
  Object.assign(world, { turnstile: 'pass', siteverifyCalls: 0, feishu: [], feishuReply: { code: 0, msg: 'success' }, feishuDown: false, emails: [], emailFails: false });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      world.siteverifyCalls++;
      if (world.turnstile === 'down') return new Response('', { status: 502 });
      const body = JSON.parse(String(init?.body));
      return Response.json({ success: world.turnstile === 'pass' && body.secret === env.TURNSTILE_SECRET_KEY && body.response === 'good-token' });
    }
    if (url.hostname === 'open.feishu.cn') {
      if (world.feishuDown) throw new TypeError('network down');
      world.feishu.push({ url: url.href, body: JSON.parse(String(init?.body)) });
      return Response.json(world.feishuReply);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Waits for waitUntil work (notifications) before returning.
async function call(path: string, init: RequestInit = {}, environment: Env = testEnv) {
  const ctx = createExecutionContext();
  const request = new Request(`${ORIGIN}${path}`, init) as Request<unknown, IncomingRequestCfProperties>;
  const response = await app.fetch!(request, environment, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const GOOD = { kind: 'feature', content: 'Please add a dark mode', email: '', lang: 'ja', v: '1.2.0', 'cf-turnstile-response': 'good-token' };

function submit(product: string, fields: Record<string, string>) {
  return call(`/${product}`, { method: 'POST', headers: FORM, body: new URLSearchParams(fields).toString(), cf: { country: 'JP' } } as RequestInit);
}

const rows = async () => (await env.DB.prepare('SELECT * FROM feedback ORDER BY id').all<Record<string, unknown>>()).results;

async function addChannel(kind: string, target: string, opts: { secret?: string; products?: string[]; enabled?: boolean } = {}) {
  await env.DB.prepare('INSERT INTO channels (kind, target, secret, products, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(kind, target, opts.secret ?? null, opts.products ? JSON.stringify(opts.products) : null, opts.enabled === false ? 0 : 1, Date.now())
    .run();
}

async function signIn(): Promise<string> {
  const response = await call('/admin/login', { method: 'POST', headers: { ...FORM, Origin: ORIGIN }, body: `token=${encodeURIComponent(env.ADMIN_TOKEN)}` });
  return response.headers.get('Set-Cookie')!.split(';')[0];
}

function adminPost(path: string, fields: Record<string, string> | string, cookie: string | null, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { ...FORM };
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  return call(path, { method: 'POST', headers, body: typeof fields === 'string' ? fields : new URLSearchParams(fields).toString() });
}

describe('products and link parameters', () => {
  it('rejects unknown products without verifying or storing anything', async () => {
    expect((await call('/nope')).status).toBe(404);
    expect((await call('/nope/thanks')).status).toBe(404);
    expect((await submit('nope', GOOD)).status).toBe(404);
    expect(world.siteverifyCalls).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it('reads only v and lang from the link and never echoes anything else', async () => {
    const response = await call('/alpha?v=1.2.0&lang=ja&url=https%3A%2F%2Fprivate.example%2Fpage&title=Secret+Title');
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('アルファ');
    expect(html).toContain('name="v" value="1.2.0"');
    expect(html).not.toContain('private.example');
    expect(html).not.toContain('Secret Title');
    const malformed = await (await call('/alpha?v=https%3A%2F%2Fprivate.example')).text();
    expect(malformed).not.toContain('name="v"');
  });

  it('stores only the whitelisted fields, with the country from Cloudflare', async () => {
    const response = await submit('alpha', { ...GOOD, url: 'https://private.example/page', starred: '1', country: 'XX', id: '999', created_at: '1' });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/alpha/thanks?lang=ja');
    const [row] = await rows();
    expect(row).toMatchObject({ product: 'alpha', kind: 'feature', content: 'Please add a dark mode', email: null, version: '1.2.0', lang: 'ja', country: 'JP', starred: 0 });
    expect(row.id).not.toBe(999);
    expect(JSON.stringify(row)).not.toContain('private.example');
  });

  it('keeps feedback whose version is malformed, without the version', async () => {
    expect((await submit('alpha', { ...GOOD, v: '<script>alert(1)</script>' })).status).toBe(303);
    expect((await rows())[0].version).toBeNull();
  });
});

describe('length and type limits', () => {
  it('rejects types the product does not offer and empty, overlong or malformed input', async () => {
    for (const fields of [
      { ...GOOD, kind: 'hack' },
      { ...GOOD, kind: 'feature', product: 'beta' },
      { ...GOOD, content: '   \r\n ' },
      { ...GOOD, content: 'あ'.repeat(2001) },
      { ...GOOD, email: 'not-an-email' },
    ]) {
      const product = 'product' in fields ? 'beta' : 'alpha';
      expect((await submit(product, fields)).status).toBe(400);
    }
    expect(world.siteverifyCalls).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it('counts characters after normalising line breaks, and keeps a valid email', async () => {
    expect((await submit('alpha', { ...GOOD, content: 'あ'.repeat(2000) })).status).toBe(303);
    expect((await submit('alpha', { ...GOOD, content: 'a\r\n'.repeat(999) + 'a', email: ' user@example.com ' })).status).toBe(303);
    const stored = await rows();
    expect(stored[1].content).toBe('a\n'.repeat(999) + 'a');
    expect(stored[1].email).toBe('user@example.com');
  });

  it('shows the form again with the text kept and escaped', async () => {
    const response = await submit('alpha', { ...GOOD, content: '<b>keep me</b>', email: 'bad' });
    const html = await response.text();
    expect(html).toContain('&lt;b&gt;keep me&lt;/b&gt;');
    expect(html).toContain('role="alert"');
  });

  it('rejects oversized bodies by bytes actually read', async () => {
    const bytes = new TextEncoder().encode(new URLSearchParams({ ...GOOD, content: 'x'.repeat(40 * 1024) }).toString());
    const streamed = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 1024) controller.enqueue(bytes.slice(i, i + 1024));
        controller.close();
      },
    });
    const response = await call('/alpha', { method: 'POST', headers: FORM, body: streamed, duplex: 'half' } as RequestInit);
    expect(response.status).toBe(413);
    expect(await rows()).toHaveLength(0);
  });
});

describe('Turnstile', () => {
  it('rejects missing and failed tokens and keeps the text', async () => {
    const { 'cf-turnstile-response': _, ...withoutToken } = GOOD;
    expect((await submit('alpha', withoutToken)).status).toBe(400);
    expect(world.siteverifyCalls).toBe(0);
    world.turnstile = 'fail';
    const failed = await submit('alpha', GOOD);
    expect(failed.status).toBe(400);
    expect(await failed.text()).toContain('Please add a dark mode');
    expect(await rows()).toHaveLength(0);
  });

  it('tells a siteverify outage apart from a failed check', async () => {
    world.turnstile = 'down';
    const response = await submit('alpha', GOOD);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('Please add a dark mode');
    expect(await rows()).toHaveLength(0);
  });

  it('refuses feedback while Turnstile is not configured', async () => {
    const unconfigured = { ...testEnv, TURNSTILE_SECRET_KEY: '' } as Env;
    expect((await call('/alpha', {}, unconfigured)).status).toBe(503);
    const posted = await call('/alpha', { method: 'POST', headers: FORM, body: new URLSearchParams(GOOD).toString() }, unconfigured);
    expect(posted.status).toBe(503);
    expect(await rows()).toHaveLength(0);
  });
});

describe('notifications', () => {
  it('never loses feedback when every channel fails, and logs no targets or user data', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    world.emailFails = true;
    await addChannel('email', 'dev@example.com');
    await addChannel('feishu', FEISHU);
    await addChannel('feishu', FEISHU.replace('0123abcd', 'ffffffff'));
    world.feishuReply = { code: 19021, msg: 'sign match fail' };
    const response = await submit('alpha', { ...GOOD, email: 'user@example.com' });
    expect(response.status).toBe(303);
    expect(await rows()).toHaveLength(1);
    world.feishuDown = true;
    expect((await submit('alpha', GOOD)).status).toBe(303);
    expect(await rows()).toHaveLength(2);
    const logged = JSON.stringify(errors.mock.calls);
    expect(errors.mock.calls.filter(([tag]) => tag === 'notify_failed')).toHaveLength(6);
    expect(logged).toContain('E_RECIPIENT_NOT_ALLOWED');
    expect(logged).toContain('feishu_19021');
    expect(logged).toContain('feishu_unreachable');
    for (const secret of ['dev@example.com', 'user@example.com', '0123abcd', 'dark mode']) expect(logged).not.toContain(secret);
  });

  it('notifies enabled channels for the product, with reply-to and a valid Feishu signature', async () => {
    await addChannel('email', 'dev@example.com');
    await addChannel('email', 'off@example.com', { enabled: false });
    await addChannel('feishu', FEISHU, { secret: 'feishu-secret', products: ['alpha'] });
    await addChannel('feishu', FEISHU.replace('0123abcd', 'bbbbbbbb'), { products: ['beta'] });
    await submit('alpha', { ...GOOD, email: 'user@example.com' });
    const [row] = await rows();

    expect(world.emails).toHaveLength(1);
    const [email] = world.emails;
    expect(email).toMatchObject({ to: 'dev@example.com', replyTo: 'user@example.com', from: { email: 'koe@44san.com', name: 'Koe' } });
    expect(email.subject).toBe(`[Koe] Alpha · 功能需求 #${row.id}`);
    expect(email.text).toContain('Please add a dark mode');
    expect(email.text).toContain('回复邮箱：user@example.com');
    expect(email.text).toContain(`${ORIGIN}/admin?id=${row.id}`);
    const tokyo = new Date(row.created_at as number).toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 16);
    expect(email.text).toContain(`时间：${tokyo}（东京）`);

    expect(world.feishu).toHaveLength(1);
    const [{ url, body }] = world.feishu;
    expect(url).toBe(FEISHU);
    expect(body.msg_type).toBe('text');
    expect(body.content.text).toContain('Please add a dark mode');
    expect(body.content.text).toContain('user@example.com');
    expect(body.sign).toBe(await hmacBase64(`${body.timestamp}\nfeishu-secret`, ''));
    expect(Math.abs(Number(body.timestamp) - Date.now() / 1000)).toBeLessThan(5);
  });
});

describe('admin', () => {
  it('refuses everything without a valid session', async () => {
    await submit('alpha', GOOD);
    const login = await call('/admin');
    expect(login.status).toBe(200);
    // Browsers send `Origin: null` with posts from no-referrer pages, which would lock the admin out.
    expect(login.headers.get('Referrer-Policy')).toBe('same-origin');
    expect(await login.text()).not.toContain('Please add a dark mode');
    expect(await (await call('/admin/channels')).text()).toContain('name="token"');

    const id = String((await rows())[0].id);
    const expired = Math.floor(Date.now() / 1000) - 60;
    for (const cookie of [
      null,
      `koe_admin=9999999999.${'0'.repeat(64)}`,
      `koe_admin=${expired}.${await hmacHex(env.ADMIN_TOKEN, `koe-admin:${expired}`)}`,
    ]) {
      expect((await adminPost(`/admin/feedback/${id}/delete`, {}, cookie)).status).toBe(401);
      expect((await adminPost('/admin/channels', { kind: 'feishu', target: FEISHU }, cookie)).status).toBe(401);
    }
    const wrong = await adminPost('/admin/login', { token: 'wrong' }, null);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('Set-Cookie')).toBeNull();
    expect(await rows()).toHaveLength(1);

    const weak = { ...testEnv, ADMIN_TOKEN: 'short' } as Env;
    expect((await call('/admin', {}, weak)).status).toBe(503);
  });

  it('rejects posts from another origin even with a session', async () => {
    await submit('alpha', GOOD);
    const cookie = await signIn();
    const id = String((await rows())[0].id);
    expect((await adminPost(`/admin/feedback/${id}/delete`, {}, cookie, 'https://evil.example')).status).toBe(403);
    expect((await adminPost(`/admin/feedback/${id}/delete`, {}, cookie, null)).status).toBe(403);
    expect(await rows()).toHaveLength(1);
  });

  it('signs in, then lists, stars and deletes feedback', async () => {
    await submit('alpha', { ...GOOD, content: '<i>first</i>' });
    await submit('alpha', { ...GOOD, content: 'second' });
    const login = await adminPost('/admin/login', { token: env.ADMIN_TOKEN, next: '/admin?id=1' }, null);
    expect(login.status).toBe(303);
    expect(login.headers.get('Location')).toBe('/admin?id=1');
    expect(login.headers.get('Set-Cookie')).toMatch(/^koe_admin=\d{10}\.[0-9a-f]{64}; Path=\/admin; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$/);
    const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    expect((await adminPost('/admin/login', { token: env.ADMIN_TOKEN, next: 'https://evil.example/' }, null)).headers.get('Location')).toBe('/admin');

    const [first, second] = await rows();
    const list = await (await call('/admin', { headers: { Cookie: cookie } })).text();
    expect(list).toContain('&lt;i&gt;first&lt;/i&gt;');
    expect(list).toContain('second');

    const starred = await adminPost(`/admin/feedback/${first.id}/star`, { starred: '1', back: '/admin?kind=feature' }, cookie);
    expect(starred.headers.get('Location')).toBe(`/admin?kind=feature#f${first.id}`);
    expect((await rows())[0].starred).toBe(1);
    const starredOnly = await (await call('/admin?starred=1', { headers: { Cookie: cookie } })).text();
    expect(starredOnly).toContain('first');
    expect(starredOnly).not.toContain('second');
    expect((await adminPost(`/admin/feedback/${first.id}/star`, { starred: 'yes' }, cookie)).status).toBe(400);
    await adminPost(`/admin/feedback/${first.id}/star`, { starred: '0' }, cookie);
    expect((await rows())[0].starred).toBe(0);

    await adminPost(`/admin/feedback/${second.id}/delete`, { back: 'https://evil.example/' }, cookie);
    expect((await rows()).map((row) => row.id)).toEqual([first.id]);
  });

  it('accepts only official Feishu webhooks, masks them and sends test notifications', async () => {
    const cookie = await signIn();
    for (const target of ['https://evil.example/open-apis/bot/v2/hook/0123abcd', 'http://open.feishu.cn/open-apis/bot/v2/hook/0123abcd', `${FEISHU}?x=1`]) {
      const response = await adminPost('/admin/channels', { kind: 'feishu', target }, cookie);
      expect(response.headers.get('Location')).toBe('/admin/channels?notice=invalid_target');
    }
    expect((await adminPost('/admin/channels', { kind: 'email', target: 'nope' }, cookie)).headers.get('Location')).toBe('/admin/channels?notice=invalid_target');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM channels').first<{ n: number }>())!.n).toBe(0);

    const added = await adminPost('/admin/channels', `kind=feishu&target=${encodeURIComponent(FEISHU)}&secret=s3cret&products=alpha&products=unknown`, cookie);
    expect(added.headers.get('Location')).toBe('/admin/channels?notice=added');
    const channel = (await env.DB.prepare('SELECT * FROM channels').first<Record<string, unknown>>())!;
    expect(channel).toMatchObject({ kind: 'feishu', target: FEISHU, secret: 's3cret', products: '["alpha"]', enabled: 1 });

    const page = await (await call('/admin/channels', { headers: { Cookie: cookie } })).text();
    expect(page).toContain('hook/0123…cdef');
    expect(page).not.toContain('0123abcd-4567');
    expect(page).not.toContain('s3cret');

    const tested = await adminPost(`/admin/channels/${channel.id}/test`, {}, cookie);
    expect(tested.headers.get('Location')).toBe('/admin/channels?notice=test_ok');
    expect(world.feishu).toHaveLength(1);
    world.feishuReply = { code: 19021 };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await adminPost(`/admin/channels/${channel.id}/test`, {}, cookie)).headers.get('Location')).toBe('/admin/channels?notice=test_failed&code=feishu_19021');
  });
});
