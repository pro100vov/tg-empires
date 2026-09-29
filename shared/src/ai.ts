/**
 * ИИ-соперники. `planAiTurn` — чистая функция: получает вид игры глазами ИИ
 * (туман применён, seed скрыт) и возвращает варианты следующего действия по убыванию
 * ценности. Сервер применяет первое, что прошло, и просит план заново — так ИИ
 * «пересчитывает» после каждого действия. Свой случайный выбор ИИ берёт из mulberry32,
 * а не из nextRandom, чтобы не сдвигать броски боя.
 *
 * Перед каждым шагом ИИ выбирает стратегию (`chooseStrategy`, см. docs/ai-strategy.md):
 * экспансия — табуны лёгкой конницы расхватывают ничью землю; фронт — резервы стягиваются
 * к точке сбора у границы, рядом строится депо (казармы); наступление — кулак идёт на столицу
 * врага; оборона — всё к столице. Стратегия задаёт веса вариантов.
 *
 * Все пороги и веса — в таблице `TUNING`, чтобы их было легко крутить.
 */
import { TRUCE_ROUNDS, atWar, relationOf } from './diplomacy.js';
import { eventById } from './events.js';
import {
  allyStacksCovering,
  applyAction,
  autoEndTurnIfExhausted,
  battleForecastRatio,
  canAfford,
  canFormSquare,
  computeIncome,
  playerById,
  squarePinned,
  techCostFor,
  totalArmy,
  upkeepFor,
  defenseMultiplier,
} from './engine.js';
import { COMMANDERS } from './commanders.js';
import { TERRAIN } from './config.js';
import { buildingsFor, eraOf, techsFor } from './eras.js';
import { capitalSpots, chargePathOpen, hexDistance, neighbors, tileAt } from './map.js';
import { mulberry32 } from './rng.js';
import {
  CHARGE_COST,
  UNIT_IDS,
  armyCanCharge,
  armyCanKite,
  armyCount,
  armyPower,
  armyRange,
  armySpeed,
  dominantClass,
  enterMoveCost,
  ensureWings,
  mobileCount,
  moveHaltsOnEnter,
  takeFromWings,
  unitsFor,
  volleyArmy,
  wingsAlreadyMarching,
  wingsToArmy,
  tileHasMarched,
  armyHasHeavyArtillery,
  MOVED_VOLLEY,
} from './units.js';
import { publicView, rememberSeenBuildings } from './vision.js';
import type { ActionResult, AiLevel, Army, BuildingType, Coord, EraId, GameAction, GameState, Player, Resources, TechType, Tile, UnitClass, UnitId } from './types.js';

interface Tuning {
  /** Отношение сил, с которого ИИ решается атаковать. */
  attackRatio: number;
  /** Порог залпа. */
  volleyRatio: number;
  /** Шанс «зевнуть» и пропустить лучшее действие. */
  skip: number;
  /** Совместный удар соседних стеков. */
  joint: boolean;
  /** Строй каре против конницы. */
  square: boolean;
  /** Насколько ИИ любит строить и изучать (множитель веса). */
  economy: number;
  research: number;
  /** Доля решений, где рода войск подбираются против врага. */
  counter: number;
  /** Смотрит ли на опасность рядом, прежде чем идти вперёд. */
  cautious: boolean;
  /** Дипломатия: предлагает и разрывает договоры. */
  diplomat: boolean;
  /** Сколько войск оставляет в столице (доля). */
  garrison: number;
  /** Сколько всадников-разведчиков держит для захвата ничьей земли. */
  maxRiders: number;
  /** Выносит ли табун на шаг, чтобы всадники дальше расходились бесплатно. */
  herds: boolean;
  /** Стягивает ли резервы к фронту и строит депо. */
  fronts: boolean;
}

const TUNING: Record<AiLevel, Tuning> = {
  easy: {
    attackRatio: 1.6,
    volleyRatio: 1.6,
    skip: 0.3,
    joint: false,
    square: false,
    economy: 0.5,
    research: 0.4,
    counter: 0.2,
    cautious: false,
    diplomat: false,
    garrison: 0.3,
    maxRiders: 3,
    herds: false,
    fronts: false,
  },
  normal: {
    attackRatio: 1.25,
    volleyRatio: 1.15,
    skip: 0.04,
    joint: true,
    square: true,
    economy: 1,
    research: 1,
    counter: 0.75,
    cautious: true,
    diplomat: false,
    garrison: 0.35,
    maxRiders: 8,
    herds: true,
    fronts: true,
  },
  hard: {
    attackRatio: 1.05,
    volleyRatio: 0.9,
    skip: 0,
    joint: true,
    square: true,
    economy: 1.25,
    research: 1.25,
    counter: 1,
    cautious: true,
    diplomat: true,
    garrison: 0.4,
    maxRiders: 12,
    herds: true,
    fronts: true,
  },
};

/** Сколько отрядов в раунд ИИ добавляет к плановому размеру армии (6 + раунд × темп). */
const RECRUIT_PACE: Record<AiLevel, number> = { easy: 1.4, normal: 1.3, hard: 1.6 };

/** Кто бьёт какой род: конница — стрелков, стрелки — пехоту, пехота — конницу. */
const COUNTER: Record<UnitClass, UnitClass> = { cavalry: 'infantry', archer: 'cavalry', infantry: 'archer' };

/** Стратегия ИИ на текущий шаг. */
export type AiStrategy = 'expand' | 'front' | 'offensive' | 'defense';

/** С какого расстояния чужие войска/земли считаются «контактом» — пора строить фронт. */
const CONTACT_ARMY = 4;
const CONTACT_LAND = 2;
/** Докуда (в шагах от своих земель) ИИ считает ничью землю «своей будущей». */
const CLAIM_HORIZON = 5;
/** Перевес главного стека над видимым врагом у границы, с которого начинается наступление. */
const OFFENSIVE_RATIO = 1.35;
/** Меньше этой силы у врага не предполагаем (гарнизон под туманом). */
const ENEMY_POWER_FLOOR = 7;
/** Уже наступая, продолжаем при перевесе от этого. */
const OFFENSIVE_HOLD = 1.05;

interface Cand {
  action: GameAction;
  score: number;
}

interface Ctx {
  view: GameState;
  me: Player;
  level: AiLevel;
  t: Tuning;
  era: EraId;
  units: ReturnType<typeof unitsFor>;
  rand: () => number;
  mine: Tile[];
  stacks: Tile[];
  capital: Tile | undefined;
  /** Видимые чужие стеки, с которыми идёт война. */
  enemies: Tile[];
  income: Resources;
  upkeep: number;
  /** Живые державы, с которыми война. */
  foes: Player[];
  /** Известные по раскладке карты столицы врагов — куда идти армии. */
  goals: Coord[];
  /** Сумма атаки видимых врагов рядом со столицей. */
  threat: number;
  threatClass: UnitClass | null;
  strategy: AiStrategy;
  /** Род для захвата земли: самый дешёвый с ходом 3 (лёгкая конница). */
  rider: UnitId | null;
  /** Сколько клеток можно занять в пределах `CLAIM_HORIZON` шагов от своих земель. */
  claimCount: number;
  /** Из них ничьих (не вражеских). */
  neutralCount: number;
  /** Враг рядом с нашими землями (войска или граница). */
  contact: boolean;
  /** Видимые вражеские стеки у наших земель и их сила. */
  enemyNear: Tile[];
  enemyNearPower: number;
  /** Сила всех наших стеков. */
  fieldPower: number;
  /** Точка сбора: куда стягиваются резервы. */
  rally: Tile | null;
  /** Ориентиры врага у границы: его стеки рядом, иначе его клетки рядом с нашими. */
  foeMarks: Coord[];
  roundsLeft: number;
  /** Кэш опасности по клеткам. */
  dangerCache: Map<string, number>;
}

function key(c: Coord): string {
  return `${c.x},${c.y}`;
}

function rngFor(view: GameState, me: Player): () => number {
  let h = 2166136261 >>> 0;
  const mix = (n: number) => {
    h = Math.imul(h ^ (n >>> 0), 16777619) >>> 0;
  };
  for (const ch of view.roomCode) mix(ch.charCodeAt(0));
  mix(view.round);
  mix(view.turnIndex);
  mix(me.actionsLeft);
  mix(totalArmy(view, me.id));
  mix(Math.round(me.resources.gold));
  mix(Math.round(me.resources.iron));
  return mulberry32(h);
}

function sumArmies(tiles: Tile[]): Army {
  const out: Army = {};
  for (const t of tiles) {
    for (const [id, n] of Object.entries(t.army)) out[id as UnitId] = (out[id as UnitId] ?? 0) + (n ?? 0);
  }
  return out;
}

function attackPowerOf(ctx: Ctx, tile: Tile): number {
  return armyPower(tile.army, 'attack', 'infantry', tile.terrain, { era: ctx.era });
}

/** Самый дешёвый род с ходом 3+: им выгоднее всего расхватывать землю. */
function pickRider(units: ReturnType<typeof unitsFor>, era: EraId): UnitId | null {
  let best: UnitId | null = null;
  let bestPrice = Number.POSITIVE_INFINITY;
  for (const id of UNIT_IDS) {
    const u = units[id];
    if (armySpeed({ [id]: 1 }, era) < 3) continue;
    const price = (u.cost.gold ?? 0) + 1.5 * (u.cost.iron ?? 0) + 4 * u.upkeep;
    if (price < bestPrice) {
      bestPrice = price;
      best = id;
    }
  }
  return best;
}

/** Можно ли войти на клетку (без боя): проходима, не под договором, нет видимых чужих войск. */
function canEnter(ctx: Ctx, t: Tile): boolean {
  if (!TERRAIN[t.terrain].passable) return false;
  if (t.ownerId && t.ownerId !== ctx.me.id) {
    if (!atWar(ctx.view, ctx.me.id, t.ownerId)) return false;
    if (armyCount(t.army) > 0) return false;
  }
  return true;
}

/** Клетку можно занять простым входом: ничья или пустая вражеская. */
function isClaimable(ctx: Ctx, t: Tile): boolean {
  return t.ownerId !== ctx.me.id && canEnter(ctx, t);
}

/**
 * Поле расстояний (в шагах) от источников по проходимым для нас клеткам.
 * Через чужие войска не идём, но сами клетки с ними получают расстояние (цель атаки).
 */
function distField(ctx: Ctx, sources: Coord[], limit = 64): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: Coord[] = [];
  for (const s of sources) {
    const k = key(s);
    if (dist.has(k)) continue;
    dist.set(k, 0);
    queue.push(s);
  }
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    const d = dist.get(key(cur))!;
    if (d >= limit) continue;
    for (const n of neighbors(ctx.view, cur)) {
      const k = key(n);
      if (dist.has(k) || !TERRAIN[n.terrain].passable) continue;
      if (n.ownerId && n.ownerId !== ctx.me.id && !atWar(ctx.view, ctx.me.id, n.ownerId)) continue;
      dist.set(k, d + 1);
      if (canEnter(ctx, n)) queue.push(n);
    }
  }
  return dist;
}

function buildCtx(view: GameState, me: Player): Ctx {
  const level = me.ai ?? 'normal';
  const era = eraOf(view.settings);
  const mine = view.tiles.filter((t) => t.ownerId === me.id);
  const stacks = mine.filter((t) => armyCount(t.army) > 0);
  const capital = mine.find((t) => t.capitalOf === me.id);
  const enemies = view.tiles.filter(
    (t) => t.ownerId && t.ownerId !== me.id && armyCount(t.army) > 0 && atWar(view, me.id, t.ownerId),
  );
  const foes = view.players.filter((p) => p.alive && p.id !== me.id && atWar(view, me.id, p.id));
  // Игроки рассажены по столицам по порядку — раскладка публична (в лобби видны кольца).
  const spots = capitalSpots(view.width, Math.max(2, view.players.length));
  const goals: Coord[] = [];
  view.players.forEach((p, i) => {
    const spot = spots[i];
    if (spot && p.alive && p.id !== me.id && atWar(view, me.id, p.id)) goals.push(spot);
  });
  const units = unitsFor(era);
  const ctx: Ctx = {
    view,
    me,
    level,
    t: TUNING[level],
    era,
    units,
    rand: rngFor(view, me),
    mine,
    stacks,
    capital,
    enemies,
    income: computeIncome(view, me.id),
    upkeep: upkeepFor(view, me.id),
    foes,
    goals,
    threat: 0,
    threatClass: null,
    strategy: 'expand',
    rider: pickRider(units, era),
    claimCount: 0,
    neutralCount: 0,
    contact: false,
    enemyNear: [],
    enemyNearPower: 0,
    fieldPower: 0,
    rally: null,
    foeMarks: [],
    roundsLeft: view.maxRounds - view.round,
    dangerCache: new Map(),
  };
  if (capital) {
    const near = enemies.filter((e) => hexDistance(e, capital) <= 3);
    ctx.threat = near.reduce((sum, e) => sum + attackPowerOf(ctx, e), 0);
    ctx.threatClass = near.length > 0 ? dominantClass(sumArmies(near)) : null;
  }

  // Ничья земля в досягаемости.
  const reach = distField(ctx, mine, CLAIM_HORIZON);
  const claimable = view.tiles.filter((t) => {
    const d = reach.get(key(t));
    return d !== undefined && d > 0 && isClaimable(ctx, t);
  });
  ctx.claimCount = claimable.length;
  ctx.neutralCount = claimable.filter((t) => !t.ownerId).length;

  // Контакт: вражеские стеки или земли рядом с нашими.
  const nearMine = (t: Coord, r: number) => mine.some((m) => hexDistance(m, t) <= r);
  ctx.enemyNear = enemies.filter((e) => nearMine(e, CONTACT_ARMY + 1));
  ctx.enemyNearPower = ctx.enemyNear.reduce((sum, e) => sum + attackPowerOf(ctx, e), 0);
  const foeLand = view.tiles.filter((t) => t.ownerId && t.ownerId !== me.id && atWar(view, me.id, t.ownerId));
  // Одиночный разъезд врага — ещё не фронт: контакт — это граница или заметный стек рядом.
  const nearArmy = enemies.filter((e) => nearMine(e, CONTACT_ARMY));
  ctx.contact =
    armyCount(sumArmies(nearArmy)) >= 3 || nearArmy.some((e) => armyCount(e.army) >= 2) || foeLand.some((t) => nearMine(t, CONTACT_LAND));
  ctx.fieldPower = stacks.reduce((sum, s) => sum + attackPowerOf(ctx, s), 0);
  const border = foeLand.filter((t) => nearMine(t, CONTACT_LAND + 1));
  ctx.foeMarks = ctx.enemyNear.length > 0 ? ctx.enemyNear : border.length > 0 ? border : foeLand;
  ctx.strategy = chooseStrategy(ctx);
  ctx.rally = pickRally(ctx);
  return ctx;
}

/** Выбор стратегии по обстановке — пересчитывается перед каждым действием. */
function chooseStrategy(ctx: Ctx): AiStrategy {
  const cap = ctx.capital;
  if (cap && ctx.threat > 0) {
    const vs = ctx.threatClass ?? 'infantry';
    if (defensePowerAt(ctx, cap.army, cap, vs) < ctx.threat * 1.3) return 'defense';
  }
  if (!ctx.contact) return 'expand';
  // Наступаем кулаком: главный стек должен быть заметно сильнее всего, что видно у границы.
  // Под туманом видно не всё — меньше чем на гарнизон (~6 отрядов) врага не рассчитываем.
  const lead = leadStack(ctx);
  const leadPower = lead ? attackPowerOf(ctx, lead) : 0;
  const enemyRef = Math.max(ctx.enemyNearPower, ENEMY_POWER_FLOOR);
  // Кулак уже вышел вперёд (у вражеских земель) — не пятимся при небольшом перевесе, иначе стек ходит туда-сюда.
  const pushing = lead ? ctx.foeMarks.some((m) => hexDistance(m, lead) <= 2) : false;
  const need = pushing ? OFFENSIVE_HOLD : OFFENSIVE_RATIO;
  if (lead && armyCount(lead.army) >= 8 && leadPower >= enemyRef * need) return 'offensive';
  if (ctx.t.fronts && ctx.fieldPower < ctx.enemyNearPower * 0.6 && ctx.enemyNearPower > 6) return 'defense';
  return 'front';
}

/** Главный стек: самый сильный вне столицы (или столица, если в поле никого). */
function leadStack(ctx: Ctx): Tile | undefined {
  const field = ctx.stacks.filter((s) => s.capitalOf !== ctx.me.id && s.routedTurns === 0 && armyCount(s.army) >= 2);
  const pool = field.length > 0 ? field : ctx.stacks;
  return [...pool].sort((a, b) => attackPowerOf(ctx, b) - attackPowerOf(ctx, a))[0];
}

/** Точка сбора: оборона — столица; фронт — своя клетка у границы (не вплотную к врагу); наступление — главный стек. */
function pickRally(ctx: Ctx): Tile | null {
  if (!ctx.t.fronts) return null;
  if (ctx.strategy === 'defense') return ctx.capital ?? null;
  if (ctx.strategy === 'expand') return null;
  const marks = ctx.foeMarks;
  if (marks.length === 0) return null;
  if (ctx.strategy === 'offensive') {
    // Кулак — самый сильный стек (гарнизон столицы не в счёт, если есть другие).
    const lead = leadStack(ctx);
    if (lead && armyCount(lead.army) >= 4) return lead;
  }
  let best: Tile | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const t of ctx.mine) {
    if (!TERRAIN[t.terrain].passable) continue;
    let d = Number.POSITIVE_INFINITY;
    for (const m of marks) d = Math.min(d, hexDistance(t, m));
    const stackNear = ctx.enemyNear.some((e) => hexDistance(e, t) <= 1);
    let score = Math.abs(d - 2) * 10 + (stackNear ? 25 : 0);
    if (t.terrain === 'hills') score -= 4;
    if (t.building) score -= 2;
    if (t.capitalOf === ctx.me.id) score -= 3;
    // Точка сбора не должна скакать: где уже стоит крупный стек — там и собираемся.
    score -= Math.min(12, armyCount(t.army)) * 1.2;
    if (ctx.capital) score += hexDistance(t, ctx.capital) * 0.3;
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/** Меньше этого столица не остаётся: вражеские разъезды берут пустую столицу за один ход. */
function minGarrison(ctx: Ctx): number {
  if (!ctx.contact) return 2;
  return Math.max(3, Math.min(10, Math.floor(ctx.view.round / 2)));
}

function garrisonOf(ctx: Ctx, tile: Tile): number {
  if (tile.capitalOf !== ctx.me.id) return 0;
  const n = armyCount(tile.army);
  if (ctx.strategy === 'defense') return n;
  const floor = minGarrison(ctx);
  const frontline = ctx.enemyNear.some((e) => hexDistance(e, tile) <= 4);
  if (frontline) return Math.min(n, Math.max(floor, Math.ceil(n * 0.5)));
  // Пока врагов нет рядом, всадники-разведчики уходят; держим пару отрядов.
  if (ctx.strategy === 'expand') return Math.min(n, floor);
  return Math.min(n, Math.max(floor, Math.ceil(n * ctx.t.garrison)));
}

/** Гарнизон столицы ниже минимума — нанять пехоту прямо в столице. */
function garrisonRecruitCands(ctx: Ctx, foodSlack: number): Cand[] {
  const cap = ctx.capital;
  if (!cap || !ctx.contact || !ctx.t.fronts) return [];
  const need = minGarrison(ctx) - armyCount(cap.army);
  if (need < 1) return [];
  // Против конницы (разъездов) — пехота: она же лучше всего держит стены.
  const unit = pickRecruitUnit(ctx, 'cavalry');
  const info = ctx.units[unit];
  const count = Math.min(need, maxByBudget(ctx.me.resources, info.cost), Math.max(1, Math.floor(foodSlack / Math.max(0.5, info.upkeep))));
  if (count < 1) return [];
  return [{ action: { type: 'recruit', at: { x: cap.x, y: cap.y }, count, unit }, score: 450 + need * 10 }];
}

/** Сила обороны стека на клетке. */
function defensePowerAt(ctx: Ctx, army: Army, tile: Tile, vs: UnitClass): number {
  return armyPower(army, 'defense', vs, tile.terrain, { era: ctx.era }) * defenseMultiplier(ctx.view, tile, ctx.me);
}

/** Сколько отрядов врага могут ударить по клетке в ближайший ход. */
function threatAround(ctx: Ctx, at: Coord, radius: number): { power: number; vs: UnitClass } {
  let power = 0;
  const counts: Record<UnitClass, number> = { infantry: 0, cavalry: 0, archer: 0 };
  for (const e of ctx.enemies) {
    const reach = armyCanCharge(e.army) ? radius + 2 : radius;
    if (hexDistance(e, at) > reach) continue;
    power += attackPowerOf(ctx, e);
    counts[dominantClass(e.army)] += armyCount(e.army);
  }
  const vs = (Object.keys(counts) as UnitClass[]).sort((a, b) => counts[b] - counts[a])[0] ?? 'infantry';
  return { power, vs };
}

function dangerAt(ctx: Ctx, t: Coord): number {
  const k = key(t);
  let d = ctx.dangerCache.get(k);
  if (d === undefined) {
    d = threatAround(ctx, t, 1).power;
    ctx.dangerCache.set(k, d);
  }
  return d;
}

// ── Дипломатия ──────────────────────────────────────────────────────────────

/** Мощь видимых стеков державы (для сравнения сил). */
function visiblePower(ctx: Ctx, ownerId: string): number {
  let power = 0;
  for (const t of ctx.view.tiles) {
    if (t.ownerId !== ownerId || armyCount(t.army) === 0) continue;
    power += armyPower(t.army, 'attack', 'infantry', t.terrain, { era: ctx.era });
  }
  return power;
}

function myPower(ctx: Ctx): number {
  return visiblePower(ctx, ctx.me.id);
}

/** Ответы на предложения договоров и, у сложного ИИ, собственные предложения. */
export function planAiDiplomacy(view: GameState, aiId: string, opts: { respondOnly?: boolean } = {}): GameAction[] {
  const me = playerById(view, aiId);
  if (!me || !me.alive || !view.settings.diplomacy || view.settings.hotseat || view.phase !== 'playing') return [];
  const ctx = buildCtx(view, me);
  const out: GameAction[] = [];
  const alive = view.players.filter((p) => p.alive);

  for (const proposal of view.proposals.filter((p) => p.to === aiId)) {
    const from = playerById(view, proposal.from);
    if (!from?.alive) continue;
    const theirs = visiblePower(ctx, from.id);
    const weaker = myPower(ctx) < theirs * 1.3;
    const otherFront = ctx.foes.some((f) => f.id !== from.id);
    let accept = false;
    if (proposal.kind === 'truce') {
      accept = ctx.level === 'easy' ? ctx.rand() < 0.5 : weaker || otherFront;
    } else {
      // Союз нужен, только пока остаётся кто-то третий: иначе партия сразу закончится общей победой.
      const others = alive.filter((p) => p.id !== aiId && p.id !== from.id);
      accept = ctx.level === 'hard' && others.length > 0 && otherFront;
    }
    out.push({ type: accept ? 'acceptProposal' : 'declineProposal', id: proposal.id });
  }

  // Свои предложения и разрывы — только в начале своего хода, чтобы не сыпать ими на каждом шаге.
  const turnStart = me.actionsLeft >= view.settings.actionsPerTurn + me.tech.logistics - 1;
  if (opts.respondOnly || !turnStart) return out;

  if (ctx.t.diplomat && view.round >= 4 && view.proposals.every((p) => p.from !== aiId) && ctx.rand() < 0.25) {
    // Мир с тем, с кем нет границы, пока воюем с другим.
    const front = ctx.foes.find((f) => ctx.enemies.some((e) => e.ownerId === f.id && ctx.capital && hexDistance(e, ctx.capital) <= 4));
    const far = ctx.foes.find(
      (f) =>
        f.id !== front?.id &&
        !view.proposals.some((p) => p.from === f.id || p.to === f.id) &&
        !ctx.enemies.some((e) => e.ownerId === f.id && ctx.capital && hexDistance(e, ctx.capital) <= 5),
    );
    if (front && far && !relationOf(view, aiId, far.id)) {
      out.push({ type: 'propose', to: far.id, kind: 'truce', rounds: TRUCE_ROUNDS[1] });
    }
  }
  if (ctx.t.diplomat && view.round >= 8 && ctx.rand() < 0.1) {
    // Договор мешает, когда мы намного сильнее.
    for (const p of alive) {
      const rel = relationOf(view, aiId, p.id);
      if (!rel || rel.breakAt != null || rel.kind === 'alliance') continue;
      if (myPower(ctx) > visiblePower(ctx, p.id) * 1.8 && visiblePower(ctx, p.id) > 0) {
        out.push({ type: 'breakTreaty', with: p.id });
        break;
      }
    }
  }
  return out;
}

// ── События ────────────────────────────────────────────────────────────────

function eventChoiceCand(ctx: Ctx): Cand | null {
  const pending = ctx.me.event;
  if (!pending?.pending) return null;
  const def = eventById(pending.id);
  const cost = def?.choice?.cost;
  let accept = Boolean(cost && canAfford(ctx.me.resources, cost));
  if (accept && def) {
    const after = ctx.me.resources.gold - (cost?.gold ?? 0);
    if (def.id === 'mercenaries') accept = after >= 20;
    else if (def.id === 'caravan') accept = ctx.me.resources.food - (cost?.food ?? 0) >= ctx.upkeep;
    else if (def.id === 'tax_revolt') accept = after >= 10;
  }
  if (ctx.level === 'easy' && ctx.rand() < 0.4) accept = !accept;
  if (accept && def?.choice?.cost && !canAfford(ctx.me.resources, def.choice.cost)) accept = false;
  return { action: { type: 'eventChoice', choice: accept ? 1 : 0 }, score: 1000 };
}

// ── Экономика, наём, наука ─────────────────────────────────────────────────

function maxByBudget(res: Resources, cost: Partial<Resources>): number {
  const byGold = cost.gold ? Math.floor(res.gold / cost.gold) : Number.POSITIVE_INFINITY;
  const byFood = cost.food ? Math.floor(res.food / cost.food) : Number.POSITIVE_INFINITY;
  const byIron = cost.iron ? Math.floor(res.iron / cost.iron) : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(byGold, byFood, byIron));
}

/** Какой род нанимать: против самого частого рода врага; иначе — самый выгодный по цене. */
function pickRecruitUnit(ctx: Ctx, target: UnitClass | null): UnitId {
  const ids = Object.keys(ctx.units) as UnitId[];
  const wantClass = target && ctx.rand() < ctx.t.counter ? COUNTER[target] : null;
  // Когда железа мало, дорогие по железу отряды не нанять — считаем его дороже; избыток — почти бесплатен.
  const { gold, iron } = ctx.me.resources;
  const ironWeight = iron < 20 ? 5 : iron > 100 ? 0.5 : 1.5;
  const goldWeight = gold > 120 ? 0.6 : 1;
  // Еда — потолок армии: когда её впритык, выгоднее меньше, но крепче.
  const foodTight = ctx.income.food - ctx.upkeep < 10;
  const upkeepWeight = foodTight ? 12 : 6;
  let best: UnitId = 'medium_infantry';
  let bestValue = -1;
  for (const id of ids) {
    const u = ctx.units[id];
    if (wantClass && u.class !== wantClass) continue;
    if (id === ctx.rider && ctx.strategy !== 'expand') continue;
    // Пехота и конница — основа; чисто стрелковые отряды дают войску дальность, но слабее в рукопашной.
    const strength = u.attack + u.defense + (u.range > 0 ? 0.3 : 0) + (u.charge ? 0.2 : 0);
    const price = goldWeight * (u.cost.gold ?? 0) + ironWeight * (u.cost.iron ?? 0) + upkeepWeight * u.upkeep;
    const value = strength / price;
    if (value > bestValue) {
      bestValue = value;
      best = id;
    }
  }
  return best;
}

/** Еда, которую наём не трогает (технологии тоже стоят еды). */
const FOOD_RESERVE = 30;

/** Доход еды с учётом строящихся ферм. */
function foodIncome(ctx: Ctx): number {
  const farm = buildingsFor(ctx.era).farm.income.food ?? 0;
  return ctx.income.food + ctx.mine.filter((t) => t.construction?.building === 'farm').length * farm;
}

function recruitSpots(ctx: Ctx): Tile[] {
  return ctx.mine.filter(
    (t) => (t.capitalOf === ctx.me.id || (t.building === 'barracks' && !t.construction)) && TERRAIN[t.terrain].passable,
  );
}

function ridersOwned(ctx: Ctx): number {
  if (!ctx.rider) return 0;
  return ctx.mine.reduce((sum, t) => sum + (t.army[ctx.rider!] ?? 0), 0);
}

/** Всадники для захвата земли: столько, сколько есть ничьих клеток рядом. */
function riderRecruitCands(ctx: Ctx, spots: Tile[]): Cand[] {
  const rider = ctx.rider;
  if (!rider || ctx.strategy === 'defense') return [];
  // На войне всадники нужны только под ничью землю: в бою они слабы.
  const land = ctx.strategy === 'expand' ? ctx.claimCount : ctx.neutralCount;
  const want = Math.min(ctx.t.maxRiders, Math.ceil(land / 4));
  const need = want - ridersOwned(ctx);
  if (need < 1) return [];
  const info = ctx.units[rider];
  // Всадник сам себя кормит: каждая занятая равнина даёт 2🌾, поэтому в экспансии по еде смотрим с запасом.
  const foodSlack =
    foodIncome(ctx) - ctx.upkeep + Math.floor(ctx.me.resources.food / (ctx.strategy === 'expand' ? 3 : 8)) + (ctx.strategy === 'expand' ? 2 * need : 0);
  const foodCap = Math.floor(foodSlack / Math.max(0.5, info.upkeep));
  const count = Math.min(need, maxByBudget(ctx.me.resources, info.cost), foodCap);
  if (count < 1) return [];
  // Нанимаем там, откуда ближе до ничьей земли.
  const field = distField(ctx, ctx.view.tiles.filter((t) => isClaimable(ctx, t)), 12);
  const spot = [...spots].sort((a, b) => (field.get(key(a)) ?? 99) - (field.get(key(b)) ?? 99))[0];
  if (!spot) return [];
  const base = { expand: 470, front: 300, offensive: 250, defense: 0 }[ctx.strategy];
  // Одного-двух всадников нанимать ради одной клетки — мало смысла.
  const score = base + Math.min(land, 30) * 2 - (count < 2 && land < 6 ? 120 : 0);
  return [{ action: { type: 'recruit', at: { x: spot.x, y: spot.y }, count, unit: rider }, score }];
}

function recruitCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const { me } = ctx;
  const spots = recruitSpots(ctx);
  if (spots.length === 0) return out;
  out.push(...riderRecruitCands(ctx, spots));

  const threatened = ctx.threat > 0;
  const enemyClass =
    ctx.threatClass ??
    (ctx.enemyNear.length > 0 ? dominantClass(sumArmies(ctx.enemyNear)) : ctx.enemies.length > 0 ? dominantClass(ctx.enemies[0]!.army) : null);
  // Армия должна кормиться с дохода: запас растягиваем ходов на 8, под угрозой — на 3.
  // Немного еды держим про запас — на технологии.
  const foodSlack = foodIncome(ctx) - ctx.upkeep + Math.floor(Math.max(0, me.resources.food - (threatened ? 0 : FOOD_RESERVE)) / (threatened ? 3 : 8));
  out.push(...garrisonRecruitCands(ctx, foodSlack));
  // Депо поближе к точке сбора: новобранцам не идти через всю страну.
  const anchor = ctx.strategy === 'defense' ? ctx.capital : ctx.rally;
  const ordered = anchor ? [...spots].sort((a, b) => hexDistance(a, anchor) - hexDistance(b, anchor)) : spots;

  for (const [i, tile] of ordered.entries()) {
    const unit = pickRecruitUnit(ctx, enemyClass);
    const info = ctx.units[unit];
    const cap = maxByBudget(me.resources, info.cost);
    const foodCap = Math.floor((foodSlack + 0.2) / Math.max(0.5, info.upkeep));
    const count = Math.min(cap, foodCap, threatened ? 12 : 10);
    if (count < 1) continue;
    // Сколько войск нужно к этому раунду: ниже плана — наём важнее построек и науки.
    const armyNow = totalArmy(ctx.view, me.id) - ridersOwned(ctx);
    let score: number;
    switch (ctx.strategy) {
      case 'expand': {
        // Пока врага не видно, армия — только гарнизон; золото уходит на всадников и рынки.
        const planned = 4 + ctx.view.round * 0.7 * RECRUIT_PACE[ctx.level];
        score = armyNow < planned ? 230 : 120;
        break;
      }
      case 'front':
        score = ctx.fieldPower < ctx.enemyNearPower * 1.4 ? 420 : 260;
        break;
      case 'offensive':
        score = 300;
        break;
      case 'defense':
        score = 560;
        break;
    }
    const planned = 6 + ctx.view.round * RECRUIT_PACE[ctx.level];
    if (ctx.strategy !== 'expand' && armyNow < planned) score += 40;
    if (threatened) score += 200 + Math.min(200, ctx.threat * 4);
    // Армия и так большая относительно дохода — не раздуваем.
    if (ctx.upkeep > ctx.income.food + 4 && !threatened) score -= 200;
    // Дальние от фронта точки найма — запасные.
    score -= i * 30;
    out.push({ action: { type: 'recruit', at: { x: tile.x, y: tile.y }, count, unit }, score });
  }
  return out;
}

/** Своя клетка под депо (казармы) рядом с точкой сбора: 2–5 шагов до врага, не под ударом. */
function depotSpot(ctx: Ctx, pool: Tile[], anchor: Coord): Tile | undefined {
  const marks: Coord[] = ctx.enemyNear.length > 0 ? ctx.enemyNear : [anchor];
  const distTo = (t: Coord) => Math.min(...marks.map((m) => hexDistance(t, m)));
  return pool
    .filter((t) => hexDistance(t, anchor) <= 3 && dangerAt(ctx, t) === 0 && distTo(t) >= 2)
    .sort((a, b) => distTo(a) - distTo(b) + ((b.terrain === 'hills' ? 1 : 0) - (a.terrain === 'hills' ? 1 : 0)) * 0.5)[0];
}

function buildCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const { me, view } = ctx;
  const buildings = buildingsFor(ctx.era);
  const roundsLeft = ctx.roundsLeft;
  const early = Math.max(0.35, Math.min(1, roundsLeft / (view.maxRounds * 0.7)));
  // Строящиеся фермы уже в счёт: не закладываем по четыре за ход.
  const foodMargin = foodIncome(ctx) - ctx.upkeep;
  const starving = foodMargin < 0 && me.resources.food < -foodMargin * 3;

  const free = ctx.mine.filter((t) => !t.building && !t.construction && TERRAIN[t.terrain].passable && !t.capitalOf);
  const safe = free.filter((t) => threatAround(ctx, t, 2).power === 0);
  const pool = safe.length > 0 ? safe : free;
  const pickTile = (rank: (t: Tile) => number): Tile | undefined =>
    [...pool].sort((a, b) => rank(b) - rank(a) || hexDistance(a, ctx.capital ?? a) - hexDistance(b, ctx.capital ?? b))[0];

  // Пока есть ничья земля, золото сперва на всадников: клетка дешевле рынка.
  const landRush = ctx.strategy === 'expand' && ctx.claimCount >= 8 && ridersOwned(ctx) < Math.min(ctx.t.maxRiders, ctx.claimCount / 4);
  const options: { type: BuildingType; tile: Tile | undefined; score: number; urgent?: boolean }[] = [
    {
      // Еды и так хватает — ферма не нужна: сверх запаса еда только копится.
      type: 'farm',
      tile: pickTile((t) => (t.terrain === 'plains' ? 2 : 0) + (t.terrain === 'forest' ? -1 : 0)),
      // Еда — потолок армии: при лишнем золоте ферма дешевле всего даёт место под новые отряды.
      score: starving
        ? 700
        : foodMargin < 2 && me.resources.food < 60
          ? 260
          : foodMargin < 6 && me.resources.gold > 45 && ctx.strategy !== 'expand'
            ? 250 + Math.min(80, (me.resources.gold - 45) / 2)
            : 0,
      urgent: starving || (foodMargin < 6 && me.resources.gold > 60),
    },
    {
      type: 'mine',
      tile: pickTile((t) => (t.terrain === 'hills' ? 3 : t.terrain === 'forest' ? 1 : 0)),
      // Железо кончилось, а золото копится — нанимать не на что: шахта.
      score: me.resources.iron < 30 && ctx.income.iron < 10 ? 250 : me.resources.gold > 90 && me.resources.iron < 60 ? 245 : 0,
      urgent: true,
    },
    // Золото — главное узкое место: рынок окупается за ~8 ходов (но не когда золото и так копится).
    { type: 'market', tile: pickTile((t) => (t.terrain === 'plains' ? 1 : 0) - dangerAt(ctx, t)), score: landRush ? 150 : me.resources.gold > 150 ? 0 : 235 },
  ];

  if (ctx.t.fronts && (ctx.strategy === 'front' || ctx.strategy === 'offensive')) {
    // Депо у фронта: найм рядом с полем боя, а не за полкарты в столице.
    const anchor = ctx.rally ?? ctx.enemyNear[0];
    const spotsNow = ctx.mine.filter(
      (t) => t.capitalOf === me.id || t.building === 'barracks' || t.construction?.building === 'barracks',
    );
    const covered = anchor ? spotsNow.some((t) => hexDistance(t, anchor) <= 3) : true;
    // Одно депо за раз и не больше одного на 8 раундов партии.
    const building = ctx.mine.some((t) => t.construction?.building === 'barracks');
    const depots = ctx.mine.filter((t) => t.building === 'barracks').length;
    if (anchor && !covered && !building && depots <= view.round / 8) {
      const tile = depotSpot(ctx, free, anchor);
      if (tile) options.push({ type: 'barracks', tile, score: 430, urgent: true });
    }
    // Частокол на точке сбора, если враг рядом.
    const rally = ctx.rally;
    if (ctx.strategy === 'front' && rally && rally.ownerId === me.id && !rally.building && !rally.construction && !rally.capitalOf && ctx.enemyNearPower > 0) {
      const near = threatAround(ctx, rally, 3).power;
      if (near > 0) options.push({ type: 'palisade', tile: rally, score: 240 + Math.min(120, near * 3), urgent: true });
    }
  }
  if (ctx.strategy === 'defense' && ctx.capital) {
    // Столица уже с крепостью — укрепляем подступы: частокол на холмах/клетках рядом со стеком.
    const ring = free.filter((t) => hexDistance(t, ctx.capital!) === 1 && armyCount(t.army) > 0);
    const tile = ring.sort((a, b) => armyCount(b.army) - armyCount(a.army))[0];
    if (tile) options.push({ type: 'palisade', tile, score: 300, urgent: true });
  }

  for (const opt of options) {
    if (!opt.tile || opt.score <= 0) continue;
    const info = buildings[opt.type];
    if (!canAfford(me.resources, info.cost)) continue;
    // Ферма и рынок окупаются только при запасе ходов до конца партии.
    const value = opt.score * ctx.t.economy * (opt.urgent ? 1 : early);
    out.push({ action: { type: 'build', at: { x: opt.tile.x, y: opt.tile.y }, building: opt.type }, score: value });
  }
  return out;
}

function researchCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const { me } = ctx;
  const techs = techsFor(ctx.era);
  const atWarNow = ctx.strategy !== 'expand' || ctx.threat > 0;
  // Логистика (+1⚡ в ход) окупается сразу; экономика — медленно; боевые — когда идёт война.
  const base: Record<TechType, number> = { logistics: 245, economy: 175, attack: 170, defense: 140 };
  if (ctx.strategy === 'expand') {
    base.economy += 25;
    base.attack -= 30;
    base.defense -= 30;
  }
  if (atWarNow) {
    base.attack += 50;
    base.defense += 30;
  }
  if (ctx.strategy === 'defense') base.defense += 40;
  if (ctx.strategy === 'offensive') base.attack += 30;
  if (ctx.level === 'hard' && atWarNow) {
    base.attack += 20;
    base.defense += 20;
  }
  if (ctx.level === 'easy') {
    for (const key of Object.keys(base) as TechType[]) base[key] = 160 + ctx.rand() * 60;
  }
  for (const tech of Object.keys(techs) as TechType[]) {
    const level = me.tech[tech];
    if (level >= techs[tech].maxLevel) continue;
    const cost = techCostFor(me, level);
    if (!canAfford(me.resources, cost)) continue;
    // Не выгребаем казну до нуля: оставляем на наём.
    if (ctx.level !== 'easy' && me.resources.gold - cost.gold < 8 && ctx.threat > 0) continue;
    let score = base[tech] - level * 25;
    if (tech === 'economy' && ctx.roundsLeft < 6) score -= 120;
    if (tech === 'logistics' && level >= 2) score -= 60;
    // Первый уровень логистики — лишнее действие каждый ход до конца партии: берём, как только есть на что.
    if (tech === 'logistics' && level === 0 && ctx.view.round >= 3) score += 70;
    out.push({ action: { type: 'research', tech }, score: score * ctx.t.research });
  }
  return out;
}

// ── Бой ────────────────────────────────────────────────────────────────────

function squadOf(from: Tile, count: number, minMp = 1, only?: UnitId): Army {
  return wingsToArmy(takeFromWings(ensureWings(from), count, only, minMp).taken);
}

function tileValue(ctx: Ctx, tile: Tile): number {
  let value = 8 + armyCount(tile.army) * 1.2;
  if (tile.building) value += 6;
  if (tile.capitalOf) value += 70;
  if (tile.terrain === 'hills') value += 2;
  return value;
}

function attackCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const { me, view, t } = ctx;
  const shift = { expand: 0, front: 0, offensive: -0.1, defense: 0.1 }[ctx.strategy];
  for (const from of ctx.stacks) {
    if (from.routedTurns > 0 || from.movesLeft < 1 || squarePinned(view, from)) continue;
    const wings = ensureWings(from);
    const mobile = mobileCount(wings);
    if (mobile < 1) continue;
    const isCapital = from.capitalOf === me.id;
    const nearThreat = isCapital && ctx.threat > 0;
    const spare = isCapital ? Math.max(0, armyCount(from.army) - garrisonOf(ctx, from)) : armyCount(from.army);
    // Гарнизон столицы бьёт только то, что рядом со стенами, и не уходит целиком.
    const count = Math.min(mobile, nearThreat ? armyCount(from.army) : Math.max(spare, isCapital ? 0 : 1));
    if (count < 1) continue;

    const targets: { to: Tile; charge: boolean }[] = [];
    for (const to of neighbors(view, from)) {
      if (!TERRAIN[to.terrain].passable) continue;
      if (!to.ownerId || to.ownerId === me.id || !atWar(view, me.id, to.ownerId)) continue;
      if (armyCount(to.army) < 1) continue;
      targets.push({ to, charge: false });
    }
    // Набег с двух гексов — если умеют все.
    const chargers = mobileCount(wings, undefined, CHARGE_COST);
    if (chargers >= 1 && from.routedTurns === 0) {
      const sq = squadOf(from, Math.min(count, chargers), CHARGE_COST);
      if (armyCanCharge(sq)) {
        for (const to of view.tiles) {
          if (hexDistance(from, to) !== 2 || !to.ownerId || to.ownerId === me.id) continue;
          if (!atWar(view, me.id, to.ownerId) || armyCount(to.army) < 1 || to.terrain === 'forest') continue;
          if (!TERRAIN[to.terrain].passable || !chargePathOpen(view, from, to, me.id)) continue;
          targets.push({ to, charge: true });
        }
      }
    }

    for (const { to, charge } of targets) {
      const defender = to.ownerId ? playerById(view, to.ownerId) : undefined;
      const minMp = charge ? CHARGE_COST : 1;
      const send = Math.min(count, mobileCount(wings, undefined, minMp));
      if (send < 1) continue;
      const taken = squadOf(from, send, minMp);
      const cmd = send === armyCount(from.army) ? from.commander : null;
      const alone = battleForecastRatio(view, me, taken, to, defender, charge, {}, cmd);
      let ratio = alone;
      let support: Tile[] = [];
      if (t.joint) {
        const helpers = allyStacksCovering(view, me.id, to, from).filter((h) => h.capitalOf !== me.id || ctx.threat === 0);
        if (helpers.length > 0) {
          const together = battleForecastRatio(view, me, taken, to, defender, charge, sumArmies(helpers), cmd);
          if (together > ratio * 1.05) {
            ratio = together;
            support = helpers;
          }
        }
      }
      const closeToHome = ctx.capital ? hexDistance(to, ctx.capital) <= 2 : false;
      const needed = t.attackRatio + shift - (closeToHome ? 0.15 : 0) - (to.capitalOf ? 0.1 : 0);
      if (ratio < needed) continue;
      // Разгром (×4) сносит стек почти без потерь — такие удары лучшие.
      const crush = ratio >= 4 ? 60 : 0;
      const score = 300 + tileValue(ctx, to) * 4 + Math.min(ratio - needed, 2) * 40 + crush + (charge ? -10 : 0);
      out.push({
        action: {
          type: 'move',
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y },
          count: send,
          ...(support.length > 0 ? { supportFrom: support.map((h) => ({ x: h.x, y: h.y })) } : {}),
        },
        score,
      });
    }
  }
  return out;
}

function volleyCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const { me, view, t } = ctx;
  for (const from of ctx.stacks) {
    if (from.routedTurns > 0 || from.shotsLeft < 1) continue;
    const marched = tileHasMarched(from, ctx.era, 0);
    if (marched && armyHasHeavyArtillery(from.army, ctx.era)) continue;
    const range = armyRange(from.army, ctx.era, from.terrain);
    if (range < 1) continue;
    for (const to of ctx.enemies) {
      const dist = hexDistance(from, to);
      if (dist < 1 || dist > range) continue;
      const shooters = volleyArmy(from.army, ctx.era, dist, from.terrain);
      if (armyCount(shooters) < 1) continue;
      const attack =
        armyPower(shooters, 'attack', dominantClass(to.army), to.terrain, { volley: true, fromTerrain: from.terrain, era: ctx.era }) *
        (marched ? MOVED_VOLLEY : 1) *
        0.9;
      const owner = to.ownerId ? playerById(view, to.ownerId) : undefined;
      const defense =
        armyPower(to.army, 'defense', 'archer', to.terrain, { era: ctx.era }) * defenseMultiplier(view, to, owner, true);
      const ratio = attack / Math.max(defense, 0.001);
      if (ratio < t.volleyRatio * 0.55) continue;
      // После залпа стоит весь стек. Главный стек в наступлении лучше идёт вперёд, если стрелков в нём мало.
      const frozen =
        ctx.strategy === 'offensive' && ctx.rally && key(ctx.rally) === key(from) && !armyCanKite(from.army) && hexDistance(from, to) > 1;
      out.push({
        action: { type: 'shoot', from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } },
        score: 330 + Math.min(ratio, 3) * 30 + tileValue(ctx, to) - (frozen ? 160 : 0),
      });
    }
  }
  return out;
}

function squareCands(ctx: Ctx): Cand[] {
  if (ctx.era !== 'napoleonic' || !ctx.t.square) return [];
  const out: Cand[] = [];
  for (const tile of ctx.stacks) {
    if (tile.square || !canFormSquare(tile)) continue;
    const cavalryNear = neighbors(ctx.view, tile).some(
      (n) => n.ownerId && n.ownerId !== ctx.me.id && atWar(ctx.view, ctx.me.id, n.ownerId) && armyCount(n.army) > 0 && n.army && dominantClass(n.army) === 'cavalry',
    );
    if (cavalryNear) out.push({ action: { type: 'formSquare', at: { x: tile.x, y: tile.y } }, score: 520 });
  }
  return out;
}

// ── Движение: захват земли ─────────────────────────────────────────────────

/** Сколько стоит занять клетку (в «клетках»): доход, отнятая у врага земля, постройка, опасность. */
function claimGain(ctx: Ctx, t: Tile): number {
  const inc = TERRAIN[t.terrain].income;
  let g = 0.7 + 0.12 * (inc.gold ?? 0) + 0.08 * (inc.food ?? 0) + 0.1 * (inc.iron ?? 0);
  // Вражеская клетка — вдвойне: нам доход, ему убыток.
  if (t.ownerId) g += 0.8;
  if (t.building) g += 0.5;
  // В конце партии каждая клетка — это очки.
  if (ctx.roundsLeft <= 2) g *= 1.4;
  // Под носом у вражеского стека клетку быстро отнимут.
  if (dangerAt(ctx, t) > 0) g *= 0.4;
  return g;
}

/** Ничьих клеток вокруг — как много ещё можно будет занять отсюда. */
function claimableAround(ctx: Ctx, t: Coord): number {
  let n = 0;
  for (const nb of neighbors(ctx.view, t)) if (isClaimable(ctx, nb)) n += 1;
  return n;
}

/**
 * Лучший путь одного отряда с запасом хода `moves`: максимум занятых клеток по пути.
 * Возвращает первый шаг и выгоду (в «клетках»). Путь не длиннее 3 шагов.
 */
function bestRide(ctx: Ctx, start: Tile, army: Army, moves: number): { first: Tile; gain: number } | null {
  let best: { first: Tile; gain: number } | null = null;
  const taken = new Set<string>();
  const walk = (cur: Tile, left: number, got: number, first: Tile | null, depth: number) => {
    for (const n of neighbors(ctx.view, cur)) {
      if (!canEnter(ctx, n)) continue;
      const k = key(n);
      const halt = moveHaltsOnEnter(army, n.terrain, left);
      const next = halt ? 0 : Math.max(0, left - Math.min(enterMoveCost(army, n.terrain), left));
      const add = !taken.has(k) && isClaimable(ctx, n) ? claimGain(ctx, n) : 0;
      const total = got + add;
      const f = first ?? n;
      // Небольшая добавка за то, что с конечной клетки можно расти дальше.
      const value = total + 0.05 * claimableAround(ctx, n);
      if (total > 0 && (!best || value > best.gain + 1e-9)) best = { first: f, gain: value };
      if (next > 0 && depth < 3) {
        if (add > 0) taken.add(k);
        walk(n, next, total, f, depth + 1);
        if (add > 0) taken.delete(k);
      }
    }
  };
  walk(start, moves, 0, null, 1);
  return best;
}

function isFreeMove(ctx: Ctx, from: Tile, count: number, only?: UnitId): boolean {
  const taken = takeFromWings(ensureWings(from), count, only, 1).taken;
  return wingsAlreadyMarching(taken, from.commander ? COMMANDERS[from.commander].speedBonus : 0, ctx.era);
}

function moveAction(from: Coord, to: Coord, count: number, unit?: UnitId): GameAction {
  return {
    type: 'move',
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
    count,
    ...(unit ? { unit } : {}),
  };
}

/**
 * Захват земли. Табун всадников за одно действие выходит на шаг, после чего каждый всадник
 * бесплатно (поход уже начат) расходится по ничьим клеткам — одно действие даёт до 10+ клеток.
 */
function expandCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const { me, view } = ctx;
  const rider = ctx.rider;
  const nearFront = (t: Coord) => ctx.enemyNear.some((e) => hexDistance(e, t) <= 2);
  for (const from of ctx.stacks) {
    if (from.routedTurns > 0 || from.movesLeft < 1 || squarePinned(view, from)) continue;
    const wings = ensureWings(from);
    const isCapital = from.capitalOf === me.id;
    const total = armyCount(from.army);
    const spare = isCapital ? Math.max(0, total - garrisonOf(ctx, from)) : total;
    // Стек на точке сбора и у фронта не растаскиваем — там нужен кулак.
    const holding = ctx.strategy !== 'expand' && ((ctx.rally && key(ctx.rally) === key(from)) || nearFront(from));

    // 1. Всадники: сначала бесплатные продолжения, потом табун или одиночный выезд.
    const riders = rider ? mobileCount(wings, rider) : 0;
    if (rider && riders > 0 && (!holding || total === riders)) {
      const one = squadOf(from, 1, 1, rider);
      const oneMoves = takeFromWings(wings, 1, rider, 1).taken[0]?.movesLeft ?? 0;
      const free = isFreeMove(ctx, from, 1, rider);
      const ride = bestRide(ctx, from, one, oneMoves);
      if (free) {
        if (ride) out.push({ action: moveAction(from, ride.first, 1, rider), score: 640 + ride.gain * 10 });
      } else if (me.actionsLeft > 0) {
        const pool = isCapital ? Math.min(riders, spare) : riders;
        if (ride && pool >= 1) out.push({ action: moveAction(from, ride.first, 1, rider), score: 190 + ride.gain * 16 });
        // Табун: k всадников на соседнюю клетку, дальше они разойдутся бесплатно.
        if (ctx.t.herds && pool >= 2) {
          const speed = armySpeed({ [rider]: 1 }, ctx.era);
          for (const hub of neighbors(view, from)) {
            if (!canEnter(ctx, hub)) continue;
            const halt = moveHaltsOnEnter(one, hub.terrain, speed);
            const left = halt ? 0 : speed - Math.min(enterMoveCost(one, hub.terrain), speed);
            if (left < 1) continue;
            let region = 0;
            let regionGain = 0;
            for (const t of view.tiles) {
              if (t === hub || hexDistance(t, hub) > left || !isClaimable(ctx, t)) continue;
              region += 1;
              regionGain += claimGain(ctx, t);
            }
            if (region < 2) continue;
            const k = Math.max(2, Math.min(pool, Math.ceil(region / left)));
            const avg = regionGain / region;
            const gain = (isClaimable(ctx, hub) ? claimGain(ctx, hub) : 0) + Math.min(region, k * left) * avg * 0.8;
            out.push({ action: moveAction(from, hub, k, rider), score: 190 + gain * 16 });
          }
        }
      }
    }

    // 2. Прочие войска — по клетке за действие, и только лишние (не гарнизон и не кулак у фронта).
    if (me.actionsLeft < 1 || holding || spare < 1) continue;
    if (ctx.strategy === 'defense') continue;
    for (const to of neighbors(view, from)) {
      if (!isClaimable(ctx, to)) continue;
      const one = squadOf(from, 1);
      if (armyCount(one) < 1 || (rider && (one[rider] ?? 0) > 0)) continue;
      let score = 175 + claimGain(ctx, to) * 20;
      if (ctx.t.cautious && dangerAt(ctx, to) > defensePowerAt(ctx, one, to, 'infantry') * 1.1) score -= 150;
      if (ctx.level === 'easy') score += ctx.rand() * 40;
      out.push({ action: moveAction(from, to, 1), score });
    }
  }
  return out;
}

/** Всадники без ничьей земли рядом — едут к ближайшей (или вливаются в армию). */
function riderRelocateCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const rider = ctx.rider;
  if (!rider || ctx.me.actionsLeft < 1 || ctx.claimCount === 0) return out;
  const field = distField(
    ctx,
    ctx.view.tiles.filter((t) => isClaimable(ctx, t) && dangerAt(ctx, t) === 0),
    10,
  );
  for (const from of ctx.stacks) {
    if (from.routedTurns > 0 || from.movesLeft < 1) continue;
    const wings = ensureWings(from);
    const n = mobileCount(wings, rider);
    if (n < 1 || isFreeMove(ctx, from, n, rider)) continue;
    if (from.capitalOf === ctx.me.id && armyCount(from.army) - n < garrisonOf(ctx, from) && ctx.strategy === 'defense') continue;
    const d = field.get(key(from));
    if (d === undefined || d <= 3) continue;
    const next = neighbors(ctx.view, from)
      .filter((t) => canEnter(ctx, t) && (field.get(key(t)) ?? 99) < d)
      .sort((a, b) => (field.get(key(a)) ?? 99) - (field.get(key(b)) ?? 99))[0];
    if (!next) continue;
    out.push({ action: moveAction(from, next, n, rider), score: 150 + Math.min(n, 6) * 6 });
  }
  return out;
}

// ── Движение: фронт, резервы, наступление ─────────────────────────────────

/** Резервы идут к точке сбора (фронт/оборона) или к главному стеку (наступление). */
function reinforceCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const rally = ctx.rally;
  if (!rally || !ctx.t.fronts) return out;
  const { me, view } = ctx;
  const field = distField(ctx, [rally], 30);
  const riderLand = ctx.claimCount > 0 && ctx.strategy !== 'defense';
  for (const from of ctx.stacks) {
    if (key(from) === key(rally)) continue;
    if (from.routedTurns > 0 || from.movesLeft < 1 || squarePinned(view, from)) continue;
    const d = field.get(key(from));
    if (d === undefined || d < 1) continue;
    const wings = ensureWings(from);
    const mobile = mobileCount(wings);
    const isCapital = from.capitalOf === me.id;
    const spare = isCapital ? Math.max(0, armyCount(from.army) - garrisonOf(ctx, from)) : armyCount(from.army);
    let send = Math.min(mobile, spare);
    // Из столицы — только заметными группами, иначе гарнизон пополняется и тут же уходит.
    if (isCapital && send < 3 && ctx.strategy !== 'defense') continue;
    // Всадники, у которых ещё есть земля для захвата, остаются на экспансии.
    if (riderLand && ctx.rider && (from.army[ctx.rider] ?? 0) === armyCount(from.army)) {
      const one = squadOf(from, 1, 1, ctx.rider);
      if (bestRide(ctx, from, one, armySpeed(one, ctx.era))) continue;
    }
    if (send < 1) continue;
    // Одиночек через полкарты не гоняем — дорого по действиям.
    if (send < 2 && d > 3 && ctx.strategy !== 'defense') continue;
    const next = neighbors(view, from)
      .filter((t) => canEnter(ctx, t) && (field.get(key(t)) ?? 99) < d)
      .sort((a, b) => (field.get(key(a)) ?? 99) - (field.get(key(b)) ?? 99) || (a.ownerId === me.id ? -1 : 1))[0];
    if (!next) continue;
    const squad = squadOf(from, send);
    if (ctx.t.cautious && ctx.strategy !== 'defense') {
      const danger = threatAround(ctx, next, 1);
      if (danger.power > defensePowerAt(ctx, squad, next, danger.vs) * 1.2) continue;
    }
    const free = isFreeMove(ctx, from, send);
    if (!free && me.actionsLeft < 1) continue;
    const base = { expand: 0, front: 205, offensive: 225, defense: 330 }[ctx.strategy];
    const score = (free ? 560 : base) + Math.min(d, 8) * 5 + Math.min(send, 12) * 4;
    out.push({ action: moveAction(from, next, send), score });
  }
  return out;
}

/** Наступление: главный стек идёт к вражеской столице или к ближайшему видимому врагу. */
function advanceCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const lead = ctx.rally;
  if (ctx.strategy !== 'offensive' || !lead || lead.ownerId !== ctx.me.id) return out;
  if (lead.routedTurns > 0 || lead.movesLeft < 1 || squarePinned(ctx.view, lead)) return out;
  // Цель — вражеская столица; на видимый стек сворачиваем, только если он заметный (иначе кулак гоняется за разъездами).
  const leadPower = attackPowerOf(ctx, lead);
  const big = ctx.enemyNear.filter((e) => attackPowerOf(ctx, e) >= leadPower * 0.25);
  const targets: Coord[] = [...ctx.goals, ...big];
  if (targets.length === 0) return out;
  const field = distField(ctx, targets, 40);
  const d = field.get(key(lead));
  if (d === undefined || d <= 1) return out;
  const wings = ensureWings(lead);
  const isCapital = lead.capitalOf === ctx.me.id;
  const send = Math.min(mobileCount(wings), isCapital ? Math.max(0, armyCount(lead.army) - garrisonOf(ctx, lead)) : armyCount(lead.army));
  if (send < 3) return out;
  const squad = squadOf(lead, send);
  const next = neighbors(ctx.view, lead)
    .filter((t) => canEnter(ctx, t) && (field.get(key(t)) ?? 99) < d)
    .sort((a, b) => (field.get(key(a)) ?? 99) - (field.get(key(b)) ?? 99) || (b.terrain === 'hills' ? 1 : 0) - (a.terrain === 'hills' ? 1 : 0))[0];
  if (!next) return out;
  const danger = threatAround(ctx, next, 1);
  if (danger.power > defensePowerAt(ctx, squad, next, danger.vs) * 1.1) return out;
  const free = isFreeMove(ctx, lead, send);
  if (!free && ctx.me.actionsLeft < 1) return out;
  out.push({ action: moveAction(lead, next, send), score: (free ? 580 : 285) + (isClaimable(ctx, next) ? 10 : 0) });
  return out;
}

/** Срочное подтягивание стека к столице, если ей угрожают. */
function rescueCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const cap = ctx.capital;
  if (!cap || ctx.threat <= 0) return out;
  const garrison = defensePowerAt(ctx, cap.army, cap, ctx.threatClass ?? 'infantry');
  if (garrison > ctx.threat * 1.2) return out;
  for (const from of ctx.stacks) {
    if (from === cap || from.routedTurns > 0 || from.movesLeft < 1 || hexDistance(from, cap) > 4) continue;
    const mobile = mobileCount(ensureWings(from));
    if (mobile < 1) continue;
    for (const to of neighbors(ctx.view, from)) {
      if (hexDistance(to, cap) >= hexDistance(from, cap) || !canEnter(ctx, to)) continue;
      out.push({ action: moveAction(from, to, mobile), score: 700 });
    }
  }
  return out;
}

/** Стратегия ИИ на этот момент — для тестов и отладки. */
export function aiStrategyOf(view: GameState, aiId: string): AiStrategy | null {
  const me = playerById(view, aiId);
  if (!me || !me.alive || view.phase !== 'playing') return null;
  return buildCtx(view, me).strategy;
}

/** Варианты следующего действия ИИ по убыванию ценности; в конце всегда «конец хода». */
export function planAiTurn(view: GameState, aiId: string): GameAction[] {
  const me = playerById(view, aiId);
  if (!me || !me.alive || view.phase !== 'playing') return [];
  const ctx = buildCtx(view, me);
  const cands: Cand[] = [];

  const choice = eventChoiceCand(ctx);
  if (choice) cands.push(choice);
  for (const action of planAiDiplomacy(view, aiId)) cands.push({ action, score: 900 });
  if (view.pendingSquare) return cands.map((c) => c.action);

  if (me.actionsLeft > 0) {
    cands.push(
      ...rescueCands(ctx),
      ...recruitCands(ctx),
      ...buildCands(ctx),
      ...researchCands(ctx),
      ...attackCands(ctx),
      ...volleyCands(ctx),
      ...squareCands(ctx),
      ...riderRelocateCands(ctx),
    );
  }
  // Бесплатные продолжения похода движок не берёт за действие — их ищем и без запаса ⚡.
  cands.push(...expandCands(ctx), ...reinforceCands(ctx), ...advanceCands(ctx));

  cands.sort((a, b) => b.score - a.score);
  // Лёгкий ИИ иногда «зевает» и пропускает лучшее решение.
  if (ctx.t.skip > 0 && cands.length > 1 && ctx.rand() < ctx.t.skip) {
    const idx = cands.findIndex((c) => c.score < 900);
    if (idx >= 0) cands.splice(idx, 1);
  }
  const plan = cands.slice(0, 8).map((c) => c.action);
  plan.push({ type: 'endTurn' });
  return plan;
}

/** Ответ обороны ИИ на предложение каре. */
export function aiSquareReply(view: GameState, aiId: string): boolean {
  const pending = view.pendingSquare;
  const me = playerById(view, aiId);
  if (!pending || !me) return false;
  const to = tileAt(view, pending.to.x, pending.to.y);
  if (!to || !canFormSquare(to)) return false;
  if (me.actionsLeft < 1 && to.square !== true) {
    // Каре стоит действие в ход — без запаса действий держать его нечем.
    return false;
  }
  const level = me.ai ?? 'normal';
  if (level === 'easy') return armyCount(to.army) % 2 === 0;
  return true;
}

export interface AiStep {
  action: GameAction | null;
  result: ActionResult | null;
  attempts: number;
  rejected: number;
  /** Тексты отказов движка — для разбора в тестах. */
  errors: string[];
}

/**
 * Один шаг ИИ на настоящем состоянии: строит вид, просит план, применяет первое удавшееся
 * действие. Не удалось ничего — заканчивает ход. Дальше решает вызывающий (пауза, рассылка).
 */
export function stepAi(state: GameState, aiId: string): AiStep {
  if (state.phase !== 'playing') return { action: null, result: null, attempts: 0, rejected: 0, errors: [] };
  rememberSeenBuildings(state, aiId);
  const view = publicView(state, aiId);

  if (state.pendingSquare && state.pendingSquare.defenderId === aiId) {
    const action: GameAction = { type: 'squareReply', form: aiSquareReply(view, aiId) };
    const result = applyAction(state, aiId, action);
    if (result.ok) autoEndTurnIfExhausted(state);
    return { action, result, attempts: 1, rejected: result.ok ? 0 : 1, errors: result.ok ? [] : [result.error] };
  }

  const plan = planAiTurn(view, aiId);
  let attempts = 0;
  let rejected = 0;
  const errors: string[] = [];
  for (const action of plan) {
    attempts += 1;
    const result = applyAction(state, aiId, action);
    if (result.ok) {
      if (action.type !== 'endTurn') autoEndTurnIfExhausted(state);
      return { action, result, attempts, rejected, errors };
    }
    rejected += 1;
    errors.push(`${action.type}: ${result.error}`);
  }
  // План пуст (ждём ответа обороны) или ничего не прошло.
  if (state.pendingSquare) return { action: null, result: null, attempts, rejected, errors };
  attempts += 1;
  const result = applyAction(state, aiId, { type: 'endTurn' });
  if (!result.ok) rejected += 1;
  return { action: { type: 'endTurn' }, result, attempts, rejected, errors };
}
