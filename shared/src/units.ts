import type { Army, EraId, MarchWing, ShotKind, TerrainType, Tile, UnitClass, UnitId, UnitTier } from './types.js';
import type { Resources } from './types.js';
import { ERA_UNITS, ERAS } from './eras.js';

export const UNIT_IDS: UnitId[] = [
  'light_infantry',
  'medium_infantry',
  'heavy_infantry',
  'light_cavalry',
  'medium_cavalry',
  'heavy_cavalry',
  'light_archer',
  'medium_archer',
  'heavy_archer',
  'light_horse_archer',
  'medium_horse_archer',
  'heavy_horse_archer',
];

export interface UnitInfo {
  id: UnitId;
  class: UnitClass;
  tier: UnitTier;
  name: string;
  icon: string;
  attack: number;
  defense: number;
  /** Гексов хода за раунд владельца. */
  speed: number;
  /** Ближний бой с 2 гексов, если осталось ≥2 клетки хода. */
  charge: boolean;
  /** Конные лучники: ход как у конницы, залп как у лучников. */
  mounted: boolean;
  cost: Resources;
  /** Еды в ход на отряд: конница ест больше пехоты. */
  upkeep: number;
  description: string;
  /** Подпись в сетке найма. */
  short: string;
  /** Дальность залпа; 0 — только ближний бой. */
  range: number;
  /** Вид снаряда, если умеет стрелять. */
  shot?: ShotKind;
}

/** Множитель атаки при набеге (удар с разгона). */
export const CHARGE_ATTACK = 1.2;
/** Сколько клеток хода сжигает набег. */
export const CHARGE_COST = 2;
/** Конница почти не берёт каре. */
export const SQUARE_CAVALRY_ATTACK = 0.32;
/** В каре и атака, и ответ скучены — бьют слабо. */
export const SQUARE_MELEE = 0.55;
/** Потери в бою с каре режутся: это перемалывание, а не резня. */
export const SQUARE_CASUALTY = 0.4;
/** Залп после хода в этом раунде — слабее; ближний бой не трогаем. */
export const MOVED_VOLLEY = 0.65;

export const UNITS: Record<UnitId, UnitInfo> = {
  light_infantry: {
    id: 'light_infantry',
    class: 'infantry',
    tier: 'light',
    name: 'Лёгкая пехота',
    icon: '🗡️',
    attack: 0.8,
    defense: 0.75,
    speed: 1,
    charge: false,
    mounted: false,
    cost: { gold: 5, food: 0, iron: 2 },
    upkeep: 1,
    description: 'Дешёвый строй, слабо держит удар',
    short: 'Лёгк. пех.',
    range: 0,
  },
  medium_infantry: {
    id: 'medium_infantry',
    class: 'infantry',
    tier: 'medium',
    name: 'Пехота',
    icon: '⚔️',
    attack: 1,
    defense: 1.1,
    speed: 1,
    charge: false,
    mounted: false,
    cost: { gold: 8, food: 0, iron: 4 },
    upkeep: 1.2,
    description: 'Сильна против конницы, в лесу держится лучше коней',
    short: 'Средн. пех.',
    range: 0,
  },
  heavy_infantry: {
    id: 'heavy_infantry',
    class: 'infantry',
    tier: 'heavy',
    name: 'Тяжёлая пехота',
    icon: '🛡️',
    attack: 1.2,
    defense: 1.55,
    speed: 1,
    charge: false,
    mounted: false,
    cost: { gold: 14, food: 0, iron: 8 },
    upkeep: 1.6,
    description: 'Щит державы, ход 1, бьёт только в упор',
    short: 'Тяж. пех.',
    range: 0,
  },
  light_cavalry: {
    id: 'light_cavalry',
    class: 'cavalry',
    tier: 'light',
    name: 'Лёгкая конница',
    icon: '🐴',
    attack: 0.95,
    defense: 0.65,
    speed: 3,
    charge: true,
    mounted: false,
    cost: { gold: 7, food: 0, iron: 3 },
    upkeep: 2,
    description: 'Ход 3, набег с 2 гексов, лес −2 кл.',
    short: 'Лёгк. кон.',
    range: 0,
  },
  medium_cavalry: {
    id: 'medium_cavalry',
    class: 'cavalry',
    tier: 'medium',
    name: 'Конница',
    icon: '🐎',
    attack: 1.25,
    defense: 0.85,
    speed: 2,
    charge: true,
    mounted: false,
    cost: { gold: 12, food: 0, iron: 5 },
    upkeep: 2.4,
    description: 'Набег с 2 гексов, в лесу строй встаёт',
    short: 'Средн. кон.',
    range: 0,
  },
  heavy_cavalry: {
    id: 'heavy_cavalry',
    class: 'cavalry',
    tier: 'heavy',
    name: 'Тяжёлая конница',
    icon: '🏇',
    attack: 1.55,
    defense: 1.05,
    speed: 2,
    charge: true,
    mounted: false,
    cost: { gold: 18, food: 0, iron: 9 },
    upkeep: 3,
    description: 'Таран с набегу, лес стоп, холмы −2 кл.',
    short: 'Тяж. кон.',
    range: 0,
  },
  light_archer: {
    id: 'light_archer',
    class: 'archer',
    tier: 'light',
    name: 'Лёгкие лучники',
    icon: '🏹',
    attack: 0.9,
    defense: 0.55,
    speed: 2,
    charge: false,
    mounted: false,
    cost: { gold: 6, food: 0, iron: 3 },
    upkeep: 1,
    description: 'Ход 2 гекса, залп в лес слаб',
    short: 'Лёгк. луч.',
    range: 2,
  },
  medium_archer: {
    id: 'medium_archer',
    class: 'archer',
    tier: 'medium',
    name: 'Лучники',
    icon: '🎯',
    attack: 1.2,
    defense: 0.7,
    speed: 1,
    charge: false,
    mounted: false,
    cost: { gold: 10, food: 0, iron: 4 },
    upkeep: 1.2,
    description: 'Залп на 2, в чащу бьют слабо',
    short: 'Средн. луч.',
    range: 2,
  },
  heavy_archer: {
    id: 'heavy_archer',
    class: 'archer',
    tier: 'heavy',
    name: 'Тяжёлые лучники',
    icon: '🏹',
    attack: 1.45,
    defense: 0.85,
    speed: 1,
    charge: false,
    mounted: false,
    cost: { gold: 16, food: 0, iron: 7 },
    upkeep: 1.6,
    description: 'Мощный залп с холмов, в лес слабо',
    short: 'Тяж. луч.',
    range: 2,
  },
  light_horse_archer: {
    id: 'light_horse_archer',
    class: 'archer',
    tier: 'light',
    name: 'Лёгкие кон. лучники',
    icon: '🏹',
    attack: 0.95,
    defense: 0.5,
    speed: 3,
    charge: false,
    mounted: true,
    cost: { gold: 9, food: 0, iron: 4 },
    upkeep: 2,
    description: 'Ход 3, залп, лес −2 кл. но не стоп, после выстрела могут отойти',
    short: 'Лёгк. кон.луч.',
    range: 2,
  },
  medium_horse_archer: {
    id: 'medium_horse_archer',
    class: 'archer',
    tier: 'medium',
    name: 'Конные лучники',
    icon: '🏹',
    attack: 1.2,
    defense: 0.6,
    speed: 3,
    charge: false,
    mounted: true,
    cost: { gold: 14, food: 0, iron: 6 },
    upkeep: 2.4,
    description: 'Ход 3, залп, в лесу стоп, после выстрела могут отойти',
    short: 'Кон. луч.',
    range: 2,
  },
  heavy_horse_archer: {
    id: 'heavy_horse_archer',
    class: 'archer',
    tier: 'heavy',
    name: 'Тяж. кон. лучники',
    icon: '🏹',
    attack: 1.4,
    defense: 0.75,
    speed: 2,
    charge: false,
    mounted: true,
    cost: { gold: 20, food: 0, iron: 8 },
    upkeep: 2.8,
    description: 'Ход 2, залп с коня, лес стоп, холмы −2 кл.',
    short: 'Тяж. кон.луч.',
    range: 2,
  },
};

export function unitsFor(era: EraId = 'ancient'): Record<UnitId, UnitInfo> {
  const overlay = ERA_UNITS[era] ?? {};
  const next = {} as Record<UnitId, UnitInfo>;
  for (const id of UNIT_IDS) {
    const base = UNITS[id];
    const extra = overlay[id];
    next[id] = extra
      ? {
          ...base,
          ...extra,
          id: base.id,
          class: base.class,
          tier: base.tier,
          charge: base.charge,
          mounted: base.mounted,
          shot: extra.shot ?? base.shot ?? ((extra.range ?? base.range) > 0 ? 'arrow' : undefined),
        }
      : { ...base, shot: base.shot ?? (base.range > 0 ? 'arrow' : undefined) };
  }
  return next;
}

export function unitOf(id: UnitId, era: EraId = 'ancient'): UnitInfo {
  return unitsFor(era)[id];
}

/** Камень-ножницы-бумага: конница бьёт лучников, лучники — пехоту, пехота — конницу. */
const BEATS: Record<UnitClass, UnitClass> = {
  cavalry: 'archer',
  archer: 'infantry',
  infantry: 'cavalry',
};

export function emptyArmy(): Army {
  return {};
}

export function armyCount(army: Army | undefined): number {
  if (!army) return 0;
  let n = 0;
  for (const id of UNIT_IDS) n += army[id] ?? 0;
  return n;
}

export function addToArmy(army: Army, unit: UnitId, count: number): Army {
  if (count <= 0) return { ...army };
  const next = { ...army };
  next[unit] = (next[unit] ?? 0) + count;
  return next;
}

export function mergeArmies(a: Army, b: Army): Army {
  const next: Army = { ...a };
  for (const id of UNIT_IDS) {
    const n = (next[id] ?? 0) + (b[id] ?? 0);
    if (n > 0) next[id] = n;
    else delete next[id];
  }
  return next;
}

export function armyUnitIds(army: Army): UnitId[] {
  return UNIT_IDS.filter((id) => (army[id] ?? 0) > 0);
}

/** Снимает `count` голов, начиная с лёгких отрядов. `only` — только этот род. */
export function takeArmy(from: Army, count: number, only?: UnitId): { taken: Army; rest: Army } {
  let left = Math.max(0, Math.floor(count));
  const taken: Army = {};
  const rest: Army = { ...from };
  const order = only ? [only] : UNIT_IDS;
  for (const id of order) {
    if (left <= 0) break;
    const have = rest[id] ?? 0;
    if (have <= 0) continue;
    const n = Math.min(have, left);
    taken[id] = n;
    const remain = have - n;
    if (remain > 0) rest[id] = remain;
    else delete rest[id];
    left -= n;
  }
  return { taken, rest };
}

export function scaleArmy(army: Army, survivors: number): Army {
  const total = armyCount(army);
  if (survivors <= 0 || total <= 0) return {};
  if (survivors >= total) return { ...army };
  const { taken } = takeArmy(army, survivors);
  return taken;
}

export function dominantUnit(army: Army): UnitId | null {
  let best: UnitId | null = null;
  let bestN = 0;
  for (const id of UNIT_IDS) {
    const n = army[id] ?? 0;
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

export function dominantClass(army: Army): UnitClass {
  const counts: Record<UnitClass, number> = { infantry: 0, cavalry: 0, archer: 0 };
  for (const id of UNIT_IDS) {
    const n = army[id] ?? 0;
    if (n) counts[UNITS[id].class] += n;
  }
  let best: UnitClass = 'infantry';
  let bestN = -1;
  for (const cls of ['infantry', 'cavalry', 'archer'] as UnitClass[]) {
    if (counts[cls] > bestN) {
      best = cls;
      bestN = counts[cls];
    }
  }
  return best;
}

function classMod(
  atk: UnitClass,
  def: UnitClass,
  era: EraId,
  square = false,
): number {
  // Линейная пехота без каре не держит кавалерию — каре как раз и переворачивает это.
  if (era === 'napoleonic' && !square) {
    if (atk === 'cavalry' && def === 'infantry') return 1.4;
    if (atk === 'infantry' && def === 'cavalry') return 0.7;
  }
  if (BEATS[atk] === def) return 1.4;
  if (BEATS[def] === atk) return 0.7;
  return 1;
}

export function armyHasClass(army: Army, cls: UnitClass): boolean {
  for (const id of UNIT_IDS) {
    if ((army[id] ?? 0) > 0 && UNITS[id].class === cls) return true;
  }
  return false;
}

export function armyHasCavalry(army: Army): boolean {
  return armyHasClass(army, 'cavalry');
}

export function armyHasInfantry(army: Army): boolean {
  return armyHasClass(army, 'infantry');
}

function mountedUnit(unit: UnitInfo): boolean {
  return unit.class === 'cavalry' || unit.mounted;
}

/** Ближний бой на клетке: кто как дерётся в лесу и на холмах. */
function terrainFightMod(unit: UnitInfo, terrain: TerrainType, role: 'attack' | 'defense'): number {
  if (terrain === 'forest') {
    if (role === 'attack') {
      if (unit.class === 'infantry') {
        if (unit.tier === 'light') return 1.06;
        if (unit.tier === 'heavy') return 0.82;
        return 0.96;
      }
      if (mountedUnit(unit)) {
        if (unit.tier === 'light') return 0.78;
        if (unit.tier === 'heavy') return 0.52;
        return 0.62;
      }
      return 0.74;
    }
    if (unit.class === 'infantry') {
      if (unit.tier === 'light') return 1.22;
      if (unit.tier === 'heavy') return 0.92;
      return 1.14;
    }
    if (mountedUnit(unit)) {
      if (unit.tier === 'light') return 0.82;
      if (unit.tier === 'heavy') return 0.62;
      return 0.72;
    }
    return 0.95;
  }
  if (terrain === 'hills') {
    if (role === 'attack') {
      if (unit.class === 'infantry') return 0.92;
      if (mountedUnit(unit)) {
        if (unit.tier === 'heavy') return 0.68;
        if (unit.tier === 'light') return 0.88;
        return 0.78;
      }
      return 0.88;
    }
    if (unit.class === 'infantry') return 1.12;
    if (mountedUnit(unit)) {
      if (unit.tier === 'heavy') return 0.78;
      return 0.85;
    }
    return 1.08;
  }
  return 1;
}

/** Залп: штраф за цель в лесу/на холме и бонус за стрельбу с холмов. */
function terrainVolleyMod(unit: UnitInfo, fromTerrain: TerrainType, toTerrain: TerrainType): number {
  let m = 1;
  if (fromTerrain === 'hills') m *= unit.mounted ? 1.12 : 1.22;
  if (fromTerrain === 'forest') m *= 0.82;
  if (toTerrain === 'forest') m *= unit.mounted ? 0.45 : 0.52;
  if (toTerrain === 'hills') m *= 0.84;
  return m;
}

export interface ArmyPowerOpts {
  volley?: boolean;
  fromTerrain?: TerrainType;
  era?: EraId;
  square?: boolean;
}

export function armyPower(
  army: Army,
  role: 'attack' | 'defense',
  vs: UnitClass,
  terrain: TerrainType,
  opts?: ArmyPowerOpts,
): number {
  const era = opts?.era ?? 'ancient';
  const square = Boolean(opts?.square);
  let power = 0;
  for (const id of UNIT_IDS) {
    const n = army[id] ?? 0;
    if (!n) continue;
    const unit = unitOf(id, era);
    const fightClass = opts?.volley && unit.range > 0 ? 'archer' : unit.class;
    const stat = role === 'attack' ? unit.attack : unit.defense;
    const ground =
      opts?.volley && role === 'attack'
        ? terrainVolleyMod(unit, opts.fromTerrain ?? 'plains', terrain)
        : terrainFightMod(unit, terrain, role);
    let squareMod = 1;
    if (square && !opts?.volley) {
      squareMod = role === 'attack' && unit.class === 'cavalry' ? SQUARE_CAVALRY_ATTACK : SQUARE_MELEE;
    }
    power += n * stat * classMod(fightClass, vs, era, square) * ground * squareMod;
  }
  return power;
}

export function unitShortLabel(id: UnitId, era: EraId = 'ancient'): string {
  return unitOf(id, era).short;
}

export function unitLabel(id: UnitId, era: EraId = 'ancient'): string {
  const u = unitOf(id, era);
  return `${u.icon} ${u.short}`;
}

export function unitSpeed(id: UnitId, era: EraId = 'ancient'): number {
  return unitOf(id, era).speed;
}

/** Стек может набегать, только если все отряды в нём умеют удар с разгона. */
export function armyCanCharge(army: Army): boolean {
  let any = false;
  for (const id of UNIT_IDS) {
    if ((army[id] ?? 0) <= 0) continue;
    any = true;
    if (!UNITS[id].charge) return false;
  }
  return any;
}

/** Стек может отойти после залпа: только конные лучники, без пехоты и ударной конницы. */
export function armyCanKite(army: Army): boolean {
  let any = false;
  for (const id of UNIT_IDS) {
    if ((army[id] ?? 0) <= 0) continue;
    any = true;
    if (!(UNITS[id].mounted && UNITS[id].class === 'archer')) return false;
  }
  return any;
}

/** В стеке есть кони: ударная конница или конные лучники. */
export function armyRidesHorses(army: Army): boolean {
  for (const id of UNIT_IDS) {
    if ((army[id] ?? 0) <= 0) continue;
    if (UNITS[id].class === 'cavalry' || UNITS[id].mounted) return true;
  }
  return false;
}

function unitEnterCost(unit: UnitInfo, terrain: TerrainType): number {
  if (!mountedUnit(unit)) return 1;
  if (terrain === 'forest') return 2;
  if (terrain === 'hills' && unit.tier === 'heavy') return 2;
  return 1;
}

/** Средняя и тяжёлая конница в чаще теряет строй. Лёгкая проходит медленно. Холмы не стопорят. */
function unitHaltsOnEnter(unit: UnitInfo, terrain: TerrainType): boolean {
  return mountedUnit(unit) && terrain === 'forest' && unit.tier !== 'light';
}

/** Сколько клеток хода стоит войти на местность. */
export function enterMoveCost(army: Army, terrain: TerrainType): number {
  let cost = 1;
  for (const id of UNIT_IDS) {
    if ((army[id] ?? 0) <= 0) continue;
    cost = Math.max(cost, unitEnterCost(UNITS[id], terrain));
  }
  return cost;
}

/** Если запаса меньше стоимости гекса — всё равно входим и останавливаемся. */
export function spentMoveCost(army: Army, terrain: TerrainType, movesLeft: number): number {
  if (movesLeft < 1) return 0;
  return Math.min(enterMoveCost(army, terrain), movesLeft);
}

/** Конница, войдя в чащу сомкнутым строем, дальше в этот ход не идёт. */
export function enterHaltsArmy(army: Army, terrain: TerrainType): boolean {
  for (const id of UNIT_IDS) {
    if ((army[id] ?? 0) <= 0) continue;
    if (unitHaltsOnEnter(UNITS[id], terrain)) return true;
  }
  return false;
}

export function moveHaltsOnEnter(army: Army, terrain: TerrainType, movesLeft: number): boolean {
  if (enterHaltsArmy(army, terrain)) return true;
  return spentMoveCost(army, terrain, movesLeft) < enterMoveCost(army, terrain);
}

/** Короткая подсказка, как кони ходят по лесу и холмам. */
export function terrainMoveHint(army: Army): string | null {
  if (!armyRidesHorses(army)) return null;
  const forestCost = enterMoveCost(army, 'forest');
  const hillCost = enterMoveCost(army, 'hills');
  const forestHalt = enterHaltsArmy(army, 'forest');
  const bits = [`лес ${forestCost} кл.${forestHalt ? ' и стоп' : ''}`];
  if (hillCost > 1) bits.push(`холмы ${hillCost} кл.`);
  return bits.join(' · ');
}
export function unitRange(id: UnitId, era: EraId = 'ancient'): number {
  return unitOf(id, era).range;
}

export function armySpeed(army: Army, era: EraId = 'ancient'): number {
  let min = 99;
  let any = false;
  for (const id of UNIT_IDS) {
    if ((army[id] ?? 0) <= 0) continue;
    any = true;
    min = Math.min(min, unitSpeed(id, era));
  }
  return any ? min : 0;
}

/** Что потеряет стек, если смешать два отряда. */
export function mixWarning(a: Army, b: Army, era: EraId = 'ancient'): string | null {
  if (armyCount(a) < 1 || armyCount(b) < 1) return null;
  const merged = mergeArmies(a, b);
  const notes: string[] = [];
  const flavor = ERAS[era];
  const speedMerged = armySpeed(merged, era);
  if (speedMerged < Math.max(armySpeed(a, era), armySpeed(b, era))) notes.push(`ход станет ${speedMerged} кл.`);
  if ((armyCanKite(a) || armyCanKite(b)) && !armyCanKite(merged)) {
    notes.push(flavor.kiteMix);
  }
  if ((armyCanCharge(a) || armyCanCharge(b)) && !armyCanCharge(merged)) {
    notes.push(flavor.chargeMix);
  }
  if (armyRidesHorses(merged) && (!armyRidesHorses(a) || !armyRidesHorses(b))) {
    notes.push(enterHaltsArmy(merged, 'forest') ? flavor.forestHalt : 'в лесу тратят 2 кл.');
  }
  if (notes.length > 0) return `Смешение строя: ${notes.join(', ')}.`;
  if (armyUnitIds(a).some((id) => (b[id] ?? 0) < 1) && armyUnitIds(b).some((id) => (a[id] ?? 0) < 1)) {
    return 'Разные рода в одном стеке: действует самый медленный.';
  }
  return null;
}

export const HILLS_VOLLEY_BONUS = 1;

export function armyRange(army: Army, era: EraId = 'ancient', fromTerrain?: TerrainType): number {
  let max = 0;
  for (const id of UNIT_IDS) {
    if ((army[id] ?? 0) > 0) max = Math.max(max, unitRange(id, era));
  }
  if (max > 0 && fromTerrain === 'hills') max += HILLS_VOLLEY_BONUS;
  return max;
}

export function unitShotKind(id: UnitId, era: EraId = 'ancient'): ShotKind | null {
  const unit = unitOf(id, era);
  if (unit.range < 1) return null;
  return unit.shot ?? 'arrow';
}

/** Орудия / батареи (не луки и не мушкеты). */
export function isArtilleryUnit(id: UnitId, era: EraId = 'ancient'): boolean {
  return unitShotKind(id, era) === 'cannon';
}

export function armyHasHeavyArtillery(army: Army, era: EraId = 'ancient'): boolean {
  for (const id of UNIT_IDS) {
    if ((army[id] ?? 0) < 1) continue;
    if (!isArtilleryUnit(id, era)) continue;
    if (unitOf(id, era).tier === 'heavy') return true;
  }
  return false;
}

/** Крыло уже тратило ход в этом раунде (запас меньше полной скорости). */
export function wingHasMarched(wing: MarchWing, era: EraId = 'ancient', speedBonus = 0): boolean {
  if (armyCount(wing.army) < 1) return false;
  return wing.movesLeft < armySpeed(wing.army, era) + speedBonus;
}

export function tileHasMarched(tile: Tile, era: EraId = 'ancient', speedBonus = 0): boolean {
  return ensureWings(tile).some((wing) => wingHasMarched(wing, era, speedBonus));
}

/** Весь стек уже получил приказ в этом раунде (ходил) — залп идёт в счёт того же ⚡. */
export function tileShotIsFree(tile: Tile, era: EraId = 'ancient', speedBonus = 0): boolean {
  const wings = ensureWings(tile).filter((wing) => armyCount(wing.army) > 0);
  return wings.length > 0 && wings.every((wing) => wingHasMarched(wing, era, speedBonus));
}

/** Кто в стеке умеет стрелять (и, если задана дистанция, достаёт до цели). */
export function volleyArmy(
  army: Army,
  era: EraId = 'ancient',
  dist = 1,
  fromTerrain?: TerrainType,
): Army {
  const catalog = unitsFor(era);
  const next: Army = {};
  for (const id of UNIT_IDS) {
    const n = army[id] ?? 0;
    if (n < 1) continue;
    let range = catalog[id].range;
    if (range < 1) continue;
    if (fromTerrain === 'hills') range += HILLS_VOLLEY_BONUS;
    if (range >= dist) next[id] = n;
  }
  return next;
}

export function archerArmy(army: Army, era: EraId = 'ancient'): Army {
  return volleyArmy(army, era);
}

export function wingsToArmy(wings: MarchWing[]): Army {
  let next: Army = {};
  for (const wing of wings) next = mergeArmies(next, wing.army);
  return next;
}

export function coalesceWings(wings: MarchWing[]): MarchWing[] {
  const map = new Map<string, MarchWing>();
  for (const wing of wings) {
    if (armyCount(wing.army) < 1) continue;
    const key = `${wing.movesLeft}|${wing.shotsLeft}`;
    const prev = map.get(key);
    if (prev) prev.army = mergeArmies(prev.army, wing.army);
    else map.set(key, { army: { ...wing.army }, movesLeft: wing.movesLeft, shotsLeft: wing.shotsLeft });
  }
  return [...map.values()].sort((a, b) => b.movesLeft - a.movesLeft);
}

export function ensureWings(tile: Tile): MarchWing[] {
  if (tile.wings && tile.wings.length > 0) {
    const summed = wingsToArmy(tile.wings);
    let same = true;
    for (const id of UNIT_IDS) {
      if ((summed[id] ?? 0) !== (tile.army[id] ?? 0)) {
        same = false;
        break;
      }
    }
    if (same) return coalesceWings(tile.wings);
  }
  if (armyCount(tile.army) < 1) return [];
  return [{ army: { ...tile.army }, movesLeft: tile.movesLeft, shotsLeft: tile.shotsLeft }];
}

export function writeWings(tile: Tile, wings: MarchWing[]): void {
  tile.wings = coalesceWings(wings);
  tile.army = wingsToArmy(tile.wings);
  tile.movesLeft = 0;
  tile.shotsLeft = 0;
  for (const wing of tile.wings) {
    tile.movesLeft = Math.max(tile.movesLeft, wing.movesLeft);
    tile.shotsLeft = Math.max(tile.shotsLeft, wing.shotsLeft);
  }
  if (tile.wings.length === 0) {
    tile.army = {};
    tile.movesLeft = 0;
    tile.shotsLeft = 0;
    tile.square = false;
  }
}

export function mobileCount(wings: MarchWing[], only?: UnitId, minMp = 1): number {
  let n = 0;
  for (const wing of wings) {
    if (wing.movesLeft < minMp) continue;
    n += only ? (wing.army[only] ?? 0) : armyCount(wing.army);
  }
  return n;
}

/** Снимает отряды с наибольшим запасом хода — свежий стек можно вести отдельно. */
export function takeFromWings(
  wings: MarchWing[],
  count: number,
  only?: UnitId,
  minMp = 1,
): { taken: MarchWing[]; rest: MarchWing[] } {
  const sorted = [...wings].sort((a, b) => b.movesLeft - a.movesLeft);
  const taken: MarchWing[] = [];
  const rest: MarchWing[] = [];
  let left = Math.max(0, Math.floor(count));
  for (const wing of sorted) {
    if (left <= 0 || wing.movesLeft < minMp) {
      rest.push(wing);
      continue;
    }
    const piece = takeArmy(wing.army, left, only);
    const n = armyCount(piece.taken);
    if (n > 0) {
      taken.push({ army: piece.taken, movesLeft: wing.movesLeft, shotsLeft: wing.shotsLeft });
      left -= n;
    }
    if (armyCount(piece.rest) > 0) rest.push({ army: piece.rest, movesLeft: wing.movesLeft, shotsLeft: wing.shotsLeft });
  }
  return { taken: coalesceWings(taken), rest: coalesceWings(rest) };
}

export function spendWingMove(
  wing: MarchWing,
  terrain: TerrainType,
  opts: { charging?: boolean; fight?: boolean; era?: EraId },
): MarchWing {
  if (opts.charging || opts.fight) return { ...wing, army: { ...wing.army }, movesLeft: 0 };
  const halt = moveHaltsOnEnter(wing.army, terrain, wing.movesLeft);
  const cost = spentMoveCost(wing.army, terrain, wing.movesLeft);
  const eraId = opts.era ?? 'ancient';
  return {
    ...wing,
    army: { ...wing.army },
    movesLeft: halt ? 0 : Math.max(0, wing.movesLeft - cost),
    // Тяжёлая артиллерия после любого шага больше не стреляет в этот ход.
    shotsLeft: armyHasHeavyArtillery(wing.army, eraId) ? 0 : wing.shotsLeft,
  };
}

export function wingsAlreadyMarching(wings: MarchWing[], speedBonus = 0, era: EraId = 'ancient'): boolean {
  if (wings.length < 1) return false;
  return wings.every((wing) => {
    const speed = armySpeed(wing.army, era) + speedBonus;
    // Уже ходили или уже стреляли (конные стрелки после залпа) — приказ оплачен.
    return wing.movesLeft > 0 && (wing.movesLeft < speed || (wing.shotsLeft < 1 && armyCanKite(wing.army)));
  });
}

export function wingMoveRange(tile: Tile): { min: number; max: number } {
  const wings = ensureWings(tile);
  if (wings.length === 0) return { min: 0, max: 0 };
  let min = wings[0]!.movesLeft;
  let max = min;
  for (const wing of wings) {
    min = Math.min(min, wing.movesLeft);
    max = Math.max(max, wing.movesLeft);
  }
  return { min, max };
}

export const DEFAULT_UNIT: UnitId = 'medium_infantry';
export const UNIT_COST: Resources = UNITS.medium_infantry.cost;
