/**
 * Проверка данных от клиента перед тем, как они попадут в движок.
 * Ничего не бросает — на любой мусор возвращает null.
 */
import { COMMANDER_IDS } from './commanders.js';
import { UNIT_IDS } from './units.js';
import type {
  AiLevel,
  BuildingType,
  CommanderId,
  Coord,
  DeployAction,
  GameAction,
  GameSettings,
  LobbyAction,
  TechType,
  TerrainType,
  TreatyKind,
  UnitId,
} from './types.js';

const BUILDING_IDS: BuildingType[] = ['farm', 'mine', 'market', 'palisade', 'fort', 'barracks'];
const TECH_IDS: TechType[] = ['attack', 'defense', 'economy', 'logistics'];
const TERRAIN_IDS: TerrainType[] = ['plains', 'forest', 'hills', 'mountains', 'water'];
const GAME_ACTION_TYPES = [
  'move',
  'shoot',
  'build',
  'recruit',
  'appoint',
  'research',
  'formSquare',
  'breakSquare',
  'squareReply',
  'eventChoice',
  'propose',
  'acceptProposal',
  'declineProposal',
  'breakTreaty',
  'endTurn',
  'surrender',
] as const;
const LOBBY_ACTION_TYPES = ['configure', 'paint', 'reroll', 'setAdmin', 'addAi', 'removeAi'] as const;
const AI_LEVELS: AiLevel[] = ['easy', 'normal', 'hard'];
const TREATY_KINDS: TreatyKind[] = ['truce', 'alliance'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseCoord(v: unknown): Coord | null {
  if (!isPlainObject(v)) return null;
  const { x, y } = v;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if ((x as number) < 0 || (x as number) >= 64 || (y as number) < 0 || (y as number) >= 64) return null;
  return { x: x as number, y: y as number };
}

/** Идентификатор игрока/предложения: непустая короткая строка. */
function parseId(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 300) return null;
  return v;
}

function parseCount(v: unknown): number | null {
  if (!Number.isInteger(v)) return null;
  const n = v as number;
  if (n < 1 || n > 10000) return null;
  return n;
}

/** Опциональное поле unit: отсутствует — ок, есть — должно быть известным родом войск. */
function parseUnitField(v: unknown): { ok: true; unit?: UnitId } | { ok: false } {
  if (v === undefined) return { ok: true };
  if (typeof v === 'string' && (UNIT_IDS as string[]).includes(v)) return { ok: true, unit: v as UnitId };
  return { ok: false };
}

function parseSupportFrom(v: unknown): { ok: true; supportFrom?: Coord[] } | { ok: false } {
  if (v === undefined) return { ok: true };
  if (!Array.isArray(v) || v.length > 6) return { ok: false };
  const coords: Coord[] = [];
  for (const item of v) {
    const c = parseCoord(item);
    if (!c) return { ok: false };
    coords.push(c);
  }
  return { ok: true, supportFrom: coords };
}

export function parseGameAction(raw: unknown): GameAction | null {
  if (!isPlainObject(raw)) return null;
  const type = raw.type;
  if (typeof type !== 'string' || !(GAME_ACTION_TYPES as readonly string[]).includes(type)) return null;

  switch (type as GameAction['type']) {
    case 'move': {
      const from = parseCoord(raw.from);
      const to = parseCoord(raw.to);
      const count = parseCount(raw.count);
      const unitField = parseUnitField(raw.unit);
      const supportField = parseSupportFrom(raw.supportFrom);
      if (!from || !to || count == null || !unitField.ok || !supportField.ok) return null;
      return {
        type: 'move',
        from,
        to,
        count,
        ...(unitField.unit !== undefined ? { unit: unitField.unit } : {}),
        ...(supportField.supportFrom ? { supportFrom: supportField.supportFrom } : {}),
      };
    }
    case 'shoot': {
      const from = parseCoord(raw.from);
      const to = parseCoord(raw.to);
      if (!from || !to) return null;
      return { type: 'shoot', from, to };
    }
    case 'build': {
      const at = parseCoord(raw.at);
      const building = raw.building;
      if (!at || typeof building !== 'string' || !(BUILDING_IDS as string[]).includes(building)) return null;
      return { type: 'build', at, building: building as BuildingType };
    }
    case 'recruit': {
      const at = parseCoord(raw.at);
      const count = parseCount(raw.count);
      const unitField = parseUnitField(raw.unit);
      if (!at || count == null || !unitField.ok) return null;
      return { type: 'recruit', at, count, ...(unitField.unit !== undefined ? { unit: unitField.unit } : {}) };
    }
    case 'appoint': {
      const at = parseCoord(raw.at);
      const commander = raw.commander;
      if (!at || typeof commander !== 'string' || !(COMMANDER_IDS as string[]).includes(commander)) return null;
      return { type: 'appoint', at, commander: commander as CommanderId };
    }
    case 'research': {
      const tech = raw.tech;
      if (typeof tech !== 'string' || !(TECH_IDS as string[]).includes(tech)) return null;
      return { type: 'research', tech: tech as TechType };
    }
    case 'formSquare': {
      const at = parseCoord(raw.at);
      if (!at) return null;
      return { type: 'formSquare', at };
    }
    case 'breakSquare': {
      const at = parseCoord(raw.at);
      if (!at) return null;
      return { type: 'breakSquare', at };
    }
    case 'squareReply': {
      if (typeof raw.form !== 'boolean') return null;
      return { type: 'squareReply', form: raw.form };
    }
    case 'eventChoice': {
      if (raw.choice !== 0 && raw.choice !== 1) return null;
      return { type: 'eventChoice', choice: raw.choice };
    }
    case 'propose': {
      const to = parseId(raw.to);
      const kind = raw.kind;
      if (!to || typeof kind !== 'string' || !(TREATY_KINDS as string[]).includes(kind)) return null;
      let rounds: number | undefined;
      if (raw.rounds !== undefined) {
        if (!Number.isInteger(raw.rounds) || (raw.rounds as number) < 1 || (raw.rounds as number) > 100) return null;
        rounds = raw.rounds as number;
      }
      return { type: 'propose', to, kind: kind as TreatyKind, ...(rounds !== undefined ? { rounds } : {}) };
    }
    case 'acceptProposal':
    case 'declineProposal': {
      const id = parseId(raw.id);
      if (!id) return null;
      return { type: type as 'acceptProposal' | 'declineProposal', id };
    }
    case 'breakTreaty': {
      const other = parseId(raw.with);
      if (!other) return null;
      return { type: 'breakTreaty', with: other };
    }
    case 'endTurn':
      return { type: 'endTurn' };
    case 'surrender':
      return { type: 'surrender' };
    default:
      return null;
  }
}

export function parseLobbyAction(raw: unknown): LobbyAction | null {
  if (!isPlainObject(raw)) return null;
  const type = raw.type;
  if (typeof type !== 'string' || !(LOBBY_ACTION_TYPES as readonly string[]).includes(type)) return null;

  switch (type as LobbyAction['type']) {
    case 'configure': {
      if (!isPlainObject(raw.settings)) return null;
      return { type: 'configure', settings: raw.settings as Partial<GameSettings> };
    }
    case 'paint': {
      const at = parseCoord(raw.at);
      const terrain = raw.terrain;
      if (!at || typeof terrain !== 'string' || !(TERRAIN_IDS as string[]).includes(terrain)) return null;
      return { type: 'paint', at, terrain: terrain as TerrainType };
    }
    case 'reroll':
      return { type: 'reroll' };
    case 'setAdmin': {
      const playerId = raw.playerId;
      const admin = raw.admin;
      if (typeof playerId !== 'string' || playerId.length === 0 || playerId.length > 128) return null;
      if (typeof admin !== 'boolean') return null;
      return { type: 'setAdmin', playerId, admin };
    }
    case 'addAi': {
      const difficulty = raw.difficulty;
      if (typeof difficulty !== 'string' || !(AI_LEVELS as string[]).includes(difficulty)) return null;
      return { type: 'addAi', difficulty: difficulty as AiLevel };
    }
    case 'removeAi': {
      const playerId = parseId(raw.playerId);
      if (!playerId) return null;
      return { type: 'removeAi', playerId };
    }
    default:
      return null;
  }
}

const DEPLOY_ACTION_TYPES = ['buySquad', 'sellSquad', 'buyCommander', 'sellCommander', 'buyFort', 'sellFort', 'auto', 'clear', 'ready'] as const;

/** Закупка варгейма: тип, клетка, род войск/командир/укрепление из белых списков. */
export function parseDeployAction(raw: unknown): DeployAction | null {
  if (!isPlainObject(raw)) return null;
  const type = raw.type;
  if (typeof type !== 'string' || !(DEPLOY_ACTION_TYPES as readonly string[]).includes(type)) return null;
  switch (type as DeployAction['type']) {
    case 'buySquad': {
      const at = parseCoord(raw.at);
      const unit = raw.unit;
      if (!at || typeof unit !== 'string' || !(UNIT_IDS as string[]).includes(unit)) return null;
      return { type: 'buySquad', at, unit: unit as UnitId };
    }
    case 'sellSquad':
    case 'sellCommander': {
      const at = parseCoord(raw.at);
      if (!at) return null;
      return { type: type as 'sellSquad' | 'sellCommander', at };
    }
    case 'buyCommander': {
      const at = parseCoord(raw.at);
      const commander = raw.commander;
      if (!at || typeof commander !== 'string' || !(COMMANDER_IDS as string[]).includes(commander)) return null;
      return { type: 'buyCommander', at, commander: commander as CommanderId };
    }
    case 'buyFort':
    case 'sellFort': {
      const building = raw.building;
      if (typeof building !== 'string' || !(BUILDING_IDS as string[]).includes(building)) return null;
      return { type: type as 'buyFort' | 'sellFort', building: building as BuildingType };
    }
    case 'auto':
      return { type: 'auto' };
    case 'clear':
      return { type: 'clear' };
    case 'ready':
      if (typeof raw.ready !== 'boolean') return null;
      return { type: 'ready', ready: raw.ready };
    default:
      return null;
  }
}
