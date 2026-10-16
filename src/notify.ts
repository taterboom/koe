import { hmacBase64 } from './crypto';
import { formatTime, isEmail, KIND_LABEL, type FeedbackRecord } from './feedback';
import type { ProductMap } from './products';

// Notification channels live in D1 and are managed in the admin. Webhook URLs and
// signing secrets are credentials: shown masked, never logged. Logs carry only the
// channel id and an error code — never the target, the content or the user's email.

export type ChannelKind = 'email' | 'feishu';

export interface Channel {
  id: number;
  kind: ChannelKind;
  target: string;
  secret: string | null;
  products: string | null; // NULL = every product, else a JSON array of keys
  enabled: number;
  created_at: number;
}

export interface Message {
  subject: string;
  text: string;
  replyTo?: string | null;
}

export class NotifyError extends Error {}

const FEISHU_HOSTS = ['open.feishu.cn', 'open.larksuite.com'];
const FEISHU_PATH = /^\/open-apis\/bot\/v2\/hook\/([A-Za-z0-9-]{8,128})$/;
const MAX_SECRET = 128;

/** Only official Feishu / Lark custom-bot endpoints, so a channel can never point elsewhere. */
export function isFeishuWebhook(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && FEISHU_HOSTS.includes(url.hostname) && !url.port && !url.search && !url.hash
      && !url.username && FEISHU_PATH.test(url.pathname) && url.href === value;
  } catch {
    return false;
  }
}

export function isValidTarget(kind: ChannelKind, target: string): boolean {
  return kind === 'email' ? isEmail(target) : isFeishuWebhook(target);
}

export function isValidSecret(secret: string): boolean {
  return secret.length <= MAX_SECRET && /^[\x21-\x7e]*$/.test(secret);
}

export function maskTarget(channel: Pick<Channel, 'kind' | 'target'>): string {
  if (channel.kind === 'email') return channel.target;
  const url = new URL(channel.target);
  const token = FEISHU_PATH.exec(url.pathname)?.[1] ?? '';
  return `${url.origin}/open-apis/bot/v2/hook/${token.slice(0, 4)}…${token.slice(-4)}`;
}

export function channelProducts(channel: Pick<Channel, 'products'>): string[] | null {
  if (channel.products === null) return null;
  try {
    const parsed: unknown = JSON.parse(channel.products);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

// Channel management: a handful of rows, read whole.
export async function listChannels(db: D1Database): Promise<Channel[]> {
  const { results } = await db.prepare('SELECT id, kind, target, secret, products, enabled, created_at FROM channels ORDER BY id').all<Channel>();
  return results;
}

export async function getChannel(db: D1Database, id: number): Promise<Channel | null> {
  return db.prepare('SELECT id, kind, target, secret, products, enabled, created_at FROM channels WHERE id = ?').bind(id).first<Channel>();
}

export async function addChannel(db: D1Database, channel: { kind: ChannelKind; target: string; secret: string | null; products: string[] | null }): Promise<void> {
  await db
    .prepare('INSERT INTO channels (kind, target, secret, products, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(channel.kind, channel.target, channel.secret, channel.products ? JSON.stringify(channel.products) : null, Date.now())
    .run();
}

export async function setChannelEnabled(db: D1Database, id: number, enabled: boolean): Promise<void> {
  await db.prepare('UPDATE channels SET enabled = ? WHERE id = ?').bind(enabled ? 1 : 0, id).run();
}

export async function deleteChannel(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM channels WHERE id = ?').bind(id).run();
}

export function feedbackMessage(record: FeedbackRecord, products: ProductMap, adminUrl: string): Message {
  const product = Object.hasOwn(products, record.product) ? products[record.product].name : record.product;
  const subject = `[Koe] ${product} · ${KIND_LABEL[record.kind]} #${record.id}`;
  const text = [
    `产品：${product}`,
    `类型：${KIND_LABEL[record.kind]}`,
    `版本：${record.version ?? '未知'}`,
    `语言：${record.lang}`,
    `国家 / 地区：${record.country ?? '未知'}`,
    `回复邮箱：${record.email ?? '未留'}`,
    `时间：${formatTime(record.created_at)}（东京）`,
    '',
    record.content,
    '',
    `后台查看：${adminUrl}`,
  ].join('\n');
  return { subject, text, replyTo: record.email };
}

async function sendEmail(env: Env, to: string, message: Message): Promise<void> {
  try {
    await env.EMAIL.send({
      from: { email: env.MAIL_FROM, name: 'Koe' },
      to,
      subject: message.subject,
      text: message.text,
      // Replying to the notification answers the user directly.
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new NotifyError(typeof code === 'string' ? code : 'email_failed');
  }
}

// https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
async function postFeishu(url: string, secret: string | null, message: Message): Promise<void> {
  const body: Record<string, unknown> = { msg_type: 'text', content: { text: `${message.subject}\n\n${message.text}` } };
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    body.timestamp = timestamp;
    body.sign = await hmacBase64(`${timestamp}\n${secret}`, '');
  }
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new NotifyError('feishu_unreachable');
  }
  // Feishu answers most errors with HTTP 200 and a non-zero code.
  const result = (await response.json().catch(() => null)) as { code?: unknown } | null;
  if (!response.ok || result?.code !== 0) throw new NotifyError(`feishu_${typeof result?.code === 'number' ? result.code : response.status}`);
}

export async function deliver(env: Env, channel: Channel, message: Message): Promise<void> {
  if (channel.kind === 'email') return sendEmail(env, channel.target, message);
  return postFeishu(channel.target, channel.secret, message);
}

export function errorCode(error: unknown): string {
  return error instanceof NotifyError ? error.message : 'unknown';
}

/**
 * Runs after the feedback is stored, inside waitUntil: a failing channel is
 * logged and skipped, and never affects the stored feedback or the response.
 */
export async function notifyNew(env: Env, products: ProductMap, record: FeedbackRecord, origin: string): Promise<void> {
  try {
    const { results } = await env.DB
      .prepare('SELECT id, kind, target, secret, products, enabled, created_at FROM channels WHERE enabled = 1')
      .all<Channel>();
    const message = feedbackMessage(record, products, `${origin}/admin?id=${record.id}`);
    await Promise.all(
      results
        .filter((channel) => channelProducts(channel)?.includes(record.product) ?? true)
        .map((channel) => deliver(env, channel, message).catch((error) => console.error('notify_failed', channel.id, channel.kind, errorCode(error)))),
    );
  } catch (error) {
    console.error('notify_failed', 'channels', error instanceof Error ? error.message : 'unknown');
  }
}
