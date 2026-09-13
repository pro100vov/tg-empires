import { createGame, playerById, randomRoomCode, randomSeed, roomAbandoned } from '@tge/shared';
import type { GameState, RoomSummary } from '@tge/shared';

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

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

/** Активная партия игрока: он в слоте и не нажимал «Выйти». */
export function findRoomByPlayer(userId: string): GameState | undefined {
  for (const room of rooms.values()) {
    const member = playerById(room.state, userId);
    if (member && !member.left) {
      room.updatedAt = Date.now();
      return room.state;
    }
    if (
      !member &&
      room.state.hostId === userId &&
      room.state.phase === 'lobby' &&
      !room.state.players.some((p) => p.id === userId)
    ) {
      room.updatedAt = Date.now();
      return room.state;
    }
  }
  return undefined;
}

export function discardIfAbandoned(state: GameState): boolean {
  if (!roomAbandoned(state)) return false;
  deleteRoom(state.roomCode);
  return true;
}

export function summarize(state: GameState): RoomSummary {
  return {
    roomCode: state.roomCode,
    hostName: state.players.find((p) => p.id === state.hostId)?.name ?? 'Хост',
    phase: state.phase,
    playerCount: state.players.filter((p) => !p.left).length,
  };
}

/**
 * Комнаты живут в памяти. Обрыв связи партию не убивает — удаляем только
 * когда все явно вышли или комната сутки никто не трогал.
 */
export function startRoomCleanup(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (roomAbandoned(room.state) || now - room.updatedAt > ROOM_TTL_MS) {
        rooms.delete(code);
      }
    }
  }, 5 * 60 * 1000);
}
