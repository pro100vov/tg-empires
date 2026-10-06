import {
  BUILDINGS,
  defaultGameSettings,
  MAP_SIZES,
  MAX_ACTIONS,
  MIN_ACTIONS,
  MAX_PLAYERS,
  PLAYER_COLORS,
  START_RESOURCES,
  STARVATION_DESERTION,
  TERRAIN,
  CAPITAL_INCOME,
  ECONOMY_TECH_BONUS,
  TURN_MINUTES_OPTIONS,
  KILL_GOAL_MAX,
  WAR_CAPITAL_MAX,
  WAR_CAPITAL_MIN,
  emptyStats,
  techCost,
} from './config.js';
import { TRUCE_ROUNDS, alliesOf, areAllies, atWar, pairKey, relationOf } from './diplomacy.js';
import { EVENT_RULES, eventById, eventName, pickEvent } from './events.js';
import type { EventContext, EventDef } from './events.js';
import {
  capitalSpots,
  chargePathOpen,
  ensureCapitalApproaches,
  generateTiles,
  hexDistance,
  neighbors,
  resizeTiles,
  tileAt,
  walkPath,
} from './map.js';
import { mulberry32 } from './rng.js';
import { canSeeArmyOn, canWatchTile } from './vision.js';
import {
  HEAL_REST_TURNS,
  WAR_FORTS,
  WAR_FORT_TURNS,
  allDeployed,
  autoDeploy,
  deployStep,
  isWargame,
  killGoalOf,
  prepareDeploy,
  squadSize,
  squadUnit,
  squadsOf,
  wargameScore,
} from './wargame.js';
import { COMMANDERS } from './commanders.js';
import { ERAS, buildingsFor, commandersFor, eraOf, isEraId, techsFor } from './eras.js';
import type {
  ActionResult,
  AiLevel,
  Army,
  BuildingType,
  CommanderId,
  Coord,
  DeployAction,
  GameAction,
  GameFx,
  GameSettings,
  GameState,
  LobbyAction,
  LogEntry,
  Player,
  PlayerStats,
  Resources,
  Squad,
  TerrainType,
  Tile,
  UnitId,
} from './types.js';
import {
  DEFAULT_UNIT,
  UNITS,
  volleyArmy,
  armyCount,
  armyPower,
  armyRange,
  armySpeed,
  armyCanCharge,
  armyCanKite,
  armyHasCavalry,
  armyHasInfantry,
  CHARGE_ATTACK,
  CHARGE_COST,
  MOVED_VOLLEY,
  SQUARE_CASUALTY,
  dominantClass,
  dominantUnit,
  mergeArmies,
  scaleArmy,
  takeArmy,
  ensureWings,
  writeWings,
  takeFromWings,
  mobileCount,
  spendWingMove,
  wingsToArmy,
  wingsAlreadyMarching,
  unitsFor,
  armyHasHeavyArtillery,
  tileHasMarched,
  tileShotIsFree,
} from './units.js';

const EMPTY: Resources = { gold: 0, food: 0, iron: 0 };

function era(state: GameState) {
  return eraOf(state.settings);
}

function flavorOf(state: GameState) {
  return ERAS[era(state)];
}

function chargeWord(state: GameState): string {
  return flavorOf(state).chargeLabel.split(/\s+/)[0] ?? 'Набег';
}

function unitsOf(state: GameState) {
  return unitsFor(era(state));
}

function buildingsOf(state: GameState) {
  return buildingsFor(era(state));
}

function commandersOf(state: GameState) {
  return commandersFor(era(state));
}

function stackSpeed(tile: Tile, state: GameState): number {
  if (armyCount(tile.army) === 0) return 0;
  return armySpeed(tile.army, era(state)) + (tile.commander ? COMMANDERS[tile.commander].speedBonus : 0);
}

function speedBonus(tile: Tile): number {
  return tile.commander ? COMMANDERS[tile.commander].speedBonus : 0;
}

function clearMarch(tile: Tile): void {
  writeWings(tile, []);
  tile.commander = null;
  tile.routedTurns = 0;
  tile.square = false;
  tile.squad = null;
}

/** Повтор хода после ответа на каре — больше не предлагаем строй. */
let resolvingSquareOffer = false;

export function canFormSquare(tile: Tile): boolean {
  if (tile.terrain === 'forest') return false;
  if (tile.routedTurns > 0) return false;
  if (!armyHasInfantry(tile.army)) return false;
  if (armyHasCavalry(tile.army)) return false;
  return armyCount(tile.army) > 0;
}

export function enemyCavalryAdjacent(state: GameState, tile: Tile): boolean {
  if (!tile.ownerId) return false;
  return neighbors(state, tile).some(
    (n) => n.ownerId != null && n.ownerId !== tile.ownerId && armyHasCavalry(n.army),
  );
}

export function squarePinned(state: GameState, tile: Tile): boolean {
  return Boolean(tile.square) && enemyCavalryAdjacent(state, tile);
}

export function shouldOfferSquare(state: GameState, attacking: Army, to: Tile): boolean {
  if (era(state) !== 'napoleonic') return false;
  if (to.square) return false;
  if (!to.ownerId) return false;
  if (!armyHasCavalry(attacking)) return false;
  return canFormSquare(to);
}

export function canAnswerSquare(state: GameState, userId: string): boolean {
  const pending = state.pendingSquare;
  if (!pending) return false;
  if (userId === pending.defenderId) return true;
  return Boolean(state.settings.hotseat && userId === state.hostId);
}

export function playerById(state: GameState, id: string): Player | undefined {
  return state.players.find((p) => p.id === id);
}

export function currentPlayer(state: GameState): Player | undefined {
  const id = state.order[state.turnIndex];
  return id ? playerById(state, id) : undefined;
}

export function hotseatRivalId(hostId: string): string {
  return `hotseat:${hostId}`;
}

export function isHotseatRival(playerId: string): boolean {
  return playerId.startsWith('hotseat:');
}

/** В партии «сам с собой» хост действует и смотрит за того, чей сейчас ход. */
export function actingPlayerId(state: GameState, userId: string): string {
  if (!state.settings.hotseat || userId !== state.hostId) return userId;
  // Расстановка соло: сначала своя армия, после «Готов» — армия «Соперника».
  if (state.phase === 'deploy') return state.players.find((p) => !p.deployReady)?.id ?? userId;
  if (state.phase !== 'playing' && state.phase !== 'finished') return userId;
  return currentPlayer(state)?.id ?? userId;
}

export function setupHotseat(state: GameState, hostId: string, hostName: string): ActionResult {
  const joined = addPlayer(state, hostId, hostName);
  if (!joined.ok) return joined;
  const rival = addPlayer(state, hotseatRivalId(hostId), 'Соперник');
  if (!rival.ok) return rival;
  const dummy = playerById(state, hotseatRivalId(hostId));
  if (dummy) dummy.connected = false;
  state.settings.hotseat = true;
  state.settings.diplomacy = false;
  return { ok: true, events: [] };
}

export function canAfford(res: Resources, cost: Partial<Resources>): boolean {
  return (
    res.gold >= (cost.gold ?? 0) && res.food >= (cost.food ?? 0) && res.iron >= (cost.iron ?? 0)
  );
}

function pay(res: Resources, cost: Partial<Resources>): void {
  res.gold -= cost.gold ?? 0;
  res.food -= cost.food ?? 0;
  res.iron -= cost.iron ?? 0;
}

export function multiplyCost(cost: Partial<Resources>, times: number): Resources {
  return {
    gold: (cost.gold ?? 0) * times,
    food: (cost.food ?? 0) * times,
    iron: (cost.iron ?? 0) * times,
  };
}

export function createGame(roomCode: string, hostId: string, seed: number): GameState {
  const settings = defaultGameSettings();
  const size = settings.mapSize;
  return {
    roomCode,
    hostId,
    adminIds: [],
    settings,
    phase: 'lobby',
    seed,
    width: size,
    height: size,
    tiles: generateTiles(size, MAX_PLAYERS, seed),
    players: [],
    order: [],
    turnIndex: 0,
    round: 0,
    maxRounds: settings.maxRounds,
    log: [],
    winnerId: null,
    turnDeadline: null,
    history: [],
    records: {},
    relations: {},
    proposals: [],
  };
}

/**
 * Дозаполняет состояние полями, добавленными позже: сохранённые до обновления партии
 * должны загружаться и играться. Меняет объект на месте и возвращает его.
 */
export function normalizeState(state: GameState): GameState {
  state.settings = { ...defaultGameSettings(), ...state.settings };
  state.adminIds ??= [];
  state.log ??= [];
  state.history ??= [];
  state.records ??= {};
  state.relations ??= {};
  state.proposals ??= [];
  if (state.turnDeadline === undefined) state.turnDeadline = null;
  for (const player of state.players) {
    player.seenBuildings ??= {};
    player.stats = { ...emptyStats(), ...player.stats };
    player.effects ??= [];
    player.recentEvents ??= [];
    player.eventCooldown ??= 0;
    player.forts ??= [];
  }
  for (const tile of state.tiles) {
    tile.routedTurns ??= 0;
  }
  return state;
}

function newPlayer(state: GameState, id: string, name: string): Player {
  return {
    id,
    name,
    color: PLAYER_COLORS[state.players.length % PLAYER_COLORS.length]!,
    resources: { ...START_RESOURCES },
    tech: { attack: 0, defense: 0, economy: 0, logistics: 0 },
    actionsLeft: 0,
    alive: true,
    connected: true,
    seenBuildings: {},
    stats: emptyStats(),
    effects: [],
    recentEvents: [],
    eventCooldown: 0,
    event: null,
  };
}

export function addPlayer(state: GameState, id: string, name: string): ActionResult {
  const existing = playerById(state, id);
  if (existing) {
    existing.connected = true;
    existing.name = name || existing.name;
    return { ok: true, events: [] };
  }
  if (state.phase !== 'lobby') return { ok: false, error: 'Игра уже началась' };
  if (state.players.length >= MAX_PLAYERS) return { ok: false, error: 'В комнате нет мест' };

  state.players.push(newPlayer(state, id, name));
  if (!state.hostId) state.hostId = id;
  return { ok: true, events: [`${name} присоединился к игре`] };
}

const AI_NAMES: Record<AiLevel, string[]> = {
  easy: ['Новобранец', 'Оруженосец', 'Ополченец'],
  normal: ['Полководец', 'Стратег', 'Воевода'],
  hard: ['Завоеватель', 'Тиран', 'Император'],
};

export function isAiPlayer(playerId: string): boolean {
  return playerId.startsWith('ai:');
}

export function aiLevelOf(state: GameState, playerId: string): AiLevel | null {
  return playerById(state, playerId)?.ai ?? null;
}

/** ИИ-соперник в лобби: id `ai:<n>`, всегда «онлайн». */
export function addAiPlayer(state: GameState, difficulty: AiLevel): ActionResult {
  if (state.phase !== 'lobby') return { ok: false, error: 'Игра уже началась' };
  if (state.settings.hotseat) return { ok: false, error: 'В партии «сам с собой» ИИ не нужен' };
  if (state.players.length >= MAX_PLAYERS) return { ok: false, error: 'В комнате нет мест' };
  if (!(difficulty in AI_NAMES)) return { ok: false, error: 'Неизвестная сложность ИИ' };
  let n = 1;
  while (playerById(state, `ai:${n}`)) n += 1;
  const names = AI_NAMES[difficulty];
  const player = newPlayer(state, `ai:${n}`, `ИИ ${names[(n - 1) % names.length]}`);
  player.ai = difficulty;
  state.players.push(player);
  return { ok: true, events: [] };
}

/** Игрок временно ушёл (перезагрузка, разрыв связи) — место и права не отнимаем. */
export function markDisconnected(state: GameState, id: string): void {
  if (isHotseatRival(id) || isAiPlayer(id)) return;
  const player = playerById(state, id);
  if (player) player.connected = false;
}

function dropFromLobby(state: GameState, id: string): void {
  state.players = state.players.filter((p) => p.id !== id);
  state.players.forEach((p, i) => {
    p.color = PLAYER_COLORS[i % PLAYER_COLORS.length]!;
  });
  // Ушли все — хоста нет, им станет следующий вошедший (см. addPlayer). ИИ хостом не бывает.
  if (state.hostId === id) state.hostId = state.players.find((p) => !isAiPlayer(p.id))?.id ?? '';
  state.adminIds = state.adminIds.filter((adminId) => adminId !== id && state.players.some((p) => p.id === adminId));
}

export function removePlayer(state: GameState, id: string): void {
  if (isHotseatRival(id) || isAiPlayer(id)) return;
  if (state.phase === 'lobby') {
    if (state.settings.hotseat) {
      const player = playerById(state, id);
      if (player) player.connected = false;
      return;
    }
    dropFromLobby(state, id);
    return;
  }
  const player = playerById(state, id);
  if (player) player.connected = false;
}

/** Живые люди в партии (без ИИ и «Соперника» соло). */
export function humanPlayers(state: GameState): Player[] {
  return state.players.filter((p) => !isAiPlayer(p.id) && !isHotseatRival(p.id));
}

export function isLobbyAdmin(state: GameState, playerId: string): boolean {
  if (state.hostId === playerId) return true;
  return state.adminIds.includes(playerId);
}

function clampInt(n: unknown, min: number, max: number): number | null {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function sanitizeSettings(patch: Partial<GameSettings>): Partial<GameSettings> {
  const next: Partial<GameSettings> = {};
  if (patch.mapSize != null) {
    const size = clampInt(patch.mapSize, 8, 14);
    if (size != null && (MAP_SIZES as readonly number[]).includes(size)) next.mapSize = size;
  }
  if (patch.terrainMode === 'random' || patch.terrainMode === 'custom') next.terrainMode = patch.terrainMode;
  if (typeof patch.fogOfWar === 'boolean') next.fogOfWar = patch.fogOfWar;
  // hotseat выставляет только setupHotseat — через лобби его менять нельзя (иначе хост
  // может подменить режим и ходить за всех, либо сломать соло-партию).
  if (isEraId(patch.era)) next.era = patch.era;
  if (patch.turnMinutes != null && (TURN_MINUTES_OPTIONS as readonly number[]).includes(patch.turnMinutes)) {
    next.turnMinutes = patch.turnMinutes;
  }
  if (typeof patch.randomEvents === 'boolean') next.randomEvents = patch.randomEvents;
  if (typeof patch.diplomacy === 'boolean') next.diplomacy = patch.diplomacy;
  if (patch.maxRounds != null) {
    const rounds = clampInt(patch.maxRounds, 15, 60);
    if (rounds != null) next.maxRounds = rounds;
  }
  if (patch.startGold != null) {
    const gold = clampInt(patch.startGold, 20, 200);
    if (gold != null) next.startGold = gold;
  }
  if (patch.startFood != null) {
    const food = clampInt(patch.startFood, 0, 150);
    if (food != null) next.startFood = food;
  }
  if (patch.startIron != null) {
    const iron = clampInt(patch.startIron, 0, 150);
    if (iron != null) next.startIron = iron;
  }
  if (patch.startArmy != null) {
    const army = clampInt(patch.startArmy, 2, 20);
    if (army != null) next.startArmy = army;
  }
  if (patch.actionsPerTurn != null) {
    const actions = clampInt(patch.actionsPerTurn, MIN_ACTIONS, MAX_ACTIONS);
    if (actions != null) next.actionsPerTurn = actions;
  }
  if (patch.mode === 'empire' || patch.mode === 'wargame') next.mode = patch.mode;
  if (patch.warCapital != null) {
    const capital = clampInt(patch.warCapital, WAR_CAPITAL_MIN, WAR_CAPITAL_MAX);
    if (capital != null) next.warCapital = capital;
  }
  if (patch.killGoal != null) {
    const goal = clampInt(patch.killGoal, -1, KILL_GOAL_MAX);
    if (goal != null) next.killGoal = goal;
  }
  return next;
}

const TERRAINS: TerrainType[] = ['plains', 'forest', 'hills', 'mountains', 'water'];

export function applyLobbyAction(state: GameState, playerId: string, action: LobbyAction): ActionResult {
  if (state.phase !== 'lobby') return { ok: false, error: 'Настройки доступны только в лобби' };

  if (action.type === 'setAdmin') {
    if (playerId !== state.hostId) return { ok: false, error: 'Админа назначает только хост' };
    if (action.playerId === state.hostId) return { ok: false, error: 'Хост и так управляет комнатой' };
    if (!playerById(state, action.playerId)) return { ok: false, error: 'Игрока нет в комнате' };
    if (action.admin) {
      if (!state.adminIds.includes(action.playerId)) state.adminIds.push(action.playerId);
    } else {
      state.adminIds = state.adminIds.filter((id) => id !== action.playerId);
    }
    return { ok: true, events: [] };
  }

  if (!isLobbyAdmin(state, playerId)) return { ok: false, error: 'Настраивать игру может хост или админ' };

  if (action.type === 'addAi') return addAiPlayer(state, action.difficulty);

  if (action.type === 'removeAi') {
    const target = playerById(state, action.playerId);
    if (!target || !isAiPlayer(target.id)) return { ok: false, error: 'Это не ИИ-соперник' };
    dropFromLobby(state, target.id);
    return { ok: true, events: [] };
  }

  if (action.type === 'reroll') {
    state.seed = (state.seed + 0x9e3779b9) >>> 0;
    state.settings.terrainMode = 'random';
    state.tiles = generateTiles(state.settings.mapSize, MAX_PLAYERS, state.seed);
    state.width = state.settings.mapSize;
    state.height = state.settings.mapSize;
    return { ok: true, events: [] };
  }

  if (action.type === 'paint') {
    if (!TERRAINS.includes(action.terrain)) return { ok: false, error: 'Неизвестный рельеф' };
    const tile = tileAt(state, action.at.x, action.at.y);
    if (!tile) return { ok: false, error: 'Клетки не существует' };
    tile.terrain = action.terrain;
    state.settings.terrainMode = 'custom';
    return { ok: true, events: [] };
  }

  if (action.type === 'configure') {
    const patch = sanitizeSettings(action.settings);
    const prev = state.settings;
    const next = { ...prev, ...patch };
    const sizeChanged = next.mapSize !== prev.mapSize;
    const modeToRandom = next.terrainMode === 'random' && prev.terrainMode !== 'random';
    if (sizeChanged && next.terrainMode === 'custom') {
      state.tiles = resizeTiles(state.tiles, state.width, state.height, next.mapSize);
    } else if (sizeChanged || modeToRandom) {
      if (modeToRandom) state.seed = (state.seed + 0x9e3779b9) >>> 0;
      state.tiles = generateTiles(next.mapSize, MAX_PLAYERS, state.seed);
    }
    state.settings = next;
    state.width = next.mapSize;
    state.height = next.mapSize;
    state.maxRounds = next.maxRounds;
    return { ok: true, events: [] };
  }

  return { ok: false, error: 'Неизвестное действие лобби' };
}

export function startGame(state: GameState, byPlayerId: string): ActionResult {
  if (state.phase !== 'lobby') return { ok: false, error: 'Игра уже идёт' };
  if (byPlayerId !== state.hostId) return { ok: false, error: 'Начать игру может только хост' };
  if (state.players.length < 2) return { ok: false, error: 'Нужно минимум 2 игрока' };

  const settings = state.settings;
  const size = settings.mapSize;
  if (state.width !== size || state.height !== size || state.tiles.length !== size * size) {
    state.tiles = generateTiles(size, state.players.length, state.seed);
  }
  state.width = size;
  state.height = size;
  if (isWargame(state)) return startDeploy(state);
  ensureCapitalApproaches(state.tiles, size, state.players.length, settings.terrainMode !== 'custom');

  const spots = capitalSpots(size, state.players.length);
  state.players.forEach((player, i) => {
    player.resources = {
      gold: settings.startGold,
      food: settings.startFood,
      iron: settings.startIron,
    };
    const spot = spots[i]!;
    const capital = tileAt(state, spot.x, spot.y)!;
    capital.ownerId = player.id;
    capital.capitalOf = player.id;
    capital.building = 'fort';
    capital.army = { medium_infantry: settings.startArmy };
    for (const t of neighbors(state, spot)) {
      if (TERRAIN[t.terrain].passable) t.ownerId = player.id;
    }
  });

  const rand = mulberry32(state.seed ^ 0x9e3779b9);
  state.order = state.players
    .map((p) => ({ id: p.id, k: rand() }))
    .sort((a, b) => a.k - b.k)
    .map((p) => p.id);

  state.phase = 'playing';
  state.round = 1;
  state.turnIndex = 0;
  state.maxRounds = settings.maxRounds;
  state.log = [{ round: 1, text: 'Игра началась. Держава ждёт ваших решений.' }];
  beginTurn(state);
  return { ok: true, events: [] };
}

/** Варгейм: вместо столиц — закупка и расстановка; ИИ закупаются сразу. */
function startDeploy(state: GameState): ActionResult {
  const settings = state.settings;
  // В варгейме нет экономики и событий; дипломатия — тоже в бою на счёт отрядов лишняя.
  settings.randomEvents = false;
  settings.diplomacy = false;
  prepareDeploy(state);
  const rand = mulberry32(state.seed ^ 0x9e3779b9);
  state.order = state.players
    .map((p) => ({ id: p.id, k: rand() }))
    .sort((a, b) => a.k - b.k)
    .map((p) => p.id);
  state.phase = 'deploy';
  state.round = 0;
  state.turnIndex = 0;
  state.maxRounds = settings.maxRounds;
  state.log = [{ round: 0, text: 'Варгейм: купите армию на капитал и расставьте её в своей зоне.' }];
  for (const player of state.players) {
    if (!player.ai) continue;
    autoDeploy(state, player.id);
    player.deployReady = squadsOf(state, player.id).length > 0;
  }
  if (allDeployed(state)) beginBattle(state);
  return { ok: true, events: [] };
}

/** Закупка/расстановка варгейма; когда готовы все — начинается бой. */
export function applyDeployAction(state: GameState, playerId: string, action: DeployAction): ActionResult {
  const result = deployStep(state, playerId, action);
  if (result.ok && allDeployed(state)) beginBattle(state);
  return result;
}

/** Расстановка вышла по времени: докупить и поставить «Готов» за игрока. */
export function forceDeployReady(state: GameState, playerId: string): void {
  const player = playerById(state, playerId);
  if (state.phase !== 'deploy' || !player || player.deployReady) return;
  if (squadsOf(state, playerId).length === 0) autoDeploy(state, playerId);
  player.deployReady = true;
  if (allDeployed(state)) beginBattle(state);
}

function beginBattle(state: GameState): void {
  state.phase = 'playing';
  state.round = 1;
  state.turnIndex = 0;
  for (const player of state.players) {
    player.deployReady = false;
    if (squadsOf(state, player.id).length === 0) {
      player.alive = false;
      player.deadRound = 1;
    }
  }
  state.log.push({ round: 1, text: 'Армии расставлены. В бой!' });
  const alive = state.players.filter((p) => p.alive);
  if (alive.length <= 1) {
    finish(state, alive[0]?.id ?? null);
    return;
  }
  while (!currentPlayer(state)?.alive && state.turnIndex < state.order.length - 1) state.turnIndex += 1;
  beginTurn(state);
}

export function computeIncome(state: GameState, playerId: string): Resources {
  const player = playerById(state, playerId);
  if (!player || isWargame(state)) return { ...EMPTY };
  const income: Resources = { ...EMPTY };
  for (const tile of state.tiles) {
    if (tile.ownerId !== playerId) continue;
    const terrain = TERRAIN[tile.terrain].income;
    income.gold += terrain.gold ?? 0;
    income.food += terrain.food ?? 0;
    income.iron += terrain.iron ?? 0;
    if (tile.building) {
      const b = BUILDINGS[tile.building].income;
      income.gold += b.gold ?? 0;
      income.food += b.food ?? 0;
      income.iron += b.iron ?? 0;
    }
    if (tile.capitalOf === playerId) {
      income.gold += CAPITAL_INCOME.gold;
      income.food += CAPITAL_INCOME.food;
      income.iron += CAPITAL_INCOME.iron;
    }
  }
  const mult = 1 + ECONOMY_TECH_BONUS * player.tech.economy;
  const eff = effectIncomeMul(player);
  return {
    gold: Math.round(income.gold * mult * eff.gold),
    food: Math.round(income.food * mult * eff.food),
    iron: Math.round(income.iron * mult * eff.iron),
  };
}

/** Произведение множителей дохода от действующих событий. */
function effectIncomeMul(player: Player): Resources {
  const mul: Resources = { gold: 1, food: 1, iron: 1 };
  for (const effect of player.effects ?? []) {
    if (!effect.incomeMul) continue;
    mul.gold *= effect.incomeMul.gold ?? 1;
    mul.food *= effect.incomeMul.food ?? 1;
    mul.iron *= effect.incomeMul.iron ?? 1;
  }
  return mul;
}

/** Цена технологии для игрока: со скидкой «Учёного из-за моря». */
export function techCostFor(player: Player, level: number): Resources {
  const base = techCost(level);
  let discount = 0;
  for (const effect of player.effects ?? []) discount = Math.max(discount, effect.researchDiscount ?? 0);
  if (discount <= 0) return base;
  const k = 1 - discount;
  return { gold: Math.ceil(base.gold * k), food: Math.ceil(base.food * k), iron: Math.ceil(base.iron * k) };
}

export function totalArmy(state: GameState, playerId: string): number {
  return state.tiles.reduce((sum, t) => (t.ownerId === playerId ? sum + armyCount(t.army) : sum), 0);
}

export function upkeepFor(state: GameState, playerId: string): number {
  if (isWargame(state)) return 0;
  const units = unitsOf(state);
  let food = 0;
  for (const tile of state.tiles) {
    if (tile.ownerId !== playerId) continue;
    for (const [id, n] of Object.entries(tile.army)) food += (n ?? 0) * (units[id as UnitId]?.upkeep ?? 1);
  }
  return Math.ceil(food - 1e-9);
}

/** Сколько записей журнала хранит партия (игроку приходит только видимая ему часть). */
const LOG_LIMIT = 300;

interface LogOpts {
  /** Участники: видят запись всегда. */
  actors?: (string | null | undefined)[];
  /** Клетки события: запись видят и те, кто их наблюдает. Первая — для центрирования карты. */
  at?: Coord[];
  /** Центрировать карту на этой клетке, не делая её источником свидетелей. */
  focus?: Coord;
  /** Новость для всех. */
  public?: boolean;
}

/**
 * Запись журнала. Без `public` она видна участникам и тем, кто видит клетки события
 * (считаем по состоянию на момент записи — вызывать после изменения клеток).
 * Туман выключен — журнал общий.
 */
function log(state: GameState, text: string, opts: LogOpts = {}): void {
  const entry: LogEntry = { round: state.round, text };
  const first = opts.focus ?? opts.at?.[0];
  if (first) entry.at = { x: first.x, y: first.y };
  if (!opts.public && state.settings.fogOfWar !== false) {
    const seen = new Set<string>();
    for (const id of opts.actors ?? []) if (id) seen.add(id);
    if (opts.at) {
      for (const p of state.players) {
        if (!p.alive || seen.has(p.id)) continue;
        if (opts.at.some((c) => canWatchTile(state, p.id, c))) seen.add(p.id);
      }
    }
    entry.seenBy = [...seen];
  }
  state.log.push(entry);
  if (state.log.length > LOG_LIMIT) state.log.shift();
}

/** Публичная запись от сервера (например, «не успел — ход завершён»). */
export function logPublic(state: GameState, text: string): void {
  log(state, text, { public: true });
}

const clampStat = (n: number) => Math.max(0, Math.round(n));

function stats(state: GameState, playerId: string | null | undefined): PlayerStats | null {
  if (!playerId) return null;
  return playerById(state, playerId)?.stats ?? null;
}

/** Записывает исход боя в счётчики и рекорды. */
function recordBattle(
  state: GameState,
  attackerId: string,
  defenderId: string | null,
  atkBefore: number,
  atkAfter: number,
  defBefore: number,
  defAfter: number,
  attackerWon: boolean,
): void {
  const a = stats(state, attackerId);
  const d = stats(state, defenderId);
  const total = atkBefore + defBefore;
  if (a) {
    if (attackerWon) a.battlesWon += 1;
    else a.battlesLost += 1;
    a.unitsKilled += clampStat(defBefore - defAfter);
    a.unitsLost += clampStat(atkBefore - atkAfter);
    a.biggestBattle = Math.max(a.biggestBattle, total);
  }
  if (d) {
    if (attackerWon) d.battlesLost += 1;
    else d.battlesWon += 1;
    d.unitsKilled += clampStat(atkBefore - atkAfter);
    d.unitsLost += clampStat(defBefore - defAfter);
    d.biggestBattle = Math.max(d.biggestBattle, total);
  }
  const records = state.records;
  if (!records.firstBlood) records.firstBlood = { round: state.round, attackerId, defenderId };
  if (!records.biggestBattle || total > records.biggestBattle.units) {
    records.biggestBattle = { round: state.round, attackerId, defenderId, units: total };
  }
}

/** Срез по игрокам на конец раунда — для графиков итогов. */
function snapshotHistory(state: GameState, round: number): void {
  if (state.history.some((h) => h.round === round)) return;
  const players: Record<string, { score: number; tiles: number; army: number; income: number }> = {};
  for (const p of state.players) {
    players[p.id] = {
      score: scoreOf(state, p.id),
      tiles: state.tiles.reduce((n, t) => (t.ownerId === p.id ? n + 1 : n), 0),
      army: totalArmy(state, p.id),
      income: p.alive ? computeIncome(state, p.id).gold : 0,
    };
  }
  state.history.push({ round, players });
}

/** Число клеток, перешедших к игроку, — в статистику. */
function countCaptured(state: GameState, playerId: string, n = 1): void {
  const s = stats(state, playerId);
  if (s) s.tilesCaptured += n;
}

function beginTurn(state: GameState): void {
  const player = currentPlayer(state);
  if (!player) return;

  // Разрыв договора, объявленный этим игроком в прошлых раундах, вступает в силу.
  if (state.settings.diplomacy) enforceBreaks(state, player.id);

  const war = isWargame(state);
  for (const tile of state.tiles) {
    if (tile.ownerId !== player.id || !tile.construction) continue;
    // Варгейм: укрепление строит отряд на клетке — без него стройка стоит (и срывается уборкой).
    if (war && armyCount(tile.army) === 0) continue;
    tile.construction.turnsLeft -= 1;
    if (tile.construction.turnsLeft > 0) continue;
    tile.building = tile.construction.building;
    const name = buildingsOf(state)[tile.building].name;
    tile.construction = null;
    player.stats.buildingsBuilt += 1;
    log(state, `${name} достроена.`, { actors: [player.id], at: [tile] });
  }

  const income = computeIncome(state, player.id);
  player.resources.gold += income.gold;
  player.resources.food += income.food;
  player.resources.iron += income.iron;
  tickEffects(player);

  const upkeep = upkeepFor(state, player.id);
  if (war || player.resources.food >= upkeep) {
    player.resources.food -= upkeep;
  } else {
    player.resources.food = 0;
    let deserted = 0;
    for (const tile of state.tiles) {
      if (tile.ownerId !== player.id || armyCount(tile.army) === 0) continue;
      const total = armyCount(tile.army);
      const loss = Math.max(1, Math.floor(total * STARVATION_DESERTION));
      tile.army = takeArmy(tile.army, loss).rest;
      deserted += loss;
    }
    if (deserted > 0) log(state, `${player.name}: голод, дезертировало ${deserted} отр.`, { actors: [player.id] });
  }

  for (const tile of state.tiles) {
    if (tile.ownerId !== player.id) continue;
    if (armyCount(tile.army) === 0) {
      clearMarch(tile);
      continue;
    }
    const mp = stackSpeed(tile, state);
    writeWings(tile, [
      {
        army: { ...tile.army },
        // Отступающие неуправляемы: без хода и залпа, пока висит бегство.
        movesLeft: tile.routedTurns > 0 ? 0 : mp,
        shotsLeft: tile.routedTurns > 0 ? 0 : 1,
      },
    ]);
  }

  player.actionsLeft = state.settings.actionsPerTurn + player.tech.logistics;

  let squaresHeld = 0;
  let squaresBroke = 0;
  for (const tile of state.tiles) {
    if (tile.ownerId !== player.id || !tile.square) continue;
    if (!canFormSquare(tile)) {
      tile.square = false;
      squaresBroke += 1;
      continue;
    }
    if (player.actionsLeft < 1) {
      tile.square = false;
      squaresBroke += 1;
      continue;
    }
    player.actionsLeft -= 1;
    squaresHeld += 1;
  }
  if (squaresHeld > 0) {
    log(state, `${player.name}: каре держит строй (−${squaresHeld}⚡).`, { actors: [player.id] });
  }
  if (squaresBroke > 0) {
    log(state, `${player.name}: каре рассыпалось.`, { actors: [player.id] });
  }

  if (state.settings.randomEvents && !war) rollEvent(state, player);
}

/**
 * Варгейм, конец хода владельца: отряд, который весь ход не ходил, не стрелял и не дрался,
 * копит покой; за `HEAL_REST_TURNS` таких ходов подряд возвращает 1 юнит (до размера покупки).
 */
function restSquads(state: GameState, player: Player): void {
  let healed = 0;
  for (const tile of state.tiles) {
    if (tile.ownerId !== player.id || armyCount(tile.army) === 0) continue;
    const squad: Squad = (tile.squad ??= { size: armyCount(tile.army), rest: 0 });
    if (squad.active) {
      squad.active = false;
      squad.rest = 0;
      continue;
    }
    squad.rest += 1;
    const unit = squadUnit(tile);
    if (squad.rest < HEAL_REST_TURNS || !unit || armyCount(tile.army) >= squad.size) continue;
    squad.rest = 0;
    writeWings(tile, [...ensureWings(tile), { army: { [unit]: 1 }, movesLeft: 0, shotsLeft: 0 }]);
    healed += 1;
  }
  if (healed > 0) log(state, `${player.name}: отряды отдохнули и пополнились (+${healed}).`, { actors: [player.id] });
}

function nextTurn(state: GameState): void {
  if (state.phase !== 'playing') return;
  const ending = currentPlayer(state);
  if (ending) {
    for (const tile of state.tiles) {
      if (tile.ownerId === ending.id && tile.routedTurns > 0) tile.routedTurns -= 1;
    }
    if (isWargame(state)) restSquads(state, ending);
    // Не ответил на выбор — вариант «отказаться».
    if (ending.event?.pending) resolveEventChoice(state, ending, 0);
    // Предложения ему живут до конца его ближайшего хода.
    state.proposals = state.proposals.filter((p) => p.to !== ending.id);
  }
  const alive = state.players.filter((p) => p.alive);
  if (alive.length <= 1) {
    finish(state, alive[0]?.id ?? null);
    return;
  }
  if (checkAlliedVictory(state)) return;

  let guard = 0;
  do {
    state.turnIndex += 1;
    if (state.turnIndex >= state.order.length) {
      state.turnIndex = 0;
      snapshotHistory(state, state.round);
      state.round += 1;
      expireTruces(state);
      if (state.round > state.maxRounds) {
        finishByScore(state);
        return;
      }
    }
    guard += 1;
  } while (!currentPlayer(state)?.alive && guard < state.order.length * 2);

  beginTurn(state);
}

export function scoreOf(state: GameState, playerId: string): number {
  const player = playerById(state, playerId);
  if (!player) return 0;
  if (isWargame(state)) return wargameScore(state, player);
  let score = 0;
  for (const tile of state.tiles) {
    if (tile.ownerId !== playerId) continue;
    score += 3;
    if (tile.building) score += 2;
    if (tile.capitalOf === playerId) score += 10;
    score += armyCount(tile.army);
  }
  score += (player.tech.attack + player.tech.defense + player.tech.economy + player.tech.logistics) * 3;
  return score;
}

/** Порядок мест: победитель, затем живые по очкам, затем павшие — кто продержался дольше. */
export function rankPlayers(state: GameState): Player[] {
  const alive = state.players
    .filter((p) => p.alive)
    .sort((a, b) => {
      if (a.id === state.winnerId) return -1;
      if (b.id === state.winnerId) return 1;
      return scoreOf(state, b.id) - scoreOf(state, a.id);
    });
  const dead = state.players.filter((p) => !p.alive).sort((a, b) => (b.deadRound ?? 0) - (a.deadRound ?? 0));
  return [...alive, ...dead];
}

function finish(state: GameState, winnerId: string | null): void {
  state.phase = 'finished';
  state.winnerId = winnerId;
  state.pendingSquare = null;
  state.proposals = [];
  for (const p of state.players) p.event = p.event?.pending ? { ...p.event, pending: false } : p.event;
  // Раунд, в котором партия оборвалась, тоже попадает на график.
  snapshotHistory(state, Math.min(state.round, state.maxRounds));
  const winner = winnerId ? playerById(state, winnerId) : null;
  log(state, winner ? `Победа: ${winner.name}!` : 'Игра окончена.', { public: true });
}

function finishByScore(state: GameState): void {
  const ranked = state.players
    .filter((p) => p.alive)
    .map((p) => ({ id: p.id, score: scoreOf(state, p.id) }))
    .sort((a, b) => b.score - a.score);
  log(state, 'Отведённое число раундов исчерпано, победа по очкам.', { public: true });
  finish(state, ranked[0]?.id ?? null);
}

function eliminate(state: GameState, victimId: string, conquerorId: string): void {
  const victim = playerById(state, victimId);
  const conqueror = playerById(state, conquerorId);
  if (!victim) return;
  victim.alive = false;
  victim.deadRound = state.round;
  let taken = 0;
  for (const tile of state.tiles) {
    if (tile.ownerId !== victimId) continue;
    tile.ownerId = conquerorId;
    tile.construction = null;
    clearMarch(tile);
    if (tile.capitalOf === victimId) tile.capitalOf = null;
    taken += 1;
  }
  if (taken > 1) countCaptured(state, conquerorId, taken - 1);
  // Договоры и предложения павшей державы теряют смысл.
  for (const key of Object.keys(state.relations)) {
    if (key.split('|').includes(victimId)) delete state.relations[key];
  }
  state.proposals = state.proposals.filter((p) => p.from !== victimId && p.to !== victimId);
  log(state, `Держава ${victim.name} пала под натиском ${conqueror?.name ?? 'врага'}.`, { public: true });
}

/** Добровольная сдача: земли — сильнейшему живому сопернику; можно не в свой ход. */
function applySurrender(state: GameState, playerId: string): ActionResult {
  const me = playerById(state, playerId);
  if (!me || !me.alive) return { ok: false, error: 'Вы вне игры' };

  if (state.pendingSquare && (state.pendingSquare.attackerId === playerId || state.pendingSquare.defenderId === playerId)) {
    state.pendingSquare = null;
  }
  if (me.event?.pending) me.event = { ...me.event, pending: false };

  const wasCurrent = currentPlayer(state)?.id === playerId;
  const heir = state.players
    .filter((p) => p.alive && p.id !== playerId)
    .sort((a, b) => scoreOf(state, b.id) - scoreOf(state, a.id))[0];

  me.alive = false;
  me.deadRound = state.round;
  let taken = 0;
  for (const tile of state.tiles) {
    if (tile.ownerId !== playerId) continue;
    tile.ownerId = heir?.id ?? null;
    tile.construction = null;
    clearMarch(tile);
    if (tile.capitalOf === playerId) tile.capitalOf = null;
    taken += 1;
  }
  if (heir && taken > 1) countCaptured(state, heir.id, taken - 1);
  for (const key of Object.keys(state.relations)) {
    if (key.split('|').includes(playerId)) delete state.relations[key];
  }
  state.proposals = state.proposals.filter((p) => p.from !== playerId && p.to !== playerId);
  log(
    state,
    heir ? `${me.name} сдаётся. Земли отходят ${heir.name}.` : `${me.name} сдаётся.`,
    { public: true },
  );

  const alive = state.players.filter((p) => p.alive);
  if (alive.length <= 1) {
    finish(state, alive[0]?.id ?? null);
    return { ok: true, events: [] };
  }
  if (checkAlliedVictory(state)) return { ok: true, events: [] };
  if (wasCurrent) nextTurn(state);
  return { ok: true, events: [] };
}

/** Варгейм: купленное укрепление ставит отряд на своей клетке; уйдёт — стройка сорвётся. */
function placeWarFort(state: GameState, player: Player, tile: Tile, building: BuildingType): ActionResult {
  if (tile.ownerId !== player.id || armyCount(tile.army) < 1) {
    return { ok: false, error: 'Укрепление ставит отряд — выберите клетку со своим отрядом' };
  }
  if (tile.routedTurns > 0) return { ok: false, error: 'Отступающим отрядом нельзя управлять' };
  if (tile.building) return { ok: false, error: 'Здесь уже есть постройка' };
  if (tile.construction) return { ok: false, error: 'Здесь уже идёт стройка' };
  if (!WAR_FORTS.includes(building)) return { ok: false, error: 'Такое укрепление не продаётся' };
  const forts = (player.forts ??= []);
  const idx = forts.indexOf(building);
  if (idx < 0) return { ok: false, error: 'Это укрепление не куплено' };
  forts.splice(idx, 1);
  const turns = WAR_FORT_TURNS[building] ?? 1;
  tile.construction = { building, turnsLeft: turns };
  player.actionsLeft -= 1;
  const name = buildingsOf(state)[building].name;
  log(state, `${player.name} ставит ${name} — ${turns === 1 ? '1 ход' : `${turns} хода`}.`, { actors: [player.id], at: [tile] });
  return { ok: true, events: [] };
}

function nextRandom(state: GameState): number {
  state.seed = (Math.imul(state.seed, 1103515245) + 12345) >>> 0;
  return mulberry32(state.seed)();
}

// ── Случайные события ───────────────────────────────────────────────────────

function tickEffects(player: Player): void {
  for (const effect of player.effects) effect.turnsLeft -= 1;
  player.effects = player.effects.filter((effect) => effect.turnsLeft > 0);
}

function turnsWord(n: number): string {
  return n === 1 ? '1 ход' : n >= 2 && n <= 4 ? `${n} хода` : `${n} ходов`;
}

function rankOf(state: GameState, player: Player): 'leader' | 'lagging' | 'mid' {
  const alive = state.players.filter((p) => p.alive);
  if (alive.length < 2) return 'mid';
  const mine = scoreOf(state, player.id);
  const others = alive.filter((p) => p.id !== player.id).map((p) => scoreOf(state, p.id));
  if (mine > Math.max(...others)) return 'leader';
  if (mine < Math.min(...others)) return 'lagging';
  return 'mid';
}

function capitalTileOf(state: GameState, playerId: string): Tile | undefined {
  return state.tiles.find((t) => t.capitalOf === playerId && t.ownerId === playerId);
}

/** Крупнейший стек игрока (по числу отрядов); `pred` — доп. условие. */
function biggestStack(state: GameState, playerId: string, pred: (t: Tile) => boolean = () => true): Tile | null {
  let best: Tile | null = null;
  for (const t of state.tiles) {
    if (t.ownerId !== playerId || !pred(t)) continue;
    const n = armyCount(t.army);
    if (n > 0 && (!best || n > armyCount(best.army))) best = t;
  }
  return best;
}

function eventContext(state: GameState, player: Player): EventContext {
  const ctx: EventContext = {
    round: state.round,
    tiles: 0,
    farms: 0,
    mines: 0,
    markets: 0,
    plains: 0,
    hills: 0,
    freeForests: 0,
    army: 0,
    gold: player.resources.gold,
    actionsLeft: player.actionsLeft,
    constructions: 0,
    longConstructions: 0,
    movingStacks: 0,
    hasCapital: false,
    capitalHasArmy: false,
    capitalHasCommander: false,
    enemyNeighbors: 0,
    rivals: state.players.filter((p) => p.alive && p.id !== player.id && atWar(state, player.id, p.id)).length,
  };
  for (const tile of state.tiles) {
    if (tile.ownerId !== player.id) continue;
    ctx.tiles += 1;
    if (tile.building === 'farm') ctx.farms += 1;
    if (tile.building === 'mine') ctx.mines += 1;
    if (tile.building === 'market') ctx.markets += 1;
    if (tile.terrain === 'plains') ctx.plains += 1;
    if (tile.terrain === 'hills') ctx.hills += 1;
    const n = armyCount(tile.army);
    ctx.army += n;
    if (tile.terrain === 'forest' && n === 0 && !tile.capitalOf) ctx.freeForests += 1;
    if (tile.construction) {
      ctx.constructions += 1;
      if (tile.construction.turnsLeft >= 2) ctx.longConstructions += 1;
    }
    if (n > 0 && tile.movesLeft > 0) ctx.movingStacks += 1;
    if (tile.capitalOf === player.id) {
      ctx.hasCapital = true;
      ctx.capitalHasArmy = n > 0;
      ctx.capitalHasCommander = Boolean(tile.commander);
    }
    for (const nb of neighbors(state, tile)) {
      if (nb.ownerId && nb.ownerId !== player.id && armyCount(nb.army) > 0 && atWar(state, player.id, nb.ownerId)) {
        ctx.enemyNeighbors += 1;
      }
    }
  }
  return ctx;
}

function rollEvent(state: GameState, player: Player): void {
  if (!player.alive || state.round < EVENT_RULES.startRound) return;
  if (player.eventCooldown > 0) {
    player.eventCooldown -= 1;
    return;
  }
  if (nextRandom(state) >= EVENT_RULES.chance) return;
  const fresh = player.recentEvents.filter((e) => state.round - e.round < EVENT_RULES.repeatRounds);
  const def = pickEvent(eventContext(state, player), {
    recent: new Set(fresh.map((e) => e.id)),
    rank: rankOf(state, player),
    roll: nextRandom(state),
  });
  if (!def) return;
  player.recentEvents = [...fresh, { id: def.id, round: state.round }];
  player.eventCooldown = EVENT_RULES.cooldownTurns;
  startEvent(state, player, def);
}

/** Запускает событие у игрока: с выбором — ждёт ответа, без — сразу применяет. */
export function startEvent(state: GameState, player: Player, def: EventDef): void {
  if (def.choice) {
    player.event = { id: def.id, round: state.round, pending: true, detail: '' };
    log(state, `${def.icon} ${eventName(def, era(state))}: нужно решение до конца хода.`, { actors: [player.id] });
    return;
  }
  applyEventEffect(state, player, def, 1);
}

function resolveEventChoice(state: GameState, player: Player, choice: 0 | 1): ActionResult {
  const pending = player.event;
  if (!pending?.pending) return { ok: false, error: 'Сейчас нечего выбирать' };
  const def = eventById(pending.id);
  if (!def?.choice) {
    player.event = null;
    return { ok: false, error: 'Сейчас нечего выбирать' };
  }
  if (choice === 1 && def.choice.cost && !canAfford(player.resources, def.choice.cost)) {
    return { ok: false, error: 'Не хватает ресурсов' };
  }
  applyEventEffect(state, player, def, choice);
  return { ok: true, events: [] };
}

function addEffect(player: Player, effect: PlayerEffect): void {
  player.effects = [...player.effects.filter((e) => e.id !== effect.id), effect];
}
type PlayerEffect = Player['effects'][number];

function addUnitsAt(state: GameState, tile: Tile, unit: UnitId, count: number): void {
  const units = unitsOf(state);
  writeWings(tile, [
    ...ensureWings(tile),
    { army: { [unit]: count }, movesLeft: units[unit].speed + speedBonus(tile), shotsLeft: 1 },
  ]);
}

function randomOf<T>(state: GameState, items: T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.min(items.length - 1, Math.floor(nextRandom(state) * items.length))];
}

/** Применяет событие (или выбранный вариант) и записывает итог игроку. */
function applyEventEffect(state: GameState, player: Player, def: EventDef, choice: 0 | 1): void {
  const p = def.p;
  const units = unitsOf(state);
  let detail = '';
  let at: Coord[] | undefined;
  let good = def.tone === 'good';
  let bad = def.tone === 'bad';
  const cap = capitalTileOf(state, player.id);

  switch (def.id) {
    case 'harvest': {
      const n = Math.round(computeIncome(state, player.id).food * p.pct!);
      player.resources.food += n;
      detail = `+${n}🌾`;
      break;
    }
    case 'crop_failure':
    case 'drought': {
      addEffect(player, { id: def.id, turnsLeft: p.turns!, incomeMul: { food: p.mul! } });
      detail = `🌾 −${Math.round((1 - p.mul!) * 100)}% на ${turnsWord(p.turns!)}`;
      break;
    }
    case 'gold_vein': {
      player.resources.gold += p.gold!;
      detail = `+${p.gold}🪙`;
      break;
    }
    case 'mine_collapse': {
      addEffect(player, { id: def.id, turnsLeft: p.turns!, incomeMul: { iron: p.mul! } });
      detail = `🔩 −${Math.round((1 - p.mul!) * 100)}% на ${turnsWord(p.turns!)}`;
      break;
    }
    case 'caravan': {
      if (choice === 1) {
        player.resources.food -= p.food!;
        player.resources.gold += p.gold!;
        detail = `−${p.food}🌾 +${p.gold}🪙`;
        good = true;
      } else {
        detail = 'Вы отказались';
      }
      break;
    }
    case 'patron': {
      player.resources.gold += p.gold!;
      player.resources.iron += p.iron!;
      detail = `+${p.gold}🪙 +${p.iron}🔩`;
      break;
    }
    case 'pilgrims': {
      player.resources.gold += p.gold!;
      player.resources.food += p.food!;
      detail = `+${p.gold}🪙 +${p.food}🌾`;
      break;
    }
    case 'tax_revolt': {
      if (choice === 1) {
        player.resources.gold -= p.gold!;
        detail = `Откупились: −${p.gold}🪙`;
        break;
      }
      const lost = randomOf(
        state,
        state.tiles.filter((t) => t.ownerId === player.id && !t.capitalOf && armyCount(t.army) === 0),
      );
      if (lost) {
        lost.ownerId = null;
        lost.construction = null;
        lost.building = null;
        clearMarch(lost);
        at = [lost];
        detail = 'Клетка отпала от державы';
      } else {
        detail = 'Бунт утих сам';
      }
      break;
    }
    case 'camp_plague': {
      const tile = biggestStack(state, player.id);
      if (tile) {
        const before = armyCount(tile.army);
        const loss = Math.min(before, Math.max(1, Math.floor(before * p.pct!)));
        writeWings(tile, takeFromWings(ensureWings(tile), loss, undefined, 0).rest);
        if (armyCount(tile.army) === 0) clearMarch(tile);
        at = [tile];
        detail = `−${loss} отр.`;
      }
      break;
    }
    case 'volunteers': {
      if (cap) {
        addUnitsAt(state, cap, 'light_infantry', p.count!);
        detail = `+${p.count} × ${units.light_infantry.name}`;
        at = [cap];
      }
      break;
    }
    case 'mercenaries': {
      if (choice === 1 && cap) {
        player.resources.gold -= p.gold!;
        addUnitsAt(state, cap, 'medium_cavalry', p.count!);
        detail = `−${p.gold}🪙, +${p.count} × ${units.medium_cavalry.name}`;
        at = [cap];
        good = true;
      } else {
        detail = 'Вы отказались';
      }
      break;
    }
    case 'holiday': {
      player.actionsLeft += p.actions!;
      detail = `+${p.actions}⚡`;
      break;
    }
    case 'court_intrigue': {
      player.actionsLeft = Math.max(0, player.actionsLeft - p.actions!);
      detail = `−${p.actions}⚡`;
      break;
    }
    case 'scholar': {
      addEffect(player, { id: def.id, turnsLeft: p.turns!, researchDiscount: p.discount! });
      detail = `Следующая технология −${Math.round(p.discount! * 100)}%`;
      break;
    }
    case 'smiths': {
      player.resources.iron += p.iron!;
      detail = `+${p.iron}🔩`;
      break;
    }
    case 'forest_fire': {
      const tile = randomOf(
        state,
        state.tiles.filter((t) => t.ownerId === player.id && t.terrain === 'forest' && !t.capitalOf && armyCount(t.army) === 0),
      );
      if (tile) {
        tile.terrain = 'plains';
        at = [tile];
        detail = 'Лес выгорел → равнина';
      }
      break;
    }
    case 'flood': {
      const tile = randomOf(state, state.tiles.filter((t) => t.ownerId === player.id && t.construction));
      if (tile?.construction) {
        tile.construction.turnsLeft += p.turns!;
        at = [tile];
        detail = `Стройка задержана на ${turnsWord(p.turns!)}`;
      }
      break;
    }
    case 'master_builders': {
      let n = 0;
      for (const t of state.tiles) {
        if (t.ownerId !== player.id || !t.construction || t.construction.turnsLeft < 2) continue;
        t.construction.turnsLeft -= p.turns!;
        n += 1;
      }
      detail = `Ускорено строек: ${n}`;
      break;
    }
    case 'morale': {
      addEffect(player, { id: def.id, turnsLeft: p.turns!, attackMul: p.mul! });
      detail = `+${Math.round((p.mul! - 1) * 100)}% к атаке на ${turnsWord(p.turns!)}`;
      break;
    }
    case 'fever': {
      const tile = biggestStack(state, player.id, (t) => t.movesLeft > 0);
      if (tile) {
        writeWings(tile, ensureWings(tile).map((w) => ({ ...w, movesLeft: 0 })));
        at = [tile];
        detail = 'Крупнейший стек не ходит в этот ход';
      }
      break;
    }
    case 'hero': {
      if (cap && armyCount(cap.army) > 0 && !cap.commander) {
        const ids = Object.keys(commandersOf(state)) as CommanderId[];
        const id = randomOf(state, ids);
        if (id) {
          giveCommander(state, cap, id);
          detail = `Командир: ${commandersOf(state)[id].name}`;
          at = [cap];
        }
      }
      break;
    }
    case 'defectors': {
      let source: Tile | undefined;
      for (const t of state.tiles) {
        if (t.ownerId !== player.id) continue;
        for (const nb of neighbors(state, t)) {
          if (nb.ownerId && nb.ownerId !== player.id && armyCount(nb.army) > 0 && atWar(state, player.id, nb.ownerId)) {
            source = nb;
          }
        }
        if (source) break;
      }
      const unit = source ? dominantUnit(source.army) : null;
      if (cap && unit) {
        addUnitsAt(state, cap, unit, p.count!);
        detail = `+${p.count} × ${units[unit].name}`;
        at = [cap];
      }
      break;
    }
    case 'spy': {
      const rivals = state.players.filter((r) => r.alive && r.id !== player.id && capitalTileOf(state, r.id));
      const rival = randomOf(state, rivals);
      const rivalCap = rival ? capitalTileOf(state, rival.id) : undefined;
      if (rival && rivalCap) {
        let found = 0;
        for (const t of state.tiles) {
          if (!t.building || hexDistance(t, rivalCap) > p.radius!) continue;
          const key = coordKey(t);
          if (player.seenBuildings[key] !== t.building) found += 1;
          player.seenBuildings[key] = t.building;
        }
        detail = `Раскрыто построек у ${rival.name}: ${found}`;
      }
      break;
    }
  }

  if (def.tone === 'mixed') {
    good = choice === 1;
    bad = false;
  }
  if (good) player.stats.eventsGood += 1;
  if (bad) player.stats.eventsBad += 1;
  player.event = { id: def.id, round: state.round, pending: false, detail };
  log(state, `${def.icon} ${eventName(def, era(state))}${detail ? `: ${detail}` : ''}`, {
    actors: [player.id],
    // Меняющие карту события видят и свидетели.
    at: def.id === 'forest_fire' || def.id === 'tax_revolt' ? at : undefined,
    focus: at?.[0],
  });
}

/** Командир в стеке; ещё не ходившие крылья получают бонус скорости. */
function giveCommander(state: GameState, tile: Tile, commander: CommanderId): void {
  const unmovedWings = ensureWings(tile).map((wing) => {
    const speed = armySpeed(wing.army, era(state));
    if (wing.movesLeft >= speed) {
      return { ...wing, movesLeft: speed + COMMANDERS[commander].speedBonus };
    }
    return wing;
  });
  tile.commander = commander;
  writeWings(tile, unmovedWings);
}

// ── Дипломатия ──────────────────────────────────────────────────────────────

const TREATY_NAME = { truce: 'перемирие', alliance: 'союз' } as const;

/** Перемирия, сроки которых вышли к началу нового раунда, обращаются в войну. */
function expireTruces(state: GameState): void {
  for (const [key, rel] of Object.entries(state.relations)) {
    if (rel.kind !== 'truce' || rel.until == null || rel.until > state.round) continue;
    delete state.relations[key];
    const names = key.split('|').map((id) => playerById(state, id)?.name ?? '—');
    log(state, `Перемирие ${names.join(' и ')} истекло — снова война.`, { public: true });
  }
}

/** Разрыв, объявленный игроком раньше, вступает в силу с его хода. */
function enforceBreaks(state: GameState, playerId: string): void {
  for (const [key, rel] of Object.entries(state.relations)) {
    if (rel.breakBy !== playerId || rel.breakAt == null || state.round < rel.breakAt) continue;
    delete state.relations[key];
    const names = key.split('|').map((id) => playerById(state, id)?.name ?? '—');
    log(state, `Война: ${names.join(' и ')} больше не связаны договором.`, { public: true });
  }
}

/** Все живые попарно в союзе — партия заканчивается общей победой (по очкам). */
function checkAlliedVictory(state: GameState): boolean {
  if (!state.settings.diplomacy || state.phase !== 'playing') return false;
  const alive = state.players.filter((p) => p.alive);
  if (alive.length < 2) return false;
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const rel = relationOf(state, alive[i]!.id, alive[j]!.id);
      if (rel?.kind !== 'alliance' || rel.breakAt != null) return false;
    }
  }
  const ranked = alive
    .map((p) => ({ p, score: scoreOf(state, p.id) }))
    .sort((a, b) => b.score - a.score);
  for (const { p } of ranked.slice(1)) p.alliedWinner = true;
  log(state, 'Все державы в союзе — общая победа!', { public: true });
  finish(state, ranked[0]!.p.id);
  return true;
}

const DIPLOMACY_ACTIONS = ['propose', 'acceptProposal', 'declineProposal', 'breakTreaty'] as const;

function isDiplomacyAction(action: GameAction): action is Extract<GameAction, { type: (typeof DIPLOMACY_ACTIONS)[number] }> {
  return (DIPLOMACY_ACTIONS as readonly string[]).includes(action.type);
}

function applyDiplomacy(
  state: GameState,
  playerId: string,
  action: Extract<GameAction, { type: (typeof DIPLOMACY_ACTIONS)[number] }>,
): ActionResult {
  if (!state.settings.diplomacy || state.settings.hotseat) {
    return { ok: false, error: 'Дипломатия выключена в этой партии' };
  }
  const me = playerById(state, playerId);
  if (!me || !me.alive) return { ok: false, error: 'Вы вне игры' };

  switch (action.type) {
    case 'propose': {
      const target = playerById(state, action.to);
      if (!target || !target.alive || target.id === playerId) return { ok: false, error: 'Нет такой державы' };
      const rel = relationOf(state, playerId, target.id);
      if (rel?.breakAt != null) return { ok: false, error: 'Договор уже разрывается' };
      if (state.proposals.some((p) => pairKey(p.from, p.to) === pairKey(playerId, target.id))) {
        return { ok: false, error: 'Предложение этой державе уже есть — ответьте на него' };
      }
      if (action.kind === 'truce') {
        if (rel) return { ok: false, error: 'С этой державой уже есть договор' };
        if (!(TRUCE_ROUNDS as readonly number[]).includes(action.rounds ?? 0)) {
          return { ok: false, error: 'Перемирие заключают на 3, 5 или 10 раундов' };
        }
      } else if (action.kind === 'alliance') {
        if (rel?.kind === 'alliance') return { ok: false, error: 'Вы уже союзники' };
      } else {
        return { ok: false, error: 'Неизвестный договор' };
      }
      state.proposals.push({
        id: `${playerId}>${target.id}`,
        from: playerId,
        to: target.id,
        kind: action.kind,
        ...(action.kind === 'truce' ? { rounds: action.rounds } : {}),
        round: state.round,
      });
      log(
        state,
        `${me.name} предлагает ${target.name}: ${TREATY_NAME[action.kind]}${action.kind === 'truce' ? ` на ${action.rounds} р.` : ''}.`,
        { public: true },
      );
      return { ok: true, events: ['proposal'] };
    }

    case 'acceptProposal':
    case 'declineProposal': {
      const idx = state.proposals.findIndex((p) => p.id === action.id && p.to === playerId);
      if (idx < 0) return { ok: false, error: 'Предложение не найдено или устарело' };
      const proposal = state.proposals[idx]!;
      state.proposals.splice(idx, 1);
      const from = playerById(state, proposal.from);
      if (action.type === 'declineProposal') {
        log(state, `${me.name} отклоняет предложение ${from?.name ?? '—'}.`, { public: true });
        return { ok: true, events: [] };
      }
      if (!from?.alive) return { ok: false, error: 'Предложившей державы уже нет' };
      state.relations[pairKey(proposal.from, proposal.to)] =
        proposal.kind === 'truce'
          ? { kind: 'truce', until: state.round + (proposal.rounds ?? 3) }
          : { kind: 'alliance' };
      log(
        state,
        `${from.name} и ${me.name}: ${TREATY_NAME[proposal.kind]}${proposal.kind === 'truce' ? ` на ${proposal.rounds} р.` : ''}.`,
        { public: true },
      );
      checkAlliedVictory(state);
      return { ok: true, events: ['treaty'] };
    }

    case 'breakTreaty': {
      const other = playerById(state, action.with);
      const rel = other ? relationOf(state, playerId, action.with) : undefined;
      if (!other || !rel) return { ok: false, error: 'С этой державой нет договора' };
      if (rel.breakAt != null) return { ok: false, error: 'Разрыв уже объявлен' };
      rel.breakAt = state.round + 1;
      rel.breakBy = playerId;
      log(
        state,
        `${me.name} разрывает ${TREATY_NAME[rel.kind]} с ${other.name} — война с раунда ${rel.breakAt}.`,
        { public: true },
      );
      return { ok: true, events: ['break'] };
    }
  }
}

export function defenseMultiplier(
  state: GameState,
  tile: Tile,
  defender: Player | undefined,
  vsMissiles = false,
): number {
  const terrain = vsMissiles ? TERRAIN[tile.terrain].missileCover : TERRAIN[tile.terrain].defenseBonus;
  const building = tile.building ? BUILDINGS[tile.building].defenseBonus : 0;
  const capital = tile.capitalOf ? 0.25 : 0;
  const tech = defender ? 0.12 * defender.tech.defense : 0;
  return (1 + terrain + building + capital) * (1 + tech);
}

export function attackMultiplier(attacker: Player): number {
  let mul = 1 + 0.12 * attacker.tech.attack;
  for (const effect of attacker.effects ?? []) mul *= effect.attackMul ?? 1;
  return mul;
}

function commanderBonus(id: CommanderId | null, stat: 'attack' | 'defense'): number {
  if (!id) return 1;
  return 1 + COMMANDERS[id][stat];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Свои стеки вплотную к цели — могут бить вместе с атакующим. */
export function allyStacksCovering(state: GameState, playerId: string, target: Coord, exclude: Coord): Tile[] {
  return neighbors(state, target).filter(
    (tile) =>
      tile.ownerId === playerId &&
      armyCount(tile.army) > 0 &&
      tile.routedTurns === 0 &&
      tile.movesLeft > 0 &&
      !(tile.x === exclude.x && tile.y === exclude.y),
  );
}

/** Выбранные игроком помощники: только из допустимых соседних стеков. */
export function pickSupportTiles(
  state: GameState,
  playerId: string,
  target: Coord,
  exclude: Coord,
  requested: Coord[] | undefined,
): { ok: true; tiles: Tile[] } | { ok: false; error: string } {
  const allowed = allyStacksCovering(state, playerId, target, exclude);
  if (!requested || requested.length === 0) return { ok: true, tiles: [] };
  const picked: Tile[] = [];
  const seen = new Set<string>();
  for (const c of requested) {
    const key = `${c.x},${c.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tile = allowed.find((t) => t.x === c.x && t.y === c.y);
    if (!tile) return { ok: false, error: 'Этот отряд не может помочь в атаке' };
    picked.push(tile);
  }
  return { ok: true, tiles: picked };
}

function splitByRatio(parts: Army[], survivors: number): Army[] {
  const totals = parts.map(armyCount);
  const group = totals.reduce((sum, n) => sum + n, 0) || 1;
  const shares = totals.map((n) => Math.floor((survivors * n) / group));
  let leftover = survivors - shares.reduce((sum, n) => sum + n, 0);
  shares[0] = (shares[0] ?? 0) + leftover;
  return parts.map((army, i) => scaleArmy(army, Math.max(0, shares[i] ?? 0)));
}

interface BattleOutcome {
  attackerWon: boolean;
  attackerSurvivors: Army;
  defenderSurvivors: Army;
  attackerRouted: boolean;
  defenderRouted: boolean;
  attackerRoutTurns: number;
  defenderRoutTurns: number;
}

function maybeRout(
  state: GameState,
  loserPower: number,
  winnerPower: number,
  commander: CommanderId | null,
): boolean {
  const ratio = loserPower / Math.max(winnerPower, 0.001);
  let chance = 0.18 + (1 - Math.min(1, ratio)) * 0.42;
  if (commander) chance *= 1 - COMMANDERS[commander].routResist;
  return nextRandom(state) < clamp(chance, 0.08, 0.72);
}

/** 1 ход бегства при лёгких потерях, 2 — если выбито ≥40% отряда. */
function routTurnsFromLoss(before: number, after: number): number {
  if (before <= 0) return 1;
  const frac = (before - Math.max(0, after)) / before;
  return frac >= 0.4 ? 2 : 1;
}

function resolveBattle(
  state: GameState,
  attacker: Player,
  defender: Player | undefined,
  attacking: Army,
  tile: Tile,
  atkCommander: CommanderId | null,
  charging = false,
  support: Army = {},
): BattleOutcome {
  const eraId = era(state);
  const square = Boolean(tile.square);
  const combined = mergeArmies(attacking, support);
  const jitter = () => 0.85 + nextRandom(state) * 0.3;
  const vsDef = dominantClass(tile.army);
  const vsAtk = dominantClass(combined);
  const chargingEff = charging && !square;
  const strike =
    armyPower(attacking, 'attack', vsDef, tile.terrain, { era: eraId, square }) * (chargingEff ? CHARGE_ATTACK : 1) +
    armyPower(support, 'attack', vsDef, tile.terrain, { era: eraId, square });
  const attackPower =
    strike * attackMultiplier(attacker) * commanderBonus(atkCommander, 'attack') * jitter();
  const defensePower =
    armyPower(tile.army, 'defense', vsAtk, tile.terrain, { era: eraId, square }) *
    defenseMultiplier(state, tile, defender) *
    commanderBonus(tile.commander, 'defense') *
    (tile.routedTurns > 0 ? 0.65 : 1) *
    jitter();

  const atkCount = armyCount(combined);
  const defCount = armyCount(tile.army);
  const attackerWon = attackPower > defensePower;
  const winP = attackerWon ? attackPower : defensePower;
  const loseP = attackerWon ? defensePower : attackPower;
  const loseRatio = loseP / Math.max(winP, 0.001);
  const overwhelming = winP / Math.max(loseP, 0.001) >= 4;

  const loseCount = attackerWon ? defCount : atkCount;
  const winCount = attackerWon ? atkCount : defCount;
  let loserLoss = Math.round(loseCount * clamp(0.32 + (1 - loseRatio) * 0.5, 0.2, overwhelming ? 1 : 0.72));
  let winnerLoss = Math.round(winCount * clamp(loseRatio * 0.48, 0, 0.45));
  if (square) {
    loserLoss = Math.round(loserLoss * SQUARE_CASUALTY);
    winnerLoss = Math.round(winnerLoss * SQUARE_CASUALTY);
  }
  if (!overwhelming && loseCount > 1) loserLoss = Math.min(loserLoss, loseCount - 1);
  loserLoss = clamp(loserLoss, 0, loseCount);
  winnerLoss = clamp(winnerLoss, 0, Math.max(0, winCount - (attackerWon ? 1 : 0)));

  const atkLeft = attackerWon ? Math.max(1, atkCount - winnerLoss) : atkCount - loserLoss;
  const defLeft = attackerWon ? defCount - loserLoss : Math.max(defCount > 1 ? 1 : 0, defCount - winnerLoss);

  const attackerSurvivors = scaleArmy(combined, Math.max(0, atkLeft));
  const defenderSurvivors = scaleArmy(tile.army, Math.max(0, defLeft));
  const attackerRouted =
    !attackerWon && armyCount(attackerSurvivors) > 0 && maybeRout(state, attackPower, defensePower, atkCommander);
  const defenderRouted =
    attackerWon && armyCount(defenderSurvivors) > 0 && maybeRout(state, defensePower, attackPower, tile.commander);
  return {
    attackerWon,
    attackerSurvivors,
    defenderSurvivors,
    attackerRouted,
    defenderRouted,
    attackerRoutTurns: attackerRouted ? routTurnsFromLoss(atkCount, armyCount(attackerSurvivors)) : 0,
    defenderRoutTurns: defenderRouted ? routTurnsFromLoss(defCount, armyCount(defenderSurvivors)) : 0,
  };
}

/** Доп. потери при бегстве, если с тыла тоже враг. */
const ROUTE_REAR_LOSS = 0.35;

function fleeMovePoints(state: GameState, army: Army, commander: CommanderId | null): number {
  return Math.max(1, armySpeed(army, era(state)) + (commander ? COMMANDERS[commander].speedBonus : 0));
}

/** Соседи дальше от угрозы, чем сама клетка — «тыл» при бегстве. */
function enemyBehind(state: GameState, origin: Coord, ownerId: string, threat: Coord): boolean {
  const front = hexDistance(origin, threat);
  return neighbors(state, origin).some(
    (n) =>
      hexDistance(n, threat) > front &&
      n.ownerId != null &&
      n.ownerId !== ownerId &&
      armyCount(n.army) > 0,
  );
}

function canLandFlee(tile: Tile, ownerId: string, origin: Coord, threat: Coord): boolean {
  if (tile.x === origin.x && tile.y === origin.y) return false;
  if (tile.x === threat.x && tile.y === threat.y) return false;
  if (!TERRAIN[tile.terrain].passable) return false;
  if (armyCount(tile.army) > 0 && tile.ownerId !== ownerId) return false;
  if (armyCount(tile.army) === 0 && tile.ownerId != null && tile.ownerId !== ownerId) return false;
  return true;
}

/** Клетка бегства в пределах maxSteps: как можно дальше от угрозы. */
function pickFleeDestination(
  state: GameState,
  origin: Coord,
  ownerId: string,
  threat: Coord,
  maxSteps: number,
): { tile: Tile; steps: number } | null {
  if (maxSteps < 1) return null;
  const originDist = hexDistance(origin, threat);
  const seen = new Set<string>([`${origin.x},${origin.y}`]);
  const queue: Array<{ x: number; y: number; d: number }> = [{ x: origin.x, y: origin.y, d: 0 }];
  let best: { tile: Tile; steps: number; score: number } | null = null;

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.d >= maxSteps) continue;
    for (const n of neighbors(state, cur)) {
      const key = `${n.x},${n.y}`;
      if (seen.has(key)) continue;
      if (!TERRAIN[n.terrain].passable) continue;
      if (n.ownerId != null && n.ownerId !== ownerId && armyCount(n.army) > 0) continue;
      if (n.ownerId != null && n.ownerId !== ownerId && armyCount(n.army) === 0) continue;
      seen.add(key);
      const steps = cur.d + 1;
      // Варгейм: бегущий отряд не вливается в чужой отряд — только на пустую клетку.
      const stackFree = !isWargame(state) || armyCount(n.army) === 0;
      if (stackFree && canLandFlee(n, ownerId, origin, threat)) {
        const dist = hexDistance(n, threat);
        if (dist >= originDist) {
          const score =
            dist * 1000 +
            steps * 10 +
            (n.ownerId === ownerId ? 5 : 0) +
            (armyCount(n.army) === 0 ? 2 : 0);
          if (!best || score > best.score) best = { tile: n, steps, score };
        }
      }
      queue.push({ x: n.x, y: n.y, d: steps });
    }
  }
  return best ? { tile: best.tile, steps: best.steps } : null;
}

interface FleeResult {
  ok: boolean;
  lostExtra: number;
  steps: number;
  left: number;
}

/**
 * Отступление / бегство от угрозы.
 * При routedTurns > 0 — на полный ход стека; если с тыла враг — доп. потери.
 */
function displaceArmy(
  state: GameState,
  army: Army,
  origin: Tile,
  ownerId: string,
  threat: Coord,
  commander: CommanderId | null,
  routedTurns: number,
  squad: Squad | null = null,
): FleeResult {
  const empty: FleeResult = { ok: false, lostExtra: 0, steps: 0, left: 0 };
  if (armyCount(army) === 0) return empty;

  let fleeing = army;
  let lostExtra = 0;
  if (routedTurns > 0 && enemyBehind(state, origin, ownerId, threat)) {
    const n = armyCount(fleeing);
    lostExtra = Math.min(n, Math.max(1, Math.round(n * ROUTE_REAR_LOSS)));
    fleeing = scaleArmy(fleeing, n - lostExtra);
    if (armyCount(fleeing) === 0) return { ok: false, lostExtra, steps: 0, left: 0 };
  }

  const maxSteps = routedTurns > 0 ? fleeMovePoints(state, fleeing, commander) : 1;
  const dest = pickFleeDestination(state, origin, ownerId, threat, maxSteps);
  if (!dest) return { ok: false, lostExtra, steps: 0, left: armyCount(fleeing) };

  dest.tile.ownerId = ownerId;
  writeWings(dest.tile, [...ensureWings(dest.tile), { army: fleeing, movesLeft: 0, shotsLeft: 0 }]);
  if (commander && !dest.tile.commander) dest.tile.commander = commander;
  if (squad && !dest.tile.squad) dest.tile.squad = squad;
  dest.tile.routedTurns = Math.max(dest.tile.routedTurns, routedTurns);
  return { ok: true, lostExtra, steps: dest.steps, left: armyCount(fleeing) };
}

function fleeLogSuffix(result: FleeResult, routed: boolean): string {
  const bits: string[] = [];
  if (result.lostExtra > 0) bits.push(`−${result.lostExtra} отр. с тыла`);
  if (result.ok && routed && result.steps > 0) bits.push(`отход на ${result.steps} гекс.`);
  return bits.length > 0 ? ` (${bits.join(', ')})` : '';
}

/** Оценка боя без случайного разброса — для панели хода. */
export function battleForecastRatio(
  state: GameState,
  attacker: Player,
  attacking: Army,
  tile: Tile,
  defender: Player | undefined,
  charging = false,
  support: Army = {},
  atkCommander: CommanderId | null = null,
): number {
  const eraId = era(state);
  const square = Boolean(tile.square);
  const combined = mergeArmies(attacking, support);
  const vsDef = dominantClass(tile.army);
  const chargingEff = charging && !square;
  const strike =
    armyPower(attacking, 'attack', vsDef, tile.terrain, { era: eraId, square }) * (chargingEff ? CHARGE_ATTACK : 1) +
    armyPower(support, 'attack', vsDef, tile.terrain, { era: eraId, square });
  // Те же множители, что в resolveBattle, только без случайного разброса.
  const attackPower = strike * attackMultiplier(attacker) * commanderBonus(atkCommander, 'attack');
  const defensePower =
    armyPower(tile.army, 'defense', dominantClass(combined), tile.terrain, { era: eraId, square }) *
    defenseMultiplier(state, tile, defender) *
    commanderBonus(tile.commander, 'defense') *
    (tile.routedTurns > 0 ? 0.65 : 1);
  return attackPower / Math.max(defensePower, 0.001);
}

function applySquareReply(state: GameState, userId: string, form: boolean): ActionResult {
  const pending = state.pendingSquare;
  if (!pending) return { ok: false, error: 'Сейчас не выбирают каре' };
  if (!canAnswerSquare(state, userId)) return { ok: false, error: 'Каре выбирает оборона' };
  const to = tileAt(state, pending.to.x, pending.to.y);
  const defender = pending.defenderId ? playerById(state, pending.defenderId) : undefined;
  const squareLog = { actors: [pending.attackerId, pending.defenderId], focus: pending.to };
  if (form) {
    if (!to || !canFormSquare(to)) {
      return { ok: false, error: 'Этот отряд не может встать в каре' };
    }
    to.square = true;
    log(state, `${defender?.name ?? 'Оборона'} ставит пехоту в каре.`, squareLog);
  } else {
    log(state, `${defender?.name ?? 'Оборона'} встречает конницу в линии.`, squareLog);
  }
  state.pendingSquare = null;
  resolvingSquareOffer = true;
  let result: ActionResult;
  try {
    result = applyAction(state, pending.attackerId, {
      type: 'move',
      from: pending.from,
      to: pending.to,
      count: pending.count,
      unit: pending.unit,
      supportFrom: pending.supportFrom,
    });
  } finally {
    resolvingSquareOffer = false;
  }
  // Ответ обороны уже изменил состояние (каре снято с ожидания) — его нужно разослать,
  // даже если атака не состоялась, иначе атакующий застрянет в окне «оборона решает».
  if (!result.ok) {
    log(state, `Атака отменена: ${result.error}.`, squareLog);
    return { ok: true, events: [] };
  }
  return result;
}

/** Вложенность applyAction: ответ на каре повторяет ход изнутри — итоги варгейма считаем один раз. */
let actionDepth = 0;

export function applyAction(state: GameState, playerId: string, action: GameAction): ActionResult {
  if (!isWargame(state) || state.phase !== 'playing') return applyActionCore(state, playerId, action);
  const outer = actionDepth === 0;
  if (outer) ensureSquads(state);
  const census = outer ? squadCensus(state) : null;
  const sides = outer ? battleSides(state, playerId, action) : null;
  actionDepth += 1;
  let result: ActionResult;
  try {
    result = applyActionCore(state, playerId, action);
  } finally {
    actionDepth -= 1;
  }
  if (outer && census && result.ok) settleWargame(state, census, sides, action);
  return result;
}

/** У каждой армии варгейма есть запись отряда (страховка для старых и странных состояний). */
function ensureSquads(state: GameState): void {
  for (const tile of state.tiles) {
    if (armyCount(tile.army) > 0 && !tile.squad) tile.squad = { size: armyCount(tile.army), rest: 0 };
  }
}

interface SquadCensus {
  where: Map<Squad, { key: string; count: number }>;
  perPlayer: Map<string, number>;
}

function squadCensus(state: GameState): SquadCensus {
  const where = new Map<Squad, { key: string; count: number }>();
  const perPlayer = new Map<string, number>();
  for (const tile of state.tiles) {
    if (!tile.ownerId || armyCount(tile.army) === 0) continue;
    if (tile.squad) where.set(tile.squad, { key: coordKey(tile), count: armyCount(tile.army) });
    perPlayer.set(tile.ownerId, (perPlayer.get(tile.ownerId) ?? 0) + 1);
  }
  return { where, perPlayer };
}

/** Кто с кем дерётся в этом действии — кому зачесть уничтоженные отряды. */
function battleSides(state: GameState, playerId: string, action: GameAction): { actor: string; target: string | null } | null {
  if (action.type === 'move' || action.type === 'shoot') {
    return { actor: playerId, target: tileAt(state, action.to.x, action.to.y)?.ownerId ?? null };
  }
  if (action.type === 'squareReply' && state.pendingSquare) {
    return { actor: state.pendingSquare.attackerId, target: state.pendingSquare.defenderId };
  }
  return null;
}

/** Клетки, которых коснулось действие: их отряды в этот ход не отдыхают. */
function touchedCoords(action: GameAction): Coord[] {
  switch (action.type) {
    case 'move':
      return [action.from, action.to, ...(action.supportFrom ?? [])];
    case 'shoot':
      return [action.from, action.to];
    case 'build':
    case 'formSquare':
    case 'breakSquare':
      return [action.at];
    default:
      return [];
  }
}

/**
 * Варгейм после действия: пустые клетки ничьи, стройка без отряда сорвана, отряды, что
 * двигались или дрались, теряют покой; погибшие отряды засчитываются, армии без отрядов
 * выбывают; проверка победы по счёту и по уничтожению.
 */
function settleWargame(
  state: GameState,
  census: SquadCensus,
  sides: { actor: string; target: string | null } | null,
  action: GameAction,
): void {
  for (const tile of state.tiles) {
    if (armyCount(tile.army) > 0) {
      tile.squad ??= { size: armyCount(tile.army), rest: 0 };
      const prev = census.where.get(tile.squad);
      // Сдвинулся или потерял юниты — значит, был в деле (пополнение после отдыха не в счёт).
      if (!prev || prev.key !== coordKey(tile) || armyCount(tile.army) < prev.count) tile.squad.active = true;
      continue;
    }
    if (tile.construction && tile.ownerId) {
      log(state, `Стройка (${buildingsOf(state)[tile.construction.building].name}) сорвана: отряд ушёл.`, {
        actors: [tile.ownerId],
        at: [tile],
      });
    }
    tile.construction = null;
    tile.ownerId = null;
    clearMarch(tile);
  }
  for (const c of touchedCoords(action)) {
    const tile = tileAt(state, c.x, c.y);
    if (tile?.squad && armyCount(tile.army) > 0) tile.squad.active = true;
  }

  const goal = killGoalOf(state.settings);
  for (const player of state.players) {
    const had = census.perPlayer.get(player.id) ?? 0;
    const now = squadsOf(state, player.id).length;
    const lost = had - now;
    if (lost <= 0) continue;
    player.stats.squadsLost += lost;
    const killerId = sides ? (player.id === sides.actor ? sides.target : sides.actor) : null;
    const killer = killerId ? playerById(state, killerId) : undefined;
    if (killer) {
      killer.stats.squadsKilled += lost;
      const tally = goal > 0 ? ` (${killer.stats.squadsKilled}/${goal})` : '';
      log(state, `${killer.name} уничтожает ${lost === 1 ? 'отряд' : `${lost} отр.`} ${player.name}${tally}.`, {
        public: true,
      });
    }
    if (player.alive && now === 0) {
      player.alive = false;
      player.deadRound = state.round;
      log(state, `Армия ${player.name} разбита.`, { public: true });
    }
  }

  if (state.phase !== 'playing') return;
  if (goal > 0) {
    const champion = state.players
      .filter((p) => p.alive && p.stats.squadsKilled >= goal)
      .sort((a, b) => b.stats.squadsKilled - a.stats.squadsKilled)[0];
    if (champion) {
      log(state, `${champion.name} уничтожил ${champion.stats.squadsKilled} отр. — цель достигнута.`, { public: true });
      finish(state, champion.id);
      return;
    }
  }
  const alive = state.players.filter((p) => p.alive);
  if (alive.length <= 1) {
    finish(state, alive[0]?.id ?? null);
    return;
  }
  if (!currentPlayer(state)?.alive) nextTurn(state);
}

function applyActionCore(state: GameState, playerId: string, action: GameAction): ActionResult {
  if (state.phase !== 'playing') return { ok: false, error: 'Игра не идёт' };
  if (action.type === 'squareReply') {
    return applySquareReply(state, playerId, action.form);
  }
  if (action.type === 'surrender') {
    return applySurrender(state, playerId);
  }
  // Договоры заключают и разрывают в любой момент, не тратя действий.
  if (isDiplomacyAction(action)) return applyDiplomacy(state, playerId, action);
  const player = currentPlayer(state);
  if (!player || player.id !== playerId) return { ok: false, error: 'Сейчас не ваш ход' };
  if (action.type === 'eventChoice') return resolveEventChoice(state, player, action.choice === 1 ? 1 : 0);
  if (state.pendingSquare) return { ok: false, error: 'Сначала оборона решает, вставать ли в каре' };

  switch (action.type) {
    case 'endTurn': {
      nextTurn(state);
      return { ok: true, events: [] };
    }

    case 'research': {
      if (isWargame(state)) return { ok: false, error: 'В варгейме нет технологий' };
      if (player.actionsLeft < 1) return { ok: false, error: 'Действия на ход закончились' };
      const techs = techsFor(era(state));
      if (!Object.hasOwn(techs, action.tech)) return { ok: false, error: 'Неизвестная технология' };
      const level = player.tech[action.tech];
      const info = techs[action.tech];
      if (level >= info.maxLevel) return { ok: false, error: 'Максимальный уровень' };
      const cost = techCostFor(player, level);
      if (!canAfford(player.resources, cost)) return { ok: false, error: 'Не хватает ресурсов' };
      pay(player.resources, cost);
      player.tech[action.tech] = level + 1;
      player.actionsLeft -= 1;
      // Скидка «Учёного из-за моря» действует на одну технологию.
      player.effects = player.effects.filter((e) => e.researchDiscount == null);
      log(state, `${player.name} изучает ${info.name} (ур. ${level + 1})`, { actors: [player.id] });
      return { ok: true, events: [] };
    }

    case 'build': {
      if (player.actionsLeft < 1) return { ok: false, error: 'Действия на ход закончились' };
      const tile = tileAt(state, action.at.x, action.at.y);
      if (!tile) return { ok: false, error: 'Клетки не существует' };
      if (isWargame(state)) return placeWarFort(state, player, tile, action.building);
      if (tile.ownerId !== playerId) return { ok: false, error: 'Клетка не ваша' };
      if (tile.building) return { ok: false, error: 'Здесь уже есть постройка' };
      if (tile.construction) return { ok: false, error: 'Здесь уже идёт стройка' };
      const buildings = buildingsOf(state);
      if (!Object.hasOwn(buildings, action.building)) return { ok: false, error: 'Неизвестная постройка' };
      const info = buildings[action.building];
      if (!canAfford(player.resources, info.cost)) return { ok: false, error: 'Не хватает ресурсов' };
      pay(player.resources, info.cost);
      tile.construction = { building: action.building, turnsLeft: info.buildTurns };
      player.actionsLeft -= 1;
      log(
        state,
        `${player.name} закладывает ${info.name} — ${info.buildTurns === 1 ? '1 ход' : `${info.buildTurns} хода`}.`,
        { actors: [player.id], at: [tile] },
      );
      return { ok: true, events: [] };
    }

    case 'recruit': {
      if (isWargame(state)) return { ok: false, error: 'В варгейме армию покупают до боя' };
      if (player.actionsLeft < 1) return { ok: false, error: 'Действия на ход закончились' };
      const tile = tileAt(state, action.at.x, action.at.y);
      if (!tile) return { ok: false, error: 'Клетки не существует' };
      if (tile.ownerId !== playerId) return { ok: false, error: 'Клетка не ваша' };
      const canRecruitHere =
        tile.capitalOf === playerId || (tile.building ? BUILDINGS[tile.building].allowsRecruit : false);
      if (!canRecruitHere) return { ok: false, error: 'Нанимать можно в столице или казармах' };
      const count = Math.floor(action.count);
      if (count < 1) return { ok: false, error: 'Некорректное число отрядов' };
      const units = unitsOf(state);
      const unit: UnitId = action.unit && Object.hasOwn(units, action.unit) ? action.unit : DEFAULT_UNIT;
      const cost = multiplyCost(units[unit].cost, count);
      if (!canAfford(player.resources, cost)) return { ok: false, error: 'Не хватает ресурсов' };
      pay(player.resources, cost);
      const bonus = speedBonus(tile);
      writeWings(tile, [
        ...ensureWings(tile),
        { army: { [unit]: count }, movesLeft: units[unit].speed + bonus, shotsLeft: 1 },
      ]);
      player.actionsLeft -= 1;
      player.stats.unitsRecruited += count;
      log(state, `${player.name} нанимает ${count} × ${units[unit].name}`, { actors: [player.id], at: [tile] });
      return { ok: true, events: [] };
    }

    case 'appoint': {
      if (isWargame(state)) return { ok: false, error: 'В варгейме командиров покупают до боя' };
      if (player.actionsLeft < 1) return { ok: false, error: 'Действия на ход закончились' };
      const tile = tileAt(state, action.at.x, action.at.y);
      if (!tile) return { ok: false, error: 'Клетки не существует' };
      if (tile.ownerId !== playerId) return { ok: false, error: 'Клетка не ваша' };
      const canHere =
        tile.capitalOf === playerId || (tile.building ? BUILDINGS[tile.building].allowsRecruit : false);
      if (!canHere) return { ok: false, error: 'Командира назначают в столице или казармах' };
      if (armyCount(tile.army) < 1) return { ok: false, error: 'Нужны войска на клетке' };
      if (tile.routedTurns > 0) return { ok: false, error: 'Отступающим отрядом нельзя управлять' };
      if (tile.commander) return { ok: false, error: 'У этого стека уже есть командир' };
      const commanders = commandersOf(state);
      if (!Object.hasOwn(commanders, action.commander)) return { ok: false, error: 'Неизвестный командир' };
      const info = commanders[action.commander];
      if (!canAfford(player.resources, info.cost)) return { ok: false, error: 'Не хватает ресурсов' };
      pay(player.resources, info.cost);
      giveCommander(state, tile, action.commander);
      player.actionsLeft -= 1;
      log(state, `${player.name} назначает командира: ${info.name}`, { actors: [player.id], at: [tile] });
      return { ok: true, events: [] };
    }

    case 'move': {
      const from = tileAt(state, action.from.x, action.from.y);
      const to = tileAt(state, action.to.x, action.to.y);
      if (!from || !to) return { ok: false, error: 'Клетки не существует' };
      if (!TERRAIN[to.terrain].passable) return { ok: false, error: 'Через горы и море не пройти' };
      if (from.ownerId !== playerId) return { ok: false, error: 'Это не ваша клетка' };
      if (to.ownerId && to.ownerId !== playerId && !atWar(state, playerId, to.ownerId)) {
        return { ok: false, error: 'Договор запрещает входить на земли этой державы' };
      }
      if (from.routedTurns > 0) {
        return { ok: false, error: 'Отступающим отрядом нельзя управлять' };
      }
      if (squarePinned(state, from)) {
        return { ok: false, error: 'Каре не разойти, пока рядом вражеская конница' };
      }
      if (from.movesLeft < 1) return { ok: false, error: 'Эти войска уже исчерпали запас хода' };
      const dist = hexDistance(from, to);
      const enemyFight = to.ownerId !== playerId && armyCount(to.army) > 0;
      // Варгейм: отряд ходит целиком и не встаёт на клетку к своему.
      const war = isWargame(state);
      if (war && !enemyFight && armyCount(to.army) > 0) {
        return { ok: false, error: 'Два отряда на одну клетку не встают' };
      }
      const count = war ? armyCount(from.army) : Math.floor(action.count);
      const only = !war && action.unit && Object.hasOwn(UNITS, action.unit) ? action.unit : undefined;
      const fromWings = ensureWings(from);
      const wantCharge =
        dist === 2 &&
        enemyFight &&
        to.terrain !== 'forest' &&
        chargePathOpen(state, from, to, playerId);
      const minMp = wantCharge ? CHARGE_COST : 1;
      const available = mobileCount(fromWings, only, minMp);
      if (count < 1 || count > available) return { ok: false, error: 'Недостаточно войск' };
      const { taken: takenWings, rest: restWings } = takeFromWings(fromWings, count, only, minMp);
      const taken = wingsToArmy(takenWings);
      if (armyCount(taken) !== count) return { ok: false, error: 'Недостаточно войск' };
      const charging = wantCharge && armyCanCharge(taken);
      const path = charging ? null : walkPath(state, from, to, playerId, 1, true);
      if (!charging) {
        if (!path || path.length !== 2) return { ok: false, error: 'Сюда за этот ход не дойти' };
      }

      const supportPick = enemyFight
        ? pickSupportTiles(state, playerId, to, from, action.supportFrom)
        : { ok: true as const, tiles: [] as Tile[] };
      if (!supportPick.ok) return supportPick;
      const allies = supportPick.tiles;

      // Действие проверяем до предложения каре: иначе оборона ответит, а повтор хода не пройдёт.
      const alreadyMarching = wingsAlreadyMarching(takenWings, speedBonus(from), era(state));
      if (!alreadyMarching && player.actionsLeft < 1) {
        return { ok: false, error: 'Действия на ход закончились' };
      }

      if (!resolvingSquareOffer && enemyFight && shouldOfferSquare(state, taken, to)) {
        state.pendingSquare = {
          attackerId: playerId,
          defenderId: to.ownerId!,
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y },
          count,
          unit: only,
          charging,
          supportFrom: allies.map((tile) => ({ x: tile.x, y: tile.y })),
        };
        log(state, `${player.name}: конница на пехоту — оборона решает, вставать ли в каре.`, {
          actors: [playerId, to.ownerId],
          focus: { x: to.x, y: to.y },
        });
        return { ok: true, events: ['square-offer'] };
      }

      if (!alreadyMarching) player.actionsLeft -= 1;
      const lead = dominantUnit(taken) ?? DEFAULT_UNIT;
      const events: string[] = [];
      const arrivingWings = takenWings.map((wing) =>
        spendWingMove(wing, to.terrain, { charging, fight: enemyFight, era: era(state) }),
      );
      const movingCommander = armyCount(wingsToArmy(restWings)) === 0 ? from.commander : null;
      const movingRouted = armyCount(wingsToArmy(restWings)) === 0 ? from.routedTurns : 0;
      const movingSquad = armyCount(wingsToArmy(restWings)) === 0 ? from.squad ?? null : null;
      if (movingCommander) from.commander = null;
      if (movingSquad) from.squad = null;

      const fxBase = {
        kind: charging ? ('charge' as const) : ('move' as const),
        from: { x: from.x, y: from.y },
        to: { x: to.x, y: to.y },
        unit: lead,
        count,
      };

      const leaveSource = () => {
        writeWings(from, restWings);
        if (armyCount(from.army) === 0) {
          from.commander = null;
          from.routedTurns = 0;
        }
      };

      const claimPath = () => {
        if (!path || war) return;
        for (const c of path.slice(1, -1)) {
          const step = tileAt(state, c.x, c.y);
          if (!step || step.ownerId === playerId) continue;
          if (armyCount(step.army) > 0) continue;
          step.ownerId = playerId;
          step.construction = null;
          countCaptured(state, playerId);
        }
      };

      // Кто владел клеткой до хода — участник боя и свидетель захвата для журнала.
      const prevOwner = to.ownerId;
      const battleLog = {
        actors: [playerId, prevOwner],
        at: [
          { x: to.x, y: to.y },
          { x: from.x, y: from.y },
        ],
      };

      const occupy = (incoming: typeof arrivingWings, capture: boolean) => {
        const keep = !capture && to.ownerId === playerId ? ensureWings(to) : [];
        if (to.ownerId !== playerId) countCaptured(state, playerId);
        to.ownerId = playerId;
        if (capture) {
          to.construction = null;
          to.routedTurns = 0;
          to.square = false;
          to.squad = null;
        }
        writeWings(to, [...keep, ...incoming]);
        if (movingCommander && !to.commander) to.commander = movingCommander;
        if (movingSquad && armyCount(to.army) > 0) to.squad = movingSquad;
        if (movingRouted > 0) to.routedTurns = Math.max(to.routedTurns, movingRouted);
        if (armyCount(to.army) === 0) {
          to.commander = null;
          to.routedTurns = 0;
          to.square = false;
        } else if (to.square && armyHasCavalry(to.army)) {
          to.square = false;
        }
      };

      if (to.ownerId === playerId) {
        claimPath();
        leaveSource();
        occupy(arrivingWings, false);
        const fx: GameFx = { ...fxBase, battle: 'none' };
        return { ok: true, events, fx };
      }

      if (armyCount(to.army) > 0) {
        const defender = to.ownerId ? playerById(state, to.ownerId) : undefined;
        const support = allies.reduce((army, tile) => mergeArmies(army, tile.army), {} as Army);
        const supportCount = armyCount(support);
        const outcome = resolveBattle(state, player, defender, taken, to, movingCommander, charging, support);
        recordBattle(
          state,
          playerId,
          defender?.id ?? null,
          armyCount(taken) + supportCount,
          armyCount(outcome.attackerSurvivors),
          armyCount(to.army),
          armyCount(outcome.defenderSurvivors),
          outcome.attackerWon,
        );
        const split = splitByRatio([taken, ...allies.map((tile) => tile.army)], armyCount(outcome.attackerSurvivors));
        const moverSurvivors = split[0] ?? {};
        const applyAllyLosses = () => {
          allies.forEach((tile, i) => {
            const left = split[i + 1] ?? {};
            if (armyCount(left) === 0) {
              clearMarch(tile);
              return;
            }
            // Участники совместного удара больше ничего не делают в этот ход.
            writeWings(tile, [{ army: left, movesLeft: 0, shotsLeft: 0 }]);
          });
        };
        if (outcome.attackerWon) claimPath();
        leaveSource();
        applyAllyLosses();
        if (outcome.attackerWon) {
          const capitalVictim = to.capitalOf;
          const defId = to.ownerId;
          const defCmdr = to.commander;
          const defSquad = to.squad ?? null;
          to.commander = null;
          to.squad = null;
          if (armyCount(outcome.defenderSurvivors) > 0 && defId) {
            const fled = displaceArmy(
              state,
              outcome.defenderSurvivors,
              to,
              defId,
              { x: from.x, y: from.y },
              defCmdr,
              outcome.defenderRoutTurns,
              defSquad,
            );
            if (fled.ok) {
              log(
                state,
                outcome.defenderRouted
                  ? `Бой: оборона обращена в бегство на ${outcome.defenderRoutTurns} х.${fleeLogSuffix(fled, true)}.`
                  : `Бой: остатки обороны отступают${fleeLogSuffix(fled, false)}.`,
                battleLog,
              );
            } else if (fled.lostExtra > 0 && fled.left === 0) {
              log(state, `Бой: оборона зажата с тыла, остатки пали (−${fled.lostExtra} отр.).`, battleLog);
            } else {
              log(state, `Бой: отступать некуда, остатки обороны пали.`, battleLog);
            }
          }
          occupy([{ army: moverSurvivors, movesLeft: 0, shotsLeft: 0 }], true);
          log(
            state,
            `${charging ? chargeWord(state) : 'Бой'}: ${player.name}${supportCount > 0 ? ` бьёт вместе (${allies.length + 1} отр.)` : ' побеждает'}, осталось ${armyCount(outcome.attackerSurvivors)} отр.`,
            battleLog,
          );
          if (capitalVictim && capitalVictim !== playerId) {
            to.capitalOf = null;
            eliminate(state, capitalVictim, playerId);
          }
          events.push(outcome.defenderRouted ? 'battle-rout' : 'battle-won');
          const alive = state.players.filter((p) => p.alive);
          if (alive.length <= 1) finish(state, alive[0]?.id ?? null);
          return { ok: true, events, fx: { ...fxBase, battle: outcome.defenderRouted ? 'rout' : 'won' } };
        }

        writeWings(to, [
          { army: outcome.defenderSurvivors, movesLeft: to.movesLeft, shotsLeft: to.shotsLeft },
        ]);
        if (outcome.attackerRouted && armyCount(moverSurvivors) > 0) {
          const fled = displaceArmy(
            state,
            moverSurvivors,
            from,
            playerId,
            { x: to.x, y: to.y },
            movingCommander,
            outcome.attackerRoutTurns,
            movingSquad,
          );
          if (!fled.ok && fled.left > 0) {
            writeWings(from, [
              ...ensureWings(from),
              { army: scaleArmy(moverSurvivors, fled.left), movesLeft: 0, shotsLeft: 0 },
            ]);
            from.ownerId = playerId;
            if (movingCommander && !from.commander) from.commander = movingCommander;
            if (movingSquad && !from.squad) from.squad = movingSquad;
            from.routedTurns = Math.max(from.routedTurns, outcome.attackerRoutTurns);
          }
          log(
            state,
            fled.ok
              ? `${charging ? chargeWord(state) : 'Бой'}: атака ${player.name}${supportCount > 0 ? ' (несколько отрядов)' : ''} обращена в бегство на ${outcome.attackerRoutTurns} х., уцелело ${fled.left} отр.${fleeLogSuffix(fled, true)}`
              : fled.lostExtra > 0 && fled.left === 0
                ? `${charging ? chargeWord(state) : 'Бой'}: атака ${player.name} зажата с тыла и уничтожена (−${fled.lostExtra} отр.).`
                : `${charging ? chargeWord(state) : 'Бой'}: атака ${player.name}${supportCount > 0 ? ' (несколько отрядов)' : ''} обращена в бегство на ${outcome.attackerRoutTurns} х., уцелело ${fled.left} отр., отходить некуда${fled.lostExtra > 0 ? `, −${fled.lostExtra} с тыла` : ''}.`,
            battleLog,
          );
        } else {
          writeWings(from, [
            ...ensureWings(from),
            { army: moverSurvivors, movesLeft: 0, shotsLeft: 0 },
          ]);
          if (movingCommander && armyCount(moverSurvivors) > 0 && !from.commander) {
            from.commander = movingCommander;
          }
          if (movingSquad && armyCount(moverSurvivors) > 0 && !from.squad) {
            from.ownerId = playerId;
            from.squad = movingSquad;
          }
          log(
            state,
            `${charging ? chargeWord(state) : 'Бой'}: атака ${player.name}${supportCount > 0 ? ' (несколько отрядов)' : ''} отбита, уцелело ${armyCount(outcome.attackerSurvivors)} отр.`,
            battleLog,
          );
        }
        events.push(outcome.attackerRouted ? 'battle-rout' : 'battle-lost');
        return { ok: true, events, fx: { ...fxBase, battle: outcome.attackerRouted ? 'rout' : 'lost' } };
      }

      const capitalVictim = to.capitalOf;
      claimPath();
      leaveSource();
      occupy(arrivingWings, true);
      if (capitalVictim && capitalVictim !== playerId) {
        to.capitalOf = null;
        eliminate(state, capitalVictim, playerId);
      } else {
        log(state, `${player.name} занимает клетку`, battleLog);
      }

      const alive = state.players.filter((p) => p.alive);
      if (alive.length <= 1) finish(state, alive[0]?.id ?? null);
      return { ok: true, events, fx: { ...fxBase, battle: 'none' } };
    }

    case 'shoot': {
      const from = tileAt(state, action.from.x, action.from.y);
      const to = tileAt(state, action.to.x, action.to.y);
      if (!from || !to) return { ok: false, error: 'Клетки не существует' };
      if (from.ownerId !== playerId) return { ok: false, error: 'Это не ваша клетка' };
      if (from.routedTurns > 0) return { ok: false, error: 'Отступающим отрядом нельзя управлять' };
      const dist = hexDistance(from, to);
      const shooters = volleyArmy(from.army, era(state), dist, from.terrain);
      const shots = armyCount(shooters);
      if (shots < 1) return { ok: false, error: 'Некем открыть огонь' };
      if (from.shotsLeft < 1) return { ok: false, error: `Этот отряд уже ${flavorOf(state).volleyLabel === 'Залп' ? 'дал залп' : 'стрелял'} в этот ход` };
      const marched = tileHasMarched(from, era(state), speedBonus(from));
      if (marched && armyHasHeavyArtillery(from.army, era(state))) {
        return { ok: false, error: 'Тяжёлая артиллерия после хода не стреляет' };
      }
      // Стек уже ходил этим приказом — залп после хода ⚡ не берёт.
      const freeShot = tileShotIsFree(from, era(state), speedBonus(from));
      if (!freeShot && player.actionsLeft < 1) return { ok: false, error: 'Действия на ход закончились' };
      const range = armyRange(from.army, era(state), from.terrain);
      if (dist < 1 || dist > range) return { ok: false, error: 'Цель вне дальности' };
      if (to.ownerId === playerId) return { ok: false, error: 'Нельзя стрелять по своим' };
      if (to.ownerId && !atWar(state, playerId, to.ownerId)) {
        return { ok: false, error: 'Договор запрещает огонь по этой державе' };
      }
      if (armyCount(to.army) < 1) return { ok: false, error: 'Некого обстреливать' };
      // Клиент не подсвечивает скрытые туманом цели — сервер тоже не даёт стрелять вслепую.
      if (!canWatchTile(state, playerId, to) || !canSeeArmyOn(state, playerId, to)) {
        return { ok: false, error: 'Цель не видна' };
      }

      const defender = to.ownerId ? playerById(state, to.ownerId) : undefined;
      const jitter = () => 0.85 + nextRandom(state) * 0.3;
      const attackPower =
        armyPower(shooters, 'attack', dominantClass(to.army), to.terrain, {
          volley: true,
          fromTerrain: from.terrain,
          era: era(state),
        }) *
        attackMultiplier(player) *
        commanderBonus(from.commander, 'attack') *
        0.9 *
        (marched ? MOVED_VOLLEY : 1) *
        jitter();
      const defensePower =
        armyPower(to.army, 'defense', 'archer', to.terrain, { era: era(state) }) *
        defenseMultiplier(state, to, defender, true) *
        commanderBonus(to.commander, 'defense') *
        (to.routedTurns > 0 ? 0.65 : 1) *
        jitter();
      const defCount = armyCount(to.army);
      const ratio = attackPower / Math.max(defensePower, 0.001);
      let losses = Math.min(defCount, Math.max(0, Math.round(defCount * Math.min(1, ratio * 0.55))));
      if (ratio < 2.2 && defCount > 1) losses = Math.min(losses, defCount - 1);
      if (!freeShot) player.actionsLeft -= 1;
      const shooterStats = player.stats;
      shooterStats.unitsKilled += losses;
      const targetStats = stats(state, to.ownerId);
      if (targetStats) targetStats.unitsLost += losses;
      const volleyLog = {
        actors: [playerId, to.ownerId],
        at: [
          { x: to.x, y: to.y },
          { x: from.x, y: from.y },
        ],
      };
      writeWings(
        from,
        ensureWings(from).map((wing) => ({
          ...wing,
          shotsLeft: 0,
          movesLeft: armyCanKite(from.army) ? wing.movesLeft : 0,
        })),
      );
      const lead = dominantUnit(shooters) ?? DEFAULT_UNIT;
      const fxBase = {
        kind: 'shoot' as const,
        from: { x: from.x, y: from.y },
        to: { x: to.x, y: to.y },
        unit: lead,
        count: shots,
      };

      if (losses <= 0) {
        log(state, `${flavorOf(state).volleyLabel} ${player.name} не нанёс потерь.`, volleyLog);
        return { ok: true, events: ['volley'], fx: { ...fxBase, battle: 'lost' } };
      }

      if (losses >= defCount) {
        clearMarch(to);
        log(state, `${flavorOf(state).volleyLabel} ${player.name} уничтожает гарнизон.`, volleyLog);
        return { ok: true, events: ['volley-wipe'], fx: { ...fxBase, battle: 'won' } };
      }

      writeWings(to, [
        {
          army: scaleArmy(to.army, defCount - losses),
          movesLeft: to.movesLeft,
          shotsLeft: to.shotsLeft,
        },
      ]);
      const routed = maybeRout(state, defensePower, attackPower, to.commander);
      if (routed) {
        const defId = to.ownerId!;
        const defCmdr = to.commander;
        const defSquad = to.squad ?? null;
        const survivors = { ...to.army };
        const survivorsCount = armyCount(survivors);
        const routTurns = routTurnsFromLoss(defCount, survivorsCount);
        const movesLeft = to.movesLeft;
        const shotsLeft = to.shotsLeft;
        writeWings(to, []);
        to.commander = null;
        to.squad = null;
        to.routedTurns = 0;
        const fled = displaceArmy(state, survivors, to, defId, { x: from.x, y: from.y }, defCmdr, routTurns, defSquad);
        if (!fled.ok && fled.left > 0) {
          writeWings(to, [
            { army: scaleArmy(survivors, fled.left), movesLeft: 0, shotsLeft: 0 },
          ]);
          if (defCmdr) to.commander = defCmdr;
          if (defSquad) to.squad = defSquad;
          to.routedTurns = Math.max(to.routedTurns, routTurns);
        }
        log(
          state,
          fled.ok
            ? `${flavorOf(state).volleyLabel} ${player.name}: −${losses} отр., гарнизон в панике на ${routTurns} х.${fleeLogSuffix(fled, true)}.`
            : fled.lostExtra > 0 && fled.left === 0
              ? `${flavorOf(state).volleyLabel} ${player.name}: −${losses} отр., гарнизон зажат с тыла и уничтожен (−${fled.lostExtra}).`
              : `${flavorOf(state).volleyLabel} ${player.name}: −${losses} отр., гарнизон в панике на ${routTurns} х.${fled.lostExtra > 0 ? `, −${fled.lostExtra} с тыла` : ''}, бежать некуда.`,
          volleyLog,
        );
      } else {
        log(state, `${flavorOf(state).volleyLabel} ${player.name}: −${losses} отр. у обороны.`, volleyLog);
      }
      return { ok: true, events: ['volley'], fx: { ...fxBase, battle: routed ? 'rout' : 'lost' } };
    }

    case 'formSquare': {
      if (era(state) !== 'napoleonic') return { ok: false, error: 'Каре — строй Наполеоники' };
      if (player.actionsLeft < 1) return { ok: false, error: 'Действия на ход закончились' };
      const tile = tileAt(state, action.at.x, action.at.y);
      if (!tile) return { ok: false, error: 'Клетки не существует' };
      if (tile.ownerId !== playerId) return { ok: false, error: 'Клетка не ваша' };
      if (tile.square) return { ok: false, error: 'Отряд уже стоит в каре' };
      if (!canFormSquare(tile)) return { ok: false, error: 'В каре встаёт пехота, не в лесу' };
      tile.square = true;
      player.actionsLeft -= 1;
      log(state, `${player.name} ставит пехоту в каре.`, { actors: [player.id], at: [tile] });
      return { ok: true, events: ['square-form'] };
    }

    case 'breakSquare': {
      const tile = tileAt(state, action.at.x, action.at.y);
      if (!tile) return { ok: false, error: 'Клетки не существует' };
      if (tile.ownerId !== playerId) return { ok: false, error: 'Клетка не ваша' };
      if (!tile.square) return { ok: false, error: 'Этот отряд не в каре' };
      if (squarePinned(state, tile)) {
        return { ok: false, error: 'Каре не разойти, пока рядом вражеская конница' };
      }
      tile.square = false;
      log(state, `${player.name} распускает каре.`, { actors: [player.id], at: [tile] });
      return { ok: true, events: ['square-break'] };
    }

    default:
      return { ok: false, error: 'Неизвестное действие' };
  }
}

/**
 * Есть ли у игрока клетка, которая может бесплатно продолжить уже начатый поход
 * (move не тратит действие для крыла, которое уже маршировало, — см. wingsAlreadyMarching).
 * Пока такая клетка есть, автоконец хода откладываем: иначе поход обрывается зря.
 */
function hasFreeContinuingMarch(state: GameState, playerId: string): boolean {
  for (const tile of state.tiles) {
    if (tile.ownerId !== playerId) continue;
    if (tile.routedTurns > 0) continue;
    if (squarePinned(state, tile)) continue;
    const bonus = speedBonus(tile);
    for (const wing of ensureWings(tile)) {
      if (wingsAlreadyMarching([wing], bonus, era(state))) return true;
    }
  }
  return false;
}

/** Стек уже ходил, ещё не стрелял и видит цель в досягаемости — залп без ⚡. */
function hasFreeShot(state: GameState, playerId: string): boolean {
  const eraId = era(state);
  for (const from of state.tiles) {
    if (from.ownerId !== playerId || from.routedTurns > 0 || from.shotsLeft < 1) continue;
    if (!tileShotIsFree(from, eraId, speedBonus(from))) continue;
    if (armyHasHeavyArtillery(from.army, eraId)) continue;
    const range = armyRange(from.army, eraId, from.terrain);
    if (range < 1) continue;
    for (const to of state.tiles) {
      if (!to.ownerId || to.ownerId === playerId || armyCount(to.army) < 1) continue;
      const dist = hexDistance(from, to);
      if (dist < 1 || dist > range || !atWar(state, playerId, to.ownerId)) continue;
      if (armyCount(volleyArmy(from.army, eraId, dist, from.terrain)) < 1) continue;
      if (canWatchTile(state, playerId, to) && canSeeArmyOn(state, playerId, to)) return true;
    }
  }
  return false;
}

/** Действия закончились — ход завершается автоматически. */
export function autoEndTurnIfExhausted(state: GameState): void {
  if (state.pendingSquare) return;
  const player = currentPlayer(state);
  if (state.phase !== 'playing' || !player || player.actionsLeft > 0) return;
  if (hasFreeContinuingMarch(state, player.id)) return;
  if (hasFreeShot(state, player.id)) return;
  nextTurn(state);
}

export function coordKey(c: Coord): string {
  return `${c.x},${c.y}`;
}
