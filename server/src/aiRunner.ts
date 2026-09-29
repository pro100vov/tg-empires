import { applyAction, currentPlayer, isAiPlayer, planAiDiplomacy, publicView, rememberSeenBuildings, stepAi } from '@tge/shared';
import type { GameState } from '@tge/shared';
import { pushStateSafe } from './hub.js';
import { getRoom } from './rooms.js';

/**
 * Запускает ходы ИИ-игроков. Сам ИИ (`stepAi`) живёт в shared и только решает; здесь —
 * темп (пауза 500–700 мс между действиями, чтобы люди видели анимации) и рассылка.
 * Каждое действие уходит через pushState с fx, как ход обычного игрока.
 */

const running = new Set<string>();
const MIN_PAUSE_MS = 500;
const JITTER_MS = 200;
/** После мирного шага (всадники расходятся по ничьим клеткам) — пауза короче, чтобы ход ИИ не тянулся. */
const QUICK_PAUSE_MS = 220;
/** Страховка: больше действий за один запуск ИИ не делает. */
const MAX_STEPS = 400;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** ИИ-игроки, которым адресованы предложения договоров. */
function proposalTargets(state: GameState): string[] {
  return state.proposals.filter((p) => isAiPlayer(p.to)).map((p) => p.to);
}

/** Есть ли сейчас работа для ИИ: его ход, каре против него или предложение ему. */
function hasAiWork(state: GameState): boolean {
  if (state.phase !== 'playing') return false;
  if (state.pendingSquare) return isAiPlayer(state.pendingSquare.defenderId);
  const current = currentPlayer(state);
  if (current && isAiPlayer(current.id)) return true;
  return proposalTargets(state).length > 0;
}

/** Отвечает на предложения договоров от имени ИИ (вне его хода). Возвращает, было ли что-то сделано. */
function answerProposals(state: GameState): boolean {
  let changed = false;
  for (const aiId of new Set(proposalTargets(state))) {
    rememberSeenBuildings(state, aiId);
    const view = publicView(state, aiId);
    for (const action of planAiDiplomacy(view, aiId, { respondOnly: true })) {
      if (applyAction(state, aiId, action).ok) changed = true;
    }
  }
  return changed;
}

async function runLoop(code: string): Promise<boolean> {
  let steps = 0;
  let failures = 0;
  let quick = false;
  while (steps < MAX_STEPS) {
    const state = getRoom(code);
    if (!state || !hasAiWork(state)) return true;

    const pending = state.pendingSquare;
    const current = currentPlayer(state);
    // Ход ИИ или ответ ИИ-обороны — иначе остались только предложения договоров.
    const actor = pending ? pending.defenderId : current && isAiPlayer(current.id) ? current.id : null;
    if (!actor) {
      if (!answerProposals(state)) return true;
      pushStateSafe(state);
      await sleep(300);
      continue;
    }

    await sleep(quick ? QUICK_PAUSE_MS : MIN_PAUSE_MS + Math.random() * JITTER_MS);
    const fresh = getRoom(code);
    if (!fresh || fresh.phase !== 'playing') return true;

    const step = stepAi(fresh, actor);
    steps += 1;
    if (!step.result) return true;
    quick = step.action?.type === 'move' && step.result.ok && (step.result.fx?.battle ?? 'none') === 'none';
    if (step.result.ok) {
      failures = 0;
      pushStateSafe(fresh, { fx: step.result.fx });
    } else if (++failures >= 3) {
      console.error(`[ai] ${code}: ИИ ${actor} застрял, остановка: ${step.errors.join('; ')}`);
      return false;
    }
  }
  console.error(`[ai] ${code}: превышен лимит действий ИИ`);
  return false;
}

/**
 * Вызывать после каждого изменения партии: если ходит ИИ (или ему что-то адресовано) и прогона
 * ещё нет — запускает его. Дорабатывает, пока у ИИ есть что делать.
 */
export function kickAi(state: GameState): void {
  const code = state.roomCode;
  if (running.has(code) || !hasAiWork(state)) return;
  running.add(code);
  runLoop(code)
    .then((clean) => {
      running.delete(code);
      // Состояние могло поменяться, пока крутился последний шаг, — проверим ещё раз.
      const latest = getRoom(code);
      if (clean && latest && hasAiWork(latest)) kickAi(latest);
    })
    .catch((err) => {
      running.delete(code);
      console.error(`[ai] ${code}:`, err);
    });
}
