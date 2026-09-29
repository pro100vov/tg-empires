import { createGame, humanPlayers, normalizeState, randomRoomCode, randomSeed } from '@tge/shared';
import type { GameState, MyGame, RoomSummary } from '@tge/shared';
import { dataFile, readJsonSafe, writeJsonAtomic } from './storage.js';

/** Лобби, где сидят люди: живёт, пока они заходят. */
const LOBBY_TTL_MS = 6 * 60 * 60 * 1000;
/** Лобби без людей. */
const EMPTY_LOBBY_TTL_MS = 30 * 60 * 1000;
/** Идущая партия без единого действия — с запасом под асинхронную игру. */
const PLAYING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Законченная: чтобы успели посмотреть статистику и нажать «Реванш». */
const FINISHED_TTL_MS = 24 * 60 * 60 * 1000;

const SAVE_EVERY_MS = 5_000;

interface Room {
  state: GameState;
  updatedAt: number;
}

const rooms = new Map<string, Room>();
let dirty = false;

interface SavedRooms {
  version: 1;
  savedAt: number;
  rooms: { state: GameState; updatedAt: number }[];
}

/** Что-то в комнатах поменялось — при ближайшем автосохранении запишем на диск. */
export function markDirty(_code?: string): void {
  dirty = true;
}

export function saveRooms(force = false): void {
  if (!dirty && !force) return;
  const payload: SavedRooms = {
    version: 1,
    savedAt: Date.now(),
    rooms: [...rooms.values()].map((room) => ({ state: room.state, updatedAt: room.updatedAt })),
  };
  try {
    writeJsonAtomic(dataFile('rooms.json'), payload);
    dirty = false;
  } catch (err) {
    console.error('[storage] не удалось сохранить партии:', err);
  }
}

export function startRoomAutosave(): NodeJS.Timeout {
  return setInterval(() => saveRooms(), SAVE_EVERY_MS);
}

/**
 * Поднимает партии с диска. Все люди считаются офлайн (сокеты после рестарта новые),
 * возвращает загруженные состояния.
 */
export function loadRooms(): GameState[] {
  const saved = readJsonSafe<SavedRooms>(dataFile('rooms.json'));
  if (!saved) return [];
  if (saved.version !== 1 || !Array.isArray(saved.rooms)) {
    console.error('[storage] rooms.json неизвестного формата — пропускаю');
    return [];
  }
  const loaded: GameState[] = [];
  const now = Date.now();
  for (const entry of saved.rooms) {
    try {
      const state = normalizeState(entry.state);
      for (const player of humanPlayers(state)) player.connected = false;
      rooms.set(state.roomCode, { state, updatedAt: now });
      loaded.push(state);
    } catch (err) {
      console.error('[storage] не удалось поднять комнату:', err);
    }
  }
  console.log(`[storage] поднято партий: ${loaded.length}`);
  return loaded;
}

export function createRoom(hostId: string): GameState {
  let code = randomRoomCode();
  while (rooms.has(code)) code = randomRoomCode();
  const state = createGame(code, hostId, randomSeed());
  rooms.set(code, { state, updatedAt: Date.now() });
  markDirty(code);
  return state;
}

export function getRoom(code: string): GameState | undefined {
  const room = rooms.get(code.toUpperCase());
  if (!room) return undefined;
  room.updatedAt = Date.now();
  return room.state;
}

/** Для уборщика в index.ts — без обновления updatedAt (в отличие от getRoom). */
export function listRooms(): GameState[] {
  return [...rooms.values()].map((room) => room.state);
}

export function touchRoom(code: string): void {
  const room = rooms.get(code.toUpperCase());
  if (room) room.updatedAt = Date.now();
}

export function deleteRoom(code: string): void {
  if (rooms.delete(code.toUpperCase())) markDirty(code);
}

export function summarize(state: GameState): RoomSummary {
  return {
    roomCode: state.roomCode,
    hostName: state.players.find((p) => p.id === state.hostId)?.name ?? 'Хост',
    phase: state.phase,
    playerCount: state.players.length,
  };
}

/** Партии игрока: идущие и лобби, а также законченные не позже суток назад. */
export function listRoomsOf(userId: string): GameState[] {
  const now = Date.now();
  const out: GameState[] = [];
  for (const room of rooms.values()) {
    if (!room.state.players.some((p) => p.id === userId)) continue;
    if (room.state.phase === 'finished' && now - room.updatedAt > FINISHED_TTL_MS) continue;
    out.push(room.state);
  }
  return out;
}

/** Сводка по партиям игрока для бота и меню: сначала те, где его ход. */
export function myGames(userId: string): MyGame[] {
  const rank = (g: MyGame) => (g.myTurn ? 0 : g.phase === 'playing' ? 1 : g.phase === 'lobby' ? 2 : 3);
  return listRoomsOf(userId)
    .map((state): MyGame => {
      const currentId = state.phase === 'playing' ? state.order[state.turnIndex] : undefined;
      const current = state.players.find((p) => p.id === currentId);
      const hotseatMine = state.settings.hotseat && state.hostId === userId;
      return {
        roomCode: state.roomCode,
        phase: state.phase,
        round: state.round,
        maxRounds: state.maxRounds,
        players: state.players.map((p) => ({ name: p.name, color: p.color })),
        myTurn: Boolean(current && (current.id === userId || hotseatMine)),
        turnName: current?.name ?? '',
        deadline: state.phase === 'playing' ? state.turnDeadline ?? null : null,
      };
    })
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 10);
}

/**
 * Комнаты хранятся на диске, но брошенные всё равно нужно чистить. Пустые лобби
 * исчезают быстрее, но не мгновенно — иначе перезагрузка страницы убивала бы партию.
 */
export function startRoomCleanup(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      const { phase } = room.state;
      let ttl: number;
      if (phase === 'finished') {
        ttl = FINISHED_TTL_MS;
      } else if (phase === 'playing') {
        ttl = PLAYING_TTL_MS;
      } else {
        const nobodyOnline = humanPlayers(room.state).every((p) => !p.connected);
        ttl = nobodyOnline ? EMPTY_LOBBY_TTL_MS : LOBBY_TTL_MS;
      }
      if (now - room.updatedAt > ttl) {
        rooms.delete(code);
        markDirty(code);
      }
    }
  }, 5 * 60 * 1000);
}
