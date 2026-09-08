import {
  BASE_ACTIONS,
  BUILDINGS,
  CAPITAL_START_ARMY,
  MAX_PLAYERS,
  MAX_ROUNDS,
  PLAYER_COLORS,
  START_RESOURCES,
  STARVATION_DESERTION,
  TECHS,
  TERRAIN,
  UNIT_COST,
  UPKEEP_UNITS_PER_FOOD,
  techCost,
} from './config.js';
import { capitalSpots, generateTiles, isAdjacent, mapSizeFor, tileAt } from './map.js';
import { mulberry32 } from './rng.js';
import type {
  ActionResult,
  Coord,
  GameAction,
  GameState,
  Player,
  Resources,
  Tile,
} from './types.js';

const EMPTY: Resources = { gold: 0, food: 0, iron: 0 };

export function playerById(state: GameState, id: string): Player | undefined {
  return state.players.find((p) => p.id === id);
}

export function currentPlayer(state: GameState): Player | undefined {
  const id = state.order[state.turnIndex];
  return id ? playerById(state, id) : undefined;
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
  return {
    roomCode,
    hostId,
    phase: 'lobby',
    seed,
    width: 0,
    height: 0,
    tiles: [],
    players: [],
    order: [],
    turnIndex: 0,
    round: 0,
    maxRounds: MAX_ROUNDS,
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
  });
  return { ok: true, events: [`${name} присоединился к игре`] };
}

export function removePlayer(state: GameState, id: string): void {
  if (state.phase === 'lobby') {
    state.players = state.players.filter((p) => p.id !== id);
    state.players.forEach((p, i) => {
      p.color = PLAYER_COLORS[i % PLAYER_COLORS.length]!;
    });
    if (state.hostId === id && state.players[0]) state.hostId = state.players[0].id;
    return;
  }
  const player = playerById(state, id);
  if (player) player.connected = false;
}

export function startGame(state: GameState, byPlayerId: string): ActionResult {
  if (state.phase !== 'lobby') return { ok: false, error: 'Игра уже идёт' };
  if (byPlayerId !== state.hostId) return { ok: false, error: 'Начать игру может только хост' };
  if (state.players.length < 2) return { ok: false, error: 'Нужно минимум 2 игрока' };

  const size = mapSizeFor(state.players.length);
  state.width = size;
  state.height = size;
  state.tiles = generateTiles(size, state.players.length, state.seed);

  const spots = capitalSpots(size, state.players.length);
  state.players.forEach((player, i) => {
    const spot = spots[i]!;
    const capital = tileAt(state, spot.x, spot.y)!;
    capital.ownerId = player.id;
    capital.capitalOf = player.id;
    capital.army = CAPITAL_START_ARMY;
    for (const d of [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ]) {
      const t = tileAt(state, spot.x + d.x, spot.y + d.y);
      if (t && TERRAIN[t.terrain].passable) t.ownerId = player.id;
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
  return state.tiles.reduce((sum, t) => (t.ownerId === playerId ? sum + t.army : sum), 0);
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
      if (tile.ownerId !== player.id || tile.army === 0) continue;
      const loss = Math.max(1, Math.floor(tile.army * STARVATION_DESERTION));
      tile.army = Math.max(0, tile.army - loss);
      deserted += loss;
    }
    if (deserted > 0) log(state, `${player.name}: голод, дезертировало ${deserted} отр.`);
  }

  player.actionsLeft = BASE_ACTIONS + player.tech.logistics;
}

function nextTurn(state: GameState): void {
  if (state.phase !== 'playing') return;
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
    score += tile.army;
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
    tile.army = 0;
    if (tile.capitalOf === victimId) tile.capitalOf = null;
  }
  log(state, `Держава ${victim.name} пала под натиском ${conqueror?.name ?? 'врага'}.`);
}

function nextRandom(state: GameState): number {
  state.seed = (Math.imul(state.seed, 1103515245) + 12345) >>> 0;
  return mulberry32(state.seed)();
}

export function defenseMultiplier(state: GameState, tile: Tile, defender: Player | undefined): number {
  const terrain = TERRAIN[tile.terrain].defenseBonus;
  const building = tile.building ? BUILDINGS[tile.building].defenseBonus : 0;
  const capital = tile.capitalOf ? 0.25 : 0;
  const tech = defender ? 0.12 * defender.tech.defense : 0;
  return (1 + terrain + building + capital) * (1 + tech);
}

export function attackMultiplier(attacker: Player): number {
  return 1 + 0.12 * attacker.tech.attack;
}

interface BattleOutcome {
  attackerWon: boolean;
  attackerSurvivors: number;
  defenderSurvivors: number;
}

function resolveBattle(
  state: GameState,
  attacker: Player,
  defender: Player | undefined,
  attackingArmy: number,
  tile: Tile,
): BattleOutcome {
  const jitter = () => 0.85 + nextRandom(state) * 0.3;
  const attackPower = attackingArmy * attackMultiplier(attacker) * jitter();
  const defensePower = tile.army * defenseMultiplier(state, tile, defender) * jitter();

  if (attackPower > defensePower) {
    const ratio = defensePower / Math.max(attackPower, 0.001);
    const losses = Math.min(attackingArmy - 1, Math.round(attackingArmy * ratio * 0.8));
    return { attackerWon: true, attackerSurvivors: Math.max(1, attackingArmy - losses), defenderSurvivors: 0 };
  }
  const ratio = attackPower / Math.max(defensePower, 0.001);
  const losses = Math.min(tile.army - 1, Math.round(tile.army * ratio * 0.8));
  return { attackerWon: false, attackerSurvivors: 0, defenderSurvivors: Math.max(1, tile.army - losses) };
}

export function applyAction(state: GameState, playerId: string, action: GameAction): ActionResult {
  if (state.phase !== 'playing') return { ok: false, error: 'Игра не идёт' };
  const player = currentPlayer(state);
  if (!player || player.id !== playerId) return { ok: false, error: 'Сейчас не ваш ход' };

  switch (action.type) {
    case 'endTurn': {
      nextTurn(state);
      return { ok: true, events: [] };
    }

    case 'research': {
      if (player.actionsLeft < 1) return { ok: false, error: 'Действия на ход закончились' };
      const level = player.tech[action.tech];
      const info = TECHS[action.tech];
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
      const info = BUILDINGS[action.building];
      if (!info) return { ok: false, error: 'Неизвестная постройка' };
      if (!canAfford(player.resources, info.cost)) return { ok: false, error: 'Не хватает ресурсов' };
      pay(player.resources, info.cost);
      tile.building = action.building;
      player.actionsLeft -= 1;
      log(state, `${player.name} строит: ${info.name} (${tile.x + 1};${tile.y + 1})`);
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
      const cost = multiplyCost(UNIT_COST, count);
      if (!canAfford(player.resources, cost)) return { ok: false, error: 'Не хватает ресурсов' };
      pay(player.resources, cost);
      tile.army += count;
      player.actionsLeft -= 1;
      log(state, `${player.name} нанимает ${count} отр.`);
      return { ok: true, events: [] };
    }

    case 'move': {
      if (player.actionsLeft < 1) return { ok: false, error: 'Действия на ход закончились' };
      const from = tileAt(state, action.from.x, action.from.y);
      const to = tileAt(state, action.to.x, action.to.y);
      if (!from || !to) return { ok: false, error: 'Клетки не существует' };
      if (!isAdjacent(from, to)) return { ok: false, error: 'Двигаться можно только на соседнюю клетку' };
      if (!TERRAIN[to.terrain].passable) return { ok: false, error: 'Через горы и море не пройти' };
      if (from.ownerId !== playerId) return { ok: false, error: 'Это не ваша клетка' };
      const count = Math.floor(action.count);
      if (count < 1 || count > from.army) return { ok: false, error: 'Недостаточно войск' };

      const events: string[] = [];
      player.actionsLeft -= 1;

      if (to.ownerId === playerId) {
        from.army -= count;
        to.army += count;
        return { ok: true, events };
      }

      if (to.army > 0) {
        const defender = to.ownerId ? playerById(state, to.ownerId) : undefined;
        const outcome = resolveBattle(state, player, defender, count, to);
        from.army -= count;
        if (outcome.attackerWon) {
          const capitalVictim = to.capitalOf;
          to.army = outcome.attackerSurvivors;
          to.ownerId = playerId;
          log(
            state,
            `Бой (${to.x + 1};${to.y + 1}): ${player.name} побеждает, осталось ${outcome.attackerSurvivors} отр.`,
          );
          if (capitalVictim && capitalVictim !== playerId) {
            to.capitalOf = null;
            eliminate(state, capitalVictim, playerId);
          }
          events.push('battle-won');
        } else {
          to.army = outcome.defenderSurvivors;
          log(
            state,
            `Бой (${to.x + 1};${to.y + 1}): атака ${player.name} отбита, у обороны ${outcome.defenderSurvivors} отр.`,
          );
          events.push('battle-lost');
        }
      } else {
        const capitalVictim = to.capitalOf;
        from.army -= count;
        to.army = count;
        to.ownerId = playerId;
        if (capitalVictim && capitalVictim !== playerId) {
          to.capitalOf = null;
          eliminate(state, capitalVictim, playerId);
        } else {
          log(state, `${player.name} занимает клетку (${to.x + 1};${to.y + 1})`);
        }
      }

      const alive = state.players.filter((p) => p.alive);
      if (alive.length <= 1) finish(state, alive[0]?.id ?? null);
      return { ok: true, events };
    }

    default:
      return { ok: false, error: 'Неизвестное действие' };
  }
}

/** Действия закончились — ход завершается автоматически. */
export function autoEndTurnIfExhausted(state: GameState): void {
  const player = currentPlayer(state);
  if (state.phase === 'playing' && player && player.actionsLeft <= 0) nextTurn(state);
}

export function coordKey(c: Coord): string {
  return `${c.x},${c.y}`;
}
