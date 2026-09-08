import { useMemo, useState } from 'react';
import {
  BUILDINGS,
  TERRAIN,
  UNIT_COST,
  attackMultiplier,
  computeIncome,
  coordKey,
  defenseMultiplier,
  isAdjacent,
  tileAt,
  upkeepFor,
} from '@tge/shared';
import type { BuildingType, Coord, GameAction, GameState, Tile } from '@tge/shared';
import MapBoard from './MapBoard';
import TechModal from './TechModal';
import { haptic, hapticResult } from '../telegram';

interface Props {
  state: GameState;
  meId: string;
  act: (action: GameAction) => Promise<boolean>;
  notify: (message: string) => void;
}

export default function GameScreen({ state, meId, act, notify }: Props) {
  const [selected, setSelected] = useState<Coord | null>(null);
  const [moveFrom, setMoveFrom] = useState<Coord | null>(null);
  const [moveTarget, setMoveTarget] = useState<Coord | null>(null);
  const [moveCount, setMoveCount] = useState(1);
  const [recruitCount, setRecruitCount] = useState(1);
  const [showTech, setShowTech] = useState(false);

  const me = state.players.find((p) => p.id === meId);
  const currentId = state.order[state.turnIndex];
  const current = state.players.find((p) => p.id === currentId);
  const isMyTurn = currentId === meId && state.phase === 'playing';

  const selectedTile = selected ? tileAt(state, selected.x, selected.y) : null;
  const fromTile = moveFrom ? tileAt(state, moveFrom.x, moveFrom.y) : null;
  const targetTile = moveTarget ? tileAt(state, moveTarget.x, moveTarget.y) : null;

  const income = useMemo(() => (me ? computeIncome(state, me.id) : null), [state, me]);
  const upkeep = useMemo(() => (me ? upkeepFor(state, me.id) : 0), [state, me]);

  const highlighted = useMemo(() => {
    const set = new Set<string>();
    if (!fromTile) return set;
    for (const d of [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ]) {
      const t = tileAt(state, fromTile.x + d.x, fromTile.y + d.y);
      if (t && TERRAIN[t.terrain].passable) set.add(coordKey(t));
    }
    return set;
  }, [state, fromTile]);

  const resetMove = () => {
    setMoveFrom(null);
    setMoveTarget(null);
    setMoveCount(1);
  };

  const pick = (tile: Tile) => {
    haptic('light');
    if (fromTile && isAdjacent(fromTile, tile) && TERRAIN[tile.terrain].passable) {
      setMoveTarget({ x: tile.x, y: tile.y });
      setMoveCount(Math.max(1, Math.min(fromTile.army, Math.ceil(fromTile.army / 2))));
      return;
    }
    resetMove();
    setSelected({ x: tile.x, y: tile.y });
  };

  const run = async (action: GameAction) => {
    const ok = await act(action);
    if (ok) hapticResult('success');
    return ok;
  };

  const confirmMove = async () => {
    if (!fromTile || !targetTile) return;
    const ok = await run({
      type: 'move',
      from: { x: fromTile.x, y: fromTile.y },
      to: { x: targetTile.x, y: targetTile.y },
      count: moveCount,
    });
    if (ok) {
      resetMove();
      setSelected({ x: targetTile.x, y: targetTile.y });
    }
  };

  const maxRecruit = me
    ? Math.max(0, Math.min(Math.floor(me.resources.gold / UNIT_COST.gold), Math.floor(me.resources.iron / UNIT_COST.iron)))
    : 0;

  const canRecruitHere =
    selectedTile != null &&
    selectedTile.ownerId === meId &&
    (selectedTile.capitalOf === meId ||
      (selectedTile.building ? BUILDINGS[selectedTile.building].allowsRecruit : false));

  /** Ориентировочное соотношение сил — без учёта случайного разброса ±15%. */
  const battleForecast = (() => {
    if (!fromTile || !targetTile || !me) return null;
    if (targetTile.army === 0 || targetTile.ownerId === meId) return null;
    const defender = targetTile.ownerId ? state.players.find((p) => p.id === targetTile.ownerId) : undefined;
    const attack = moveCount * attackMultiplier(me);
    const defense = targetTile.army * defenseMultiplier(state, targetTile, defender);
    return attack / Math.max(defense, 0.001);
  })();

  if (!me) {
    return (
      <div className="screen center">
        <p className="muted">Вы наблюдаете за партией {state.roomCode}</p>
      </div>
    );
  }

  return (
    <div className="screen game">
      <header className="topbar">
        <div className="topbar-row">
          <span className="round">
            Раунд {state.round}/{state.maxRounds}
          </span>
          <span className="turn">
            <span className="dot" style={{ background: current?.color ?? '#888' }} />
            {isMyTurn ? 'Ваш ход' : `Ходит ${current?.name ?? '—'}`}
          </span>
        </div>
        <div className="resources">
          <span title="Золото">🪙 {me.resources.gold}{income ? <i className="delta"> +{income.gold}</i> : null}</span>
          <span title="Еда">🌾 {me.resources.food}
            {income ? <i className={income.food - upkeep >= 0 ? 'delta' : 'delta neg'}> {income.food - upkeep >= 0 ? '+' : ''}{income.food - upkeep}</i> : null}
          </span>
          <span title="Железо">⚙️ {me.resources.iron}{income ? <i className="delta"> +{income.iron}</i> : null}</span>
          <span title="Действия" className="actions-left">⚡ {isMyTurn ? me.actionsLeft : 0}</span>
        </div>
      </header>

      <MapBoard state={state} meId={meId} selected={selected} highlighted={highlighted} onPick={pick} />

      <div className="panel">
        {targetTile && fromTile ? (
          <div className="move-panel">
            <div className="panel-title">
              Отправить войска на ({targetTile.x + 1};{targetTile.y + 1})
            </div>
            <input
              type="range"
              min={1}
              max={fromTile.army}
              value={Math.min(moveCount, fromTile.army)}
              onChange={(e) => setMoveCount(Number(e.target.value))}
            />
            <div className="row">
              <span>{moveCount} из {fromTile.army} отр.</span>
              {battleForecast != null && (
                <span className={battleForecast >= 1.2 ? 'good' : battleForecast >= 0.9 ? 'warn' : 'bad'}>
                  Соотношение сил {battleForecast.toFixed(2)}×
                </span>
              )}
            </div>
            <div className="row">
              <button className="btn primary grow" onClick={confirmMove}>
                {targetTile.army > 0 && targetTile.ownerId !== meId ? 'В атаку' : 'Занять'}
              </button>
              <button className="btn" onClick={resetMove}>
                Отмена
              </button>
            </div>
          </div>
        ) : selectedTile ? (
          <TileDetails
            state={state}
            tile={selectedTile}
            meId={meId}
            isMyTurn={isMyTurn}
            canRecruitHere={canRecruitHere}
            maxRecruit={maxRecruit}
            recruitCount={recruitCount}
            setRecruitCount={setRecruitCount}
            onStartMove={() => {
              setMoveFrom({ x: selectedTile.x, y: selectedTile.y });
              notify('Выберите соседнюю клетку');
            }}
            onBuild={(building) => run({ type: 'build', at: { x: selectedTile.x, y: selectedTile.y }, building })}
            onRecruit={() =>
              run({ type: 'recruit', at: { x: selectedTile.x, y: selectedTile.y }, count: recruitCount })
            }
          />
        ) : (
          <p className="muted center-text">Выберите клетку на карте</p>
        )}
      </div>

      <div className="log">
        {state.log.slice(-4).map((entry, i) => (
          <div key={i} className="log-line">
            <b>{entry.round}</b> {entry.text}
          </div>
        ))}
      </div>

      <footer className="bottombar">
        <button className="btn" onClick={() => setShowTech(true)}>
          🔬 Технологии
        </button>
        <button className="btn primary grow" disabled={!isMyTurn} onClick={() => run({ type: 'endTurn' })}>
          Завершить ход
        </button>
      </footer>

      {showTech && (
        <TechModal
          player={me}
          isMyTurn={isMyTurn}
          onResearch={(tech) => run({ type: 'research', tech })}
          onClose={() => setShowTech(false)}
        />
      )}

      {state.phase === 'finished' && (
        <div className="overlay">
          <div className="overlay-card">
            <div className="hero-icon">{state.winnerId === meId ? '👑' : '🏳️'}</div>
            <h2>{state.winnerId === meId ? 'Победа!' : `Победил ${state.players.find((p) => p.id === state.winnerId)?.name ?? '—'}`}</h2>
            <p className="muted">Партия {state.roomCode} завершена на раунде {state.round}.</p>
          </div>
        </div>
      )}
    </div>
  );
}

interface DetailsProps {
  state: GameState;
  tile: Tile;
  meId: string;
  isMyTurn: boolean;
  canRecruitHere: boolean;
  maxRecruit: number;
  recruitCount: number;
  setRecruitCount: (n: number) => void;
  onStartMove: () => void;
  onBuild: (building: BuildingType) => void;
  onRecruit: () => void;
}

function TileDetails({
  state,
  tile,
  meId,
  isMyTurn,
  canRecruitHere,
  maxRecruit,
  recruitCount,
  setRecruitCount,
  onStartMove,
  onBuild,
  onRecruit,
}: DetailsProps) {
  const owner = tile.ownerId ? state.players.find((p) => p.id === tile.ownerId) : null;
  const terrain = TERRAIN[tile.terrain];
  const isMine = tile.ownerId === meId;
  const me = state.players.find((p) => p.id === meId)!;

  return (
    <div>
      <div className="panel-title">
        ({tile.x + 1};{tile.y + 1}) {terrain.name}
        {tile.capitalOf ? ' · столица' : ''}
      </div>
      <div className="chips">
        <span className="chip">{owner ? `Владелец: ${owner.name}` : 'Ничья земля'}</span>
        {tile.army > 0 && <span className="chip">Войска: {tile.army}</span>}
        {terrain.defenseBonus > 0 && <span className="chip">Защита +{Math.round(terrain.defenseBonus * 100)}%</span>}
        {tile.building && <span className="chip">{BUILDINGS[tile.building].icon} {BUILDINGS[tile.building].name}</span>}
      </div>

      {!isMyTurn && <p className="muted">Дождитесь своего хода.</p>}

      {isMyTurn && isMine && (
        <>
          {tile.army > 0 && (
            <button className="btn primary full" onClick={onStartMove}>
              Двинуть войска ({tile.army})
            </button>
          )}

          {canRecruitHere && (
            <div className="section">
              <div className="section-title">Найм войск</div>
              {maxRecruit === 0 ? (
                <p className="muted">Не хватает ресурсов (1 отряд: 🪙{UNIT_COST.gold} ⚙️{UNIT_COST.iron}).</p>
              ) : (
                <>
                  <input
                    type="range"
                    min={1}
                    max={maxRecruit}
                    value={Math.min(recruitCount, maxRecruit)}
                    onChange={(e) => setRecruitCount(Number(e.target.value))}
                  />
                  <button className="btn full" onClick={onRecruit}>
                    Нанять {Math.min(recruitCount, maxRecruit)} отр. · 🪙
                    {Math.min(recruitCount, maxRecruit) * UNIT_COST.gold} ⚙️
                    {Math.min(recruitCount, maxRecruit) * UNIT_COST.iron}
                  </button>
                </>
              )}
            </div>
          )}

          {!tile.building && terrain.passable && (
            <div className="section">
              <div className="section-title">Строительство</div>
              <div className="build-grid">
                {(Object.keys(BUILDINGS) as BuildingType[]).map((key) => {
                  const info = BUILDINGS[key];
                  const affordable =
                    me.resources.gold >= (info.cost.gold ?? 0) && me.resources.iron >= (info.cost.iron ?? 0);
                  return (
                    <button
                      key={key}
                      className="build-btn"
                      disabled={!affordable}
                      onClick={() => onBuild(key)}
                    >
                      <span className="build-icon">{info.icon}</span>
                      <span className="build-name">{info.name}</span>
                      <span className="build-cost">
                        🪙{info.cost.gold ?? 0}
                        {info.cost.iron ? ` ⚙️${info.cost.iron}` : ''}
                      </span>
                      <span className="build-desc">{info.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
