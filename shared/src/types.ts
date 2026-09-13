export type TerrainType = 'plains' | 'forest' | 'hills' | 'mountains' | 'water';
export type EraId = 'ancient' | 'medieval' | 'napoleonic';
export type BuildingType = 'farm' | 'mine' | 'market' | 'palisade' | 'fort' | 'barracks';
export type TechType = 'attack' | 'defense' | 'economy' | 'logistics';
export type CommanderId = 'warlord' | 'marshal' | 'scout';
export type UnitClass = 'infantry' | 'cavalry' | 'archer';
export type UnitTier = 'light' | 'medium' | 'heavy';
export type ShotKind = 'arrow' | 'musket' | 'cannon';
export type UnitId =
  | 'light_infantry'
  | 'medium_infantry'
  | 'heavy_infantry'
  | 'light_cavalry'
  | 'medium_cavalry'
  | 'heavy_cavalry'
  | 'light_archer'
  | 'medium_archer'
  | 'heavy_archer'
  | 'light_horse_archer'
  | 'medium_horse_archer'
  | 'heavy_horse_archer';

export type Army = Partial<Record<UnitId, number>>;

export interface Resources {
  gold: number;
  food: number;
  iron: number;
}

export interface Coord {
  x: number;
  y: number;
}

export interface Construction {
  building: BuildingType;
  turnsLeft: number;
}

export interface Tile {
  x: number;
  y: number;
  terrain: TerrainType;
  ownerId: string | null;
  building: BuildingType | null;
  construction: Construction | null;
  army: Army;
  capitalOf: string | null;
  /** Сколько гексов этот стек ещё может пройти в текущий ход владельца. */
  movesLeft: number;
  /** Залпов в этот ход: 1 или 0. */
  shotsLeft: number;
  commander: CommanderId | null;
  /** Ходов владельца до снятия паники. */
  routedTurns: number;
  /** Наполеоника: пехота стоит в каре против конницы. */
  square?: boolean;
  /** Группы с разным запасом хода на одной клетке (слияние не смешивает усталость). */
  wings?: MarchWing[];
}

export interface MarchWing {
  army: Army;
  movesLeft: number;
  shotsLeft: number;
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
  /**
   * Явно вышел из партии. Слот и держава остаются, пока кто-то не пригласит
   * обратно или пока не выйдут все.
   */
  left: boolean;
  /** Увиденные чужие постройки: ключ "x,y". Не забываются. */
  seenBuildings: Record<string, BuildingType>;
}

export type GamePhase = 'lobby' | 'playing' | 'finished';
export type TerrainMode = 'random' | 'custom';

export interface GameSettings {
  mapSize: number;
  terrainMode: TerrainMode;
  fogOfWar: boolean;
  maxRounds: number;
  startGold: number;
  startFood: number;
  startIron: number;
  startArmy: number;
  actionsPerTurn: number;
  /** Хост ходит за все державы по очереди — для проверки правил. */
  hotseat: boolean;
  /** Внешность и состав войск: античность, средневековье, наполеоника. */
  era: EraId;
}

/** Атака конницы по пехоте ждёт ответа обороны: встать в каре или встретить в линии. */
export interface PendingSquare {
  attackerId: string;
  defenderId: string;
  from: Coord;
  to: Coord;
  count: number;
  unit?: UnitId;
  charging: boolean;
  /** Соседние клетки, чьи отряды бьют вместе с атакующим. */
  supportFrom?: Coord[];
}

export interface LogEntry {
  round: number;
  text: string;
}

export interface GameState {
  roomCode: string;
  hostId: string;
  /** Кроме хоста: могут менять настройки и рельеф в лобби. */
  adminIds: string[];
  settings: GameSettings;
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
  pendingSquare?: PendingSquare | null;
}

export type GameAction =
  | { type: 'move'; from: Coord; to: Coord; count: number; unit?: UnitId; supportFrom?: Coord[] }
  | { type: 'shoot'; from: Coord; to: Coord }
  | { type: 'build'; at: Coord; building: BuildingType }
  | { type: 'recruit'; at: Coord; count: number; unit?: UnitId }
  | { type: 'appoint'; at: Coord; commander: CommanderId }
  | { type: 'research'; tech: TechType }
  | { type: 'formSquare'; at: Coord }
  | { type: 'breakSquare'; at: Coord }
  | { type: 'squareReply'; form: boolean }
  | { type: 'endTurn' };

export type LobbyAction =
  | { type: 'configure'; settings: Partial<GameSettings> }
  | { type: 'paint'; at: Coord; terrain: TerrainType }
  | { type: 'reroll' }
  | { type: 'setAdmin'; playerId: string; admin: boolean };

export type GameFx = {
  kind: 'move' | 'shoot' | 'charge';
  from: Coord;
  to: Coord;
  unit: UnitId;
  count: number;
      battle: 'none' | 'won' | 'lost' | 'rout';
};

export type ActionResult = { ok: true; events: string[]; fx?: GameFx } | { ok: false; error: string };

/** Публичное описание комнаты для лобби бота. */
export interface RoomSummary {
  roomCode: string;
  hostName: string;
  phase: GamePhase;
  playerCount: number;
}
