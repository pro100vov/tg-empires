/**
 * Проверка данных от клиента перед тем, как они попадут в движок.
 * Ничего не бросает — на любой мусор возвращает null.
 */
import { COMMANDER_IDS } from './commanders.js';
import { UNIT_IDS } from './units.js';
import type {
  BuildingType,
  CommanderId,
  Coord,
  GameAction,
  GameSettings,
  LobbyAction,
  TechType,
  TerrainType,
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
  'endTurn',
] as const;
const LOBBY_ACTION_TYPES = ['configure', 'paint', 'reroll', 'setAdmin'] as const;

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
    case 'endTurn':
      return { type: 'endTurn' };
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
    default:
      return null;
  }
}
