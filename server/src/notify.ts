import { GrammyError, InlineKeyboard } from 'grammy';
import type { Api } from 'grammy';
import { currentPlayer, isAiPlayer, isHotseatRival, rankPlayers, scoreOf } from '@tge/shared';
import type { GameState, Player } from '@tge/shared';
import { getUser, mayNotify, setTurnMsg, touchUser } from './users.js';

/**
 * Сообщения бота: «Ваш ход», напоминание перед автопропуском, итоги партии,
 * приглашение на реванш и предложения договоров. Всё идёт через очередь
 * (лимит Telegram — 30 сообщений/с, держим ~20). Без BOT_TOKEN — только в лог.
 */

let api: Api | null = null;
let webAppUrl = '';

export function bindBot(botApi: Api | null, url: string): void {
  api = botApi;
  webAppUrl = url;
}

// ── Очередь отправки ────────────────────────────────────────────────────────

const SEND_INTERVAL_MS = 50;
const queue: Array<() => Promise<void>> = [];
let drainTimer: NodeJS.Timeout | null = null;

function drain(): void {
  const job = queue.shift();
  if (!job) {
    if (drainTimer) clearInterval(drainTimer);
    drainTimer = null;
    return;
  }
  job().catch((err) => console.error('[notify] ошибка отправки:', err));
}

function enqueue(job: () => Promise<void>): void {
  queue.push(job);
  if (!drainTimer) drainTimer = setInterval(drain, SEND_INTERVAL_MS);
}

/** Игрок из Telegram — у него числовой id, в личку ему можно писать. */
function chatIdOf(userId: string): number | null {
  const n = Number(userId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isHttps(): boolean {
  return webAppUrl.startsWith('https://');
}

/** Кнопка «открыть игру» в нужную комнату (web_app — только для https). */
export function openGameKeyboard(roomCode: string, label = '🎮 Открыть игру'): InlineKeyboard | undefined {
  if (!isHttps()) return undefined;
  return new InlineKeyboard().webApp(label, `${webAppUrl}?room=${roomCode}`);
}

function plain(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/\n/g, ' | ');
}

/**
 * Отправляет сообщение игроку; возвращает id сообщения. 403 от Telegram
 * (бот заблокирован / чат не начат) — больше этому игроку не пишем.
 */
export async function sendTo(
  userId: string,
  text: string,
  markup?: InlineKeyboard,
): Promise<number | null> {
  const chatId = chatIdOf(userId);
  if (!api || chatId == null) {
    console.log(`[notify] → ${userId}: ${plain(text)}`);
    return null;
  }
  try {
    const msg = await api.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: markup });
    return msg.message_id;
  } catch (err) {
    if (err instanceof GrammyError && (err.error_code === 403 || err.error_code === 400)) {
      console.warn(`[notify] ${userId}: писать нельзя (${err.description}) — отключаю уведомления`);
      touchUser(userId, '', false);
    } else {
      console.error(`[notify] ${userId}:`, err);
    }
    return null;
  }
}

async function deleteMsg(userId: string, messageId: number): Promise<void> {
  const chatId = chatIdOf(userId);
  if (!api || chatId == null) return;
  try {
    await api.deleteMessage(chatId, messageId);
  } catch {
    // Старое сообщение могли удалить сами или оно слишком старое — не критично.
  }
}

/** Ставит сообщение в очередь и ждёт результата не нужно: вызывающему хватает fire-and-forget. */
export function queueMessage(userId: string, text: string, markup?: InlineKeyboard): void {
  enqueue(async () => {
    await sendTo(userId, text, markup);
  });
}

// ── Хелперы ────────────────────────────────────────────────────────────────

const NOTIFY_TZ = process.env.NOTIFY_TZ || 'Europe/Moscow';

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: NOTIFY_TZ });
}

export function humanLeft(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes >= 90) return `${Math.round(minutes / 60)} ч`;
  return `${minutes} мин`;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Живой игрок, которому можно писать: не ИИ, не «Соперник» из соло. */
function isHumanId(id: string): boolean {
  return !isAiPlayer(id) && !isHotseatRival(id);
}

// ── Ваш ход и напоминание ──────────────────────────────────────────────────

const lastKey = new Map<string, string>();
const remindedFor = new Map<string, string>();
const recapSent = new Set<string>();
const proposalNotified = new Set<string>();

function turnKey(state: GameState): string {
  return `${state.phase}:${state.round}:${state.turnIndex}`;
}

/** После загрузки с диска: текущий ход считаем уже объявленным — не спамим после рестарта. */
export function restoreNotifyState(state: GameState): void {
  lastKey.set(state.roomCode, turnKey(state));
  if (state.phase === 'finished') recapSent.add(state.roomCode);
  for (const p of state.proposals) proposalNotified.add(`${state.roomCode}:${p.id}:${p.round}`);
}

function sendTurn(state: GameState, player: Player): void {
  const code = state.roomCode;
  const deadline = state.turnDeadline ? ` Время: до ${clock(state.turnDeadline)}.` : '';
  const text = `⚔️ <b>Ваш ход</b> — партия ${code}, раунд ${state.round}.${deadline}`;
  enqueue(async () => {
    const prev = getUser(player.id)?.turnMsgs[code];
    const sent = await sendTo(player.id, text, openGameKeyboard(code));
    if (sent != null) {
      setTurnMsg(player.id, code, sent);
      if (prev) await deleteMsg(player.id, prev);
    }
  });
}

/** Вызывать после каждого изменения партии. */
export function onStateChanged(state: GameState): void {
  const code = state.roomCode;
  notifyProposals(state);

  const key = turnKey(state);
  if (lastKey.get(code) === key) return;
  lastKey.set(code, key);

  if (state.phase === 'finished') {
    if (!recapSent.has(code)) {
      recapSent.add(code);
      sendRecap(state);
    }
    return;
  }
  if (state.phase !== 'playing' || state.settings.hotseat) return;
  const current = currentPlayer(state);
  if (!current || !isHumanId(current.id) || current.connected || !mayNotify(current.id)) return;
  sendTurn(state, current);
}

/**
 * Напоминания: раз за ход, тому, кто не ходит и не в игре.
 * 0 — за минуту до офлайн-пропуска; 60 — за 15 мин; 1440 — за 2 ч; блиц — без напоминаний.
 * `offlineMs` — сколько игрок уже офлайн (для режима без лимита).
 */
export function tickReminders(
  states: GameState[],
  now: number,
  offlineMs: (roomCode: string, userId: string) => number | null,
): void {
  for (const state of states) {
    if (state.phase !== 'playing' || state.settings.hotseat) continue;
    const current = currentPlayer(state);
    if (!current || !isHumanId(current.id) || current.connected || !mayNotify(current.id)) continue;
    const key = turnKey(state);
    if (remindedFor.get(state.roomCode) === key) continue;

    const minutes = state.settings.turnMinutes;
    let left: number | null = null;
    if (minutes === 0) {
      const off = offlineMs(state.roomCode, current.id);
      if (off != null && off >= 120_000 && off < 180_000) left = 180_000 - off;
    } else if (minutes >= 60 && state.turnDeadline) {
      const lead = minutes >= 1440 ? 2 * 3_600_000 : 15 * 60_000;
      const remaining = state.turnDeadline - now;
      if (remaining > 0 && remaining <= lead) left = remaining;
    }
    if (left == null) continue;
    remindedFor.set(state.roomCode, key);
    const text = `⏳ Через ${humanLeft(left)} ход в <b>${state.roomCode}</b> будет пропущен`;
    enqueue(async () => {
      await sendTo(current.id, text, openGameKeyboard(state.roomCode));
    });
  }
}

// ── Итоги партии ───────────────────────────────────────────────────────────

function recapText(state: GameState, viewer: Player): string {
  const round = Math.min(state.round, state.maxRounds);
  const lines = [`🏆 <b>Партия ${state.roomCode} окончена</b> — раунд ${round}`];
  rankPlayers(state).forEach((p, i) => {
    const who = p.id === viewer.id ? 'Вы' : esc(p.name);
    const crown = p.id === state.winnerId ? '👑 ' : p.alliedWinner ? '🤝 ' : '';
    const tail = p.alive ? `${scoreOf(state, p.id)} очков` : `пал на ${p.deadRound ?? '?'} раунде`;
    lines.push(`${i + 1}. ${crown}${who} — ${tail}`);
  });
  const s = viewer.stats;
  lines.push(`Ваши бои: ${s.battlesWon} побед / ${s.battlesLost} поражений, захвачено ${s.tilesCaptured} клеток`);
  return lines.join('\n');
}

function recapKeyboard(state: GameState): InlineKeyboard | undefined {
  const kb = new InlineKeyboard();
  if (isHttps()) kb.webApp('📈 Статистика', `${webAppUrl}?room=${state.roomCode}`);
  kb.text('🔁 Реванш', `rematch:${state.roomCode}`);
  return kb;
}

function sendRecap(state: GameState): void {
  if (state.settings.hotseat) return;
  for (const player of state.players) {
    if (!isHumanId(player.id) || !mayNotify(player.id)) continue;
    const text = recapText(state, player);
    const kb = recapKeyboard(state);
    enqueue(async () => {
      await sendTo(player.id, text, kb);
    });
  }
}

// ── Реванш ─────────────────────────────────────────────────────────────────

/** Зовём остальных участников старой партии в новую комнату. */
export function inviteToRematch(old: GameState, newCode: string, byUserId: string): void {
  const by = old.players.find((p) => p.id === byUserId);
  for (const p of old.players) {
    if (!isHumanId(p.id) || p.id === byUserId || !mayNotify(p.id)) continue;
    const text = `🔁 ${esc(by?.name ?? 'Игрок')} зовёт на реванш — комната <b>${newCode}</b>`;
    const kb = openGameKeyboard(newCode, '🎮 Играть реванш');
    enqueue(async () => {
      await sendTo(p.id, text, kb);
    });
  }
}

// ── Договоры ───────────────────────────────────────────────────────────────

/** Предложение договора офлайн-игроку — сообщение с кнопками «Принять / Отклонить». */
function notifyProposals(state: GameState): void {
  if (state.phase !== 'playing') return;
  for (const proposal of state.proposals) {
    const key = `${state.roomCode}:${proposal.id}:${proposal.round}`;
    if (proposalNotified.has(key)) continue;
    proposalNotified.add(key);
    const to = state.players.find((p) => p.id === proposal.to);
    const from = state.players.find((p) => p.id === proposal.from);
    if (!to || !from || !isHumanId(to.id) || to.connected || !mayNotify(to.id)) continue;
    const what =
      proposal.kind === 'truce' ? `перемирие на ${proposal.rounds ?? 3} раундов` : 'союз';
    const text = `🤝 Держава <b>${esc(from.name)}</b> предлагает ${what} — партия ${state.roomCode}`;
    const kb = new InlineKeyboard()
      .text('✅ Принять', `dip:a:${state.roomCode}:${from.id}`)
      .text('❌ Отклонить', `dip:d:${state.roomCode}:${from.id}`);
    enqueue(async () => {
      await sendTo(to.id, text, kb);
    });
  }
}
