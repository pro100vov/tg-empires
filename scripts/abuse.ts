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
  { type: 'eventChoice' },
  { type: 'eventChoice', choice: 7 },
  { type: 'eventChoice', choice: '1' },
  { type: 'propose' },
  { type: 'propose', to: 5, kind: 'truce' },
  { type: 'propose', to: 'x', kind: '__proto__', rounds: 3 },
  { type: 'propose', to: 'x', kind: 'truce', rounds: NaN },
  { type: 'propose', to: 'abuse-2', kind: 'truce', rounds: 1e12 },
  { type: 'propose', to: 'abuse-2', kind: 'truce', rounds: 4 },
  { type: 'propose', to: 'abuse-tester', kind: 'alliance' },
  { type: 'acceptProposal', id: { a: 1 } },
  { type: 'acceptProposal', id: 'нет>такого' },
  { type: 'declineProposal', id: 'x'.repeat(5000) },
  { type: 'breakTreaty', with: '__proto__' },
  { type: 'breakTreaty', with: 'abuse-2' },
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
  { type: 'addAi' },
  { type: 'addAi', difficulty: '__proto__' },
  { type: 'addAi', difficulty: 9 },
  { type: 'removeAi' },
  { type: 'removeAi', playerId: { x: 1 } },
  { type: 'removeAi', playerId: 'abuse-tester' },
  { type: 'configure', settings: { turnMinutes: 'много', randomEvents: 'да', diplomacy: {} } },
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
  const created = (await emit(socket, 'room:create', {})) as { state?: { roomCode?: string } };

  for (const action of BAD_GAME_ACTIONS) {
    await emit(socket, 'game:action', { action });
  }
  for (const action of BAD_LOBBY_ACTIONS) {
    await emit(socket, 'lobby:action', { action });
  }

  // Идущая партия с двумя людьми и ИИ: то же самое, но уже с настоящим движком.
  const second = await connect('abuse-2');
  await emit(second, 'room:join', { roomCode: created.state?.roomCode });
  await emit(socket, 'lobby:action', { action: { type: 'addAi', difficulty: 'hard' } });
  await emit(socket, 'game:start', {});
  for (const action of BAD_GAME_ACTIONS) {
    await emit(socket, 'game:action', { action });
    await emit(second, 'game:action', { action });
  }
  await emit(socket, 'room:rematch', {});
  await emit(second, 'room:rematch', {});
  second.close();

  // Новые события сокета с мусором.
  for (const payload of [null, {}, 'строка', 42, { ai: 'hard' }, { ai: [] }, { ai: ['x'] }, { ai: ['easy', 'easy', 'easy', 'easy'] }, { ai: [{}] }, { ai: ['hard'], tutorial: 'да' }]) {
    await emit(socket, 'room:solo', payload);
  }
  await emit(socket, 'room:mine', null);
  await emit(socket, 'room:mine', 'мусор');
  socket.emit('user:write', 'мусор');
  socket.emit('room:mine');
  socket.emit('room:rematch');
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
