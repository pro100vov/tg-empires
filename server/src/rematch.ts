import { addAiPlayer, addPlayer, applyLobbyAction, setupHotseat } from '@tge/shared';
import type { GameState } from '@tge/shared';
import { createRoom, getRoom, markDirty } from './rooms.js';

export type RematchResult =
  | { ok: true; state: GameState; created: boolean }
  | { ok: false; error: string };

/**
 * Реванш: первый нажавший создаёт новую комнату с теми же настройками (новый seed, ИИ-соперники
 * переходят сами), остальные попадают в ту же — её код лежит в `old.rematchCode`.
 * `addSelf: false` — из бота: игрок зайдёт по кнопке и станет хостом сам.
 */
export function rematchRoom(
  old: GameState,
  userId: string,
  userName: string,
  addSelf = true,
): RematchResult {
  if (old.phase !== 'finished') return { ok: false, error: 'Партия ещё идёт' };
  if (!old.players.some((p) => p.id === userId)) return { ok: false, error: 'Вы не участвовали в этой партии' };

  const existing = old.rematchCode ? getRoom(old.rematchCode) : undefined;
  if (existing && existing.phase === 'lobby') {
    if (addSelf) {
      const joined = addPlayer(existing, userId, userName);
      if (!joined.ok) return { ok: false, error: joined.error };
      markDirty(existing.roomCode);
    }
    return { ok: true, state: existing, created: false };
  }

  const fresh = createRoom(userId);
  if (old.settings.hotseat) {
    const solo = setupHotseat(fresh, userId, userName);
    if (!solo.ok) return { ok: false, error: solo.error };
  } else {
    applyLobbyAction(fresh, userId, {
      type: 'configure',
      settings: { ...old.settings, terrainMode: 'random' },
    });
    if (addSelf) addPlayer(fresh, userId, userName);
    for (const p of old.players) if (p.ai) addAiPlayer(fresh, p.ai);
  }
  old.rematchCode = fresh.roomCode;
  markDirty(fresh.roomCode);
  return { ok: true, state: fresh, created: true };
}
