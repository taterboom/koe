// The feedback and thanks pages are the only user-facing surfaces; the admin is Chinese only.
// Language rules match menkyo's thanks page. Chinese is Simplified for every zh-* tag.

import type { Kind } from './feedback';

export const LOCALES = ['zh', 'ja', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export type Localized<T> = Partial<Record<Locale, T>>;

const FALLBACK: Locale[] = ['en', 'zh', 'ja'];

function asLocale(tag: string): Locale | null {
  const primary = tag.trim().toLowerCase().split('-')[0];
  return (LOCALES as readonly string[]).includes(primary) ? (primary as Locale) : null;
}

/** An explicit ?lang= wins; otherwise the best Accept-Language match by q-value; otherwise English. */
export function pickLocale(acceptLanguage: string | null, override: string | null): Locale {
  if (override) {
    const chosen = supportedLocale(override);
    if (chosen) return chosen;
  }
  const ranked = (acceptLanguage ?? '')
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.split(';');
      const q = Number(params.find((p) => p.trim().startsWith('q='))?.trim().slice(2) ?? 1);
      return { locale: asLocale(tag), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((entry) => entry.locale && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return ranked[0]?.locale ?? 'en';
}

/** The requested language, else English, Chinese, Japanese — whichever the config provides. */
export function localized<T>(value: Localized<T> | undefined, locale: Locale): T | undefined {
  if (!value) return undefined;
  for (const candidate of [locale, ...FALLBACK]) if (value[candidate] !== undefined) return value[candidate];
  return undefined;
}

export const HTML_LANG: Record<Locale, string> = { zh: 'zh-CN', ja: 'ja', en: 'en' };

// Turnstile's own codes for its widget text.
export const TURNSTILE_LANG: Record<Locale, string> = { zh: 'zh-cn', ja: 'ja', en: 'en' };

/** One of our locales from a language tag, judged by its primary subtag (ja-JP → ja, zh_TW → zh). */
export function supportedLocale(value: unknown): Locale | null {
  return typeof value === 'string' && value.length <= 35 ? asLocale(value.replace('_', '-')) : null;
}

export type FormError = 'kind' | 'contentRequired' | 'contentTooLong' | 'email' | 'verify' | 'server';

type Strings = {
  title: (product: string) => string;
  intro: string;
  kind: string;
  kinds: Record<Kind, string>;
  content: string;
  contentHint: (max: number) => string;
  email: string;
  emailHint: string;
  submit: string;
  privacy: string;
  errors: Record<FormError, (max: number) => string>;
  thanksTitle: string;
  thanksBody: string;
  thanksReply: string;
  unavailable: string;
};

export const STRINGS: Record<Locale, Strings> = {
  zh: {
    title: (p) => `向${p}反馈`,
    intro: '想要什么功能、遇到了什么问题，都可以告诉我们。每一条都会认真阅读。',
    kind: '类型',
    kinds: { feature: '功能需求', bug: '问题报告', other: '其他' },
    content: '内容',
    contentHint: (max) => `最多 ${max} 字`,
    email: '回复邮箱（选填）',
    emailHint: '不填也可以提交，只是我们无法回复你。邮箱只用于回复这条反馈。',
    submit: '提交',
    privacy: '只保存你填写的内容，以及产品版本、语言和国家 / 地区，不记录 IP 地址。',
    errors: {
      kind: () => '请选择类型。',
      contentRequired: () => '请填写内容。',
      contentTooLong: (max) => `内容最多 ${max} 字。`,
      email: () => '邮箱格式不正确。',
      verify: () => '人机验证没有通过，请重试。',
      server: () => '暂时无法提交，请稍后重试。',
    },
    thanksTitle: '已收到，谢谢！',
    thanksBody: '我们会阅读每一条反馈，并用它决定接下来做什么。',
    thanksReply: '如果你留了邮箱，我们可能会通过邮件回复你。',
    unavailable: '反馈暂时无法使用，请稍后再试。',
  },
  ja: {
    title: (p) => `${p}へのフィードバック`,
    intro: '欲しい機能や困ったことを教えてください。すべてに目を通します。',
    kind: '種類',
    kinds: { feature: '機能のリクエスト', bug: '不具合の報告', other: 'その他' },
    content: '内容',
    contentHint: (max) => `${max} 文字まで`,
    email: '返信用メールアドレス（任意）',
    emailHint: '未入力でも送信できますが、返信はできません。メールアドレスはこのフィードバックへの返信にのみ使います。',
    submit: '送信',
    privacy: '保存するのは入力内容と、製品のバージョン・言語・国 / 地域だけです。IP アドレスは記録しません。',
    errors: {
      kind: () => '種類を選んでください。',
      contentRequired: () => '内容を入力してください。',
      contentTooLong: (max) => `内容は ${max} 文字以内にしてください。`,
      email: () => 'メールアドレスの形式が正しくありません。',
      verify: () => '確認に失敗しました。もう一度お試しください。',
      server: () => '現在送信できません。しばらくしてからもう一度お試しください。',
    },
    thanksTitle: '受け付けました。ありがとうございます！',
    thanksBody: 'いただいた内容はすべて読み、今後の開発に活かします。',
    thanksReply: 'メールアドレスを入力した場合は、メールで返信することがあります。',
    unavailable: '現在フィードバックを受け付けられません。しばらくしてからもう一度お試しください。',
  },
  en: {
    title: (p) => `Feedback for ${p}`,
    intro: "Tell us what you'd like to see or what went wrong. We read every message.",
    kind: 'Type',
    kinds: { feature: 'Feature request', bug: 'Bug report', other: 'Other' },
    content: 'Message',
    contentHint: (max) => `Up to ${max} characters`,
    email: 'Email for a reply (optional)',
    emailHint: "You can leave this empty, but then we can't reply. Your email is only used to reply to this message.",
    submit: 'Send',
    privacy: 'We keep only what you write, plus the product version, language and country. No IP addresses.',
    errors: {
      kind: () => 'Please choose a type.',
      contentRequired: () => 'Please write a message.',
      contentTooLong: (max) => `Please keep the message within ${max} characters.`,
      email: () => "That email address doesn't look right.",
      verify: () => 'Verification failed. Please try again.',
      server: () => "We couldn't send your feedback. Please try again in a moment.",
    },
    thanksTitle: 'Received — thank you!',
    thanksBody: 'We read every message and use it to decide what to build next.',
    thanksReply: 'If you left an email address, we may reply by email.',
    unavailable: 'Feedback is unavailable right now. Please try again later.',
  },
};
