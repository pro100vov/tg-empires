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

/** Сложность ИИ-соперника. */
export type AiLevel = 'easy' | 'normal' | 'hard';

/** Счётчики игрока для экрана итогов. */
export interface PlayerStats {
  battlesWon: number;
  battlesLost: number;
  unitsKilled: number;
  unitsLost: number;
  tilesCaptured: number;
  buildingsBuilt: number;
  unitsRecruited: number;
  eventsGood: number;
  eventsBad: number;
  /** Сколько отрядов было в самой крупной битве игрока (обе стороны). */
  biggestBattle: number;
}

/** Действующий на игрока эффект случайного события. */
export interface ActiveEffect {
  id: string;
  /** Сколько ходов игрока эффект ещё действует. */
  turnsLeft: number;
  /** Множители дохода по ресурсам (0.7 — минус 30%). */
  incomeMul?: Partial<Record<keyof Resources, number>>;
  /** Множитель силы атаки (1.1 — плюс 10%). */
  attackMul?: number;
  /** Скидка на следующую технологию (0.5 — вполовину). */
  researchDiscount?: number;
}

/** Событие этого хода, показанное игроку. */
export interface PlayerEvent {
  id: string;
  round: number;
  /** Ждёт выбора игрока (действие eventChoice). */
  pending: boolean;
  /** Итог события: «+40🪙», «лес → равнина». */
  detail: string;
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
  /** Увиденные чужие постройки: ключ "x,y". Не забываются. */
  seenBuildings: Record<string, BuildingType>;
  stats: PlayerStats;
  effects: ActiveEffect[];
  /** Недавние события игрока — чтобы не повторялись: id и раунд. */
  recentEvents: { id: string; round: number }[];
  /** Сколько ходов игрока событий не будет. */
  eventCooldown: number;
  event?: PlayerEvent | null;
  /** Задан у ИИ-соперников. */
  ai?: AiLevel;
  /** Раунд, на котором держава пала. */
  deadRound?: number;
  /** Победил в союзе с победителем партии. */
  alliedWinner?: boolean;
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
  /** Время на ход, мин: 0 — без лимита; 2/5 — блиц; 60/1440 — асинхронная партия. */
  turnMinutes: number;
  /** Случайные события у каждой державы. */
  randomEvents: boolean;
  /** Перемирия и союзы. */
  diplomacy: boolean;
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
  /** Кому видна запись. undefined — всем (публичные новости). */
  seenBy?: string[];
  /** Клетка события — клиент по тапу центрирует карту. */
  at?: Coord;
}

/** Срез партии на конец раунда — для графиков. */
export interface HistoryPoint {
  round: number;
  players: Record<string, { score: number; tiles: number; army: number; income: number }>;
}

export interface GameRecords {
  biggestBattle?: { round: number; attackerId: string; defenderId: string | null; units: number };
  firstBlood?: { round: number; attackerId: string; defenderId: string | null };
}

export type TreatyKind = 'truce' | 'alliance';

/** Договор между двумя державами. Нет записи — война. */
export interface Relation {
  kind: TreatyKind;
  /** Перемирие действует до начала этого раунда. */
  until?: number;
  /** Разрыв объявлен: война начнётся с хода разорвавшего в этом раунде или позже. */
  breakAt?: number;
  breakBy?: string;
}

export interface Proposal {
  id: string;
  from: string;
  to: string;
  kind: TreatyKind;
  rounds?: number;
  round: number;
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
  /** Когда сгорит ход текущего игрока, мс. Ставит сервер (время — не правило игры). */
  turnDeadline?: number | null;
  /** Срезы по раундам для графиков итогов. */
  history: HistoryPoint[];
  records: GameRecords;
  /** Ключ пары "idA|idB" (по алфавиту) → договор. */
  relations: Record<string, Relation>;
  proposals: Proposal[];
  /** Код комнаты реванша, когда кто-то его уже создал. */
  rematchCode?: string;
  /** Время сервера в момент отправки, мс — клиент сверяет с ним обратный отсчёт хода. */
  serverNow?: number;
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
  | { type: 'eventChoice'; choice: 0 | 1 }
  | { type: 'propose'; to: string; kind: TreatyKind; rounds?: number }
  | { type: 'acceptProposal'; id: string }
  | { type: 'declineProposal'; id: string }
  | { type: 'breakTreaty'; with: string }
  | { type: 'endTurn' };

export type LobbyAction =
  | { type: 'configure'; settings: Partial<GameSettings> }
  | { type: 'paint'; at: Coord; terrain: TerrainType }
  | { type: 'reroll' }
  | { type: 'setAdmin'; playerId: string; admin: boolean }
  | { type: 'addAi'; difficulty: AiLevel }
  | { type: 'removeAi'; playerId: string };

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

/** Строка списка «Мои партии» (бот /games и меню Mini App). */
export interface MyGame {
  roomCode: string;
  phase: GamePhase;
  round: number;
  maxRounds: number;
  players: { name: string; color: string }[];
  /** Сейчас ход этого игрока. */
  myTurn: boolean;
  /** Чей ход (имя) — пусто в лобби и после конца. */
  turnName: string;
  /** Когда сгорит ход, мс. */
  deadline: number | null;
}
