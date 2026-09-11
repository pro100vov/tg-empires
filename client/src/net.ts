import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { GameFx, GameState } from '@tge/shared';
import { devId, tg } from './telegram';

export type AckResponse = { ok: true; state: GameState; fx?: GameFx } | { ok: false; error: string };

export function connect(): Socket {
  const url = import.meta.env.VITE_SERVER_URL || undefined;
  return io(url, {
    // Telegram WebView и cloudflared часто ломают апгрейд WebSocket.
    // Сначала HTTP long-polling, сокет подключается следом если получится.
    transports: ['polling', 'websocket'],
    upgrade: true,
    timeout: 20000,
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
