import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import dotenv from 'dotenv';
import express from 'express';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';

import { addAiPlayer, addPlayer, applyAction, applyDeployAction, applyLobbyAction, forceDeployReady, parseDeployAction, autoEndTurnIfExhausted, actingPlayerId, currentPlayer, humanPlayers, isHotseatRival, logPublic, maskFxFor, markDisconnected, parseGameAction, parseLobbyAction, publicView, removePlayer, rememberSeenBuildings, setupHotseat, startGame } from '@tge/shared';
import type { AiLevel, GameFx, GameMode, GameState } from '@tge/shared';

import { devUser, verifyInitData } from './auth.js';
import type { AuthUser } from './auth.js';
import { createRoom, getRoom, listRooms, loadRooms, markDirty, myGames, saveRooms, startRoomAutosave, startRoomCleanup } from './rooms.js';
import { startBot } from './bot.js';
import { kickAi } from './aiRunner.js';
import { bindPush } from './hub.js';
import { inviteToRematch, onStateChanged, restoreNotifyState, tickReminders } from './notify.js';
import { rematchRoom } from './rematch.js';
import { pauseTurnClock, restoreTurnClock, syncTurnClock, turnExpired } from './turnClock.js';
import { getUser, loadUsers, saveUsers, startUsersAutosave, touchUser } from './users.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(rootDir, '.env') });

const PORT = Number(process.env.PORT ?? 3000);
const BOT_TOKEN = process.env.BOT_TOKEN ?? '';
const DEV_MODE = process.env.DEV_MODE === '1';

if (DEV_MODE && (process.env.WEBAPP_URL ?? '').startsWith('https://')) {
  console.warn('[server] ВНИМАНИЕ: DEV_MODE включён при публичном WEBAPP_URL — вход без подписи Telegram!');
}

/** Сколько ждать вернувшегося игрока в лобби, прежде чем освободить место. */
const LOBBY_GRACE_MS = 90_000;
/** Офлайн-игрок пропускает ход, чтобы партия не стояла. */
const TURN_SKIP_OFFLINE_MS = 180_000;
/** Сколько ждать ответа обороны про каре. */
const SQUARE_REPLY_MS = 60_000;

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));

const clientDist = path.join(rootDir, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

interface SocketData {
  user: AuthUser;
  roomCode?: string;
}

io.use((socket, next) => {
  const auth = socket.handshake.auth as { initData?: string; devId?: string };
  let user: AuthUser | null = verifyInitData(auth?.initData ?? '', BOT_TOKEN);
  if (!user && DEV_MODE) user = devUser(auth?.devId);
  if (!user) return next(new Error('Не удалось подтвердить пользователя Telegram'));
  (socket.data as SocketData).user = user;
  // Разрешение писать в личку не отзываем по одному входу без него: его дают /start и requestWriteAccess.
  touchUser(user.id, user.name, user.allowsWrite ? true : undefined);
  next();
});

function viewOf(state: GameState, userId: string): GameState {
  syncTurnClock(state);
  const viewer = actingPlayerId(state, userId);
  rememberSeenBuildings(state, viewer);
  return { ...publicView(state, viewer), serverNow: Date.now() };
}

async function pushState(state: GameState, payload?: { fx?: GameFx; skip?: string }): Promise<void> {
  syncTurnClock(state);
  markDirty(state.roomCode);
  onStateChanged(state);
  kickAi(state);
  const sockets = await io.in(state.roomCode).fetchSockets();
  for (const s of sockets) {
    if (payload?.skip && s.id === payload.skip) continue;
    const uid = (s.data as SocketData).user.id;
    const view = viewOf(state, uid);
    if (payload && 'fx' in payload) {
      s.emit('update', { state: view, fx: maskFxFor(state, actingPlayerId(state, uid), payload.fx) });
    } else {
      s.emit('state', view);
    }
  }
}

/** pushState асинхронный — ошибка в нём не должна становиться unhandledRejection. */
function pushStateSafe(state: GameState, payload?: { fx?: GameFx; skip?: string }): void {
  pushState(state, payload).catch((err) => console.error('[server] pushState:', err));
}
bindPush(pushStateSafe);

type Ack = (response: { ok: true; state: GameState; fx?: GameFx } | { ok: false; error: string }) => void;
/** Для событий без состояния в ответе (room:leave) — не ломаем общий Ack. */
type VoidAck = (response: { ok: true } | { ok: false; error: string }) => void;

/** Ошибка в одном событии не должна ронять сервер со всеми партиями. */
function safe<P>(name: string, handler: (payload: P, reply: Ack) => void | Promise<void>) {
  return async (payload: P, ack?: unknown) => {
    const reply: Ack = typeof ack === 'function' ? (ack as Ack) : () => {};
    try {
      await handler(payload, reply);
    } catch (err) {
      console.error(`[socket] ${name}:`, err);
      reply({ ok: false, error: 'Внутренняя ошибка сервера' });
    }
  };
}

/** Список сложностей ИИ из запроса: 1–3 известных значения, иначе null. */
function parseAiLevels(raw: unknown): AiLevel[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) return null;
  const out: AiLevel[] = [];
  for (const item of raw) {
    if (item !== 'easy' && item !== 'normal' && item !== 'hard') return null;
    out.push(item);
  }
  return out;
}

/** Режим новой комнаты из запроса: варгейм или империя по умолчанию. */
function parseMode(raw: unknown): GameMode {
  return raw === 'wargame' ? 'wargame' : 'empire';
}

/** Ключ учёта офлайн-времени игрока в комнате: своя запись на каждую пару комната/игрок. */
function offlineKey(roomCode: string, userId: string): string {
  return `${roomCode}\n${userId}`;
}

/** Когда игрок вышел из комнаты последним сокетом. Используется уборщиком (sweep). */
const offlineSince = new Map<string, number>();

/** Есть ли у пользователя ещё сокет в этой комнате (кроме уже вышедших). */
async function userHasOtherSocket(roomCode: string, userId: string): Promise<boolean> {
  const sockets = await io.in(roomCode).fetchSockets();
  return sockets.some((s) => (s.data as SocketData).user.id === userId);
}

/** Выход сокета из комнаты: если это был последний сокет игрока — помечаем офлайн. */
async function leaveRoom(socket: Socket, roomCode: string): Promise<void> {
  void socket.leave(roomCode);
  const state = getRoom(roomCode);
  if (!state) return;
  const userId = (socket.data as SocketData).user.id;
  const stillHere = await userHasOtherSocket(roomCode, userId);
  if (!stillHere) {
    markDisconnected(state, userId);
    offlineSince.set(offlineKey(roomCode, userId), Date.now());
    pushStateSafe(state);
  }
}

/** Заход сокета в комнату: уходим из прежней (если это смена комнаты), потом входим в новую. */
async function enterRoom(socket: Socket, state: GameState): Promise<void> {
  const data = socket.data as SocketData;
  if (data.roomCode && data.roomCode !== state.roomCode) {
    await leaveRoom(socket, data.roomCode);
  }
  data.roomCode = state.roomCode;
  void socket.join(state.roomCode);
  offlineSince.delete(offlineKey(state.roomCode, data.user.id));
}

io.on('connection', (socket) => {
  const data = socket.data as SocketData;
  const { user } = data;
  socket.emit('me', { id: user.id, name: user.name, canNotify: getUser(user.id)?.canNotify ?? false });

  const joinState = async (state: GameState, ack: Ack) => {
    if (state.settings.hotseat && user.id !== state.hostId && !state.players.some((p) => p.id === user.id)) {
      ack({ ok: false, error: 'Это партия сам с собой' });
      return;
    }
    const result = addPlayer(state, user.id, user.name);
    if (!result.ok) {
      ack({ ok: false, error: result.error });
      return;
    }
    await enterRoom(socket, state);
    ack({ ok: true, state: viewOf(state, user.id) });
    pushStateSafe(state);
  };

  socket.on(
    'room:create',
    safe<{ mode?: unknown }>('room:create', async (payload, reply) => {
      await joinState(createRoom(user.id, parseMode(payload?.mode)), reply);
    }),
  );

  socket.on(
    'room:solo',
    safe<{ ai?: unknown; tutorial?: unknown; mode?: unknown }>('room:solo', async (payload, reply) => {
      // «Против ИИ»: обычная комната, где вместе с игроком сидят 1–3 ИИ; хост сам настраивает и стартует.
      const levels = parseAiLevels(payload?.ai);
      const mode = payload?.tutorial === true ? 'empire' : parseMode(payload?.mode);
      if (levels) {
        const state = createRoom(user.id, mode);
        addPlayer(state, user.id, user.name);
        for (const level of levels) addAiPlayer(state, level);
        if (payload?.tutorial === true) {
          // Учебная партия: маленькая карта, один лёгкий ИИ, без случайных событий, сразу в бой.
          applyLobbyAction(state, user.id, { type: 'configure', settings: { mapSize: 8, randomEvents: false } });
          const started = startGame(state, user.id);
          if (!started.ok) return reply({ ok: false, error: started.error });
        }
        await enterRoom(socket, state);
        markDirty(state.roomCode);
        reply({ ok: true, state: viewOf(state, user.id) });
        pushStateSafe(state);
        return;
      }
      const state = createRoom(user.id, mode);
      const result = setupHotseat(state, user.id, user.name);
      if (!result.ok) return reply({ ok: false, error: result.error });
      markDirty(state.roomCode);
      await enterRoom(socket, state);
      reply({ ok: true, state: viewOf(state, user.id) });
    }),
  );

  socket.on(
    'room:join',
    safe<{ roomCode?: unknown }>('room:join', async (payload, reply) => {
      const raw = payload?.roomCode;
      if (typeof raw !== 'string' || raw.length > 16) return reply({ ok: false, error: 'Комната не найдена' });
      const code = raw.toUpperCase().trim();
      const state = code ? getRoom(code) : undefined;
      if (!state) return reply({ ok: false, error: 'Комната не найдена' });
      await joinState(state, reply);
    }),
  );

  /** «Мои партии»: те же данные, что в боте (/games). */
  socket.on('room:mine', (_payload: unknown, ack?: unknown) => {
    if (typeof ack !== 'function') return;
    try {
      (ack as (r: unknown) => void)({ ok: true, games: myGames(user.id) });
    } catch (err) {
      console.error('[socket] room:mine:', err);
      (ack as (r: unknown) => void)({ ok: false, error: 'Внутренняя ошибка сервера' });
    }
  });

  /** Игрок разрешил боту писать в личку (Telegram requestWriteAccess). */
  socket.on('user:write', (_payload: unknown, ack?: unknown) => {
    touchUser(user.id, user.name, true);
    if (typeof ack === 'function') (ack as (r: unknown) => void)({ ok: true });
  });

  /** Реванш после конца партии: новая комната с теми же настройками или вход в уже созданную. */
  socket.on(
    'room:rematch',
    safe<unknown>('room:rematch', async (_payload, reply) => {
      const old = data.roomCode ? getRoom(data.roomCode) : undefined;
      if (!old) return reply({ ok: false, error: 'Комната не найдена' });
      const result = rematchRoom(old, user.id, user.name);
      if (!result.ok) return reply({ ok: false, error: result.error });
      await joinState(result.state, reply);
      // Старая комната узнаёт код реванша; остальных участников зовёт бот.
      pushStateSafe(old);
      if (result.created) inviteToRematch(old, result.state.roomCode, user.id);
    }),
  );

  socket.on(
    'room:leave',
    async (_payload: unknown, ack?: unknown) => {
      const reply: VoidAck = typeof ack === 'function' ? (ack as VoidAck) : () => {};
      try {
        if (data.roomCode) {
          await leaveRoom(socket, data.roomCode);
          data.roomCode = undefined;
        }
        reply({ ok: true });
      } catch (err) {
        console.error('[socket] room:leave:', err);
        reply({ ok: false, error: 'Внутренняя ошибка сервера' });
      }
    },
  );

  socket.on(
    'game:start',
    safe<unknown>('game:start', (_payload, reply) => {
      const state = data.roomCode ? getRoom(data.roomCode) : undefined;
      if (!state) return reply({ ok: false, error: 'Комната не найдена' });
      const result = startGame(state, user.id);
      if (!result.ok) return reply({ ok: false, error: result.error });
      reply({ ok: true, state: viewOf(state, user.id) });
      pushStateSafe(state);
    }),
  );

  socket.on(
    'lobby:action',
    safe<{ action?: unknown }>('lobby:action', (payload, reply) => {
      const state = data.roomCode ? getRoom(data.roomCode) : undefined;
      if (!state) return reply({ ok: false, error: 'Комната не найдена' });
      const action = parseLobbyAction(payload?.action);
      if (!action) return reply({ ok: false, error: 'Некорректное действие' });
      const result = applyLobbyAction(state, user.id, action);
      if (!result.ok) return reply({ ok: false, error: result.error });
      reply({ ok: true, state: viewOf(state, user.id) });
      pushStateSafe(state);
    }),
  );

  socket.on(
    'deploy:action',
    safe<{ action?: unknown }>('deploy:action', (payload, reply) => {
      const state = data.roomCode ? getRoom(data.roomCode) : undefined;
      if (!state) return reply({ ok: false, error: 'Комната не найдена' });
      const action = parseDeployAction(payload?.action);
      if (!action) return reply({ ok: false, error: 'Некорректное действие' });
      const result = applyDeployAction(state, actingPlayerId(state, user.id), action);
      if (!result.ok) return reply({ ok: false, error: result.error });
      reply({ ok: true, state: viewOf(state, user.id) });
      pushStateSafe(state, { skip: socket.id });
    }),
  );

  socket.on(
    'game:action',
    safe<{ action?: unknown }>('game:action', (payload, reply) => {
      const state = data.roomCode ? getRoom(data.roomCode) : undefined;
      if (!state) return reply({ ok: false, error: 'Комната не найдена' });
      const action = parseGameAction(payload?.action);
      if (!action) return reply({ ok: false, error: 'Некорректное действие' });

      const actor = action.type === 'squareReply' ? user.id : actingPlayerId(state, user.id);
      const result = applyAction(state, actor, action);
      if (!result.ok) return reply({ ok: false, error: result.error });
      const fx = maskFxFor(state, actor, result.fx);
      autoEndTurnIfExhausted(state);
      reply({ ok: true, state: viewOf(state, user.id), fx });
      pushStateSafe(state, { fx: result.fx, skip: socket.id });
    }),
  );

  socket.on('disconnect', () => {
    (async () => {
      const state = data.roomCode ? getRoom(data.roomCode) : undefined;
      if (!state) return;
      // Сокет к моменту 'disconnect' уже вышел из всех комнат socket.io, поэтому
      // достаточно проверить, не остался ли у пользователя другой сокет здесь же.
      const stillHere = await userHasOtherSocket(state.roomCode, user.id);
      if (!stillHere) {
        markDisconnected(state, user.id);
        offlineSince.set(offlineKey(state.roomCode, user.id), Date.now());
        pushStateSafe(state);
      }
    })().catch((err) => console.error('[socket] disconnect:', err));
  });
});

// Партии переживают рестарт: поднимаем с диска, людей считаем офлайн с этого момента.
loadUsers();
startUsersAutosave();
for (const state of loadRooms()) {
  restoreTurnClock(state);
  restoreNotifyState(state);
  kickAi(state);
  for (const player of state.players) {
    if (!player.connected && !isHotseatRival(player.id)) offlineSince.set(offlineKey(state.roomCode, player.id), Date.now());
  }
}
startRoomCleanup();
startRoomAutosave();

/** Сохраняем всё перед остановкой (systemctl restart шлёт SIGTERM). */
function shutdown(signal: string): void {
  console.log(`[server] ${signal}: сохраняем партии и выходим`);
  saveRooms(true);
  saveUsers(true);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/** С такого времени на ход партия асинхронная: офлайн-пропуск (3 мин) не действует. */
const ASYNC_TURN_MINUTES = 60;

/** Ход сгорел по таймеру: сначала автоответ обороны (если ждём каре), потом конец хода. */
function expireTurn(state: GameState): boolean {
  const current = currentPlayer(state);
  if (!current) return false;
  if (state.pendingSquare) {
    applyAction(state, state.pendingSquare.defenderId, { type: 'squareReply', form: false });
    squareSeenAt.delete(state.roomCode);
  }
  if (state.phase !== 'playing') return true;
  logPublic(state, `${current.name} не успел — ход завершён.`);
  return applyAction(state, current.id, { type: 'endTurn' }).ok;
}

/** Когда в комнате увидели текущий pendingSquare — отсчёт тайм-аута ответа обороны. */
const squareSeenAt = new Map<string, { pending: NonNullable<GameState['pendingSquare']>; at: number }>();

/**
 * Периодическая уборка: в лобби освобождает место не вернувшегося игрока, в
 * партии — решает зависшее каре и пропускает ход надолго отключившегося игрока.
 */
function sweep(): void {
  const now = Date.now();
  for (const state of listRooms()) {
    if (state.phase === 'lobby') {
      for (const player of [...state.players]) {
        if (player.connected) continue;
        const key = offlineKey(state.roomCode, player.id);
        const since = offlineSince.get(key);
        if (since != null && now - since > LOBBY_GRACE_MS) {
          removePlayer(state, player.id);
          offlineSince.delete(key);
          pushStateSafe(state);
        }
      }
      continue;
    }

    if (state.phase === 'deploy') {
      // Варгейм: не вернувшийся к расстановке получает автозакупку и «Готов» — остальные не ждут вечно.
      if (state.settings.hotseat) continue;
      for (const player of humanPlayers(state)) {
        if (player.connected || player.deployReady) continue;
        const since = offlineSince.get(offlineKey(state.roomCode, player.id));
        if (since != null && now - since > LOBBY_GRACE_MS) {
          forceDeployReady(state, player.id);
          pushStateSafe(state);
        }
      }
      continue;
    }

    if (state.phase !== 'playing') continue;
    // В соло ждать некого: за «Соперника» (он всегда офлайн) каре выбирает сам хост.
    if (state.settings.hotseat) continue;

    syncTurnClock(state, now);
    if (turnExpired(state, now)) {
      const anyoneOnline = humanPlayers(state).some((p) => p.connected);
      // Быстрый таймер не гоняет партию по кругу, пока в ней никого нет; асинхронный — сжигает ход по дедлайну.
      if (!anyoneOnline && state.settings.turnMinutes < ASYNC_TURN_MINUTES) {
        pauseTurnClock(state, now);
        markDirty(state.roomCode);
      } else if (expireTurn(state)) {
        pushStateSafe(state);
        continue;
      }
    }

    const pending = state.pendingSquare;
    if (pending) {
      // Отсчёт привязан к конкретному предложению, а не к комнате: новое каре — новый таймер.
      const seen = squareSeenAt.get(state.roomCode);
      const seenAt = seen && seen.pending === pending ? seen.at : now;
      squareSeenAt.set(state.roomCode, { pending, at: seenAt });
      const defender = state.players.find((p) => p.id === pending.defenderId);
      const defenderOffline = !defender || !defender.connected;
      if (defenderOffline || now - seenAt > SQUARE_REPLY_MS) {
        const result = applyAction(state, pending.defenderId, { type: 'squareReply', form: false });
        squareSeenAt.delete(state.roomCode);
        if (result.ok) {
          autoEndTurnIfExhausted(state);
          pushStateSafe(state, { fx: result.fx });
        }
      }
      continue;
    }
    squareSeenAt.delete(state.roomCode);

    // В асинхронной партии офлайн — норма: ход сгорает только по дедлайну.
    if (state.settings.turnMinutes >= ASYNC_TURN_MINUTES) continue;

    const current = currentPlayer(state);
    if (!current || current.connected) continue;
    const key = offlineKey(state.roomCode, current.id);
    const since = offlineSince.get(key) ?? now;
    if (!offlineSince.has(key)) offlineSince.set(key, since);
    if (now - since <= TURN_SKIP_OFFLINE_MS) continue;
    const anotherOnline = humanPlayers(state).some((p) => p.id !== current.id && p.alive && p.connected);
    if (!anotherOnline) continue;
    const result = applyAction(state, current.id, { type: 'endTurn' });
    if (result.ok) pushStateSafe(state);
  }
  tickReminders(listRooms(), now, (code, userId) => {
    const since = offlineSince.get(offlineKey(code, userId));
    return since == null ? null : now - since;
  });
}

setInterval(sweep, 10_000);

process.on('unhandledRejection', (err) => console.error('[server] unhandledRejection:', err));

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] порт ${PORT} уже занят`);
    process.exit(1);
  }
  console.error('[server]', err);
  process.exit(1);
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] http://localhost:${PORT}`);
  if (!DEV_MODE && !BOT_TOKEN) {
    console.warn('[server] BOT_TOKEN не задан — вход через Telegram работать не будет');
  }
});

/** Между попытками запустить бота, если сеть или Telegram недоступны при старте. */
const BOT_RETRY_MS = 15_000;

function launchBot(): void {
  startBot({
    token: BOT_TOKEN,
    webAppUrl: process.env.WEBAPP_URL ?? `http://localhost:${PORT}`,
    shortName: process.env.WEBAPP_SHORT_NAME ?? 'play',
  }).catch((err) => {
    console.error(`[bot] не удалось запустить, повтор через ${BOT_RETRY_MS / 1000} с:`, err);
    setTimeout(launchBot, BOT_RETRY_MS);
  });
}

if (BOT_TOKEN) {
  launchBot();
} else {
  console.log('[bot] BOT_TOKEN не задан, бот не запускается');
}
