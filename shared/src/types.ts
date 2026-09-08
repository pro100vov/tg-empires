export type TerrainType = 'plains' | 'forest' | 'hills' | 'mountains' | 'water';
export type BuildingType = 'farm' | 'mine' | 'market' | 'fort' | 'barracks';
export type TechType = 'attack' | 'defense' | 'economy' | 'logistics';

export interface Resources {
  gold: number;
  food: number;
  iron: number;
}

export interface Coord {
  x: number;
  y: number;
}

export interface Tile {
  x: number;
  y: number;
  terrain: TerrainType;
  ownerId: string | null;
  building: BuildingType | null;
  army: number;
  capitalOf: string | null;
}

export interface Player {
  id: string;
  name: string;
  color: string;
  resources: Resources;
  tech: Record<TechType, number>;
  actionsLeft: number;
  alive: boolean;
  connected: boolean;
}

export type GamePhase = 'lobby' | 'playing' | 'finished';

export interface LogEntry {
  round: number;
  text: string;
}

export interface GameState {
  roomCode: string;
  hostId: string;
  phase: GamePhase;
  seed: number;
  width: number;
  height: number;
  tiles: Tile[];
  players: Player[];
  order: string[];
  turnIndex: number;
  round: number;
  maxRounds: number;
  log: LogEntry[];
  winnerId: string | null;
}

export type GameAction =
  | { type: 'move'; from: Coord; to: Coord; count: number }
  | { type: 'build'; at: Coord; building: BuildingType }
  | { type: 'recruit'; at: Coord; count: number }
  | { type: 'research'; tech: TechType }
  | { type: 'endTurn' };

export type ActionResult = { ok: true; events: string[] } | { ok: false; error: string };

/** Публичное описание комнаты для лобби бота. */
export interface RoomSummary {
  roomCode: string;
  hostName: string;
  phase: GamePhase;
  playerCount: number;
}
