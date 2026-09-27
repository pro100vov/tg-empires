import { useState } from 'react';
import {
  ACTION_OPTIONS,
  ERA_IDS,
  ERAS,
  eraOf,
  MAP_SIZES,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROUND_OPTIONS,
  TERRAIN,
  isHotseatRival,
  isLobbyAdmin,
} from '@tge/shared';
import type { GameState, LobbyAction, TerrainType } from '@tge/shared';
import { haptic } from '../telegram';
import MapBoard from './MapBoard';

interface Props {
  state: GameState | null;
  me: { id: string; name: string };
  onCreate: () => void;
  onSolo: () => void;
  onJoin: (code: string) => void;
  onStart: () => void;
  onLobby: (action: LobbyAction) => void;
  onExit: () => void;
}

const BRUSHES: TerrainType[] = ['plains', 'forest', 'hills', 'mountains', 'water'];
const BRUSH_ICON: Record<TerrainType, string> = {
  plains: '🟩',
  forest: '🌲',
  hills: '⛰️',
  mountains: '🗻',
  water: '🌊',
};

export default function Lobby({ state, me, onCreate, onSolo, onJoin, onStart, onLobby, onExit }: Props) {
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [brush, setBrush] = useState<TerrainType>('forest');

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

        <button
          className="btn big"
          onClick={() => {
            haptic('medium');
            onSolo();
          }}
        >
          Сам с собой
        </button>
        <p className="muted small center-text">
          Обе державы по очереди на одном экране — так удобно проверить туман, ход и бой.
        </p>

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
  const canEdit = isLobbyAdmin(state, me.id);
  const enough = state.players.length >= MIN_PLAYERS;
  const settings = state.settings;
  const era = eraOf(settings);

  const send = (action: LobbyAction) => {
    haptic('light');
    onLobby(action);
  };

  return (
    <div className="screen menu lobby-setup">
      <div className="lobby-scroll">
      <div className="hero">
        <div className="hero-icon">⚔️</div>
        <h2>Комната {state.roomCode}</h2>
        <p className="muted">
          {state.settings.hotseat
            ? 'Сам с собой: после хода экран переключается на другую державу.'
            : 'Отправьте код друзьям. Хост настраивает карту до старта.'}
        </p>
      </div>

      <div className="card">
        {state.players.map((player) => (
          <div key={player.id} className="player-row">
            <span className="dot" style={{ background: player.color }} />
            <span className="grow">{player.name}</span>
            {player.id === state.hostId && <span className="tag">хост</span>}
            {player.id !== state.hostId && state.adminIds.includes(player.id) && (
              <span className="tag">админ</span>
            )}
            {player.id === me.id && <span className="tag">вы</span>}
            {isHotseatRival(player.id) && <span className="tag">вторая держава</span>}
            {isHost && player.id !== me.id && !isHotseatRival(player.id) && (
              <button
                type="button"
                className="btn tiny"
                onClick={() =>
                  send({
                    type: 'setAdmin',
                    playerId: player.id,
                    admin: !state.adminIds.includes(player.id),
                  })
                }
              >
                {state.adminIds.includes(player.id) ? 'снять' : 'админ'}
              </button>
            )}
          </div>
        ))}
        {Array.from({ length: MAX_PLAYERS - state.players.length }).map((_, i) => (
          <div key={`empty-${i}`} className="player-row muted">
            <span className="dot empty" />
            <span className="grow">ожидание игрока…</span>
          </div>
        ))}
      </div>

      <div className="card settings-card">
        <div className="panel-title">Настройки партии</div>
        {!canEdit && (
          <p className="muted small">
            {ERAS[era].icon} {ERAS[era].name}
            {' · '}
            {settings.mapSize}×{settings.mapSize}
            {' · '}
            {settings.terrainMode === 'custom' ? 'свой рельеф' : 'случайный рельеф'}
            {' · '}
            {settings.fogOfWar ? 'туман войны' : 'вся карта видна'}
            {' · '}
            {settings.maxRounds} раундов
            {' · '}
            {settings.actionsPerTurn}⚡
          </p>
        )}

        {canEdit && (
          <>
            <div className="setting-block">
              <div className="setting-label">Эпоха</div>
              <div className="choice-row wrap">
                {ERA_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={`choice${era === id ? ' selected' : ''}`}
                    onClick={() => send({ type: 'configure', settings: { era: id } })}
                    title={ERAS[id].blurb}
                  >
                    {ERAS[id].icon} {ERAS[id].name}
                  </button>
                ))}
              </div>
              <p className="muted small">{ERAS[era].blurb}</p>
            </div>

            <div className="setting-block">
              <div className="setting-label">Размер карты</div>
              <div className="choice-row">
                {MAP_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    className={`choice${settings.mapSize === size ? ' selected' : ''}`}
                    onClick={() => send({ type: 'configure', settings: { mapSize: size } })}
                  >
                    {size}×{size}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-block">
              <div className="setting-label">Рельеф</div>
              <div className="choice-row">
                <button
                  type="button"
                  className={`choice${settings.terrainMode === 'random' ? ' selected' : ''}`}
                  onClick={() => send({ type: 'configure', settings: { terrainMode: 'random' } })}
                >
                  Случайный
                </button>
                <button
                  type="button"
                  className={`choice${settings.terrainMode === 'custom' ? ' selected' : ''}`}
                  onClick={() => send({ type: 'configure', settings: { terrainMode: 'custom' } })}
                >
                  Рисовать
                </button>
                <button type="button" className="choice" onClick={() => send({ type: 'reroll' })}>
                  Перебросить
                </button>
              </div>
            </div>

            <div className="setting-block">
              <div className="setting-label">Видимость</div>
              <div className="choice-row">
                <button
                  type="button"
                  className={`choice${settings.fogOfWar ? ' selected' : ''}`}
                  onClick={() => send({ type: 'configure', settings: { fogOfWar: true } })}
                >
                  Туман войны
                </button>
                <button
                  type="button"
                  className={`choice${!settings.fogOfWar ? ' selected' : ''}`}
                  onClick={() => send({ type: 'configure', settings: { fogOfWar: false } })}
                >
                  Всё поле
                </button>
              </div>
            </div>

            <div className="setting-block">
              <div className="setting-label">Раундов</div>
              <div className="choice-row">
                {ROUND_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`choice${settings.maxRounds === n ? ' selected' : ''}`}
                    onClick={() => send({ type: 'configure', settings: { maxRounds: n } })}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-block">
              <div className="setting-label">Действий за ход</div>
              <div className="choice-row">
                {ACTION_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`choice${settings.actionsPerTurn === n ? ' selected' : ''}`}
                    onClick={() => send({ type: 'configure', settings: { actionsPerTurn: n } })}
                  >
                    {n}⚡
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-block">
              <div className="setting-label">Старт</div>
              <div className="stepper-grid">
                <Stepper
                  label="🪙"
                  value={settings.startGold}
                  min={20}
                  max={200}
                  step={10}
                  onChange={(startGold) => send({ type: 'configure', settings: { startGold } })}
                />
                <Stepper
                  label="🌾"
                  value={settings.startFood}
                  min={0}
                  max={150}
                  step={10}
                  onChange={(startFood) => send({ type: 'configure', settings: { startFood } })}
                />
                <Stepper
                  label="🔩"
                  value={settings.startIron}
                  min={0}
                  max={150}
                  step={5}
                  onChange={(startIron) => send({ type: 'configure', settings: { startIron } })}
                />
                <Stepper
                  label="арм"
                  value={settings.startArmy}
                  min={2}
                  max={20}
                  step={1}
                  onChange={(startArmy) => send({ type: 'configure', settings: { startArmy } })}
                />
              </div>
            </div>
          </>
        )}
      </div>

      {canEdit && (
        <div className="brush-row">
          {BRUSHES.map((id) => (
            <button
              key={id}
              type="button"
              className={`choice brush${brush === id ? ' selected' : ''}`}
              onClick={() => setBrush(id)}
            >
              {BRUSH_ICON[id]} {TERRAIN[id].name}
            </button>
          ))}
        </div>
      )}

      <div className="lobby-map">
        <MapBoard
          state={state}
          meId={me.id}
          selected={null}
          highlighted={new Set()}
          fx={null}
          onPick={(tile) => {
            if (!canEdit) return;
            send({ type: 'paint', at: { x: tile.x, y: tile.y }, terrain: brush });
          }}
        />
      </div>
      {canEdit && (
        <p className="muted small center-text">
          Жёлтые кольца — столицы. Кисть красит гекс; случайную карту можно подправить.
        </p>
      )}
      </div>

      <div className="lobby-start-bar">
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

        <button className="btn" onClick={onExit}>
          Выйти в меню
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
            {enough ? (state.settings.hotseat ? 'Начать проверку' : 'Начать партию') : `Нужно минимум ${MIN_PLAYERS} игрока`}
          </button>
        ) : (
          <p className="muted center-text">
            {canEdit ? 'Вы админ: настраивайте карту. Старт — у хоста.' : 'Ждём, когда хост начнёт партию…'}
          </p>
        )}
      </div>
    </div>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="stepper">
      <button type="button" className="choice" disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))}>
        −
      </button>
      <span>
        {label} {value}
      </span>
      <button type="button" className="choice" disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))}>
        +
      </button>
    </div>
  );
}
