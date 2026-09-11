import type { CommanderId, Resources } from './types.js';

export const COMMANDER_IDS: CommanderId[] = ['warlord', 'marshal', 'scout'];

export interface CommanderInfo {
  id: CommanderId;
  name: string;
  icon: string;
  attack: number;
  defense: number;
  routResist: number;
  speedBonus: number;
  visionBonus: number;
  cost: Resources;
  description: string;
}

export const COMMANDERS: Record<CommanderId, CommanderInfo> = {
  warlord: {
    id: 'warlord',
    name: 'Воевода',
    icon: '🪖',
    attack: 0.22,
    defense: 0.08,
    routResist: 0.12,
    speedBonus: 0,
    visionBonus: 0,
    cost: { gold: 40, food: 0, iron: 12 },
    description: '+22% к атаке стека',
  },
  marshal: {
    id: 'marshal',
    name: 'Маршал',
    icon: '👑',
    attack: 0.08,
    defense: 0.25,
    routResist: 0.28,
    speedBonus: 0,
    visionBonus: 0,
    cost: { gold: 45, food: 0, iron: 16 },
    description: '+25% к обороне, реже бежит',
  },
  scout: {
    id: 'scout',
    name: 'Рейд-капитан',
    icon: '🦅',
    attack: 0.1,
    defense: 0.05,
    routResist: 0.08,
    speedBonus: 1,
    visionBonus: 1,
    cost: { gold: 32, food: 0, iron: 8 },
    description: '+1 к ходу стека и к обзору',
  },
};
