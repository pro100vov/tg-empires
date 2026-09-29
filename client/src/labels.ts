import type { AiLevel } from '@tge/shared';

/** Подписи выбора «Время на ход». */
export function turnMinutesLabel(minutes: number): string {
  if (minutes <= 0) return 'Без лимита';
  if (minutes === 60) return '1 час';
  if (minutes === 1440) return '24 часа';
  return `${minutes} мин`;
}

export function turnMinutesHint(minutes: number): string {
  if (minutes <= 0) return 'Ход не ограничен. Игрок, вышедший из игры, пропускает ход через 3 минуты.';
  if (minutes < 60) return 'Блиц: ход сгорает по таймеру, даже если игрок в игре.';
  return 'Асинхронная партия: можно ходить в любое время, бот напишет, когда настанет ваш ход.';
}

export const AI_LABEL: Record<AiLevel, string> = {
  easy: 'Лёгкий',
  normal: 'Средний',
  hard: 'Сложный',
};

/** «3 ч 05 мин» / «12:40» — сколько осталось до момента. */
export function leftLabel(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return m > 0 ? `${h} ч ${String(m).padStart(2, '0')} мин` : `${h} ч`;
  }
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
