import type { GameState, Relation } from './types.js';

/** Допустимые сроки перемирия, раундов. */
export const TRUCE_ROUNDS = [3, 5, 10] as const;

/** Ключ пары держав — не зависит от порядка. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function relationOf(state: GameState, a: string, b: string): Relation | undefined {
  const rels = state.relations;
  if (!rels) return undefined;
  // Договоров обычно нет — не строим ключ на каждый вызов (обзор считает их тысячами).
  for (const _key in rels) return rels[pairKey(a, b)];
  return undefined;
}

/** Война: нет договора (и это разные державы). */
export function atWar(state: GameState, a: string, b: string): boolean {
  if (a === b) return false;
  return !relationOf(state, a, b);
}

export function areAllies(state: GameState, a: string, b: string): boolean {
  if (a === b) return false;
  return relationOf(state, a, b)?.kind === 'alliance';
}

/** Союзники державы (только живые, без неё самой). */
export function alliesOf(state: GameState, id: string): string[] {
  const rels = state.relations;
  if (!rels) return [];
  const out: string[] = [];
  for (const p of state.players) {
    if (p.id === id || !p.alive) continue;
    if (rels[pairKey(id, p.id)]?.kind === 'alliance') out.push(p.id);
  }
  return out;
}

/** Клетка чужой державы, с которой у нас договор: входить и стрелять нельзя. */
export function treatyShields(state: GameState, viewer: string, ownerId: string | null): boolean {
  if (!ownerId || ownerId === viewer) return false;
  return Boolean(relationOf(state, viewer, ownerId));
}
