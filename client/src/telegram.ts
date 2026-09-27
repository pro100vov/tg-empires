interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number; first_name?: string } };
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  ready(): void;
  expand(): void;
  close(): void;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export const tg = window.Telegram?.WebApp;

export function initTelegram(): void {
  if (!tg) return;
  tg.ready();
  tg.expand();
  document.documentElement.dataset.scheme = tg.colorScheme;
}

/** Код комнаты приходит либо из startapp-ссылки, либо из ?room= в URL кнопки. */
export function roomCodeFromEnvironment(): string {
  const fromStartParam = tg?.initDataUnsafe?.start_param;
  if (fromStartParam) return fromStartParam.toUpperCase();
  const fromQuery = new URLSearchParams(window.location.search).get('room');
  return fromQuery ? fromQuery.toUpperCase() : '';
}

export function haptic(type: 'light' | 'medium' | 'heavy' = 'light'): void {
  tg?.HapticFeedback?.impactOccurred(type);
}

export function hapticResult(type: 'error' | 'success' | 'warning'): void {
  tg?.HapticFeedback?.notificationOccurred(type);
}

/**
 * Стабильный идентификатор для отладки в обычном браузере.
 * ?dev=alice позволяет открыть двух разных игроков в соседних вкладках.
 */
export function devId(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('dev');
  if (fromQuery) return fromQuery;
  // sessionStorage, а не localStorage: иначе две вкладки одного браузера
  // считались бы одним и тем же игроком, и партия не набирала бы состав.
  const key = 'tge-dev-id';
  let id: string | null = null;
  try {
    id = sessionStorage.getItem(key);
  } catch {
    // Хранилище закрыто (некоторые WebView) — просто без запоминания.
  }
  if (!id) {
    id = `dev-${Math.floor(Math.random() * 100000)}`;
    try {
      sessionStorage.setItem(key, id);
    } catch {
      // ignore
    }
  }
  return id;
}
