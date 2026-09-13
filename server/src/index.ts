import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import dotenv from 'dotenv';
import express from 'express';
import { Server } from 'socket.io';

import { addPlayer, applyAction, applyLobbyAction, autoEndTurnIfExhausted, actingPlayerId, invitePlayerBack, leavePlayer, maskFxFor, maskStateFor, rememberSeenBuildings, removePlayer, setupHotseat, startGame } from '@tge/shared';
import type { GameAction, GameFx, GameState, LobbyAction } from '@tge/shared';

import { devUser, verifyInitData } from './auth.js';
import type { AuthUser } from './auth.js';
import { createRoom, discardIfAbandoned, findRoomByPlayer, getRoom, startRoomCleanup } from './rooms.js';
import { notifyPlayerInvited, startBot } from './bot.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(rootDir, '.env') });

const PORT = Number(process.env.PORT ?? 3000);
const BOT_TOKEN = process.env.BOT_TOKEN ?? '';
const DEV_MODE = process.env.DEV_MODE === '1';

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
  next();
});

function viewOf(state: GameState, userId: string): GameState {
  const viewer = actingPlayerId(state, userId);
  rememberSeenBuildings(state, viewer);
  return maskStateFor(state, viewer);
}

async function pushState(state: GameState, payload?: { fx?: GameFx; skip?: string }): Promise<void> {
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

type Ack = (response: { ok: true; state: GameState; fx?: GameFx } | { ok: false; error: string }) => void;

io.on('connection', (socket) => {
  const data = socket.data as SocketData;
  const { user } = data;
  socket.emit('me', user);

  const attach = (state: GameState) => {
    data.roomCode = state.roomCode;
    void socket.join(state.roomCode);
  };

  const joinState = (state: GameState, ack?: Ack) => {
    if (state.settings.hotseat && user.id !== state.hostId && !state.players.some((p) => p.id === user.id)) {
      ack?.({ ok: false, error: 'Это партия сам с собой' });
      return;
    }
    const result = addPlayer(state, user.id, user.name);
    if (!result.ok) {
      ack?.({ ok: false, error: result.error });
      return;
    }
    attach(state);
    ack?.({ ok: true, state: viewOf(state, user.id) });
    void pushState(state);
  };

  const resumeActive = (): GameState | undefined => {
    const existing = findRoomByPlayer(user.id);
    if (!existing) return undefined;
    const result = addPlayer(existing, user.id, user.name);
    if (!result.ok) return undefined;
    attach(existing);
    return existing;
  };

  socket.on('room:resume', (_payload: unknown, ack?: Ack) => {
    const existing = resumeActive();
    if (!existing) {
      ack?.({ ok: false, error: 'Нет активной партии' });
      return;
    }
    ack?.({ ok: true, state: viewOf(existing, user.id) });
    void pushState(existing);
  });

  socket.on('room:create', (_payload: unknown, ack?: Ack) => {
    const existing = resumeActive();
    if (existing) {
      ack?.({ ok: true, state: viewOf(existing, user.id) });
      void pushState(existing);
      return;
    }
    joinState(createRoom(user.id), ack);
  });

  socket.on('room:solo', (_payload: unknown, ack?: Ack) => {
    const existing = resumeActive();
    if (existing) {
      ack?.({ ok: true, state: viewOf(existing, user.id) });
      void pushState(existing);
      return;
    }
    const state = createRoom(user.id);
    const result = setupHotseat(state, user.id, user.name);
    if (!result.ok) {
      ack?.({ ok: false, error: result.error });
      return;
    }
    attach(state);
    ack?.({ ok: true, state: viewOf(state, user.id) });
  });

  socket.on('room:join', (payload: { roomCode?: string }, ack?: Ack) => {
    const code = (payload?.roomCode ?? '').toUpperCase().trim();
    const state = code ? getRoom(code) : undefined;
    if (!state) {
      ack?.({ ok: false, error: 'Комната не найдена' });
      return;
    }
    const mine = findRoomByPlayer(user.id);
    if (mine && mine.roomCode !== state.roomCode) {
      ack?.({ ok: false, error: 'Сначала выйдите из текущей партии' });
      return;
    }
    joinState(state, ack);
  });

  socket.on('room:leave', (_payload: unknown, ack?: Ack) => {
    const state = data.roomCode ? getRoom(data.roomCode) : findRoomByPlayer(user.id);
    if (!state) return ack?.({ ok: false, error: 'Комната не найдена' });
    const result = leavePlayer(state, user.id);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    void socket.leave(state.roomCode);
    data.roomCode = undefined;
    if (discardIfAbandoned(state)) {
      ack?.({ ok: true, state: viewOf(state, user.id) });
      return;
    }
    ack?.({ ok: true, state: viewOf(state, user.id) });
    void pushState(state);
  });

  socket.on('room:invite', (payload: { playerId?: string }, ack?: Ack) => {
    const state = data.roomCode ? getRoom(data.roomCode) : undefined;
    if (!state) return ack?.({ ok: false, error: 'Комната не найдена' });
    const targetId = payload?.playerId ?? '';
    if (!targetId) return ack?.({ ok: false, error: 'Некого приглашать' });
    const busy = findRoomByPlayer(targetId);
    if (busy && busy.roomCode !== state.roomCode) {
      return ack?.({ ok: false, error: 'Игрок уже в другой партии — пусть выйдет из неё' });
    }
    const result = invitePlayerBack(state, user.id, targetId);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    notifyPlayerInvited(targetId, state.roomCode, user.name);
    ack?.({ ok: true, state: viewOf(state, user.id) });
    void pushState(state);
  });

  socket.on('game:start', (_payload: unknown, ack?: Ack) => {
    const state = data.roomCode ? getRoom(data.roomCode) : undefined;
    if (!state) return ack?.({ ok: false, error: 'Комната не найдена' });
    const result = startGame(state, user.id);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    ack?.({ ok: true, state: viewOf(state, user.id) });
    void pushState(state);
  });

  socket.on('lobby:action', (payload: { action?: LobbyAction }, ack?: Ack) => {
    const state = data.roomCode ? getRoom(data.roomCode) : undefined;
    if (!state) return ack?.({ ok: false, error: 'Комната не найдена' });
    if (!payload?.action) return ack?.({ ok: false, error: 'Пустое действие' });
    const result = applyLobbyAction(state, user.id, payload.action);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    ack?.({ ok: true, state: viewOf(state, user.id) });
    void pushState(state);
  });

  socket.on('game:action', (payload: { action?: GameAction }, ack?: Ack) => {
    const state = data.roomCode ? getRoom(data.roomCode) : undefined;
    if (!state) return ack?.({ ok: false, error: 'Комната не найдена' });
    if (!payload?.action) return ack?.({ ok: false, error: 'Пустое действие' });

    const actor =
      payload.action.type === 'squareReply' ? user.id : actingPlayerId(state, user.id);
    const result = applyAction(state, actor, payload.action);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    const fx = maskFxFor(state, actor, result.fx);
    autoEndTurnIfExhausted(state);
    ack?.({ ok: true, state: viewOf(state, user.id), fx });
    void pushState(state, { fx: result.fx, skip: socket.id });
  });

  socket.on('disconnect', () => {
    const state = data.roomCode ? getRoom(data.roomCode) : undefined;
    if (!state) return;
    // Комната переживает выход игроков: перезагрузка страницы или переход по
    // ссылке не должны стирать партию. Пустые комнаты убирает уборщик по TTL.
    removePlayer(state, user.id);
    void pushState(state);
  });
});

startRoomCleanup();

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

if (BOT_TOKEN) {
  startBot({
    token: BOT_TOKEN,
    webAppUrl: process.env.WEBAPP_URL ?? `http://localhost:${PORT}`,
    shortName: process.env.WEBAPP_SHORT_NAME ?? 'play',
  }).catch((err) => console.error('[bot] не удалось запустить:', err));
} else {
  console.log('[bot] BOT_TOKEN не задан, бот не запускается');
}
