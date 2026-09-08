import { useState } from 'react';
import { MAX_PLAYERS, MIN_PLAYERS } from '@tge/shared';
import type { GameState } from '@tge/shared';
import { haptic } from '../telegram';

interface Props {
  state: GameState | null;
  me: { id: string; name: string };
  onCreate: () => void;
  onJoin: (code: string) => void;
  onStart: () => void;
}

export default function Lobby({ state, me, onCreate, onJoin, onStart }: Props) {
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);

  if (!state) {
    return (
      <div className="screen menu">
        <div className="hero">
          <div className="hero-icon">🏰</div>
          <h1>TG Empires</h1>
          <p className="muted">
            Пошаговая стратегия на 2–{MAX_PLAYERS} держав: развивайте экономику, стройте
            крепости, изучайте технологии и захватывайте земли соседей.
          </p>
        </div>

        <button
          className="btn primary big"
          onClick={() => {
            haptic('medium');
            onCreate();
          }}
        >
          Создать партию
        </button>

        <div className="join-row">
          <input
            className="input"
            placeholder="Код комнаты"
            value={code}
            maxLength={5}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button className="btn" disabled={code.length < 4} onClick={() => onJoin(code)}>
            Войти
          </button>
        </div>
      </div>
    );
  }

  const isHost = state.hostId === me.id;
  const enough = state.players.length >= MIN_PLAYERS;

  return (
    <div className="screen menu">
      <div className="hero">
        <div className="hero-icon">⚔️</div>
        <h2>Комната {state.roomCode}</h2>
        <p className="muted">Отправьте код или ссылку друзьям — до {MAX_PLAYERS} игроков.</p>
      </div>

      <div className="card">
        {state.players.map((player) => (
          <div key={player.id} className="player-row">
            <span className="dot" style={{ background: player.color }} />
            <span className="grow">{player.name}</span>
            {player.id === state.hostId && <span className="tag">хост</span>}
            {player.id === me.id && <span className="tag">вы</span>}
          </div>
        ))}
        {Array.from({ length: MAX_PLAYERS - state.players.length }).map((_, i) => (
          <div key={`empty-${i}`} className="player-row muted">
            <span className="dot empty" />
            <span className="grow">ожидание игрока…</span>
          </div>
        ))}
      </div>

      <button
        className="btn"
        onClick={() => {
          void navigator.clipboard?.writeText(state.roomCode);
          setCopied(true);
          haptic('light');
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Код скопирован' : `Скопировать код ${state.roomCode}`}
      </button>

      {isHost ? (
        <button
          className="btn primary big"
          disabled={!enough}
          onClick={() => {
            haptic('medium');
            onStart();
          }}
        >
          {enough ? 'Начать партию' : `Нужно минимум ${MIN_PLAYERS} игрока`}
        </button>
      ) : (
        <p className="muted center-text">Ждём, когда хост начнёт партию…</p>
      )}
    </div>
  );
}
