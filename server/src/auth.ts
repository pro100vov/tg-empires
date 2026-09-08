import crypto from 'node:crypto';

export interface AuthUser {
  id: string;
  name: string;
}

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

/**
 * Проверка подписи initData по алгоритму Telegram: секрет — HMAC от токена бота
 * с ключом "WebAppData", им же подписывается отсортированная строка полей.
 */
export function verifyInitData(initData: string, botToken: string): AuthUser | null {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AUTH_AGE_SECONDS) return null;

  const rawUser = params.get('user');
  if (!rawUser) return null;
  try {
    const user = JSON.parse(rawUser) as { id: number; first_name?: string; username?: string };
    if (!user?.id) return null;
    return {
      id: String(user.id),
      name: user.first_name || user.username || `Игрок ${user.id}`,
    };
  } catch {
    return null;
  }
}

/** Локальная отладка в обычном браузере, когда подписи Telegram нет. */
export function devUser(rawId: string | undefined): AuthUser {
  const id = rawId && rawId.trim() ? rawId.trim() : `dev-${Math.floor(Math.random() * 10000)}`;
  return { id, name: `Тест-${id}` };
}
