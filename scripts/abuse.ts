/**
 * Стучится в локальный сервер (DEV_MODE=1) кривыми payload'ами и проверяет,
 * что процесс не падает: /health отвечает {ok:true} после всей пальбы.
 * Запуск: DEV_MODE=1 tsx scripts/abuse.ts (сервер должен быть уже запущен).
 */
import { io } from 'socket.io-client';

const URL = process.env.ABUSE_URL ?? 'http://localhost:3000';

const BAD_GAME_ACTIONS: unknown[] = [
  null,
  {},
  { type: 'build' },
  { type: 'build', at: { x: 1, y: 1 }, building: 'constructor' },
  { type: 'recruit', at: { x: 0, y: 0 }, count: NaN },
  { type: 'recruit', at: { x: 0, y: 0 }, count: 1, unit: 'constructor' },
  { type: 'move', from: { x: 'a', y: 0 }, to: { x: 1, y: 1 }, count: 1 },
  { type: 'appoint', at: { x: 0, y: 0 }, commander: '__proto__' },
  { type: 'hack' },
  'не объект',
  42,
  ['array'],
];

const BAD_LOBBY_ACTIONS: unknown[] = [
  null,
  {},
  { type: 'paint' },
  { type: 'configure' },
  { type: 'setAdmin', playerId: 'p1', admin: 'yes' },
];

async function health(): Promise<boolean> {
  try {
    const res = await fetch(`${URL}/health`);
    const json = (await res.json()) as { ok?: boolean };
    return json.ok === true;
  } catch {
    return false;
  }
}

function connect(devId: string): Promise<import('socket.io-client').Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(URL, {
      transports: ['polling', 'websocket'],
      auth: { devId },
    });
    const timeout = setTimeout(() => reject(new Error('не удалось подключиться')), 8000);
    socket.on('connect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function emit(socket: import('socket.io-client').Socket, event: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ ok: false, error: 'нет ответа за 5с' }), 5000);
    socket.emit(event, payload, (response: unknown) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

async function main(): Promise<void> {
  if (!(await health())) {
    console.error(`[abuse] сервер недоступен на ${URL} (нужен DEV_MODE=1)`);
    process.exit(1);
  }

  const socket = await connect('abuse-tester');
  await emit(socket, 'room:create', {});

  for (const action of BAD_GAME_ACTIONS) {
    await emit(socket, 'game:action', { action });
  }
  for (const action of BAD_LOBBY_ACTIONS) {
    await emit(socket, 'lobby:action', { action });
  }
  // Мусор верхнего уровня — не {action: ...}, а вообще что попало.
  await emit(socket, 'game:action', null);
  await emit(socket, 'game:action', 'строка вместо объекта');
  await emit(socket, 'room:join', { roomCode: 'x'.repeat(10000) });

  socket.close();

  const alive = await health();
  if (!alive) {
    console.error('[abuse] сервер упал после кривых сообщений');
    process.exit(1);
  }
  console.log('✓ сервер пережил кривые payload\'ы, /health отвечает {ok:true}');
}

void main();
