/**
 * ИИ-соперники. `planAiTurn` — чистая функция: получает вид игры глазами ИИ
 * (туман применён, seed скрыт) и возвращает варианты следующего действия по убыванию
 * ценности. Сервер применяет первое, что прошло, и просит план заново — так ИИ
 * «пересчитывает» после каждого действия. Свой случайный выбор ИИ берёт из mulberry32,
 * а не из nextRandom, чтобы не сдвигать броски боя.
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
import { capitalSpots, chargePathOpen, hexDistance, neighbors, tileAt, walkReachable } from './map.js';
import { mulberry32 } from './rng.js';
import {
  CHARGE_COST,
  armyCanCharge,
  armyCount,
  armyPower,
  armyRange,
  dominantClass,
  ensureWings,
  mobileCount,
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
  },
};

/** Сколько отрядов в раунд ИИ добавляет к плановому размеру армии (6 + раунд × темп). */
const RECRUIT_PACE: Record<AiLevel, number> = { easy: 1.4, normal: 1.3, hard: 1.6 };

/** Кто бьёт какой род: конница — стрелков, стрелки — пехоту, пехота — конницу. */
const COUNTER: Record<UnitClass, UnitClass> = { cavalry: 'infantry', archer: 'cavalry', infantry: 'archer' };

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
  const ctx: Ctx = {
    view,
    me,
    level,
    t: TUNING[level],
    era,
    units: unitsFor(era),
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
  };
  if (capital) {
    const near = enemies.filter((e) => hexDistance(e, capital) <= 3);
    ctx.threat = near.reduce((sum, e) => sum + armyPower(e.army, 'attack', 'infantry', e.terrain, { era }), 0);
    const armyOfNear = near.reduce<Army>((acc, e) => {
      const next = { ...acc };
      for (const [id, n] of Object.entries(e.army)) next[id as UnitId] = (next[id as UnitId] ?? 0) + (n ?? 0);
      return next;
    }, {});
    ctx.threatClass = near.length > 0 ? dominantClass(armyOfNear) : null;
  }
  return ctx;
}

function garrisonOf(ctx: Ctx, tile: Tile): number {
  if (tile.capitalOf !== ctx.me.id) return 0;
  const n = armyCount(tile.army);
  return Math.max(2, Math.ceil(n * ctx.t.garrison));
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
    power += armyPower(e.army, 'attack', 'infantry', e.terrain, { era: ctx.era });
    counts[dominantClass(e.army)] += armyCount(e.army);
  }
  const vs = (Object.keys(counts) as UnitClass[]).sort((a, b) => counts[b] - counts[a])[0] ?? 'infantry';
  return { power, vs };
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
  // Когда железа мало, дорогие по железу отряды не нанять — считаем его дороже.
  const ironWeight = ctx.me.resources.iron < 20 ? 5 : 1.5;
  let best: UnitId = 'medium_infantry';
  let bestValue = -1;
  for (const id of ids) {
    const u = ctx.units[id];
    if (wantClass && u.class !== wantClass) continue;
    // Пехота и конница — основа; чисто стрелковые отряды дают войску дальность, но слабее в рукопашной.
    const strength = u.attack + u.defense + (u.range > 0 ? 0.3 : 0) + (u.charge ? 0.2 : 0);
    const price = (u.cost.gold ?? 0) + ironWeight * (u.cost.iron ?? 0) + 6 * u.upkeep;
    const value = strength / price;
    if (value > bestValue) {
      bestValue = value;
      best = id;
    }
  }
  return best;
}

function recruitCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const { me } = ctx;
  const spots = ctx.mine.filter((t) => t.capitalOf === me.id || (t.building === 'barracks' && !t.construction));
  if (spots.length === 0) return out;
  const power = myPower(ctx);
  const foeStrength = ctx.foes.reduce((sum, f) => sum + visiblePower(ctx, f.id), 0);
  const threatened = ctx.threat > 0;
  const enemyClass = ctx.threatClass ?? (ctx.enemies.length > 0 ? dominantClass(ctx.enemies[0]!.army) : null);
  const foodSlack = Math.max(0, ctx.income.food - ctx.upkeep) + Math.floor(me.resources.food / 5);

  for (const tile of spots) {
    const unit = pickRecruitUnit(ctx, enemyClass);
    const info = ctx.units[unit];
    const cap = maxByBudget(me.resources, info.cost);
    const foodCap = Math.floor((foodSlack + 0.5) / Math.max(0.5, info.upkeep));
    const count = Math.min(cap, foodCap, threatened ? 12 : 8);
    if (count < 1) continue;
    // Сколько войск нужно к этому раунду: ниже плана — наём важнее построек и науки.
    const planned = 6 + ctx.view.round * RECRUIT_PACE[ctx.level];
    let score = totalArmy(ctx.view, me.id) < planned ? 330 : 190;
    // Слабой армии — наём важнее.
    if (power < foeStrength * 0.7) score += 60;
    if (threatened) score += 500 + Math.min(200, ctx.threat * 4);
    // Армия и так большая относительно дохода — не раздуваем.
    if (ctx.upkeep > ctx.income.food + 4 && !threatened) score -= 200;
    out.push({ action: { type: 'recruit', at: { x: tile.x, y: tile.y }, count, unit }, score });
  }
  return out;
}

function buildCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const { me, view } = ctx;
  const buildings = buildingsFor(ctx.era);
  const roundsLeft = view.maxRounds - view.round;
  const early = Math.max(0.35, Math.min(1, roundsLeft / (view.maxRounds * 0.7)));
  const foodMargin = ctx.income.food - ctx.upkeep;
  const starving = foodMargin < 0 && me.resources.food < -foodMargin * 3;

  const free = ctx.mine.filter(
    (t) => !t.building && !t.construction && TERRAIN[t.terrain].passable && armyCount(t.army) >= 0 && !t.capitalOf,
  );
  const safe = free.filter((t) => threatAround(ctx, t, 2).power === 0);
  const pool = safe.length > 0 ? safe : free;
  const pickTile = (rank: (t: Tile) => number): Tile | undefined =>
    [...pool].sort((a, b) => rank(b) - rank(a) || hexDistance(a, ctx.capital ?? a) - hexDistance(b, ctx.capital ?? b))[0];

  const options: { type: BuildingType; tile: Tile | undefined; score: number }[] = [
    {
      // Еды и так хватает — ферма не нужна: сверх запаса еда только копится.
      type: 'farm',
      tile: pickTile((t) => (t.terrain === 'plains' ? 2 : 0) + (t.terrain === 'forest' ? -1 : 0)),
      score: starving ? 700 : foodMargin < 2 && me.resources.food < 60 ? 260 : 0,
    },
    {
      type: 'mine',
      tile: pickTile((t) => (t.terrain === 'hills' ? 3 : t.terrain === 'forest' ? 1 : 0)),
      score: me.resources.iron < 30 && ctx.income.iron < 10 ? 250 : 0,
    },
    // Золото — главное узкое место: рынок окупается за ~8 ходов.
    { type: 'market', tile: pickTile((t) => (t.terrain === 'plains' ? 1 : 0)), score: 235 },
  ];
  // Казармы у границы: армия ближе к фронту.
  if (ctx.level === 'hard' && ctx.goals.length > 0) {
    const goal = ctx.goals[0]!;
    options.push({
      type: 'barracks',
      tile: pool.filter((t) => hexDistance(t, goal) <= 6).sort((a, b) => hexDistance(a, goal) - hexDistance(b, goal))[0],
      score: view.round >= 6 ? 150 : 0,
    });
  }
  for (const opt of options) {
    if (!opt.tile || opt.score <= 0) continue;
    const info = buildings[opt.type];
    if (!canAfford(me.resources, info.cost)) continue;
    // Ферма и рынок окупаются только при запасе ходов до конца партии.
    // Голодная ферма и шахта при нехватке железа нужны всегда, остальное окупается только заранее.
    const urgent = (opt.type === 'farm' && starving) || (opt.type === 'mine' && opt.score >= 250);
    const value = opt.score * ctx.t.economy * (urgent ? 1 : early);
    out.push({ action: { type: 'build', at: { x: opt.tile.x, y: opt.tile.y }, building: opt.type }, score: value });
  }
  return out;
}

function researchCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const { me, view } = ctx;
  const techs = techsFor(ctx.era);
  const atWarNow = ctx.enemies.length > 0 || ctx.threat > 0;
  // Логистика (+1⚡ в ход) окупается сразу; экономика — медленно; боевые — когда идёт война.
  const base: Record<TechType, number> = { logistics: 245, economy: 175, attack: 170, defense: 140 };
  if (atWarNow) {
    base.attack += 50;
    base.defense += 30;
  }
  if (ctx.level === 'hard' && atWarNow) {
    base.attack += 20;
    base.defense += 20;
  }
  if (ctx.level === 'easy') {
    for (const key of Object.keys(base) as TechType[]) base[key] = 160 + ctx.rand() * 60;
  }
  const roundsLeft = view.maxRounds - view.round;
  for (const tech of Object.keys(techs) as TechType[]) {
    const level = me.tech[tech];
    if (level >= techs[tech].maxLevel) continue;
    const cost = techCostFor(me, level);
    if (!canAfford(me.resources, cost)) continue;
    // Не выгребаем казну до нуля: оставляем на наём.
    if (ctx.level !== 'easy' && me.resources.gold - cost.gold < 8 && ctx.threat > 0) continue;
    let score = base[tech] - level * 25;
    if (tech === 'economy' && roundsLeft < 6) score -= 120;
    if (tech === 'logistics' && level >= 2) score -= 60;
    out.push({ action: { type: 'research', tech }, score: score * ctx.t.research });
  }
  return out;
}

// ── Бой и движение ─────────────────────────────────────────────────────────

function squadOf(from: Tile, count: number, minMp = 1): Army {
  return wingsToArmy(takeFromWings(ensureWings(from), count, undefined, minMp).taken);
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
          const merged = helpers.reduce<Army>((acc, h) => {
            const next = { ...acc };
            for (const [id, n] of Object.entries(h.army)) next[id as UnitId] = (next[id as UnitId] ?? 0) + (n ?? 0);
            return next;
          }, {});
          const together = battleForecastRatio(view, me, taken, to, defender, charge, merged, cmd);
          if (together > ratio * 1.05) {
            ratio = together;
            support = helpers;
          }
        }
      }
      const closeToHome = ctx.capital ? hexDistance(to, ctx.capital) <= 2 : false;
      const needed = t.attackRatio - (closeToHome ? 0.15 : 0) - (to.capitalOf ? 0.1 : 0);
      if (ratio < needed) continue;
      const score = 300 + tileValue(ctx, to) * 4 + Math.min(ratio - needed, 2) * 40 + (charge ? -10 : 0);
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
      out.push({
        action: { type: 'shoot', from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } },
        score: 330 + Math.min(ratio, 3) * 30 + tileValue(ctx, to),
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

/** Куда ведёт армию: ближайшая вражеская столица или видимый стек. */
function objectiveFor(ctx: Ctx, from: Coord): Coord | null {
  let best: Coord | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const goal of [...ctx.goals, ...ctx.enemies]) {
    const d = hexDistance(from, goal);
    if (d < bestDist) {
      bestDist = d;
      best = goal;
    }
  }
  return best;
}

/** Рядом с клеткой есть ничья земля — можно расти дальше. */
function nextToUnclaimed(view: GameState, tile: Tile): boolean {
  return neighbors(view, tile).some((n) => TERRAIN[n.terrain].passable && !n.ownerId);
}

function moveCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const { me, view, t } = ctx;
  const foes = ctx.foes.length > 0;
  for (const from of ctx.stacks) {
    if (from.routedTurns > 0 || from.movesLeft < 1 || squarePinned(view, from)) continue;
    const wings = ensureWings(from);
    const mobile = mobileCount(wings);
    if (mobile < 1) continue;
    const isCapital = from.capitalOf === me.id;
    const total = armyCount(from.army);
    const spare = isCapital ? Math.max(0, total - garrisonOf(ctx, from)) : total;
    if (spare < 1) continue;
    const objective = foes ? objectiveFor(ctx, from) : null;
    const reachable = walkReachable(view, from, me.id, 1, false).filter(
      (n) =>
        hexDistance(from, n) === 1 &&
        (!n.ownerId || n.ownerId === me.id || (armyCount(n.army) === 0 && atWar(view, me.id, n.ownerId))),
    );

    for (const to of reachable) {
      const neutral = !to.ownerId || to.ownerId !== me.id;
      const dNow = objective ? hexDistance(from, objective) : 0;
      const dNext = objective ? hexDistance(to, objective) : 0;
      const closer = objective ? dNow - dNext : 0;
      const one = squadOf(from, 1);
      // Без действий можно только продолжить уже начатый поход.
      const affordable = (count: number): boolean =>
        me.actionsLeft > 0 ||
        wingsAlreadyMarching(
          takeFromWings(ensureWings(from), count, undefined, 1).taken,
          from.commander ? COMMANDERS[from.commander].speedBonus : 0,
          ctx.era,
        );
      const safe = (squad: Army, margin: number): boolean => {
        if (!t.cautious) return true;
        const danger = threatAround(ctx, to, 1);
        return danger.power <= defensePowerAt(ctx, squad, to, danger.vs) * margin;
      };

      // Экспансия: занять клетку одним отрядом — земля остаётся за державой и без гарнизона.
      if (neutral) {
        if (!affordable(1)) continue;
        let score = 205 + (TERRAIN[to.terrain].income.gold ?? 0) * 6 + (TERRAIN[to.terrain].income.food ?? 0) * 4;
        if (to.terrain === 'hills') score += 12;
        score += closer * 10;
        if (to.ownerId) score += 25;
        if (ctx.threat > 0 && isCapital) score -= 60;
        if (!safe(one, 1.1)) score -= 150;
        if (ctx.level === 'easy') score += ctx.rand() * 40;
        out.push({
          action: { type: 'move', from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, count: 1 },
          score,
        });
        continue;
      }

      // Дальше — своя территория: подвести одиночку к границе или двинуть армию к цели.
      if (armyCount(to.army) === 0 && nextToUnclaimed(view, to) && (total >= 2 || !isCapital) && affordable(1)) {
        out.push({
          action: { type: 'move', from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, count: 1 },
          score: 170 + closer * 6 + (ctx.level === 'easy' ? ctx.rand() * 30 : 0),
        });
      }
      if (objective && closer > 0 && spare >= 3) {
        const send = Math.min(mobile, spare);
        if (!affordable(send) || !safe(squadOf(from, send), 1.15)) continue;
        if (totalArmy(view, me.id) < (ctx.level === 'hard' ? 8 : 10)) continue;
        out.push({
          action: { type: 'move', from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, count: send },
          score: 160 + closer * 8 + (to.terrain === 'hills' ? 6 : 0),
        });
      }
    }
  }
  return out;
}

/** Срочное подтягивание стека к столице, если ей угрожают. */
function rescueCands(ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const cap = ctx.capital;
  if (!cap || ctx.threat <= 0) return out;
  const garrison = armyPower(cap.army, 'defense', ctx.threatClass ?? 'infantry', cap.terrain, { era: ctx.era }) * defenseMultiplier(ctx.view, cap, ctx.me);
  if (garrison > ctx.threat * 1.2) return out;
  for (const from of ctx.stacks) {
    if (from === cap || from.routedTurns > 0 || from.movesLeft < 1 || hexDistance(from, cap) > 4) continue;
    const mobile = mobileCount(ensureWings(from));
    if (mobile < 1) continue;
    for (const to of walkReachable(ctx.view, from, ctx.me.id, 1, false)) {
      if (hexDistance(from, to) !== 1 || hexDistance(to, cap) >= hexDistance(from, cap)) continue;
      if (to.ownerId && to.ownerId !== ctx.me.id && armyCount(to.army) > 0) continue;
      out.push({
        action: { type: 'move', from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, count: mobile },
        score: 700,
      });
    }
  }
  return out;
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
    );
  }
  // Свободные продолжения похода тоже идут через moveCands (движок не берёт за них действие).
  cands.push(...moveCands(ctx));

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
