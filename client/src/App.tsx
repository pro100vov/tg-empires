import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { actingPlayerId } from '@tge/shared';
import type { GameAction, GameFx, GameState, LobbyAction } from '@tge/shared';
import { connect, request } from './net';
import { hapticResult, roomCodeFromEnvironment } from './telegram';
import Lobby from './components/Lobby';
import GameScreen from './components/GameScreen';
import Toast from './components/Toast';

interface Me {
  id: string;
  name: string;
}

/** Ключ последней комнаты в localStorage — свой на каждого пользователя (dev-вкладки не мешают друг другу). */
function lastRoomKey(userId: string): string {
  return `tge-last-room:${userId}`;
}

export default function App() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [toast, setToast] = useState('');
  const [fatal, setFatal] = useState('');
  const [fx, setFx] = useState<GameFx | null>(null);
  const fxSeqRef = useRef(0);

  // Код комнаты и id пользователя держим в ref: они нужны обработчикам socket,
  // которые регистрируются один раз и переживают разрывы связи и перезапуски сервера.
  const roomRef = useRef('');
  useEffect(() => {
    roomRef.current = state?.roomCode ?? '';
  }, [state]);
  const meRef = useRef<Me | null>(null);
  useEffect(() => {
    meRef.current = me;
  }, [me]);

  const rememberRoom = useCallback((code: string) => {
    const id = meRef.current?.id;
    if (!id) return;
    try {
      localStorage.setItem(lastRoomKey(id), code);
    } catch {
      // localStorage может быть недоступен (приватный режим и т.п.) — не критично.
    }
  }, []);

  const forgetRoom = useCallback(() => {
    const id = meRef.current?.id;
    if (!id) return;
    try {
      localStorage.removeItem(lastRoomKey(id));
    } catch {
      // ignore
    }
  }, []);

  const applyState = useCallback(
    (next: GameState) => {
      setState(next);
      rememberRoom(next.roomCode);
    },
    [rememberRoom],
  );

  const applyWithFx = useCallback(
    (next: GameState, nextFx?: GameFx) => {
      setState(next);
      rememberRoom(next.roomCode);
      if (nextFx?.kind === 'move' || nextFx?.kind === 'shoot' || nextFx?.kind === 'charge') {
        const seq = ++fxSeqRef.current;
        setFx(nextFx);
        window.setTimeout(() => {
          if (fxSeqRef.current === seq) setFx(null);
        }, nextFx.kind === 'move' ? 820 : 1000);
        return;
      }
      setFx(null);
    },
    [rememberRoom],
  );

  useEffect(() => {
    const socket = connect();
    socketRef.current = socket;

    let errors = 0;
    socket.on('connect', () => {
      errors = 0;
      setFatal('');
      setConnected(true);
      const roomCode = roomRef.current;
      if (!roomCode) return;
      void request(socket, 'room:join', { roomCode }).then((response) => {
        if (response.ok) {
          setState(response.state);
        } else {
          setState(null);
          setToast('Партия больше недоступна');
        }
      });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err) => {
      errors += 1;
      // Отказ сервера (например, подпись Telegram не прошла) socket.io сам не повторяет —
      // ждать 4 попыток бессмысленно, иначе вечный «Соединение с сервером…».
      if (!socket.active || errors >= 4) setFatal(err.message);
    });
    socket.on('me', (user: Me) => setMe(user));
    socket.on('state', (next: GameState) => {
      // Партия сменилась (создали/вошли в другую комнату) — старые обновления игнорируем.
      if (roomRef.current && next.roomCode !== roomRef.current) return;
      setState(next);
      rememberRoom(next.roomCode);
    });
    socket.on('update', (payload: { state: GameState; fx?: GameFx }) => {
      if (roomRef.current && payload.state.roomCode !== roomRef.current) return;
      applyWithFx(payload.state, payload.fx);
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [applyWithFx, rememberRoom]);

  const joinRoom = useCallback(
    async (roomCode: string) => {
      const socket = socketRef.current;
      if (!socket) return;
      const response = await request(socket, 'room:join', { roomCode });
      if (response.ok) applyState(response.state);
      else setToast(response.error);
    },
    [applyState],
  );

  const createRoom = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;
    const response = await request(socket, 'room:create', {});
    if (response.ok) applyState(response.state);
    else setToast(response.error);
  }, [applyState]);

  const createSolo = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;
    const response = await request(socket, 'room:solo', {});
    if (response.ok) applyState(response.state);
    else setToast(response.error);
  }, [applyState]);

  const startGame = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;
    const response = await request(socket, 'game:start', {});
    if (response.ok) applyState(response.state);
    else setToast(response.error);
  }, [applyState]);

  const lobbyAct = useCallback(
    async (action: LobbyAction) => {
      const socket = socketRef.current;
      if (!socket) return;
      const response = await request(socket, 'lobby:action', { action });
      if (response.ok) applyState(response.state);
      else setToast(response.error);
    },
    [applyState],
  );

  const act = useCallback(
    async (action: GameAction) => {
      const socket = socketRef.current;
      if (!socket) return { ok: false as const };
      const response = await request(socket, 'game:action', { action });
      if (response.ok) {
        applyWithFx(response.state, response.fx);
        return { ok: true as const, fx: response.fx, state: response.state };
      }
      setToast(response.error);
      hapticResult('error');
      return { ok: false as const };
    },
    [applyWithFx],
  );

  const leaveRoom = useCallback(async () => {
    const socket = socketRef.current;
    if (socket) {
      await request(socket, 'room:leave', {});
    }
    setState(null);
    forgetRoom();
  }, [forgetRoom]);

  // Ссылка-приглашение сразу приводит игрока в нужную комнату; без неё — вспоминаем
  // последнюю комнату из localStorage (например, после перезагрузки страницы).
  const autoJoined = useRef(false);
  useEffect(() => {
    if (!connected || !me || autoJoined.current) return;
    const code = roomCodeFromEnvironment();
    if (code) {
      autoJoined.current = true;
      void joinRoom(code);
      return;
    }
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(lastRoomKey(me.id));
    } catch {
      stored = null;
    }
    if (!stored) return;
    autoJoined.current = true;
    const socket = socketRef.current;
    if (!socket) return;
    void request(socket, 'room:join', { roomCode: stored }).then((response) => {
      // Молча: комната могла закрыться, пока нас не было — это не ошибка пользователя.
      if (response.ok) applyState(response.state);
      else forgetRoom();
    });
  }, [connected, me, joinRoom, applyState, forgetRoom]);

  if (fatal) {
    return (
      <div className="screen center">
        <h2>Не удалось подключиться</h2>
        <p className="muted">{fatal}</p>
        <p className="muted">Закройте игру и откройте её заново из чата с ботом.</p>
      </div>
    );
  }

  if (!connected || !me) {
    return (
      <div className="screen center">
        <div className="spinner" />
        <p className="muted">Соединение с сервером…</p>
      </div>
    );
  }

  return (
    <>
      {!state || state.phase === 'lobby' ? (
        <Lobby
          state={state}
          me={me}
          onCreate={createRoom}
          onSolo={createSolo}
          onJoin={joinRoom}
          onStart={startGame}
          onLobby={lobbyAct}
          onExit={leaveRoom}
        />
      ) : (
        <GameScreen
          state={state}
          meId={actingPlayerId(state, me.id)}
          viewerId={me.id}
          act={act}
          notify={setToast}
          fx={fx}
          onExit={leaveRoom}
        />
      )}
      <Toast message={toast} onHide={() => setToast('')} />
    </>
  );
}
