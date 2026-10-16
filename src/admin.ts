import { hmacHex, sha256Hex, timingSafeEqual } from './crypto';
import {
  deleteFeedback, formatTime, isKind, KIND_LABEL, KINDS, listFeedback, setStarred,
  type FeedbackFilter, type FeedbackRecord,
} from './feedback';
import { escapeHtml, htmlPage } from './html';
import { readForm, redirect, text } from './http';
import {
  addChannel, channelProducts, deleteChannel, deliver, errorCode, getChannel, isValidSecret, isValidTarget, listChannels,
  maskTarget, setChannelEnabled, type Channel,
} from './notify';
import type { ProductMap } from './products';

// The developer's own admin, Chinese only. One shared secret, no accounts: the
// session cookie is an expiry time signed with ADMIN_TOKEN, so rotating the token
// signs everyone out. SameSite=Lax lets links from Feishu or email open a signed-in
// page; every POST must also come from this origin.

const COOKIE = 'koe_admin';
const SESSION_SECONDS = 7 * 86_400;
const MIN_TOKEN_LENGTH = 32;
const ADMIN_FORM_LIMIT = 8 * 1024;

async function sessionValue(token: string, exp: number): Promise<string> {
  return `${exp}.${await hmacHex(token, `koe-admin:${exp}`)}`;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

async function isSignedIn(request: Request, token: string): Promise<boolean> {
  const value = readCookie(request, COOKIE);
  const match = value ? /^(\d{10})\.[0-9a-f]{64}$/.exec(value) : null;
  if (!match || Number(match[1]) * 1000 <= Date.now()) return false;
  return timingSafeEqual(value!, await sessionValue(token, Number(match[1])));
}

const sessionCookie = (value: string, maxAge: number) => `${COOKIE}=${value}; Path=/admin; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

/** Only an admin path of this site, so the redirect after login or an action cannot leave it. */
function safeBack(value: string | null): string {
  return value && /^\/admin(?:[/?]|$)/.test(value) && !/[\\\s]/.test(value) ? value : '/admin';
}

function positiveInt(value: string | null | undefined): number | undefined {
  return value && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : undefined;
}

// Under no-referrer, browsers send `Origin: null` with form posts, which the Origin check
// would reject; same-origin keeps the Origin header on our own posts and sends nothing elsewhere.
const ADMIN_HEADERS = { 'Referrer-Policy': 'same-origin' };

const STYLE = `:root{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#292d25;background:#f7f6f0}
body{max-width:880px;margin:0 auto;padding:0 20px 48px}header{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;padding:16px 0;border-bottom:1px solid #dcdfd3;margin-bottom:20px}
header nav{display:flex;align-items:center;gap:16px;margin-left:auto}a{color:#3f6212}h1{font-size:22px;margin:0 0 12px}h2{font-size:17px;margin:28px 0 10px}
form{margin:0}.inline{display:inline-flex;gap:6px;align-items:center}select,input{font:inherit;padding:4px 8px;border:1px solid #cfd6c4;border-radius:8px;background:#fff;color:inherit}
button{font:inherit;padding:4px 12px;border:1px solid #cfd6c4;border-radius:8px;background:#eef0e6;color:inherit;cursor:pointer}button.danger{color:#8a2c17}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}.notice{padding:8px 14px;border-radius:10px;background:#e8efdc;margin-bottom:16px}
.item,.channel{padding:14px 16px;border:1px solid #dcdfd3;border-radius:12px;background:#fff;margin-bottom:12px}
.meta{color:#6b7062;font-size:13px;display:flex;flex-wrap:wrap;gap:4px 12px}.content{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0}
.actions{display:flex;flex-wrap:wrap;gap:8px}.star{color:#b7791f;font-weight:600}
.add{display:grid;gap:12px;max-width:560px}.add label{display:grid;gap:4px}.add fieldset{border:0;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:6px 14px}.add legend{padding:0;margin-bottom:4px}
.hint{color:#6b7062;font-size:13px}.off{opacity:.55}.spaced{margin-top:8px}`;

// Asks before destructive actions; the only script.
const SCRIPT = `document.addEventListener('submit', (event) => { const message = event.target.dataset.confirm; if (message && !confirm(message)) event.preventDefault(); });`;

const NOTICES: Record<string, string> = {
  saved: '已保存。',
  deleted: '已删除。',
  added: '已添加渠道。',
  invalid_target: '目标格式不正确：邮件填邮箱地址，飞书 / Lark 填机器人的 webhook 地址（https://open.feishu.cn/open-apis/bot/v2/hook/…）。',
  invalid_secret: '签名密钥格式不正确。',
  test_ok: '测试通知已发出，请到对应邮箱或飞书群确认。',
  test_failed: '测试通知发送失败',
};

function page(title: string, body: string, url: URL, status = 200): Response {
  const code = url.searchParams.get('code');
  const notice = NOTICES[url.searchParams.get('notice') ?? ''];
  const banner = notice ? `<p class="notice" role="status">${escapeHtml(notice)}${code && /^[A-Za-z0-9_]{1,40}$/.test(code) ? `：${escapeHtml(code)}` : ''}</p>` : '';
  return htmlPage(`${title} · Koe`, STYLE, (nonce) => `<header><strong>Koe 后台</strong><nav><a href="/admin">反馈</a><a href="/admin/channels">通知渠道</a>
<form method="post" action="/admin/logout"><button>退出</button></form></nav></header>
${banner}${body}
<script nonce="${nonce}">${SCRIPT}</script>`, { status, lang: 'zh-CN', headers: ADMIN_HEADERS });
}

function loginPage(next: string, error?: string, status = 200): Response {
  return htmlPage('登录 · Koe', STYLE, () => `<header><strong>Koe 后台</strong></header>
${error ? `<p class="notice" role="alert">${escapeHtml(error)}</p>` : ''}
<form class="add" method="post" action="/admin/login">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label>ADMIN_TOKEN<input type="password" name="token" required autocomplete="current-password" autofocus></label>
<button>登录</button>
</form>`, { status, lang: 'zh-CN', headers: ADMIN_HEADERS });
}

// Developer-facing: the product's own name; a key no longer in the config shows as itself.
const productLabel = (products: ProductMap, key: string) => (Object.hasOwn(products, key) ? products[key].name : key);

const options = (entries: [string, string][], selected: string | undefined, all: string) =>
  `<option value="">${all}</option>${entries.map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}`;

function feedbackItem(row: FeedbackRecord, products: ProductMap, back: string): string {
  return `<article class="item" id="f${row.id}">
<div class="meta"><a href="/admin?id=${row.id}">#${row.id}</a><span>${escapeHtml(productLabel(products, row.product))}</span><span>${KIND_LABEL[row.kind]}</span>
${row.starred ? '<span class="star">★ 已收藏</span>' : ''}<span>${formatTime(row.created_at)}</span></div>
<div class="meta"><span>版本 ${escapeHtml(row.version ?? '未知')}</span><span>语言 ${row.lang}</span><span>国家 / 地区 ${escapeHtml(row.country ?? '未知')}</span>
<span>${row.email ? `<a href="mailto:${escapeHtml(row.email)}">${escapeHtml(row.email)}</a>` : '未留邮箱'}</span></div>
<div class="content">${escapeHtml(row.content)}</div>
<div class="actions">
<form method="post" action="/admin/feedback/${row.id}/star"><input type="hidden" name="back" value="${escapeHtml(back)}"><input type="hidden" name="starred" value="${row.starred ? 0 : 1}"><button>${row.starred ? '取消收藏' : '☆ 收藏'}</button></form>
<form method="post" action="/admin/feedback/${row.id}/delete" data-confirm="删除 #${row.id}？删除后无法恢复。"><input type="hidden" name="back" value="${escapeHtml(back)}"><button class="danger">删除</button></form>
</div></article>`;
}

async function feedbackList(url: URL, env: Env, products: ProductMap): Promise<Response> {
  const params = url.searchParams;
  const product = params.get('product') ?? '';
  const kind = params.get('kind');
  const filter: FeedbackFilter = {
    id: positiveInt(params.get('id')),
    product: /^[a-z0-9_-]{1,64}$/.test(product) ? product : undefined,
    kind: isKind(kind) ? kind : undefined,
    starred: params.get('starred') === '1',
    before: positiveInt(params.get('before')),
  };
  const { rows, more } = await listFeedback(env.DB, filter);
  const listQuery = (extra: Record<string, string>) => {
    const query = new URLSearchParams();
    if (filter.product) query.set('product', filter.product);
    if (filter.kind) query.set('kind', filter.kind);
    if (filter.starred) query.set('starred', '1');
    for (const [key, value] of Object.entries(extra)) query.set(key, value);
    return `/admin${query.size ? `?${query}` : ''}`;
  };
  const current = new URLSearchParams(params);
  current.delete('notice');
  current.delete('code');
  const back = `/admin${current.size ? `?${current}` : ''}`;
  const filters = `<form class="filters" method="get" action="/admin">
<select name="product">${options(Object.keys(products).map((key) => [key, productLabel(products, key)]), filter.product, '全部产品')}</select>
<select name="kind">${options(KINDS.map((k) => [k, KIND_LABEL[k]]), filter.kind, '全部类型')}</select>
<select name="starred">${options([['1', '★ 只看收藏']], filter.starred ? '1' : undefined, '全部反馈')}</select>
<button>筛选</button></form>`;
  const body = `<h1>反馈</h1>
${filter.id ? `<p>只显示 #${filter.id}。<a href="/admin">查看全部</a></p>` : filters}
${rows.length ? rows.map((row) => feedbackItem(row, products, back)).join('\n') : '<p class="hint">没有反馈。</p>'}
${more ? `<p><a href="${escapeHtml(listQuery({ before: String(rows[rows.length - 1].id) }))}">更早的反馈 →</a></p>` : ''}`;
  return page('反馈', body, url);
}

function channelItem(channel: Channel, products: ProductMap): string {
  const scope = channelProducts(channel);
  const scopeLabel = scope ? scope.map((key) => productLabel(products, key)).join('、') || '无' : '全部产品';
  return `<div class="channel${channel.enabled ? '' : ' off'}">
<div><strong>${channel.kind === 'email' ? '邮件' : '飞书 / Lark'}</strong> ${escapeHtml(maskTarget(channel))}</div>
<div class="meta"><span>#${channel.id}</span><span>${escapeHtml(scopeLabel)}</span><span>${channel.enabled ? '启用中' : '已停用'}</span>${channel.kind === 'feishu' ? `<span>${channel.secret ? '已设签名密钥' : '未设签名密钥'}</span>` : ''}</div>
<div class="actions spaced">
<form method="post" action="/admin/channels/${channel.id}/test"><button>发送测试通知</button></form>
<form method="post" action="/admin/channels/${channel.id}/toggle"><button>${channel.enabled ? '停用' : '启用'}</button></form>
<form method="post" action="/admin/channels/${channel.id}/delete" data-confirm="删除这个渠道？"><button class="danger">删除</button></form>
</div></div>`;
}

async function channelsPage(url: URL, env: Env, products: ProductMap): Promise<Response> {
  const channels = await listChannels(env.DB);
  const productBoxes = Object.keys(products)
    .map((key) => `<label><input type="checkbox" name="products" value="${escapeHtml(key)}"> ${escapeHtml(productLabel(products, key))}</label>`)
    .join('');
  const body = `<h1>通知渠道</h1>
<p class="hint">新反馈会发到所有启用、且产品范围匹配的渠道。邮件只能发到已在 Cloudflare Email Routing 验证过的地址。</p>
${channels.length ? channels.map((channel) => channelItem(channel, products)).join('\n') : '<p class="hint">还没有渠道，新反馈只会存进数据库。</p>'}
<h2>添加渠道</h2>
<form class="add" method="post" action="/admin/channels">
<label>类型<select name="kind"><option value="email">邮件</option><option value="feishu">飞书 / Lark 机器人</option></select></label>
<label>目标<input name="target" required maxlength="512" autocomplete="off" placeholder="邮箱地址，或 https://open.feishu.cn/open-apis/bot/v2/hook/…"></label>
<label>签名密钥（仅飞书 / Lark；机器人未开启签名校验时留空）<input name="secret" maxlength="128" autocomplete="off"></label>
<fieldset><legend>接收哪些产品（都不选 = 全部产品）</legend>${productBoxes}</fieldset>
<button>添加</button>
</form>`;
  return page('通知渠道', body, url);
}

async function createChannel(request: Request, env: Env, products: ProductMap): Promise<Response> {
  const form = await readForm(request, ADMIN_FORM_LIMIT);
  const kind = form.get('kind');
  const target = (form.get('target') ?? '').trim();
  const secret = (form.get('secret') ?? '').trim();
  if ((kind !== 'email' && kind !== 'feishu') || !isValidTarget(kind, target)) return redirect('/admin/channels?notice=invalid_target');
  if (kind === 'feishu' && !isValidSecret(secret)) return redirect('/admin/channels?notice=invalid_secret');
  const scope = [...new Set(form.getAll('products'))].filter((key) => Object.hasOwn(products, key));
  await addChannel(env.DB, { kind, target, secret: kind === 'feishu' && secret ? secret : null, products: scope.length ? scope : null });
  return redirect('/admin/channels?notice=added');
}

async function testChannel(env: Env, id: number, origin: string): Promise<Response> {
  const channel = await getChannel(env.DB, id);
  if (!channel) return redirect('/admin/channels');
  try {
    await deliver(env, channel, { subject: '[Koe] 测试通知', text: `这是一条来自 Koe 后台的测试通知。收到即说明渠道 #${id} 可用。\n\n${origin}/admin/channels` });
  } catch (error) {
    const code = errorCode(error);
    console.error('notify_test_failed', id, channel.kind, code);
    return redirect(`/admin/channels?notice=test_failed&code=${encodeURIComponent(code)}`);
  }
  return redirect('/admin/channels?notice=test_ok');
}

async function login(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request, ADMIN_FORM_LIMIT);
  const next = safeBack(form.get('next'));
  // Digests have equal length, so the comparison time says nothing about the token.
  if (!timingSafeEqual(await sha256Hex(form.get('token') ?? ''), await sha256Hex(env.ADMIN_TOKEN))) {
    console.warn('admin_login_failed');
    return loginPage(next, 'token 不正确。', 401);
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return redirect(next, { 'Set-Cookie': sessionCookie(await sessionValue(env.ADMIN_TOKEN, exp), SESSION_SECONDS) });
}

export async function handleAdmin(request: Request, env: Env, products: ProductMap): Promise<Response> {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < MIN_TOKEN_LENGTH) return text(503, '后台未配置：ADMIN_TOKEN 至少 32 个字符。');
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/admin';
  const isPost = request.method === 'POST';
  // Cross-site form posts carry another Origin (or none); the session cookie alone is not enough.
  if (isPost && request.headers.get('Origin') !== url.origin) return text(403, 'Forbidden');
  if (isPost && path === '/admin/login') return login(request, env);
  if (!(await isSignedIn(request, env.ADMIN_TOKEN))) {
    if (request.method === 'GET') return loginPage(safeBack(url.pathname + url.search));
    return text(401, 'Unauthorized');
  }

  if (request.method === 'GET' && path === '/admin') return feedbackList(url, env, products);
  if (request.method === 'GET' && path === '/admin/channels') return channelsPage(url, env, products);
  if (!isPost) return text(404, 'Not found');
  if (path === '/admin/logout') return redirect('/admin', { 'Set-Cookie': sessionCookie('', 0) });
  if (path === '/admin/channels') return createChannel(request, env, products);

  const feedbackAction = /^\/admin\/feedback\/([1-9]\d{0,15})\/(star|delete)$/.exec(path);
  if (feedbackAction) {
    const id = Number(feedbackAction[1]);
    const form = await readForm(request, ADMIN_FORM_LIMIT);
    const back = safeBack(form.get('back'));
    const withNotice = (notice: string) => `${back}${back.includes('?') ? '&' : '?'}notice=${notice}`;
    if (feedbackAction[2] === 'delete') {
      await deleteFeedback(env.DB, id);
      return redirect(withNotice('deleted'));
    }
    const starred = form.get('starred');
    if (starred !== '0' && starred !== '1') return text(400, 'Invalid star');
    await setStarred(env.DB, id, starred === '1');
    return redirect(`${back}#f${id}`);
  }

  const channelAction = /^\/admin\/channels\/([1-9]\d{0,15})\/(test|toggle|delete)$/.exec(path);
  if (channelAction) {
    const id = Number(channelAction[1]);
    if (channelAction[2] === 'test') return testChannel(env, id, url.origin);
    if (channelAction[2] === 'delete') {
      await deleteChannel(env.DB, id);
      return redirect('/admin/channels?notice=deleted');
    }
    const channel = await getChannel(env.DB, id);
    if (channel) await setChannelEnabled(env.DB, id, !channel.enabled);
    return redirect('/admin/channels?notice=saved');
  }
  return text(404, 'Not found');
}
