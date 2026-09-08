import type { BuildingType, Resources, TechType, TerrainType } from './types.js';

export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;
export const MAX_ROUNDS = 30;
export const BASE_ACTIONS = 3;
export const MAX_TECH_LEVEL = 5;
export const MAX_LOGISTICS_LEVEL = 3;

export const START_RESOURCES: Resources = { gold: 60, food: 40, iron: 20 };
export const CAPITAL_START_ARMY = 6;

/** Стоимость одного отряда при найме. */
export const UNIT_COST: Resources = { gold: 8, food: 0, iron: 4 };

/** Одна единица еды кормит два отряда за ход. */
export const UPKEEP_UNITS_PER_FOOD = 2;

/** Доля дезертиров, когда еды не хватило на содержание. */
export const STARVATION_DESERTION = 0.15;

export interface TerrainInfo {
  name: string;
  passable: boolean;
  income: Partial<Resources>;
  defenseBonus: number;
  color: string;
}

export const TERRAIN: Record<TerrainType, TerrainInfo> = {
  plains: { name: 'Равнина', passable: true, income: { food: 2, gold: 1 }, defenseBonus: 0, color: '#7fb069' },
  forest: { name: 'Лес', passable: true, income: { food: 1, iron: 1 }, defenseBonus: 0.2, color: '#3f7d4f' },
  hills: { name: 'Холмы', passable: true, income: { gold: 1, iron: 2 }, defenseBonus: 0.35, color: '#a9855b' },
  mountains: { name: 'Горы', passable: false, income: {}, defenseBonus: 0, color: '#6b6b76' },
  water: { name: 'Море', passable: false, income: {}, defenseBonus: 0, color: '#2f6690' },
};

export interface BuildingInfo {
  name: string;
  cost: Partial<Resources>;
  income: Partial<Resources>;
  defenseBonus: number;
  allowsRecruit: boolean;
  icon: string;
  description: string;
}

export const BUILDINGS: Record<BuildingType, BuildingInfo> = {
  farm: {
    name: 'Ферма',
    cost: { gold: 20 },
    income: { food: 2 },
    defenseBonus: 0,
    allowsRecruit: false,
    icon: '🌾',
    description: '+2 еды в ход',
  },
  mine: {
    name: 'Шахта',
    cost: { gold: 25, iron: 5 },
    income: { iron: 2 },
    defenseBonus: 0,
    allowsRecruit: false,
    icon: '⛏️',
    description: '+2 железа в ход',
  },
  market: {
    name: 'Рынок',
    cost: { gold: 30 },
    income: { gold: 3 },
    defenseBonus: 0,
    allowsRecruit: false,
    icon: '🏛️',
    description: '+3 золота в ход',
  },
  fort: {
    name: 'Крепость',
    cost: { gold: 20, iron: 15 },
    income: {},
    defenseBonus: 0.5,
    allowsRecruit: false,
    icon: '🏰',
    description: '+50% к защите клетки',
  },
  barracks: {
    name: 'Казармы',
    cost: { gold: 25, iron: 10 },
    income: {},
    defenseBonus: 0.2,
    allowsRecruit: true,
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
  economy: { name: 'Экономика', icon: '📈', maxLevel: MAX_TECH_LEVEL, description: '+10% ко всем доходам за уровень' },
  logistics: { name: 'Логистика', icon: '🐎', maxLevel: MAX_LOGISTICS_LEVEL, description: '+1 действие в ход за уровень' },
};

export function techCost(level: number): Resources {
  return { gold: 40 * (level + 1), food: 0, iron: 20 * (level + 1) };
}

export const PLAYER_COLORS = ['#e05263', '#3f8efc', '#f2b705', '#57cc99'];
