import { useEffect, useState } from 'react';
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
  TURN_MINUTES_OPTIONS,
  isHotseatRival,
  isLobbyAdmin,
} from '@tge/shared';
import type { AiLevel, GameState, LobbyAction, MyGame, TerrainType } from '@tge/shared';
import { haptic } from '../telegram';
import { AI_LABEL, leftLabel, turnMinutesHint, turnMinutesLabel } from '../labels';
import MapBoard from './MapBoard';

const AI_LEVELS: AiLevel[] = ['easy', 'normal', 'hard'];

export interface SoloOptions {
  /** Соперники-ИИ: по одной сложности на каждого. Без поля — «сам с собой». */
  ai?: AiLevel[];
  /** Учебная партия: маленькая карта, один лёгкий ИИ, старт сразу. */
  tutorial?: boolean;
}

interface Props {
  state: GameState | null;
  me: { id: string; name: string };
  onCreate: () => void;
  onSolo: (options?: SoloOptions) => void;
  onMine: () => Promise<MyGame[]>;
  onTutorial?: () => void;
  /** «❓ Обучение»: показать обучение заново. */
  onHelp?: () => void;
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

export default function Lobby({ state, me, onCreate, onSolo, onMine, onTutorial, onHelp, onJoin, onStart, onLobby, onExit }: Props) {
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [brush, setBrush] = useState<TerrainType>('forest');
  const [mine, setMine] = useState<MyGame[]>([]);
  const [soloMode, setSoloMode] = useState<'pick' | 'ai' | null>(null);
  const [aiCount, setAiCount] = useState(1);
  const [aiLevel, setAiLevel] = useState<AiLevel>('normal');
  const inMenu = state === null;

  // «Мои партии» обновляем при каждом открытии меню.
  useEffect(() => {
    if (!inMenu) return;
    let alive = true;
    void onMine().then((games) => {
      if (alive) setMine(games);
    });
    return () => {
      alive = false;
    };
  }, [inMenu, onMine]);

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

        {mine.length > 0 && (
          <div className="my-games">
            <div className="panel-title">Мои партии</div>
            {mine.map((game) => (
              <button key={game.roomCode} type="button" className="my-game" onClick={() => onJoin(game.roomCode)}>
                <span className="my-game-code">{game.roomCode}</span>
                <span className="my-game-dots">
                  {game.players.map((p, i) => (
                    <span key={i} className="dot" style={{ background: p.color }} title={p.name} />
                  ))}
                </span>
                <span className="grow muted small">
                  {game.phase === 'lobby'
                    ? 'лобби'
                    : game.phase === 'finished'
                      ? 'окончена'
                      : `раунд ${game.round}/${game.maxRounds}${game.myTurn ? '' : ` · ходит ${game.turnName}`}`}
                  {game.phase === 'playing' && game.deadline ? ` · ⏱ ${leftLabel(game.deadline - Date.now())}` : ''}
                </span>
                {game.myTurn && <span className="badge-turn">Ваш ход</span>}
              </button>
            ))}
          </div>
        )}

        <button
          className="btn primary big"
          onClick={() => {
            haptic('medium');
            onCreate();
          }}
        >
          Создать партию
        </button>

        {soloMode === null && (
          <button
            className="btn big"
            onClick={() => {
              haptic('medium');
              setSoloMode('pick');
            }}
          >
            Соло
          </button>
        )}
        {soloMode === 'pick' && (
          <div className="card solo-card">
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
            <button className="btn big" onClick={() => setSoloMode('ai')}>
              Против ИИ
            </button>
            {onTutorial && (
              <button
                className="btn big"
                onClick={() => {
                  haptic('medium');
                  onTutorial();
                }}
              >
                Учебная партия
              </button>
            )}
            <button className="btn" onClick={() => setSoloMode(null)}>
              Назад
            </button>
          </div>
        )}
        {soloMode === 'ai' && (
          <div className="card solo-card">
            <div className="setting-label">Соперников</div>
            <div className="choice-row">
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`choice${aiCount === n ? ' selected' : ''}`}
                  onClick={() => setAiCount(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="setting-label">Сложность</div>
            <div className="choice-row">
              {AI_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={`choice${aiLevel === level ? ' selected' : ''}`}
                  onClick={() => setAiLevel(level)}
                >
                  {AI_LABEL[level]}
                </button>
              ))}
            </div>
            <button
              className="btn primary big"
              onClick={() => {
                haptic('medium');
                onSolo({ ai: Array.from({ length: aiCount }, () => aiLevel) });
              }}
            >
              К настройкам партии
            </button>
            <button className="btn" onClick={() => setSoloMode('pick')}>
              Назад
            </button>
          </div>
        )}

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

        {onHelp && (
          <button className="btn" onClick={onHelp}>
            ❓ Обучение
          </button>
        )}
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
            {player.ai && <span className="tag">ИИ · {AI_LABEL[player.ai]}</span>}
            {canEdit && player.ai && (
              <button
                type="button"
                className="btn tiny"
                onClick={() => send({ type: 'removeAi', playerId: player.id })}
              >
                убрать
              </button>
            )}
            {isHost && player.id !== me.id && !isHotseatRival(player.id) && !player.ai && (
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

      {canEdit && !state.settings.hotseat && state.players.length < MAX_PLAYERS && (
        <div className="card ai-add">
          <span className="muted small">Добавить ИИ-соперника:</span>
          <div className="choice-row">
            {AI_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                className="choice"
                onClick={() => send({ type: 'addAi', difficulty: level })}
              >
                + {AI_LABEL[level]}
              </button>
            ))}
          </div>
        </div>
      )}

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
            {' · '}
            ⏱ {turnMinutesLabel(settings.turnMinutes)}
            {settings.randomEvents ? ' · 🎲 события' : ''}
            {settings.diplomacy ? ' · 🤝 дипломатия' : ''}
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
                  Новая карта
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
              <div className="setting-label">Время на ход</div>
              <div className="choice-row wrap">
                {TURN_MINUTES_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`choice${settings.turnMinutes === n ? ' selected' : ''}`}
                    onClick={() => send({ type: 'configure', settings: { turnMinutes: n } })}
                  >
                    {turnMinutesLabel(n)}
                  </button>
                ))}
              </div>
              <p className="muted small">{turnMinutesHint(settings.turnMinutes)}</p>
            </div>

            <div className="setting-block">
              <div className="setting-label">Правила</div>
              <div className="choice-row wrap">
                <button
                  type="button"
                  className={`choice${settings.randomEvents ? ' selected' : ''}`}
                  onClick={() => send({ type: 'configure', settings: { randomEvents: !settings.randomEvents } })}
                >
                  🎲 Случайные события
                </button>
                {!settings.hotseat && (
                  <button
                    type="button"
                    className={`choice${settings.diplomacy ? ' selected' : ''}`}
                    onClick={() => send({ type: 'configure', settings: { diplomacy: !settings.diplomacy } })}
                  >
                    🤝 Дипломатия
                  </button>
                )}
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
