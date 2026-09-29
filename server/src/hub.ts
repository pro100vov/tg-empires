import type { GameFx, GameState } from '@tge/shared';

/**
 * Мостик между index.ts (сокеты) и модулями, которым нужно разослать состояние
 * (бот, ИИ, реванш), — чтобы не было циклических импортов.
 */
type Push = (state: GameState, payload?: { fx?: GameFx; skip?: string }) => void;

let pushImpl: Push = () => {};

export function bindPush(fn: Push): void {
  pushImpl = fn;
}

export function pushStateSafe(state: GameState, payload?: { fx?: GameFx; skip?: string }): void {
  pushImpl(state, payload);
}
