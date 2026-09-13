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

export default function App() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [toast, setToast] = useState('');
  const [fatal, setFatal] = useState('');
  const [fx, setFx] = useState<GameFx | null>(null);
  const [booted, setBooted] = useState(false);
  const fxSeqRef = useRef(0);

  const applyWithFx = useCallback((next: GameState, nextFx?: GameFx) => {
    setState(next);
    if (nextFx?.kind === 'move' || nextFx?.kind === 'shoot' || nextFx?.kind === 'charge') {
      const seq = ++fxSeqRef.current;
      setFx(nextFx);
      window.setTimeout(() => {
        if (fxSeqRef.current === seq) setFx(null);
      }, nextFx.kind === 'move' ? 820 : 1000);
      return;
    }
    setFx(null);
  }, []);

  // Код комнаты держим отдельно от состояния: он нужен обработчику connect,
  // который переживает разрывы связи и перезапуски сервера.
  const roomRef = useRef('');
  useEffect(() => {
    roomRef.current = state?.roomCode ?? '';
  }, [state]);

  useEffect(() => {
    const socket = connect();
    socketRef.current = socket;

    socket.on('connect', () => {
      setFatal('');
      setConnected(true);
      void request(socket, 'room:resume', {}).then((response) => {
        if (response.ok) {
          setState(response.state);
          setBooted(true);
          return;
        }
        const roomCode = roomRef.current;
        if (!roomCode) {
          setBooted(true);
          return;
        }
        void request(socket, 'room:join', { roomCode }).then((join) => {
          if (join.ok) setState(join.state);
          else {
            setState(null);
            setToast('Партия больше недоступна');
          }
          setBooted(true);
        });
      });
    });
    socket.on('disconnect', () => setConnected(false));
    let errors = 0;
    socket.on('connect_error', (err) => {
      errors += 1;
      if (errors >= 4) setFatal(err.message);
    });
    socket.on('me', (user: Me) => setMe(user));
    socket.on('state', (next: GameState) => setState(next));
    socket.on('update', (payload: { state: GameState; fx?: GameFx }) => {
      applyWithFx(payload.state, payload.fx);
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [applyWithFx]);

  const joinRoom = useCallback(async (roomCode: string) => {
    const socket = socketRef.current;
    if (!socket) return;
    const response = await request(socket, 'room:join', { roomCode });
    if (response.ok) setState(response.state);
    else setToast(response.error);
  }, []);

  const createRoom = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;
    const response = await request(socket, 'room:create', {});
    if (response.ok) setState(response.state);
    else setToast(response.error);
  }, []);

  const createSolo = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;
    const response = await request(socket, 'room:solo', {});
    if (response.ok) setState(response.state);
    else setToast(response.error);
  }, []);

  const startGame = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;
    const response = await request(socket, 'game:start', {});
    if (response.ok) setState(response.state);
    else setToast(response.error);
  }, []);

  const lobbyAct = useCallback(async (action: LobbyAction) => {
    const socket = socketRef.current;
    if (!socket) return;
    const response = await request(socket, 'lobby:action', { action });
    if (response.ok) setState(response.state);
    else setToast(response.error);
  }, []);

  const leaveRoom = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;
    const response = await request(socket, 'room:leave', {});
    if (response.ok) {
      roomRef.current = '';
      setState(null);
    } else setToast(response.error);
  }, []);

  const inviteBack = useCallback(async (playerId: string) => {
    const socket = socketRef.current;
    if (!socket) return;
    const response = await request(socket, 'room:invite', { playerId });
    if (response.ok) setState(response.state);
    else setToast(response.error);
  }, []);

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

  // Ссылка-приглашение сразу приводит игрока в нужную комнату.
  const autoJoined = useRef(false);
  useEffect(() => {
    if (!connected || !me || !booted || autoJoined.current) return;
    const code = roomCodeFromEnvironment();
    if (!code) return;
    autoJoined.current = true;
    if (state) return;
    void joinRoom(code);
  }, [connected, me, booted, state, joinRoom]);

  if (fatal) {
    return (
      <div className="screen center">
        <h2>Не удалось подключиться</h2>
        <p className="muted">{fatal}</p>
      </div>
    );
  }

  if (!connected || !me || !booted) {
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
          onLeave={leaveRoom}
          onInvite={inviteBack}
        />
      ) : (
        <GameScreen
          state={state}
          meId={actingPlayerId(state, me.id)}
          viewerId={me.id}
          act={act}
          notify={setToast}
          fx={fx}
          onLeave={leaveRoom}
          onInvite={inviteBack}
        />
      )}
      <Toast message={toast} onHide={() => setToast('')} />
    </>
  );
}
