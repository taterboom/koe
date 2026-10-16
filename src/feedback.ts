import type { FormError, Locale } from './i18n';
import type { ProductConfig } from './products';

export const KINDS = ['feature', 'bug', 'other'] as const;
export type Kind = (typeof KINDS)[number];

// Developer-facing labels (admin and notifications are Chinese only).
export const KIND_LABEL: Record<Kind, string> = { feature: '功能需求', bug: '问题报告', other: '其他' };

export const MAX_CONTENT = 2000; // characters (code points), after normalising line breaks
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/;
const COUNTRY = /^[A-Z0-9]{2}$/; // ISO 3166-1 alpha-2, plus Cloudflare's XX / T1

export function isEmail(value: string): boolean {
  return value.length <= MAX_EMAIL && EMAIL.test(value);
}

export function isKind(value: unknown): value is Kind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

/** A classifying value from the product's link: kept only when well-formed, never a reason to reject. */
export function cleanVersion(value: unknown): string | null {
  return typeof value === 'string' && VERSION.test(value) ? value : null;
}

export function cleanCountry(value: unknown): string | null {
  return typeof value === 'string' && COUNTRY.test(value) ? value : null;
}

export interface FormValues {
  kind: string;
  content: string;
  email: string;
}

export interface Submission {
  kind: Kind;
  content: string;
  email: string | null;
}

/** What the user typed, checked against this product's types and the length limits. */
export function parseSubmission(product: ProductConfig, values: FormValues): { ok: true; submission: Submission } | { ok: false; error: FormError } {
  if (!isKind(values.kind) || !product.kinds.includes(values.kind)) return { ok: false, error: 'kind' };
  const content = values.content.replace(/\r\n?/g, '\n').trim();
  if (!content) return { ok: false, error: 'contentRequired' };
  if ([...content].length > MAX_CONTENT) return { ok: false, error: 'contentTooLong' };
  const email = values.email.trim();
  if (email && !isEmail(email)) return { ok: false, error: 'email' };
  return { ok: true, submission: { kind: values.kind, content, email: email || null } };
}

export interface FeedbackRecord extends Submission {
  id: number;
  product: string;
  version: string | null;
  lang: Locale;
  country: string | null;
  starred: number; // 0 | 1
  created_at: number;
}

// One insert; the row id comes back for the notification link.
export async function insertFeedback(db: D1Database, record: Omit<FeedbackRecord, 'id' | 'starred'>): Promise<FeedbackRecord> {
  const row = await db
    .prepare('INSERT INTO feedback (product, kind, content, email, version, lang, country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(record.product, record.kind, record.content, record.email, record.version, record.lang, record.country, record.created_at)
    .first<{ id: number }>();
  return { ...record, id: row!.id, starred: 0 };
}

export interface FeedbackFilter {
  id?: number;
  product?: string;
  kind?: Kind;
  starred?: boolean;
  before?: number;
}

export const PAGE_SIZE = 50;

// Newest first along the primary key; reads at most until a page is filled.
export async function listFeedback(db: D1Database, filter: FeedbackFilter): Promise<{ rows: FeedbackRecord[]; more: boolean }> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    where.push(clause);
    binds.push(value);
  };
  if (filter.id !== undefined) add('id = ?', filter.id);
  if (filter.product) add('product = ?', filter.product);
  if (filter.kind) add('kind = ?', filter.kind);
  if (filter.starred) add('starred = ?', 1);
  if (filter.before !== undefined) add('id < ?', filter.before);
  const { results } = await db
    .prepare(`SELECT id, product, kind, content, email, version, lang, country, starred, created_at FROM feedback ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${PAGE_SIZE + 1}`)
    .bind(...binds)
    .all<FeedbackRecord>();
  return { rows: results.slice(0, PAGE_SIZE), more: results.length > PAGE_SIZE };
}

export async function setStarred(db: D1Database, id: number, starred: boolean): Promise<void> {
  await db.prepare('UPDATE feedback SET starred = ? WHERE id = ?').bind(starred ? 1 : 0, id).run();
}

export async function deleteFeedback(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM feedback WHERE id = ?').bind(id).run();
}

const JST_OFFSET_MS = 9 * 3_600_000; // Japan has no daylight saving time

/** Developer-facing timestamps, in Japan time. Plain arithmetic: Intl time zones cost CPU we lack. */
export function formatTime(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}
