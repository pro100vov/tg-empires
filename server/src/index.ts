import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import dotenv from 'dotenv';
import express from 'express';
import { Server } from 'socket.io';

import { addPlayer, applyAction, autoEndTurnIfExhausted, removePlayer, startGame } from '@tge/shared';
import type { GameAction, GameState } from '@tge/shared';

import { devUser, verifyInitData } from './auth.js';
import type { AuthUser } from './auth.js';
import { createRoom, getRoom, startRoomCleanup } from './rooms.js';
import { startBot } from './bot.js';

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

function broadcast(state: GameState): void {
  io.to(state.roomCode).emit('state', state);
}

type Ack = (response: { ok: true; state: GameState } | { ok: false; error: string }) => void;

io.on('connection', (socket) => {
  const data = socket.data as SocketData;
  const { user } = data;
  socket.emit('me', user);

  const joinState = (state: GameState, ack?: Ack) => {
    const result = addPlayer(state, user.id, user.name);
    if (!result.ok) {
      ack?.({ ok: false, error: result.error });
      return;
    }
    data.roomCode = state.roomCode;
    void socket.join(state.roomCode);
    ack?.({ ok: true, state });
    broadcast(state);
  };

  socket.on('room:create', (_payload: unknown, ack?: Ack) => {
    joinState(createRoom(user.id), ack);
  });

  socket.on('room:join', (payload: { roomCode?: string }, ack?: Ack) => {
    const code = (payload?.roomCode ?? '').toUpperCase().trim();
    const state = code ? getRoom(code) : undefined;
    if (!state) {
      ack?.({ ok: false, error: 'Комната не найдена' });
      return;
    }
    joinState(state, ack);
  });

  socket.on('game:start', (_payload: unknown, ack?: Ack) => {
    const state = data.roomCode ? getRoom(data.roomCode) : undefined;
    if (!state) return ack?.({ ok: false, error: 'Комната не найдена' });
    const result = startGame(state, user.id);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    ack?.({ ok: true, state });
    broadcast(state);
  });

  socket.on('game:action', (payload: { action?: GameAction }, ack?: Ack) => {
    const state = data.roomCode ? getRoom(data.roomCode) : undefined;
    if (!state) return ack?.({ ok: false, error: 'Комната не найдена' });
    if (!payload?.action) return ack?.({ ok: false, error: 'Пустое действие' });

    const result = applyAction(state, user.id, payload.action);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    autoEndTurnIfExhausted(state);
    ack?.({ ok: true, state });
    broadcast(state);
  });

  socket.on('disconnect', () => {
    const state = data.roomCode ? getRoom(data.roomCode) : undefined;
    if (!state) return;
    // Комната переживает выход игроков: перезагрузка страницы или переход по
    // ссылке не должны стирать партию. Пустые комнаты убирает уборщик по TTL.
    removePlayer(state, user.id);
    broadcast(state);
  });
});

startRoomCleanup();

httpServer.listen(PORT, () => {
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
