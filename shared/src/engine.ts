import {
  BUILDINGS,
  defaultGameSettings,
  MAP_SIZES,
  MAX_PLAYERS,
  PLAYER_COLORS,
  START_RESOURCES,
  STARVATION_DESERTION,
  TERRAIN,
  UPKEEP_UNITS_PER_FOOD,
  techCost,
} from './config.js';
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
import { COMMANDERS } from './commanders.js';
import { ERAS, buildingsFor, commandersFor, eraOf, isEraId, techsFor } from './eras.js';
import type {
  ActionResult,
  Army,
  CommanderId,
  Coord,
  GameAction,
  GameFx,
  GameSettings,
  GameState,
  LobbyAction,
  Player,
  Resources,
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

  state.players.push({
    id,
    name,
    color: PLAYER_COLORS[state.players.length % PLAYER_COLORS.length]!,
    resources: { ...START_RESOURCES },
    tech: { attack: 0, defense: 0, economy: 0, logistics: 0 },
    actionsLeft: 0,
    alive: true,
    connected: true,
    seenBuildings: {},
  });
  return { ok: true, events: [`${name} присоединился к игре`] };
}

export function removePlayer(state: GameState, id: string): void {
  if (isHotseatRival(id)) return;
  if (state.phase === 'lobby') {
    if (state.settings.hotseat) {
      const player = playerById(state, id);
      if (player) player.connected = false;
      return;
    }
    state.players = state.players.filter((p) => p.id !== id);
    state.players.forEach((p, i) => {
      p.color = PLAYER_COLORS[i % PLAYER_COLORS.length]!;
    });
    if (state.hostId === id && state.players[0]) state.hostId = state.players[0].id;
    state.adminIds = state.adminIds.filter((adminId) => adminId !== id && state.players.some((p) => p.id === adminId));
    return;
  }
  const player = playerById(state, id);
  if (player) player.connected = false;
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
  if (typeof patch.hotseat === 'boolean') next.hotseat = patch.hotseat;
  if (isEraId(patch.era)) next.era = patch.era;
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
    const actions = clampInt(patch.actionsPerTurn, 3, 8);
    if (actions != null) next.actionsPerTurn = actions;
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

export function computeIncome(state: GameState, playerId: string): Resources {
  const player = playerById(state, playerId);
  if (!player) return { ...EMPTY };
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
      income.gold += 3;
      income.food += 2;
      income.iron += 1;
    }
  }
  const mult = 1 + 0.1 * player.tech.economy;
  return {
    gold: Math.round(income.gold * mult),
    food: Math.round(income.food * mult),
    iron: Math.round(income.iron * mult),
  };
}

export function totalArmy(state: GameState, playerId: string): number {
  return state.tiles.reduce((sum, t) => (t.ownerId === playerId ? sum + armyCount(t.army) : sum), 0);
}

export function upkeepFor(state: GameState, playerId: string): number {
  return Math.ceil(totalArmy(state, playerId) / UPKEEP_UNITS_PER_FOOD);
}

function log(state: GameState, text: string): void {
  state.log.push({ round: state.round, text });
  if (state.log.length > 100) state.log.shift();
}

function beginTurn(state: GameState): void {
  const player = currentPlayer(state);
  if (!player) return;

  for (const tile of state.tiles) {
    if (tile.ownerId !== player.id || !tile.construction) continue;
    tile.construction.turnsLeft -= 1;
    if (tile.construction.turnsLeft > 0) continue;
    tile.building = tile.construction.building;
    const name = buildingsOf(state)[tile.building].name;
    tile.construction = null;
    log(state, `${name} достроена.`);
  }

  const income = computeIncome(state, player.id);
  player.resources.gold += income.gold;
  player.resources.food += income.food;
  player.resources.iron += income.iron;

  const upkeep = upkeepFor(state, player.id);
  if (player.resources.food >= upkeep) {
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
    if (deserted > 0) log(state, `${player.name}: голод, дезертировало ${deserted} отр.`);
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
    log(state, `${player.name}: каре держит строй (−${squaresHeld}⚡).`);
  }
  if (squaresBroke > 0) {
    log(state, `${player.name}: каре рассыпалось.`);
  }
}

function nextTurn(state: GameState): void {
  if (state.phase !== 'playing') return;
  const ending = currentPlayer(state);
  if (ending) {
    for (const tile of state.tiles) {
      if (tile.ownerId === ending.id && tile.routedTurns > 0) tile.routedTurns -= 1;
    }
  }
  const alive = state.players.filter((p) => p.alive);
  if (alive.length <= 1) {
    finish(state, alive[0]?.id ?? null);
    return;
  }

  let guard = 0;
  do {
    state.turnIndex += 1;
    if (state.turnIndex >= state.order.length) {
      state.turnIndex = 0;
      state.round += 1;
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

function finish(state: GameState, winnerId: string | null): void {
  state.phase = 'finished';
  state.winnerId = winnerId;
  const winner = winnerId ? playerById(state, winnerId) : null;
  log(state, winner ? `Победа: ${winner.name}!` : 'Игра окончена.');
}

function finishByScore(state: GameState): void {
  const ranked = state.players
    .filter((p) => p.alive)
    .map((p) => ({ id: p.id, score: scoreOf(state, p.id) }))
    .sort((a, b) => b.score - a.score);
  log(state, 'Отведённое число раундов исчерпано, победа по очкам.');
  finish(state, ranked[0]?.id ?? null);
}

function eliminate(state: GameState, victimId: string, conquerorId: string): void {
  const victim = playerById(state, victimId);
  const conqueror = playerById(state, conquerorId);
  if (!victim) return;
  victim.alive = false;
  for (const tile of state.tiles) {
    if (tile.ownerId !== victimId) continue;
    tile.ownerId = conquerorId;
    tile.army = {};
    tile.construction = null;
    writeWings(tile, []);
    tile.commander = null;
    tile.routedTurns = 0;
    if (tile.capitalOf === victimId) tile.capitalOf = null;
  }
  log(state, `Держава ${victim.name} пала под натиском ${conqueror?.name ?? 'врага'}.`);
}

function nextRandom(state: GameState): number {
  state.seed = (Math.imul(state.seed, 1103515245) + 12345) >>> 0;
  return mulberry32(state.seed)();
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
  return 1 + 0.12 * attacker.tech.attack;
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
      if (canLandFlee(n, ownerId, origin, threat)) {
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
): number {
  const eraId = era(state);
  const square = Boolean(tile.square);
  const combined = mergeArmies(attacking, support);
  const vsDef = dominantClass(tile.army);
  const chargingEff = charging && !square;
  const strike =
    armyPower(attacking, 'attack', vsDef, tile.terrain, { era: eraId, square }) * (chargingEff ? CHARGE_ATTACK : 1) +
    armyPower(support, 'attack', vsDef, tile.terrain, { era: eraId, square });
  const attackPower = strike * attackMultiplier(attacker);
  const defensePower =
    armyPower(tile.army, 'defense', dominantClass(combined), tile.terrain, { era: eraId, square }) *
    defenseMultiplier(state, tile, defender);
  return attackPower / Math.max(defensePower, 0.001);
}

function applySquareReply(state: GameState, userId: string, form: boolean): ActionResult {
  const pending = state.pendingSquare;
  if (!pending) return { ok: false, error: 'Сейчас не выбирают каре' };
  if (!canAnswerSquare(state, userId)) return { ok: false, error: 'Каре выбирает оборона' };
  const to = tileAt(state, pending.to.x, pending.to.y);
  const defender = pending.defenderId ? playerById(state, pending.defenderId) : undefined;
  if (form) {
    if (!to || !canFormSquare(to)) {
      return { ok: false, error: 'Этот отряд не может встать в каре' };
    }
    to.square = true;
    log(state, `${defender?.name ?? 'Оборона'} ставит пехоту в каре.`);
  } else {
    log(state, `${defender?.name ?? 'Оборона'} встречает конницу в линии.`);
  }
  state.pendingSquare = null;
  resolvingSquareOffer = true;
  try {
    return applyAction(state, pending.attackerId, {
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
}

export function applyAction(state: GameState, playerId: string, action: GameAction): ActionResult {
  if (state.phase !== 'playing') return { ok: false, error: 'Игра не идёт' };
  if (action.type === 'squareReply') {
    return applySquareReply(state, playerId, action.form);
  }
  const player = currentPlayer(state);
  if (!player || player.id !== playerId) return { ok: false, error: 'Сейчас не ваш ход' };
  if (state.pendingSquare) return { ok: false, error: 'Сначала оборона решает, вставать ли в каре' };

  switch (action.type) {
    case 'endTurn': {
      nextTurn(state);
      return { ok: true, events: [] };
    }

    case 'research': {
      if (player.actionsLeft < 1) return { ok: false, error: 'Действия на ход закончились' };
      const level = player.tech[action.tech];
      const info = techsFor(era(state))[action.tech];
      if (!info) return { ok: false, error: 'Неизвестная технология' };
      if (level >= info.maxLevel) return { ok: false, error: 'Максимальный уровень' };
      const cost = techCost(level);
      if (!canAfford(player.resources, cost)) return { ok: false, error: 'Не хватает ресурсов' };
      pay(player.resources, cost);
      player.tech[action.tech] = level + 1;
      player.actionsLeft -= 1;
      log(state, `${player.name} изучает ${info.name} (ур. ${level + 1})`);
      return { ok: true, events: [] };
    }

    case 'build': {
      if (player.actionsLeft < 1) return { ok: false, error: 'Действия на ход закончились' };
      const tile = tileAt(state, action.at.x, action.at.y);
      if (!tile) return { ok: false, error: 'Клетки не существует' };
      if (tile.ownerId !== playerId) return { ok: false, error: 'Клетка не ваша' };
      if (tile.building) return { ok: false, error: 'Здесь уже есть постройка' };
      if (tile.construction) return { ok: false, error: 'Здесь уже идёт стройка' };
      const info = buildingsOf(state)[action.building];
      if (!info) return { ok: false, error: 'Неизвестная постройка' };
      if (!canAfford(player.resources, info.cost)) return { ok: false, error: 'Не хватает ресурсов' };
      pay(player.resources, info.cost);
      tile.construction = { building: action.building, turnsLeft: info.buildTurns };
      player.actionsLeft -= 1;
      log(
        state,
        `${player.name} закладывает ${info.name} — ${info.buildTurns === 1 ? '1 ход' : `${info.buildTurns} хода`}.`,
      );
      return { ok: true, events: [] };
    }

    case 'recruit': {
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
      const unit: UnitId = action.unit && units[action.unit] ? action.unit : DEFAULT_UNIT;
      const cost = multiplyCost(units[unit].cost, count);
      if (!canAfford(player.resources, cost)) return { ok: false, error: 'Не хватает ресурсов' };
      pay(player.resources, cost);
      const bonus = speedBonus(tile);
      writeWings(tile, [
        ...ensureWings(tile),
        { army: { [unit]: count }, movesLeft: units[unit].speed + bonus, shotsLeft: 1 },
      ]);
      player.actionsLeft -= 1;
      log(state, `${player.name} нанимает ${count} × ${units[unit].name}`);
      return { ok: true, events: [] };
    }

    case 'appoint': {
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
      const info = commandersOf(state)[action.commander];
      if (!info) return { ok: false, error: 'Неизвестный командир' };
      if (!canAfford(player.resources, info.cost)) return { ok: false, error: 'Не хватает ресурсов' };
      pay(player.resources, info.cost);
      const unmovedWings = ensureWings(tile).map((wing) => {
        const speed = armySpeed(wing.army, era(state));
        if (wing.movesLeft >= speed) {
          return { ...wing, movesLeft: speed + COMMANDERS[action.commander].speedBonus };
        }
        return wing;
      });
      tile.commander = action.commander;
      writeWings(tile, unmovedWings);
      player.actionsLeft -= 1;
      log(state, `${player.name} назначает командира: ${info.name}`);
      return { ok: true, events: [] };
    }

    case 'move': {
      const from = tileAt(state, action.from.x, action.from.y);
      const to = tileAt(state, action.to.x, action.to.y);
      if (!from || !to) return { ok: false, error: 'Клетки не существует' };
      if (!TERRAIN[to.terrain].passable) return { ok: false, error: 'Через горы и море не пройти' };
      if (from.ownerId !== playerId) return { ok: false, error: 'Это не ваша клетка' };
      if (from.routedTurns > 0) {
        return { ok: false, error: 'Отступающим отрядом нельзя управлять' };
      }
      if (squarePinned(state, from)) {
        return { ok: false, error: 'Каре не разойти, пока рядом вражеская конница' };
      }
      if (from.movesLeft < 1) return { ok: false, error: 'Эти войска уже исчерпали запас хода' };
      const dist = hexDistance(from, to);
      const enemyFight = to.ownerId !== playerId && armyCount(to.army) > 0;
      const count = Math.floor(action.count);
      const only = action.unit && UNITS[action.unit] ? action.unit : undefined;
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
        log(state, `${player.name}: конница на пехоту — оборона решает, вставать ли в каре.`);
        return { ok: true, events: ['square-offer'] };
      }

      const alreadyMarching = wingsAlreadyMarching(takenWings, speedBonus(from), era(state));
      if (!alreadyMarching) {
        if (player.actionsLeft < 1) return { ok: false, error: 'Действия на ход закончились' };
        player.actionsLeft -= 1;
      }
      const lead = dominantUnit(taken) ?? DEFAULT_UNIT;
      const events: string[] = [];
      const arrivingWings = takenWings.map((wing) =>
        spendWingMove(wing, to.terrain, { charging, fight: enemyFight, era: era(state) }),
      );
      const movingCommander = armyCount(wingsToArmy(restWings)) === 0 ? from.commander : null;
      const movingRouted = armyCount(wingsToArmy(restWings)) === 0 ? from.routedTurns : 0;
      if (movingCommander) from.commander = null;

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
        if (!path) return;
        for (const c of path.slice(1, -1)) {
          const step = tileAt(state, c.x, c.y);
          if (!step || step.ownerId === playerId) continue;
          if (armyCount(step.army) > 0) continue;
          step.ownerId = playerId;
          step.construction = null;
        }
      };

      const occupy = (incoming: typeof arrivingWings, capture: boolean) => {
        const keep = !capture && to.ownerId === playerId ? ensureWings(to) : [];
        to.ownerId = playerId;
        if (capture) {
          to.construction = null;
          to.routedTurns = 0;
          to.square = false;
        }
        writeWings(to, [...keep, ...incoming]);
        if (movingCommander && !to.commander) to.commander = movingCommander;
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
          to.commander = null;
          if (armyCount(outcome.defenderSurvivors) > 0 && defId) {
            const fled = displaceArmy(
              state,
              outcome.defenderSurvivors,
              to,
              defId,
              { x: from.x, y: from.y },
              defCmdr,
              outcome.defenderRoutTurns,
            );
            if (fled.ok) {
              log(
                state,
                outcome.defenderRouted
                  ? `Бой: оборона обращена в бегство на ${outcome.defenderRoutTurns} х.${fleeLogSuffix(fled, true)}.`
                  : `Бой: остатки обороны отступают${fleeLogSuffix(fled, false)}.`,
              );
            } else if (fled.lostExtra > 0 && fled.left === 0) {
              log(state, `Бой: оборона зажата с тыла, остатки пали (−${fled.lostExtra} отр.).`);
            } else {
              log(state, `Бой: отступать некуда, остатки обороны пали.`);
            }
          }
          occupy([{ army: moverSurvivors, movesLeft: 0, shotsLeft: 0 }], true);
          log(
            state,
            `${charging ? chargeWord(state) : 'Бой'}: ${player.name}${supportCount > 0 ? ` бьёт вместе (${allies.length + 1} отр.)` : ' побеждает'}, осталось ${armyCount(outcome.attackerSurvivors)} отр.`,
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
          );
          if (!fled.ok && fled.left > 0) {
            writeWings(from, [
              ...ensureWings(from),
              { army: scaleArmy(moverSurvivors, fled.left), movesLeft: 0, shotsLeft: 0 },
            ]);
            if (movingCommander && !from.commander) from.commander = movingCommander;
            from.routedTurns = Math.max(from.routedTurns, outcome.attackerRoutTurns);
          }
          log(
            state,
            fled.ok
              ? `${charging ? chargeWord(state) : 'Бой'}: атака ${player.name}${supportCount > 0 ? ' (несколько отрядов)' : ''} обращена в бегство на ${outcome.attackerRoutTurns} х., уцелело ${fled.left} отр.${fleeLogSuffix(fled, true)}`
              : fled.lostExtra > 0 && fled.left === 0
                ? `${charging ? chargeWord(state) : 'Бой'}: атака ${player.name} зажата с тыла и уничтожена (−${fled.lostExtra} отр.).`
                : `${charging ? chargeWord(state) : 'Бой'}: атака ${player.name}${supportCount > 0 ? ' (несколько отрядов)' : ''} обращена в бегство на ${outcome.attackerRoutTurns} х., уцелело ${fled.left} отр., отходить некуда${fled.lostExtra > 0 ? `, −${fled.lostExtra} с тыла` : ''}.`,
          );
        } else {
          writeWings(from, [
            ...ensureWings(from),
            { army: moverSurvivors, movesLeft: 0, shotsLeft: 0 },
          ]);
          if (movingCommander && armyCount(moverSurvivors) > 0 && !from.commander) {
            from.commander = movingCommander;
          }
          log(
            state,
            `${charging ? chargeWord(state) : 'Бой'}: атака ${player.name}${supportCount > 0 ? ' (несколько отрядов)' : ''} отбита, уцелело ${armyCount(outcome.attackerSurvivors)} отр.`,
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
        log(state, `${player.name} занимает клетку`);
      }

      const alive = state.players.filter((p) => p.alive);
      if (alive.length <= 1) finish(state, alive[0]?.id ?? null);
      return { ok: true, events, fx: { ...fxBase, battle: 'none' } };
    }

    case 'shoot': {
      if (player.actionsLeft < 1) return { ok: false, error: 'Действия на ход закончились' };
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
      const range = armyRange(from.army, era(state), from.terrain);
      if (dist < 1 || dist > range) return { ok: false, error: 'Цель вне дальности' };
      if (to.ownerId === playerId) return { ok: false, error: 'Нельзя стрелять по своим' };
      if (armyCount(to.army) < 1) return { ok: false, error: 'Некого обстреливать' };

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
      player.actionsLeft -= 1;
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
        log(state, `${flavorOf(state).volleyLabel} ${player.name} не нанёс потерь.`);
        return { ok: true, events: ['volley'], fx: { ...fxBase, battle: 'lost' } };
      }

      if (losses >= defCount) {
        writeWings(to, []);
        to.commander = null;
        to.routedTurns = 0;
        log(state, `${flavorOf(state).volleyLabel} ${player.name} уничтожает гарнизон.`);
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
        const survivors = { ...to.army };
        const survivorsCount = armyCount(survivors);
        const routTurns = routTurnsFromLoss(defCount, survivorsCount);
        const movesLeft = to.movesLeft;
        const shotsLeft = to.shotsLeft;
        writeWings(to, []);
        to.commander = null;
        to.routedTurns = 0;
        const fled = displaceArmy(state, survivors, to, defId, { x: from.x, y: from.y }, defCmdr, routTurns);
        if (!fled.ok && fled.left > 0) {
          writeWings(to, [
            { army: scaleArmy(survivors, fled.left), movesLeft: 0, shotsLeft: 0 },
          ]);
          if (defCmdr) to.commander = defCmdr;
          to.routedTurns = Math.max(to.routedTurns, routTurns);
        }
        log(
          state,
          fled.ok
            ? `${flavorOf(state).volleyLabel} ${player.name}: −${losses} отр., гарнизон в панике на ${routTurns} х.${fleeLogSuffix(fled, true)}.`
            : fled.lostExtra > 0 && fled.left === 0
              ? `${flavorOf(state).volleyLabel} ${player.name}: −${losses} отр., гарнизон зажат с тыла и уничтожен (−${fled.lostExtra}).`
              : `${flavorOf(state).volleyLabel} ${player.name}: −${losses} отр., гарнизон в панике на ${routTurns} х.${fled.lostExtra > 0 ? `, −${fled.lostExtra} с тыла` : ''}, бежать некуда.`,
        );
      } else {
        log(state, `${flavorOf(state).volleyLabel} ${player.name}: −${losses} отр. у обороны.`);
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
      log(state, `${player.name} ставит пехоту в каре.`);
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
      log(state, `${player.name} распускает каре.`);
      return { ok: true, events: ['square-break'] };
    }

    default:
      return { ok: false, error: 'Неизвестное действие' };
  }
}

/** Действия закончились — ход завершается автоматически. */
export function autoEndTurnIfExhausted(state: GameState): void {
  if (state.pendingSquare) return;
  const player = currentPlayer(state);
  if (state.phase === 'playing' && player && player.actionsLeft <= 0) nextTurn(state);
}

export function coordKey(c: Coord): string {
  return `${c.x},${c.y}`;
}
