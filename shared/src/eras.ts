import type { BuildingInfo, TechInfo } from './config.js';
import { BUILDINGS, TECHS } from './config.js';
import type { CommanderInfo } from './commanders.js';
import { COMMANDERS } from './commanders.js';
import type {
  BuildingType,
  CommanderId,
  EraId,
  Resources,
  ShotKind,
  TechType,
  UnitClass,
  UnitId,
} from './types.js';

export const ERA_IDS: EraId[] = ['ancient', 'medieval', 'napoleonic'];

export function isEraId(value: unknown): value is EraId {
  return value === 'ancient' || value === 'medieval' || value === 'napoleonic';
}

export function eraOf(settings: { era?: EraId } | undefined): EraId {
  return settings?.era && isEraId(settings.era) ? settings.era : 'ancient';
}

export interface EraInfo {
  id: EraId;
  name: string;
  icon: string;
  blurb: string;
  rpsHint: string;
  volleyHint: string;
  chargeLabel: string;
  volleyLabel: string;
  kiteLabel: string;
  kiteMix: string;
  chargeMix: string;
  forestHalt: string;
  beats: Record<UnitClass, string>;
}

export interface UnitFlavor {
  name: string;
  icon: string;
  short: string;
  description: string;
  attack?: number;
  defense?: number;
  speed?: number;
  range?: number;
  shot?: ShotKind;
  cost?: Resources;
}

export const ERAS: Record<EraId, EraInfo> = {
  ancient: {
    id: 'ancient',
    name: 'Античность',
    icon: '🏛️',
    blurb: 'Копья, конница и луки. Текущие правила без переименований.',
    rpsHint:
      'Конница бьёт лучников, лучники — пехоту, пехота — конницу. Конные лучники стреляют с 2 клеток и могут отойти после залпа.',
    volleyHint: 'В лес стрелы вязнут, с холмов бьют сильнее.',
    chargeLabel: 'Набег с 2 кл.',
    volleyLabel: 'Залп',
    kiteLabel: 'Отойти после залпа',
    kiteMix: 'конные лучники не отойдут после залпа',
    chargeMix: 'набег станет недоступен',
    forestHalt: 'в лесу кони стопорятся',
    beats: {
      infantry: 'Сильна против конницы',
      cavalry: 'Сильна против лучников',
      archer: 'Сильна против пехоты',
    },
  },
  medieval: {
    id: 'medieval',
    name: 'Средневековье',
    icon: '🏰',
    blurb: 'Ополчение, наёмники, пики и рыцарский таран. Арбалет бьёт броню, лук — чаще.',
    rpsHint:
      'Рыцари сминают стрелков, стрелки выбивают пехоту, пики держат конницу. Конные арбалетчики после выстрела могут отойти.',
    volleyHint: 'В лес стрелы и болты вязнут, с холмов бьют сильнее.',
    chargeLabel: 'Таран с 2 кл.',
    volleyLabel: 'Залп',
    kiteLabel: 'Отойти после выстрела',
    kiteMix: 'конные стрелки не отойдут после выстрела',
    chargeMix: 'таран станет недоступен',
    forestHalt: 'в лесу кони стопорятся',
    beats: {
      infantry: 'Пики против рыцарей',
      cavalry: 'Таран против стрелков',
      archer: 'Сильна против пехоты',
    },
  },
  napoleonic: {
    id: 'napoleonic',
    name: 'Наполеоника',
    icon: '🎖️',
    blurb: 'Линейная пехота, гренадеры, гусары и батареи. Пушки бьют на 3–4 гекса, с холма ещё дальше.',
    rpsHint:
      'Линия без каре уязвима для конницы. Каре держит коней, но стоит 1⚡ за ход и слабо бьёт в ответ. Кавалерия сминает батареи, пушки и мушкеты косят пехоту. Конная артиллерия после выстрела может сменить позицию.',
    volleyHint: 'Мушкет бьёт на 2, пушки дальше. В лесу орудия слепы. С холма батарея достаёт на клетку дальше.',
    chargeLabel: 'Атака с хода',
    volleyLabel: 'Огонь',
    kiteLabel: 'Сменить позицию после залпа',
    kiteMix: 'конные орудия не отойдут после залпа',
    chargeMix: 'атака с хода станет недоступна',
    forestHalt: 'в лесу кавалерия стопорится',
    beats: {
      infantry: 'Каре против кавалерии',
      cavalry: 'Сминает батареи',
      archer: 'Картечь против пехоты',
    },
  },
};

/** Западное средневековье: ополчение, наёмники, пики, рыцари, лук и арбалет. */
const MEDIEVAL_UNITS: Record<UnitId, UnitFlavor> = {
  light_infantry: {
    name: 'Ополчение',
    icon: '🪓',
    short: 'Ополч.',
    description: 'Простолюдины с копьём и топором. Дёшево держит строй.',
    attack: 0.75,
    defense: 0.7,
  },
  medium_infantry: {
    name: 'Наёмники',
    icon: '🗡️',
    short: 'Наёмн.',
    description: 'Сержанты и рутьеры: платят за строй, пики против конницы.',
    attack: 1.05,
    defense: 1.15,
  },
  heavy_infantry: {
    name: 'Пикинёры',
    icon: '🛡️',
    short: 'Пики',
    description: 'Длинная пика против рыцарского тарана, ход 1.',
    attack: 1.15,
    defense: 1.7,
  },
  light_cavalry: {
    name: 'Лёгкая конница',
    icon: '🐴',
    short: 'Хобел.',
    description: 'Хобелары и разъезд: ход 3, таран с 2 гексов.',
  },
  medium_cavalry: {
    name: 'Конные сержанты',
    icon: '🐎',
    short: 'Серж.',
    description: 'Не рыцари, но удар с коня. В лесу строй встаёт.',
    attack: 1.2,
  },
  heavy_cavalry: {
    name: 'Рыцари',
    icon: '🏇',
    short: 'Рыц.',
    description: 'Броня, копьё, таран. Лес стоп, холмы −2 кл.',
    attack: 1.7,
    defense: 1.15,
  },
  light_archer: {
    name: 'Охотники',
    icon: '🏹',
    short: 'Охотн.',
    description: 'Короткий лук ополчения. Ход 2, в лес слабо.',
  },
  medium_archer: {
    name: 'Лучники',
    icon: '🎯',
    short: 'Луки',
    description: 'Длинный лук: частый залп на 2, против пехоты.',
    attack: 1.25,
  },
  heavy_archer: {
    name: 'Арбалетчики',
    icon: '🏹',
    short: 'Арбал.',
    description: 'Медленный болт, бьёт броню. Залп с холмов сильнее.',
    attack: 1.55,
    defense: 0.9,
  },
  light_horse_archer: {
    name: 'Конные лучники',
    icon: '🏹',
    short: 'Кон.лук',
    description: 'Степной разъезд: ход 3, после выстрела могут отойти.',
  },
  medium_horse_archer: {
    name: 'Конные арбалетчики',
    icon: '🏹',
    short: 'Кон.арб',
    description: 'Итальянский и немецкий обычай: залп с седла, в лесу стоп.',
    attack: 1.25,
  },
  heavy_horse_archer: {
    name: 'Конные арбалетчики',
    icon: '🏹',
    short: 'Тяж.арб',
    description: 'Тяжёлый конный арбалет. Ход 2, лес стоп.',
    attack: 1.45,
  },
};

/** Наполеоновские войны: линия, гренадеры, гусары, кирасиры, батареи. */
const NAPOLEONIC_UNITS: Record<UnitId, UnitFlavor> = {
  light_infantry: {
    name: 'Вольтижёры',
    icon: '🥁',
    short: 'Вольт.',
    description: 'Застрельщики: мушкет на 2 гекса, штык в упор.',
    attack: 0.85,
    defense: 0.7,
    range: 2,
    shot: 'musket',
  },
  medium_infantry: {
    name: 'Линейная пехота',
    icon: '💂',
    short: 'Линия',
    description: 'Фузилёры: залп мушкетов на 2 и штык. Каре держит кавалерию.',
    attack: 1.05,
    defense: 1.15,
    range: 2,
    shot: 'musket',
  },
  heavy_infantry: {
    name: 'Гренадеры',
    icon: '🛡️',
    short: 'Гренад.',
    description: 'Отборные ветераны. Мушкет на 2, удар колонной, ход 1.',
    attack: 1.3,
    defense: 1.5,
    range: 2,
    shot: 'musket',
  },
  light_cavalry: {
    name: 'Гусары',
    icon: '🐴',
    short: 'Гусары',
    description: 'Разъезд и погоня. Ход 3, атака с хода.',
    attack: 1.0,
  },
  medium_cavalry: {
    name: 'Драгуны',
    icon: '🐎',
    short: 'Драг.',
    description: 'Удар с коня, могут спешиться духом. В лесу стоп.',
    attack: 1.2,
  },
  heavy_cavalry: {
    name: 'Кирасиры',
    icon: '🏇',
    short: 'Кирас.',
    description: 'Кираса и тяжёлый конь — резерв прорыва.',
    attack: 1.65,
    defense: 1.15,
  },
  light_archer: {
    name: 'Егеря',
    icon: '🎯',
    short: 'Егеря',
    description: 'Нарезная винтовка: редкий, но точный огонь на 2.',
    attack: 1.0,
    defense: 0.55,
    range: 2,
    shot: 'musket',
  },
  medium_archer: {
    name: 'Полевые пушки',
    icon: '💥',
    short: 'Пушки',
    description: '6–8 фунтов: ход 1, картечь против пехоты, огонь на 3, с холма на 4.',
    attack: 1.35,
    defense: 0.55,
    range: 3,
    shot: 'cannon',
  },
  heavy_archer: {
    name: 'Тяжёлые орудия',
    icon: '💣',
    short: 'Орудия',
    description: '12-фунтовки и гаубицы. Дальность 4, с холма 5, ход 1, после хода не стреляют.',
    attack: 1.55,
    defense: 0.7,
    range: 4,
    speed: 1,
    shot: 'cannon',
  },
  light_horse_archer: {
    name: 'Конная артиллерия',
    icon: '🐎',
    short: 'Кон.арт',
    description: 'Лёгкие орудия на рыси: ход 2, залп на 3 и смена позиции.',
    attack: 1.05,
    range: 3,
    speed: 2,
    shot: 'cannon',
  },
  medium_horse_archer: {
    name: 'Конные батареи',
    icon: '💥',
    short: 'Кон.бат',
    description: 'Конная артиллерия среднего калибра. Ход 1, огонь на 3, в лесу стоп.',
    attack: 1.3,
    range: 3,
    speed: 1,
    shot: 'cannon',
  },
  heavy_horse_archer: {
    name: 'Конные гаубицы',
    icon: '💣',
    short: 'Кон.гау',
    description: 'Тяжёлая конная батарея. Ход 1, дальность 4, после хода не стреляют.',
    attack: 1.45,
    range: 4,
    speed: 1,
    shot: 'cannon',
  },
};

export const ERA_UNITS: Record<EraId, Partial<Record<UnitId, UnitFlavor>>> = {
  ancient: {},
  medieval: MEDIEVAL_UNITS,
  napoleonic: NAPOLEONIC_UNITS,
};

type BuildingFlavor = Pick<BuildingInfo, 'name' | 'icon' | 'description'>;

const ERA_BUILDINGS: Record<EraId, Partial<Record<BuildingType, BuildingFlavor>>> = {
  ancient: {},
  medieval: {
    farm: { name: 'Надел', icon: '🌾', description: '+2 еды в ход' },
    mine: { name: 'Рудник', icon: '⛏️', description: '+2 железа в ход' },
    market: { name: 'Ярмарка', icon: '🎪', description: '+3 золота в ход' },
    palisade: { name: 'Частокол', icon: '🪵', description: '+25% к защите клетки' },
    fort: { name: 'Замок', icon: '🏰', description: '+50% к защите клетки' },
    barracks: { name: 'Дружина', icon: '⚔️', description: 'Найм войск вне столицы, +20% к защите' },
  },
  napoleonic: {
    farm: { name: 'Ферма', icon: '🌾', description: '+2 еды в ход' },
    mine: { name: 'Литейная', icon: '🏭', description: '+2 железа в ход' },
    market: { name: 'Биржа', icon: '🏛️', description: '+3 золота в ход' },
    palisade: { name: 'Редут', icon: '🪵', description: '+25% к защите клетки' },
    fort: { name: 'Цитадель', icon: '🏰', description: '+50% к защите клетки' },
    barracks: { name: 'Депо', icon: '🎖️', description: 'Найм войск вне столицы, +20% к защите' },
  },
};

type CommanderFlavor = Pick<CommanderInfo, 'name' | 'icon' | 'description'>;

const ERA_COMMANDERS: Record<EraId, Partial<Record<CommanderId, CommanderFlavor>>> = {
  ancient: {},
  medieval: {
    warlord: { name: 'Князь', icon: '⚔️', description: '+22% к атаке стека' },
    marshal: { name: 'Коннетабль', icon: '🏰', description: '+25% к обороне, реже бежит' },
    scout: { name: 'Следопыт', icon: '🦅', description: '+1 к ходу стека и к обзору' },
  },
  napoleonic: {
    warlord: { name: 'Генерал', icon: '🎖️', description: '+22% к атаке стека' },
    marshal: { name: 'Маршал', icon: '👑', description: '+25% к обороне, реже бежит' },
    scout: { name: 'Гусарский полковник', icon: '🐴', description: '+1 к ходу стека и к обзору' },
  },
};

type TechFlavor = Pick<TechInfo, 'name' | 'icon' | 'description'>;

const ERA_TECHS: Record<EraId, Partial<Record<TechType, TechFlavor>>> = {
  ancient: {},
  medieval: {
    attack: { name: 'Ратное дело', icon: '⚔️', description: '+12% к силе атаки за уровень' },
    defense: { name: 'Замки', icon: '🏰', description: '+12% к силе обороны за уровень' },
    economy: { name: 'Казна', icon: '💰', description: '+10% ко всем доходам за уровень' },
    logistics: { name: 'Поход', icon: '🐎', description: '+1 действие в ход за уровень' },
  },
  napoleonic: {
    attack: { name: 'Тактика', icon: '🎖️', description: '+12% к силе атаки за уровень' },
    defense: { name: 'Инженерия', icon: '🧱', description: '+12% к силе обороны за уровень' },
    economy: { name: 'Интендантство', icon: '📦', description: '+10% ко всем доходам за уровень' },
    logistics: { name: 'Марши', icon: '🥁', description: '+1 действие в ход за уровень' },
  },
};

export function buildingsFor(era: EraId = 'ancient'): Record<BuildingType, BuildingInfo> {
  const overlay = ERA_BUILDINGS[era] ?? {};
  const next = { ...BUILDINGS };
  for (const id of Object.keys(BUILDINGS) as BuildingType[]) {
    next[id] = { ...BUILDINGS[id], ...overlay[id] };
  }
  return next;
}

export function commandersFor(era: EraId = 'ancient'): Record<CommanderId, CommanderInfo> {
  const overlay = ERA_COMMANDERS[era] ?? {};
  const next = { ...COMMANDERS };
  for (const id of Object.keys(COMMANDERS) as CommanderId[]) {
    next[id] = { ...COMMANDERS[id], ...overlay[id] };
  }
  return next;
}

export function techsFor(era: EraId = 'ancient'): Record<TechType, TechInfo> {
  const overlay = ERA_TECHS[era] ?? {};
  const next = { ...TECHS };
  for (const id of Object.keys(TECHS) as TechType[]) {
    next[id] = { ...TECHS[id], ...overlay[id] };
  }
  return next;
}
