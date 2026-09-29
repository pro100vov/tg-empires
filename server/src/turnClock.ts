import { currentPlayer, isAiPlayer } from '@tge/shared';
import type { GameState } from '@tge/shared';

/**
 * Таймер хода. Время — не правило игры, поэтому его ведёт сервер:
 * при смене хода в `state.turnDeadline` ставится момент, когда ход сгорит.
 */

/** После рестарта сервера просроченному ходу даём немного времени, а не сжигаем сразу. */
const GRACE_AFTER_LOAD_MS = 5 * 60_000;

/** Ключ хода, для которого уже поставлен дедлайн. */
const seenTurn = new Map<string, string>();

function turnKey(state: GameState): string {
  return `${state.phase}:${state.round}:${state.turnIndex}`;
}

/** Есть ли у этого хода дедлайн вообще: идёт партия, задан лимит, ходит человек. */
function hasClock(state: GameState): boolean {
  if (state.phase !== 'playing' || state.settings.hotseat) return false;
  if (!(state.settings.turnMinutes > 0)) return false;
  const current = currentPlayer(state);
  return Boolean(current && !isAiPlayer(current.id));
}

/** Если ход сменился — ставит новый дедлайн. Безопасно вызывать сколько угодно раз. */
export function syncTurnClock(state: GameState, now = Date.now()): void {
  const key = turnKey(state);
  if (seenTurn.get(state.roomCode) === key) return;
  seenTurn.set(state.roomCode, key);
  state.turnDeadline = hasClock(state) ? now + state.settings.turnMinutes * 60_000 : null;
}

/** После загрузки с диска: запоминаем текущий ход и сдвигаем уже прошедший дедлайн. */
export function restoreTurnClock(state: GameState, now = Date.now()): void {
  seenTurn.set(state.roomCode, turnKey(state));
  if (!hasClock(state)) {
    state.turnDeadline = null;
    return;
  }
  const grace = Math.min(GRACE_AFTER_LOAD_MS, state.settings.turnMinutes * 60_000);
  if (!state.turnDeadline || state.turnDeadline < now) state.turnDeadline = now + grace;
}

/** Ход сгорел? */
export function turnExpired(state: GameState, now = Date.now()): boolean {
  return state.phase === 'playing' && state.turnDeadline != null && now >= state.turnDeadline;
}

/** Блиц-таймер ждёт, пока в партии никого нет: сдвигаем дедлайн на полный ход. */
export function pauseTurnClock(state: GameState, now = Date.now()): void {
  if (state.turnDeadline != null) state.turnDeadline = now + state.settings.turnMinutes * 60_000;
}

export function forgetTurnClock(code: string): void {
  seenTurn.delete(code);
}
