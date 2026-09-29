interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number; first_name?: string } };
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  ready(): void;
  expand(): void;
  isVersionAtLeast?(version: string): boolean;
  close(): void;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  };
  /** Bot API 6.9+: спросить разрешение, чтобы бот мог писать в личку. */
  requestWriteAccess?(callback?: (allowed: boolean) => void): void;
  /** Bot API 6.9+: хранилище в облаке Telegram, общее для всех устройств игрока. */
  CloudStorage?: {
    getItem(key: string, callback: (error: string | null, value?: string) => void): void;
    setItem(key: string, value: string, callback?: (error: string | null, stored?: boolean) => void): void;
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

/** Telegram старше нужной версии не умеет метод и шумит в консоль — не зовём его. */
function supports(version: string): boolean {
  try {
    return tg?.isVersionAtLeast ? tg.isVersionAtLeast(version) : false;
  } catch {
    return false;
  }
}

/** Просит у игрока разрешение на сообщения от бота; false — отказ или Telegram не поддерживает. */
export function requestWriteAccess(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!tg?.requestWriteAccess || !supports('6.9')) {
      resolve(false);
      return;
    }
    try {
      tg.requestWriteAccess((allowed) => resolve(Boolean(allowed)));
    } catch {
      resolve(false);
    }
  });
}

/** Значение из CloudStorage Telegram, при ошибке или вне Telegram — из localStorage. */
export function loadFlag(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    const fromLocal = () => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    };
    const cloud = supports('6.9') ? tg?.CloudStorage : undefined;
    if (!cloud) {
      resolve(fromLocal());
      return;
    }
    let done = false;
    const timer = window.setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fromLocal());
      }
    }, 2500);
    try {
      cloud.getItem(key, (error, value) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        if (error) resolve(fromLocal());
        else resolve(value ? value : fromLocal());
      });
    } catch {
      window.clearTimeout(timer);
      done = true;
      resolve(fromLocal());
    }
  });
}

/** Сохраняет флаг и в CloudStorage, и в localStorage (что сработает). */
export function saveFlag(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Хранилище закрыто — не критично.
  }
  try {
    if (supports('6.9')) tg?.CloudStorage?.setItem(key, value);
  } catch {
    // Старый Telegram без CloudStorage.
  }
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
