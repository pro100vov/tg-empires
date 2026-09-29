import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ERAS, eraOf, unitsFor } from '@tge/shared';
import type { EraId, GameSettings } from '@tge/shared';

interface Step {
  /** Значение data-tour у подсвечиваемого элемента; без него карточка по центру. */
  target?: string;
  title: string;
  text: string;
}

interface Props {
  settings: GameSettings;
  /** Обучение закончено или пропущено. */
  onDone: () => void;
}

/** Шаги обучения. Названия войск подставляются по эпохе партии. */
function stepsFor(era: EraId, diplomacy: boolean): Step[] {
  const units = unitsFor(era);
  const flavor = ERAS[era];
  const steps: Step[] = [
    {
      target: 'resources',
      title: '1. Столица и ресурсы',
      text: 'Ваша держава живёт на трёх ресурсах: 🪙 золото, 🌾 еда и 🔩 железо. Зелёные числа — доход за ход. Столица (★) — сердце державы: потеряете её — проиграете.',
    },
    {
      target: 'map',
      title: '2. Куда идти',
      text: `Нажмите на клетку со своими войсками, затем «Идти» и выберите соседний гекс. Отряды идут по одной клетке за раз (${units.light_cavalry.name} — быстрее). Кнопки 🏰 и ⚔️ на карте быстро возвращают к столице и к следующему отряду.`,
    },
    {
      target: 'panel',
      title: '3. Бой и прогноз',
      text: 'Выберите клетку с врагом рядом со своим отрядом — панель покажет прогноз боя. Выше 1.2× — хорошие шансы, ниже 0.9× — лучше не рисковать. Туман войны скрывает чужие отряды вне вашего обзора.',
    },
    {
      target: 'panel',
      title: '4. Найм',
      text: `В столице и казармах можно нанимать войска: ${units.medium_infantry.name} держит строй, ${units.light_cavalry.name} быстра, ${units.light_archer.name} бьёт издалека. Каждый отряд ест еду — следите за её доходом.`,
    },
    {
      target: 'panel',
      title: '5. Стройка',
      text: 'На своей клетке можно строить: 🌾 ферма даёт еду, ⛏️ шахта — железо, 🏛️ рынок — золото, а частокол и крепость усиливают защиту. Стройка занимает несколько ходов.',
    },
    {
      target: 'tech',
      title: '6. Технологии',
      text: 'Технологии усиливают всю державу: атаку, защиту, экономику и число действий за ход. Каждая следующая дороже.',
    },
    {
      target: 'actions',
      title: '7. Действия ⚡',
      text: 'Найм, стройка, наука и каждый поход тратят ⚡. Когда действия закончатся, ход перейдёт к сопернику сам.',
    },
    {
      target: 'end',
      title: '8. Завершить ход',
      text: 'Не хотите тратить все действия — нажмите «Завершить ход». Соперник ходит, и в ваш ход приходят доходы.',
    },
    {
      title: '9. События 🎲',
      text: 'Иногда с вашей державой случаются события — урожай, бунт, караван, наёмники. Они бывают удачными и не очень, у каждого игрока свои. В лобби их можно выключить.',
    },
  ];
  if (diplomacy) {
    steps.push({
      target: 'dip',
      title: '10. Дипломатия 🤝',
      text: 'Предложите соседу перемирие или союз: пока договор действует, нападать друг на друга нельзя. Союзники видят карту вместе. Разорвать договор можно, но война начнётся с вашего следующего хода.',
    });
  }
  steps.push({
    target: 'mini',
    title: `${steps.length + 1}. Мини-карта`,
    text: `Кнопка 🗺 показывает мини-карту: ваши земли, туман и ★ столицы. Нажмите или проведите по ней, чтобы переместиться. Играем: ${flavor.icon} ${flavor.name}!`,
  });
  return steps;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Пошаговое обучение: подсвечивает элемент интерфейса и объясняет, что с ним делать. */
export default function Tutorial({ settings, onDone }: Props) {
  const era = eraOf(settings);
  const steps = useMemo(() => stepsFor(era, settings.diplomacy && !settings.hotseat), [era, settings.diplomacy, settings.hotseat]);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const step = steps[index]!;
  const last = index === steps.length - 1;

  // Ищем цель шага и следим за её положением (окно, прокрутка, перерисовка).
  useLayoutEffect(() => {
    const measure = () => {
      if (!step.target) return setRect(null);
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (!(el instanceof HTMLElement)) return setRect(null);
      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) return setRect(null);
      setRect({ left: box.left, top: box.top, width: box.width, height: box.height });
    };
    measure();
    const id = window.setInterval(measure, 400);
    window.addEventListener('resize', measure);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('resize', measure);
    };
  }, [step.target, index]);

  // Клавиша Esc пропускает обучение.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDone();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);

  const below = rect ? rect.top < window.innerHeight / 2 : false;
  const cardStyle = rect
    ? below
      ? { top: Math.min(window.innerHeight - 220, rect.top + rect.height + 12) }
      : { bottom: Math.max(12, window.innerHeight - rect.top + 12) }
    : { top: '50%', transform: 'translateY(-50%)' };

  return (
    <div className="tour" role="dialog" aria-label="Обучение">
      <div className="tour-blocker" />
      {rect ? (
        <div
          className="tour-hole"
          style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }}
        />
      ) : (
        <div className="tour-dim" />
      )}
      <div className="tour-card" style={cardStyle}>
        <div className="tour-progress">
          {index + 1} / {steps.length}
        </div>
        <h3>{step.title}</h3>
        <p>{step.text}</p>
        <div className="row">
          <button className="btn" onClick={onDone}>
            Пропустить
          </button>
          <span className="grow" />
          {index > 0 && (
            <button className="btn" onClick={() => setIndex(index - 1)}>
              Назад
            </button>
          )}
          <button className="btn primary" onClick={() => (last ? onDone() : setIndex(index + 1))}>
            {last ? 'Готово' : 'Далее'}
          </button>
        </div>
      </div>
    </div>
  );
}
