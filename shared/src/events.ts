import type { EraId, Resources } from './types.js';

/**
 * Случайные события державы. Здесь — только данные и выбор события;
 * применение эффектов — в engine.ts (`applyEventEffect`).
 * Все числа баланса — в этой таблице.
 */

export type EventTone = 'good' | 'bad' | 'mixed';

/** Срез состояния игрока, по которому проверяются условия событий. */
export interface EventContext {
  round: number;
  tiles: number;
  farms: number;
  mines: number;
  markets: number;
  plains: number;
  hills: number;
  /** Свои леса без войск (могут сгореть). */
  freeForests: number;
  army: number;
  gold: number;
  actionsLeft: number;
  /** Идёт стройка / стройка на 2+ хода. */
  constructions: number;
  longConstructions: number;
  /** Стеки с запасом хода. */
  movingStacks: number;
  hasCapital: boolean;
  capitalHasArmy: boolean;
  capitalHasCommander: boolean;
  /** Соседние с моими клетками вражеские стеки (те, с кем война). */
  enemyNeighbors: number;
  /** Живые соперники, с которыми нет договора. */
  rivals: number;
}

export type EventParams = Record<string, number>;

export interface EventDef {
  id: string;
  icon: string;
  tone: EventTone;
  weight: number;
  name: string;
  text: string;
  /** Подписи под эпоху, где они отличаются. */
  flavor?: Partial<Record<EraId, { name?: string; text?: string }>>;
  /** Числа события. */
  p: EventParams;
  when?: (c: EventContext, p: EventParams) => boolean;
  /** Выбор игрока: [0] «отказаться» (по умолчанию к концу хода), [1] согласиться. */
  choice?: { decline: string; accept: string; cost?: Partial<Resources> };
}

/** Общие правила бросков. */
export const EVENT_RULES = {
  /** С какого раунда бывают события. */
  startRound: 3,
  /** Шанс события за ход игрока. */
  chance: 0.25,
  /** Сколько ходов игрока после события пауза. */
  cooldownTurns: 2,
  /** Одно и то же событие у игрока не повторяется столько раундов. */
  repeatRounds: 5,
  /** Мягкая подтяжка: отстающему хорошие события чаще, лидеру плохие. */
  laggingGoodMul: 1.5,
  leaderBadMul: 1.5,
};

export const EVENT_DEFS: EventDef[] = [
  {
    id: 'harvest',
    icon: '🌾',
    tone: 'good',
    weight: 10,
    name: 'Богатый урожай',
    text: 'Амбары ломятся: часть урожая пришла сверх обычного.',
    p: { pct: 0.5, farms: 1, plains: 3 },
    when: (c, p) => c.farms >= p.farms! || c.plains >= p.plains!,
  },
  {
    id: 'crop_failure',
    icon: '🥀',
    tone: 'bad',
    weight: 10,
    name: 'Неурожай',
    text: 'Поля побило градом — еды будет меньше.',
    p: { mul: 0.7, turns: 2, farms: 1 },
    when: (c, p) => c.farms >= p.farms!,
  },
  {
    id: 'drought',
    icon: '☀️',
    tone: 'bad',
    weight: 8,
    name: 'Засуха',
    text: 'Степи выжжены, зерна почти нет.',
    p: { mul: 0.5, turns: 1, plains: 4 },
    when: (c, p) => c.plains >= p.plains!,
  },
  {
    id: 'gold_vein',
    icon: '💰',
    tone: 'good',
    weight: 8,
    name: 'Золотая жила',
    text: 'В холмах нашли самородки.',
    p: { gold: 40 },
    when: (c) => c.hills >= 1 || c.mines >= 1,
  },
  {
    id: 'mine_collapse',
    icon: '⛏️',
    tone: 'bad',
    weight: 8,
    name: 'Обвал в шахте',
    text: 'Штольню завалило — железа добывают вполовину.',
    p: { mul: 0.5, turns: 2 },
    when: (c) => c.mines >= 1,
  },
  {
    id: 'caravan',
    icon: '🐪',
    tone: 'mixed',
    weight: 8,
    name: 'Караван купцов',
    text: 'Купцы предлагают выгодный обмен: зерно на золото.',
    p: { food: 20, gold: 35 },
    when: (c) => c.markets >= 1 || c.hasCapital,
    choice: { decline: 'Отказаться', accept: 'Обменять 20🌾 на 35🪙', cost: { food: 20 } },
  },
  {
    id: 'patron',
    icon: '🎁',
    tone: 'good',
    weight: 8,
    name: 'Меценат',
    text: 'Богатый покровитель жертвует державе казну и металл.',
    p: { gold: 25, iron: 10 },
  },
  {
    id: 'pilgrims',
    icon: '🚶',
    tone: 'good',
    weight: 8,
    name: 'Паломники',
    text: 'Странники оставляют дары и провизию.',
    p: { gold: 10, food: 10 },
  },
  {
    id: 'tax_revolt',
    icon: '🔥',
    tone: 'bad',
    weight: 8,
    name: 'Налоговый бунт',
    text: 'Окраины отказываются платить. Откупиться или потерять пустую клетку?',
    p: { tiles: 12, gold: 30 },
    when: (c, p) => c.tiles >= p.tiles!,
    choice: { decline: 'Не платить: одна пустая клетка отпадёт', accept: 'Откупиться: 30🪙', cost: { gold: 30 } },
  },
  {
    id: 'camp_plague',
    icon: '☠️',
    tone: 'bad',
    weight: 8,
    name: 'Мор в лагере',
    text: 'Болезнь косит самый большой стек.',
    p: { pct: 0.1, army: 10 },
    when: (c, p) => c.army >= p.army!,
  },
  {
    id: 'volunteers',
    icon: '🙋',
    tone: 'good',
    weight: 8,
    name: 'Добровольцы',
    text: 'Молодёжь сама идёт под знамёна.',
    p: { count: 3 },
    when: (c) => c.hasCapital,
  },
  {
    id: 'mercenaries',
    icon: '🗡️',
    tone: 'mixed',
    weight: 7,
    name: 'Наёмники',
    text: 'Профессиональные бойцы предлагают службу за золото.',
    flavor: {
      ancient: { name: 'Наёмные всадники', text: 'Отряд опытных всадников предлагает службу за золото.' },
      medieval: { name: 'Наёмная рыцарская дружина', text: 'Вольная дружина ищет нанимателя.' },
      napoleonic: { name: 'Полк наёмников', text: 'Вольный кавалерийский полк ищет нанимателя.' },
    },
    p: { gold: 40, count: 3 },
    when: (c, p) => c.gold >= p.gold! && c.hasCapital,
    choice: { decline: 'Отказаться', accept: 'Нанять за 40🪙', cost: { gold: 40 } },
  },
  {
    id: 'holiday',
    icon: '🎉',
    tone: 'good',
    weight: 8,
    name: 'Праздник',
    text: 'Народ ликует, дела спорятся: +1⚡ в этот ход.',
    p: { actions: 1 },
  },
  {
    id: 'court_intrigue',
    icon: '🎭',
    tone: 'bad',
    weight: 7,
    name: 'Смута при дворе',
    text: 'Придворные заняты интригами: −1⚡ в этот ход.',
    p: { actions: 1, minActions: 2 },
    when: (c, p) => c.actionsLeft >= p.minActions!,
  },
  {
    id: 'scholar',
    icon: '📚',
    tone: 'good',
    weight: 8,
    name: 'Учёный из-за моря',
    text: 'Следующая технология обойдётся вполовину дешевле.',
    p: { discount: 0.5, turns: 10 },
  },
  {
    id: 'smiths',
    icon: '🔨',
    tone: 'good',
    weight: 8,
    name: 'Кузнецы',
    text: 'Мастера прислали партию отличного железа.',
    p: { iron: 20 },
  },
  {
    id: 'forest_fire',
    icon: '🌲',
    tone: 'bad',
    weight: 7,
    name: 'Лесной пожар',
    text: 'Огонь пожрал лес — на его месте равнина.',
    p: {},
    when: (c) => c.freeForests >= 1,
  },
  {
    id: 'flood',
    icon: '🌊',
    tone: 'bad',
    weight: 7,
    name: 'Наводнение',
    text: 'Паводок размыл строительную площадку: стройка задерживается на ход.',
    p: { turns: 1 },
    when: (c) => c.constructions >= 1,
  },
  {
    id: 'master_builders',
    icon: '🏗️',
    tone: 'good',
    weight: 7,
    name: 'Мастера-строители',
    text: 'Приезжие мастера ускоряют все стройки на ход.',
    p: { turns: 1 },
    when: (c) => c.longConstructions >= 1,
  },
  {
    id: 'morale',
    icon: '🚩',
    tone: 'good',
    weight: 8,
    name: 'Боевой дух',
    text: 'Войска рвутся в бой: +10% к атаке на 2 хода.',
    p: { mul: 1.1, turns: 2, army: 5 },
    when: (c, p) => c.army >= p.army!,
  },
  {
    id: 'fever',
    icon: '🤒',
    tone: 'bad',
    weight: 6,
    name: 'Лихорадка',
    text: 'Самый большой стек слёг и не может идти в этот ход.',
    p: {},
    when: (c) => c.movingStacks >= 1,
  },
  {
    id: 'hero',
    icon: '🦸',
    tone: 'good',
    weight: 6,
    name: 'Герой из народа',
    text: 'В столице объявился талантливый командир — бесплатно.',
    p: {},
    when: (c) => c.hasCapital && c.capitalHasArmy && !c.capitalHasCommander,
  },
  {
    id: 'defectors',
    icon: '🏃',
    tone: 'good',
    weight: 6,
    name: 'Перебежчики',
    text: 'Часть вражеского отряда перешла на вашу сторону.',
    p: { count: 2 },
    when: (c) => c.enemyNeighbors >= 1 && c.hasCapital,
  },
  {
    id: 'spy',
    icon: '🕵️',
    tone: 'good',
    weight: 6,
    name: 'Шпион',
    text: 'Лазутчик донёс, что строят враги у своей столицы.',
    p: { radius: 2 },
    when: (c) => c.rivals >= 1,
  },
];

export function eventById(id: string): EventDef | undefined {
  return EVENT_DEFS.find((e) => e.id === id);
}

export function eventName(def: EventDef, era: EraId): string {
  return def.flavor?.[era]?.name ?? def.name;
}

export function eventText(def: EventDef, era: EraId): string {
  return def.flavor?.[era]?.text ?? def.text;
}

/**
 * Выбор события по весам. `roll` — число из [0, 1).
 * `rank`: лидер по очкам получает больше плохих, отстающий — больше хороших.
 */
export function pickEvent(
  ctx: EventContext,
  opts: { recent: ReadonlySet<string>; rank: 'leader' | 'lagging' | 'mid'; roll: number },
): EventDef | null {
  const pool: { def: EventDef; weight: number }[] = [];
  for (const def of EVENT_DEFS) {
    if (opts.recent.has(def.id)) continue;
    if (def.when && !def.when(ctx, def.p)) continue;
    let weight = def.weight;
    if (opts.rank === 'lagging' && def.tone === 'good') weight *= EVENT_RULES.laggingGoodMul;
    if (opts.rank === 'leader' && def.tone === 'bad') weight *= EVENT_RULES.leaderBadMul;
    pool.push({ def, weight });
  }
  const total = pool.reduce((sum, e) => sum + e.weight, 0);
  if (total <= 0) return null;
  let left = opts.roll * total;
  for (const entry of pool) {
    left -= entry.weight;
    if (left < 0) return entry.def;
  }
  return pool[pool.length - 1]!.def;
}
