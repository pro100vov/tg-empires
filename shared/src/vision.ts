import { COMMANDERS } from './commanders.js';
import type { Coord, GameFx, GameState, TerrainType, Tile } from './types.js';
import { hexDistance, hexLine, neighbors, tileAt } from './map.js';
import { armyCount } from './units.js';

/** Базовая дальность обзора от армии, столицы или крепости. */
export const VISION_BASE = 3;

function terrainHeight(terrain: TerrainType): number {
  if (terrain === 'mountains') return 3;
  if (terrain === 'hills') return 2;
  if (terrain === 'forest') return 1;
  return 0;
}

export function observerRange(tile: Tile): number {
  let range = VISION_BASE;
  if (tile.terrain === 'hills') range += 1;
  if (tile.commander) range += COMMANDERS[tile.commander].visionBonus;
  return range;
}

/** Откуда смотрит игрок: свои войска, столица, крепость. */
export function visionObservers(state: GameState, playerId: string): Tile[] {
  return state.tiles.filter(
    (tile) =>
      tile.ownerId === playerId &&
      (armyCount(tile.army) > 0 || tile.capitalOf === playerId || tile.building === 'fort'),
  );
}

/** Горы всегда закрывают. Холм закрывает, если не ниже точки наблюдения. Два леса подряд глушат луч. */
export function hasLineOfSight(state: GameState, from: Coord, to: Coord): boolean {
  const dist = hexDistance(from, to);
  if (dist <= 1) return true;
  const origin = tileAt(state, from.x, from.y);
  const fromH = origin ? terrainHeight(origin.terrain) : 0;
  const line = hexLine(from, to);
  let forestStreak = origin?.terrain === 'forest' ? 1 : 0;
  for (let i = 1; i < line.length - 1; i++) {
    const step = line[i]!;
    const tile = tileAt(state, step.x, step.y);
    if (!tile) continue;
    if (tile.terrain === 'mountains') return false;
    if (tile.terrain === 'hills' && terrainHeight(tile.terrain) >= fromH) return false;
    if (tile.terrain === 'forest') {
      forestStreak += 1;
      if (forestStreak >= 2) return false;
    } else {
      forestStreak = 0;
    }
  }
  return true;
}

/** Клетка в поле зрения: свои земли всегда, чужие — по дальности и лучу. */
export function canWatchTile(state: GameState, viewerId: string, target: Coord): boolean {
  if (state.settings?.fogOfWar === false) return true;
  const tile = tileAt(state, target.x, target.y);
  if (!tile) return false;
  if (tile.ownerId === viewerId) return true;
  for (const observer of visionObservers(state, viewerId)) {
    if (hexDistance(observer, target) > observerRange(observer)) continue;
    if (!hasLineOfSight(state, observer, target)) continue;
    return true;
  }
  return false;
}

function isContact(state: GameState, viewerId: string, tile: Tile): boolean {
  return neighbors(state, tile).some(
    (n) => n.ownerId === viewerId && (armyCount(n.army) > 0 || n.capitalOf === viewerId || n.building === 'fort'),
  );
}

/** Была бы видна армия на клетке, даже если её сейчас нет. Лес — только в упор. */
export function canDetectArmyOn(state: GameState, viewerId: string, tile: Tile): boolean {
  if (state.settings?.fogOfWar === false) return true;
  if (tile.ownerId === viewerId) return true;
  if (isContact(state, viewerId, tile)) return true;
  if (tile.terrain === 'forest') return false;
  return canWatchTile(state, viewerId, tile);
}

/** Чужую армию видно: в обзоре, не за укрытием; лес — только в упор. */
export function canSeeArmyOn(state: GameState, viewerId: string, tile: Tile): boolean {
  if (tile.ownerId === viewerId) return true;
  if (armyCount(tile.army) === 0) return true;
  return canDetectArmyOn(state, viewerId, tile);
}

function hideArmy(tile: Tile): Tile {
  return {
    ...tile,
    army: {},
    commander: null,
    routedTurns: 0,
    movesLeft: 0,
    shotsLeft: 0,
    wings: [],
    square: false,
  };
}

function tileKey(tile: Coord): string {
  return `${tile.x},${tile.y}`;
}

/** Запоминает постройки, которые зритель сейчас видит. */
export function rememberSeenBuildings(state: GameState, viewerId: string): void {
  const player = state.players.find((p) => p.id === viewerId);
  if (!player || state.phase !== 'playing') return;
  if (!player.seenBuildings) player.seenBuildings = {};
  for (const tile of state.tiles) {
    if (!tile.building) continue;
    if (tile.ownerId === viewerId || canWatchTile(state, viewerId, tile)) {
      player.seenBuildings[tileKey(tile)] = tile.building;
    }
  }
}

function maskTile(state: GameState, viewerId: string, tile: Tile): Tile {
  const seen = state.players.find((p) => p.id === viewerId)?.seenBuildings ?? {};
  const watching = tile.ownerId === viewerId || canWatchTile(state, viewerId, tile);
  if (watching) {
    return canSeeArmyOn(state, viewerId, tile) ? tile : hideArmy(tile);
  }
  const known = seen[tileKey(tile)] ?? null;
  return {
    ...hideArmy(tile),
    ownerId: null,
    capitalOf: null,
    commander: null,
    building: known,
    construction: null,
  };
}

/** Копия состояния без чужих войск и неувиденных построек. Не мутирует оригинал. */
export function maskStateFor(state: GameState, viewerId: string): GameState {
  if (state.phase !== 'playing') return state;
  if (state.settings?.fogOfWar === false) return state;
  return {
    ...state,
    tiles: state.tiles.map((tile) => maskTile(state, viewerId, tile)),
    players: state.players.map((player) =>
      player.id === viewerId ? player : { ...player, seenBuildings: {} },
    ),
  };
}

export function maskFxFor(state: GameState, viewerId: string, fx: GameFx | undefined): GameFx | undefined {
  if (!fx || state.phase !== 'playing') return fx;
  if (state.settings?.fogOfWar === false) return fx;
  const from = tileAt(state, fx.from.x, fx.from.y);
  const to = tileAt(state, fx.to.x, fx.to.y);
  if (!from || !to) return undefined;
  if (fx.kind === 'shoot' || fx.battle !== 'none') {
    const watch = canWatchTile(state, viewerId, from) || canWatchTile(state, viewerId, to);
    return watch ? fx : undefined;
  }
  if (!canDetectArmyOn(state, viewerId, to)) return undefined;
  return fx;
}
