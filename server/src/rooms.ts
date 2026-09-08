import { createGame, randomRoomCode, randomSeed } from '@tge/shared';
import type { GameState, RoomSummary } from '@tge/shared';

const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;

interface Room {
  state: GameState;
  updatedAt: number;
}

const rooms = new Map<string, Room>();

export function createRoom(hostId: string): GameState {
  let code = randomRoomCode();
  while (rooms.has(code)) code = randomRoomCode();
  const state = createGame(code, hostId, randomSeed());
  rooms.set(code, { state, updatedAt: Date.now() });
  return state;
}

export function getRoom(code: string): GameState | undefined {
  const room = rooms.get(code.toUpperCase());
  if (!room) return undefined;
  room.updatedAt = Date.now();
  return room.state;
}

export function touchRoom(code: string): void {
  const room = rooms.get(code.toUpperCase());
  if (room) room.updatedAt = Date.now();
}

export function deleteRoom(code: string): void {
  rooms.delete(code.toUpperCase());
}

export function summarize(state: GameState): RoomSummary {
  return {
    roomCode: state.roomCode,
    hostName: state.players.find((p) => p.id === state.hostId)?.name ?? 'Хост',
    phase: state.phase,
    playerCount: state.players.length,
  };
}

/**
 * Комнаты живут в памяти, поэтому брошенные нужно чистить. Пустые исчезают
 * быстрее, но не мгновенно — иначе перезагрузка страницы убивала бы партию.
 */
export function startRoomCleanup(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      const nobodyOnline = room.state.players.every((p) => !p.connected);
      const ttl = nobodyOnline ? EMPTY_ROOM_TTL_MS : ROOM_TTL_MS;
      if (now - room.updatedAt > ttl) rooms.delete(code);
    }
  }, 5 * 60 * 1000);
}
