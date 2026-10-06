/**
 * Варгейм: армия покупается на стартовый капитал, без экономики. Здесь — цены, зоны
 * расстановки, закупка (фаза `deploy`), автозакупка для ИИ и счёт отрядов. Ход и бой —
 * общие из `engine.ts`, он лишь ветвится по `isWargame`.
 */
import { KILL_GOAL_MAX, TERRAIN } from './config.js';
import { buildingsFor, commandersFor, eraOf } from './eras.js';
import { hexDistance, tileAt } from './map.js';
import { mulberry32 } from './rng.js';
import { UNIT_IDS, armyCount, dominantUnit, unitsFor, writeWings } from './units.js';
import type {
  ActionResult,
  BuildingType,
  CommanderId,
  DeployAction,
  EraId,
  GameSettings,
  GameState,
  Player,
  Tile,
  UnitClass,
  UnitId,
  UnitTier,
} from './types.js';

/** Юнитов в отряде по тиру: лёгких больше, тяжёлых меньше. */
export const SQUAD_SIZE: Record<UnitTier, number> = { light: 5, medium: 4, heavy: 3 };
/** Укрепления, которые продаются в варгейме, и сколько ходов их ставят. */
export const WAR_FORTS: BuildingType[] = ['palisade', 'fort'];
export const WAR_FORT_TURNS: Partial<Record<BuildingType, number>> = { palisade: 1, fort: 2 };
/** Сколько своих ходов покоя подряд нужно отряду, чтобы вернуть 1 юнит. */
export const HEAL_REST_TURNS = 2;
/** Очки за уничтоженный отряд при подсчёте по раундам: важнее любой стоимости армии. */
const KILL_SCORE = 1000;

export function isWargame(state: { settings?: Pick<GameSettings, 'mode'> }): boolean {
  return state.settings?.mode === 'wargame';
}

export function squadSize(era: EraId, unit: UnitId): number {
  return SQUAD_SIZE[unitsFor(era)[unit].tier];
}

/** Цена одного юнита в золоте: железо и еда империи считаются один к одному. */
export function unitPrice(era: EraId, unit: UnitId): number {
  const c = unitsFor(era)[unit].cost;
  return (c.gold ?? 0) + (c.iron ?? 0) + (c.food ?? 0);
}

export function squadPrice(era: EraId, unit: UnitId): number {
  return unitPrice(era, unit) * squadSize(era, unit);
}

export function commanderPrice(era: EraId, id: CommanderId): number {
  const c = commandersFor(era)[id].cost;
  return (c.gold ?? 0) + (c.iron ?? 0) + (c.food ?? 0);
}

export function fortPrice(era: EraId, building: BuildingType): number {
  const c = buildingsFor(era)[building].cost;
  return (c.gold ?? 0) + (c.iron ?? 0) + (c.food ?? 0);
}

/** «Авто»: примерно 40% отрядов, которые можно купить на капитал. */
export function autoKillGoal(capital: number): number {
  return Math.max(2, Math.round(capital / 150));
}

/** Сколько отрядов нужно уничтожить для победы; 0 — цель выключена. */
export function killGoalOf(settings: Pick<GameSettings, 'killGoal' | 'warCapital'>): number {
  if (settings.killGoal < 0) return autoKillGoal(settings.warCapital);
  return Math.min(KILL_GOAL_MAX, Math.max(0, Math.round(settings.killGoal)));
}

export function squadUnit(tile: Tile): UnitId | null {
  return dominantUnit(tile.army);
}

/** Клетки с отрядами игрока. */
export function squadsOf(state: GameState, playerId: string): Tile[] {
  return state.tiles.filter((t) => t.ownerId === playerId && armyCount(t.army) > 0);
}

/** Стоимость живой армии: юниты по цене плюс командиры. */
export function armyValue(state: GameState, playerId: string): number {
  const era = eraOf(state.settings);
  let value = 0;
  for (const tile of squadsOf(state, playerId)) {
    for (const id of UNIT_IDS) value += unitPrice(era, id) * (tile.army[id] ?? 0);
    if (tile.commander) value += commanderPrice(era, tile.commander);
  }
  return value;
}

export function wargameScore(state: GameState, player: Player): number {
  return (player.stats.squadsKilled ?? 0) * KILL_SCORE + armyValue(state, player.id);
}

// ── Зоны расстановки ─────────────────────────────────────────────────────────

export type ZoneSide = 'top' | 'bottom' | 'left' | 'right';
const SIDES: ZoneSide[] = ['top', 'bottom', 'left', 'right'];

export function zoneDepth(size: number): number {
  return size >= 12 ? 3 : 2;
}

/** Сторона карты игрока по месту в списке: двое — сверху и снизу, трое-четверо — ещё слева и справа. */
export function zoneSideOf(state: GameState, playerId: string): ZoneSide | null {
  const idx = state.players.findIndex((p) => p.id === playerId);
  return idx >= 0 ? SIDES[idx] ?? null : null;
}

function inSide(side: ZoneSide, size: number, players: number, x: number, y: number): boolean {
  const d = zoneDepth(size);
  // Втроём-вчетвером края по сторонам обрезаны, чтобы зоны не пересекались в углах.
  const lo = players > 2 ? d : 0;
  const hi = players > 2 ? size - 1 - d : size - 1;
  switch (side) {
    case 'top':
      return y < d && x >= lo && x <= hi;
    case 'bottom':
      return y >= size - d && x >= lo && x <= hi;
    case 'left':
      return x < d && y >= d && y <= size - 1 - d;
    case 'right':
      return x >= size - d && y >= d && y <= size - 1 - d;
  }
}

/** Чья зона расстановки на клетке (по раскладке игроков). */
export function zoneOwnerAt(state: GameState, x: number, y: number): string | null {
  const size = state.width;
  const n = state.players.length;
  for (let i = 0; i < n && i < SIDES.length; i++) {
    if (inSide(SIDES[i]!, size, n, x, y)) return state.players[i]!.id;
  }
  return null;
}

export function deployZone(state: GameState, playerId: string): Tile[] {
  return state.tiles.filter((t) => zoneOwnerAt(state, t.x, t.y) === playerId);
}

/** Глубина клетки от своего края: 0 — у самого края, больше — ближе к фронту. */
function depthOf(side: ZoneSide, size: number, t: { x: number; y: number }): number {
  switch (side) {
    case 'top':
      return t.y;
    case 'bottom':
      return size - 1 - t.y;
    case 'left':
      return t.x;
    case 'right':
      return size - 1 - t.x;
  }
}

/** Смещение вдоль своего края от середины — фланг. */
function lateralOf(side: ZoneSide, size: number, t: { x: number; y: number }): number {
  const mid = (size - 1) / 2;
  return side === 'top' || side === 'bottom' ? Math.abs(t.x - mid) : Math.abs(t.y - mid);
}

// ── Подготовка и закупка ─────────────────────────────────────────────────────

/** Чистая карта без столиц, деньги = капитал, зоны проходимы. */
export function prepareDeploy(state: GameState): void {
  for (const tile of state.tiles) {
    tile.ownerId = null;
    tile.capitalOf = null;
    tile.building = null;
    tile.construction = null;
    tile.commander = null;
    tile.routedTurns = 0;
    tile.square = false;
    tile.squad = null;
    writeWings(tile, []);
    if (zoneOwnerAt(state, tile.x, tile.y) && !TERRAIN[tile.terrain].passable) {
      tile.terrain = tile.terrain === 'mountains' ? 'hills' : 'plains';
    }
  }
  for (const player of state.players) {
    player.resources = { gold: state.settings.warCapital, food: 0, iron: 0 };
    player.forts = [];
    player.deployReady = false;
    player.actionsLeft = 0;
  }
}

function placeSquad(tile: Tile, playerId: string, unit: UnitId, size: number): void {
  tile.ownerId = playerId;
  writeWings(tile, [{ army: { [unit]: size }, movesLeft: 0, shotsLeft: 0 }]);
  tile.squad = { size, rest: 0 };
}

function clearTile(tile: Tile): void {
  writeWings(tile, []);
  tile.ownerId = null;
  tile.commander = null;
  tile.squad = null;
}

/** Деньги за отряд и его командира — обратно. */
function refundTile(state: GameState, player: Player, tile: Tile): void {
  const era = eraOf(state.settings);
  const unit = squadUnit(tile);
  if (unit) player.resources.gold += squadPrice(era, unit);
  if (tile.commander) player.resources.gold += commanderPrice(era, tile.commander);
  clearTile(tile);
}

/**
 * Одно действие закупки. Возвращает ok; начать ли бой (все готовы) — решает engine.
 */
export function deployStep(state: GameState, playerId: string, action: DeployAction): ActionResult {
  if (state.phase !== 'deploy') return { ok: false, error: 'Сейчас не расстановка' };
  const player = state.players.find((p) => p.id === playerId);
  if (!player || !player.alive) return { ok: false, error: 'Вы не в этой партии' };
  if (player.deployReady && !(action.type === 'ready' && !action.ready)) {
    return { ok: false, error: 'Вы уже готовы — снимите «Готов», чтобы менять армию' };
  }
  const era = eraOf(state.settings);
  const gold = player.resources;

  switch (action.type) {
    case 'buySquad': {
      if (!UNIT_IDS.includes(action.unit)) return { ok: false, error: 'Неизвестный род войск' };
      const tile = tileAt(state, action.at.x, action.at.y);
      if (!tile) return { ok: false, error: 'Клетки не существует' };
      if (zoneOwnerAt(state, tile.x, tile.y) !== playerId) return { ok: false, error: 'Ставить можно только в своей зоне' };
      if (!TERRAIN[tile.terrain].passable) return { ok: false, error: 'Сюда не встать' };
      if (armyCount(tile.army) > 0) return { ok: false, error: 'На клетке уже стоит отряд' };
      const price = squadPrice(era, action.unit);
      if (gold.gold < price) return { ok: false, error: 'Не хватает золота' };
      gold.gold -= price;
      placeSquad(tile, playerId, action.unit, squadSize(era, action.unit));
      return { ok: true, events: [] };
    }

    case 'sellSquad': {
      const tile = tileAt(state, action.at.x, action.at.y);
      if (!tile || tile.ownerId !== playerId || armyCount(tile.army) < 1) return { ok: false, error: 'Здесь нет вашего отряда' };
      refundTile(state, player, tile);
      return { ok: true, events: [] };
    }

    case 'buyCommander': {
      const commanders = commandersFor(era);
      if (!Object.hasOwn(commanders, action.commander)) return { ok: false, error: 'Неизвестный командир' };
      const tile = tileAt(state, action.at.x, action.at.y);
      if (!tile || tile.ownerId !== playerId || armyCount(tile.army) < 1) return { ok: false, error: 'Командира ставят к своему отряду' };
      if (tile.commander) return { ok: false, error: 'У отряда уже есть командир' };
      const price = commanderPrice(era, action.commander);
      if (gold.gold < price) return { ok: false, error: 'Не хватает золота' };
      gold.gold -= price;
      tile.commander = action.commander;
      return { ok: true, events: [] };
    }

    case 'sellCommander': {
      const tile = tileAt(state, action.at.x, action.at.y);
      if (!tile || tile.ownerId !== playerId || !tile.commander) return { ok: false, error: 'Здесь нет вашего командира' };
      gold.gold += commanderPrice(era, tile.commander);
      tile.commander = null;
      return { ok: true, events: [] };
    }

    case 'buyFort': {
      if (!WAR_FORTS.includes(action.building)) return { ok: false, error: 'Такое укрепление не продаётся' };
      const price = fortPrice(era, action.building);
      if (gold.gold < price) return { ok: false, error: 'Не хватает золота' };
      gold.gold -= price;
      (player.forts ??= []).push(action.building);
      return { ok: true, events: [] };
    }

    case 'sellFort': {
      const forts = player.forts ?? [];
      const idx = forts.indexOf(action.building);
      if (idx < 0) return { ok: false, error: 'Такого укрепления нет' };
      forts.splice(idx, 1);
      gold.gold += fortPrice(era, action.building);
      return { ok: true, events: [] };
    }

    case 'clear': {
      for (const tile of squadsOf(state, playerId)) refundTile(state, player, tile);
      for (const b of player.forts ?? []) gold.gold += fortPrice(era, b);
      player.forts = [];
      return { ok: true, events: [] };
    }

    case 'auto': {
      autoDeploy(state, playerId);
      return { ok: true, events: [] };
    }

    case 'ready': {
      if (action.ready && squadsOf(state, playerId).length === 0) {
        return { ok: false, error: 'Купите хотя бы один отряд' };
      }
      player.deployReady = action.ready;
      return { ok: true, events: [] };
    }
  }
  return { ok: false, error: 'Неизвестное действие' };
}

export function allDeployed(state: GameState): boolean {
  return state.players.filter((p) => p.alive).every((p) => p.deployReady);
}

// ── Автозакупка (ИИ, офлайн, кнопка «Авто») ──────────────────────────────────

/** Порядок покупки: пехота держит фронт, стрелки за ней, конница — фланги и добивание. */
const BUY_PATTERN: UnitId[] = [
  'medium_infantry',
  'medium_archer',
  'medium_cavalry',
  'heavy_infantry',
  'light_archer',
  'light_cavalry',
  'medium_infantry',
  'medium_horse_archer',
  'heavy_cavalry',
  'heavy_archer',
];

function placementScore(cls: UnitClass, mounted: boolean, depth: number, lateral: number, front: number): number {
  if (cls === 'infantry') return depth * 10 - lateral;
  if (cls === 'archer' && !mounted) return -Math.abs(depth - Math.max(0, front - 1)) * 10 - lateral;
  return depth * 4 + lateral * 3;
}

/** Докупает армию на остаток золота: смесь родов, командир, частокол. Готовность не трогает. */
export function autoDeploy(state: GameState, playerId: string): void {
  const player = state.players.find((p) => p.id === playerId);
  const side = zoneSideOf(state, playerId);
  if (!player || !side) return;
  const era = eraOf(state.settings);
  const units = unitsFor(era);
  const size = state.width;
  const rand = mulberry32((state.seed ^ (state.players.indexOf(player) + 1) * 0x9e3779b9) >>> 0);
  const free = () =>
    deployZone(state, playerId).filter((t) => TERRAIN[t.terrain].passable && armyCount(t.army) === 0);
  const zone = deployZone(state, playerId);
  const front = Math.max(0, ...zone.map((t) => depthOf(side, size, t)));
  const cheapest = Math.min(...UNIT_IDS.map((id) => squadPrice(era, id)));

  // Командир — если денег хватает хотя бы на пять средних отрядов сверху.
  const wantCommander = player.resources.gold >= commanderPrice(era, 'warlord') + 5 * squadPrice(era, 'medium_infantry');
  const palisade = fortPrice(era, 'palisade');
  const wantFort = player.resources.gold >= palisade + 6 * cheapest;
  if (wantFort) {
    player.resources.gold -= palisade;
    (player.forts ??= []).push('palisade');
  }
  const reserve = wantCommander ? commanderPrice(era, 'warlord') : 0;

  let i = Math.floor(rand() * BUY_PATTERN.length);
  let misses = 0;
  while (misses < BUY_PATTERN.length * 2) {
    const tiles = free();
    if (tiles.length === 0) break;
    const budget = player.resources.gold - reserve;
    if (budget < cheapest) break;
    let unit: UnitId | undefined = BUY_PATTERN[i % BUY_PATTERN.length]!;
    i += 1;
    if (squadPrice(era, unit) > budget) {
      // Не хватает на задуманный — тот же класс подешевле.
      const cls = units[unit].class;
      unit = UNIT_IDS.filter((id) => units[id].class === cls && squadPrice(era, id) <= budget).sort(
        (a, b) => squadPrice(era, b) - squadPrice(era, a),
      )[0];
      if (!unit) {
        misses += 1;
        continue;
      }
    }
    const info = units[unit];
    const tile = tiles
      .map((t) => ({ t, s: placementScore(info.class, info.mounted, depthOf(side, size, t), lateralOf(side, size, t), front) + rand() * 0.5 }))
      .sort((a, b) => b.s - a.s)[0]!.t;
    player.resources.gold -= squadPrice(era, unit);
    placeSquad(tile, playerId, unit, squadSize(era, unit));
    misses = 0;
  }

  if (wantCommander) {
    const squads = squadsOf(state, playerId).filter((t) => !t.commander);
    const best = squads.sort((a, b) => unitPrice(era, squadUnit(b)!) - unitPrice(era, squadUnit(a)!))[0];
    const price = commanderPrice(era, 'warlord');
    if (best && player.resources.gold >= price) {
      player.resources.gold -= price;
      best.commander = 'warlord';
    }
  }
}

/** Середина зоны врага — куда идти, пока враг не виден. */
export function enemyZoneCenters(state: GameState, playerId: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const p of state.players) {
    if (p.id === playerId || !p.alive) continue;
    const zone = deployZone(state, p.id);
    if (zone.length === 0) continue;
    const cx = zone.reduce((s, t) => s + t.x, 0) / zone.length;
    const cy = zone.reduce((s, t) => s + t.y, 0) / zone.length;
    const best = zone.sort((a, b) => hexDistance(a, { x: Math.round(cx), y: Math.round(cy) }) - hexDistance(b, { x: Math.round(cx), y: Math.round(cy) }))[0]!;
    out.push({ x: best.x, y: best.y });
  }
  return out;
}
