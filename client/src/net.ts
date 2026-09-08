import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { GameState } from '@tge/shared';
import { devId, tg } from './telegram';

export type AckResponse = { ok: true; state: GameState } | { ok: false; error: string };

export function connect(): Socket {
  const url = import.meta.env.VITE_SERVER_URL || undefined;
  return io(url, {
    transports: ['websocket', 'polling'],
    auth: {
      initData: tg?.initData ?? '',
      devId: devId(),
    },
  });
}

export function request(socket: Socket, event: string, payload: unknown): Promise<AckResponse> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ ok: false, error: 'Сервер не ответил' }), 8000);
    socket.emit(event, payload, (response: AckResponse) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}
