import type { BuildingType, GameSettings, PlayerStats, Resources, TechType, TerrainType } from './types.js';

export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;
export const MAX_ROUNDS = 30;
/** Сторона гексагональной карты в клетках (столбцы × ряды). */
export const MAP_SIZE = 10;
export const MAP_SIZES = [8, 10, 12, 14] as const;
export const ROUND_OPTIONS = [20, 30, 40, 50] as const;
export const ACTION_OPTIONS = [3, 4, 5, 6] as const;
/** Время на ход, мин: 0 — без лимита. */
export const TURN_MINUTES_OPTIONS = [0, 2, 5, 60, 1440] as const;
/** Ширина bounding-box pointy-top гекса, px. Высота = round(width * 2 / √3). */
export const HEX_WIDTH = 52;
export const HEX_HEIGHT = Math.round((HEX_WIDTH * 2) / Math.sqrt(3));
export const HEX_COL_STEP = HEX_WIDTH;
export const HEX_ROW_STEP = Math.round(HEX_HEIGHT * 0.75);
export const BASE_ACTIONS = 5;
export const MAX_TECH_LEVEL = 5;
export const MAX_LOGISTICS_LEVEL = 3;

/** Варгейм: капитал по умолчанию и пределы в лобби. */
export const WAR_CAPITAL = 500;
export const WAR_CAPITAL_MIN = 200;
export const WAR_CAPITAL_MAX = 2000;
export const WAR_CAPITAL_STEP = 100;
export const KILL_GOAL_MAX = 30;

export const START_RESOURCES: Resources = { gold: 70, food: 40, iron: 25 };
export const CAPITAL_START_ARMY = 6;

/** Доход столицы сверх местности. */
export const CAPITAL_INCOME: Resources = { gold: 5, food: 2, iron: 2 };

/** Прибавка ко всем доходам за уровень техи «Экономика». */
export const ECONOMY_TECH_BONUS = 0.15;

/** Доля дезертиров, когда еды не хватило на содержание. */
export const STARVATION_DESERTION = 0.15;

export interface TerrainInfo {
  name: string;
  passable: boolean;
  income: Partial<Resources>;
  /** Укрытие в ближнем бою. */
  defenseBonus: number;
  /** Укрытие от залпа. */
  missileCover: number;
  color: string;
}

export const TERRAIN: Record<TerrainType, TerrainInfo> = {
  plains: { name: 'Равнина', passable: true, income: { food: 2, gold: 1 }, defenseBonus: 0, missileCover: 0, color: '#7fb069' },
  forest: { name: 'Лес', passable: true, income: { food: 1, iron: 1 }, defenseBonus: 0.06, missileCover: 0.4, color: '#3f7d4f' },
  hills: { name: 'Холмы', passable: true, income: { gold: 1, iron: 2 }, defenseBonus: 0.28, missileCover: 0.16, color: '#a9855b' },
  mountains: { name: 'Горы', passable: false, income: {}, defenseBonus: 0, missileCover: 0, color: '#6b6b76' },
  water: { name: 'Море', passable: false, income: {}, defenseBonus: 0, missileCover: 0, color: '#2f6690' },
};

export interface BuildingInfo {
  name: string;
  cost: Partial<Resources>;
  income: Partial<Resources>;
  defenseBonus: number;
  allowsRecruit: boolean;
  /** Сколько ваших ходов стройка занимает после закладки. */
  buildTurns: number;
  icon: string;
  description: string;
}

export const BUILDINGS: Record<BuildingType, BuildingInfo> = {
  farm: {
    name: 'Ферма',
    cost: { gold: 15 },
    income: { food: 3 },
    defenseBonus: 0,
    allowsRecruit: false,
    buildTurns: 1,
    icon: '🌾',
    description: '+3 еды в ход',
  },
  mine: {
    name: 'Шахта',
    cost: { gold: 25 },
    income: { iron: 2 },
    defenseBonus: 0,
    allowsRecruit: false,
    buildTurns: 2,
    icon: '⛏️',
    description: '+2 железа в ход',
  },
  market: {
    name: 'Рынок',
    cost: { gold: 30, food: 10 },
    income: { gold: 4 },
    defenseBonus: 0,
    allowsRecruit: false,
    buildTurns: 2,
    icon: '🏛️',
    description: '+4 золота в ход',
  },
  palisade: {
    name: 'Частокол',
    cost: { gold: 10, iron: 5 },
    income: {},
    defenseBonus: 0.25,
    allowsRecruit: false,
    buildTurns: 1,
    icon: '🪵',
    description: '+25% к защите клетки',
  },
  fort: {
    name: 'Крепость',
    cost: { gold: 20, iron: 15 },
    income: {},
    defenseBonus: 0.5,
    allowsRecruit: false,
    buildTurns: 3,
    icon: '🏰',
    description: '+50% к защите клетки',
  },
  barracks: {
    name: 'Казармы',
    cost: { gold: 25, iron: 10 },
    income: {},
    defenseBonus: 0.2,
    allowsRecruit: true,
    buildTurns: 2,
    icon: '⚔️',
    description: 'Найм войск вне столицы, +20% к защите',
  },
};

export interface TechInfo {
  name: string;
  icon: string;
  maxLevel: number;
  description: string;
}

export const TECHS: Record<TechType, TechInfo> = {
  attack: { name: 'Военное дело', icon: '🗡️', maxLevel: MAX_TECH_LEVEL, description: '+12% к силе атаки за уровень' },
  defense: { name: 'Фортификация', icon: '🛡️', maxLevel: MAX_TECH_LEVEL, description: '+12% к силе обороны за уровень' },
  economy: { name: 'Экономика', icon: '📈', maxLevel: MAX_TECH_LEVEL, description: '+15% ко всем доходам за уровень' },
  logistics: { name: 'Логистика', icon: '🐎', maxLevel: MAX_LOGISTICS_LEVEL, description: '+1 действие в ход за уровень' },
};

export function techCost(level: number): Resources {
  return { gold: 30 * (level + 1), food: 10 * (level + 1), iron: 12 * (level + 1) };
}

export function defaultGameSettings(): GameSettings {
  return {
    mapSize: MAP_SIZE,
    terrainMode: 'random',
    fogOfWar: true,
    maxRounds: MAX_ROUNDS,
    startGold: START_RESOURCES.gold,
    startFood: START_RESOURCES.food,
    startIron: START_RESOURCES.iron,
    startArmy: CAPITAL_START_ARMY,
    actionsPerTurn: BASE_ACTIONS,
    hotseat: false,
    era: 'ancient',
    turnMinutes: 0,
    randomEvents: true,
    diplomacy: true,
    mode: 'empire',
    warCapital: WAR_CAPITAL,
    killGoal: -1,
  };
}

export const PLAYER_COLORS = ['#e05263', '#3f8efc', '#f2b705', '#57cc99'];

export function emptyStats(): PlayerStats {
  return {
    battlesWon: 0,
    battlesLost: 0,
    unitsKilled: 0,
    unitsLost: 0,
    tilesCaptured: 0,
    buildingsBuilt: 0,
    unitsRecruited: 0,
    eventsGood: 0,
    eventsBad: 0,
    biggestBattle: 0,
    squadsKilled: 0,
    squadsLost: 0,
  };
}
