import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { GameAction, GameState } from '@tge/shared';
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
    socket.on('connect_error', (err) => setFatal(err.message));
    socket.on('me', (user: Me) => setMe(user));
    socket.on('state', (next: GameState) => setState(next));

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, []);

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

  const startGame = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;
    const response = await request(socket, 'game:start', {});
    if (response.ok) setState(response.state);
    else setToast(response.error);
  }, []);

  const act = useCallback(async (action: GameAction) => {
    const socket = socketRef.current;
    if (!socket) return false;
    const response = await request(socket, 'game:action', { action });
    if (response.ok) {
      setState(response.state);
      return true;
    }
    setToast(response.error);
    hapticResult('error');
    return false;
  }, []);

  // Ссылка-приглашение сразу приводит игрока в нужную комнату.
  const autoJoined = useRef(false);
  useEffect(() => {
    if (!connected || !me || autoJoined.current) return;
    const code = roomCodeFromEnvironment();
    if (!code) return;
    autoJoined.current = true;
    void joinRoom(code);
  }, [connected, me, joinRoom]);

  if (fatal) {
    return (
      <div className="screen center">
        <h2>Не удалось подключиться</h2>
        <p className="muted">{fatal}</p>
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
          onJoin={joinRoom}
          onStart={startGame}
        />
      ) : (
        <GameScreen state={state} meId={me.id} act={act} notify={setToast} />
      )}
      <Toast message={toast} onHide={() => setToast('')} />
    </>
  );
}
