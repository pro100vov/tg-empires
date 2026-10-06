import { useMemo, useState } from 'react';
import {
  COMMANDER_IDS,
  ERAS,
  TERRAIN,
  UNIT_IDS,
  WAR_FORTS,
  WAR_FORT_TURNS,
  armyCount,
  buildingsFor,
  commanderPrice,
  commandersFor,
  coordKey,
  eraOf,
  fortPrice,
  killGoalOf,
  squadPrice,
  squadSize,
  squadUnit,
  unitsFor,
  zoneOwnerAt,
} from '@tge/shared';
import type { Coord, DeployAction, GameState, Tile, UnitId } from '@tge/shared';
import { haptic } from '../telegram';
import MapBoard from './MapBoard';

interface Props {
  state: GameState;
  /** За кого расставляем (в соло — по очереди за обе армии). */
  meId: string;
  deploy: (action: DeployAction) => Promise<boolean>;
  onExit: () => void;
}

/** Варгейм: закупка армии на капитал и расстановка в своей зоне — вслепую, все одновременно. */
export default function DeployScreen({ state, meId, deploy, onExit }: Props) {
  const era = eraOf(state.settings);
  const units = unitsFor(era);
  const commanders = commandersFor(era);
  const buildings = buildingsFor(era);
  const me = state.players.find((p) => p.id === meId);
  const [unit, setUnit] = useState<UnitId>('medium_infantry');
  const [selected, setSelected] = useState<Coord | null>(null);
  const [busy, setBusy] = useState(false);

  const zones = useMemo(() => {
    const map = new Map<string, string>();
    if (!me) return map;
    for (const t of state.tiles) {
      if (zoneOwnerAt(state, t.x, t.y) === me.id && TERRAIN[t.terrain].passable) map.set(coordKey(t), me.color);
    }
    return map;
  }, [state, me]);

  if (!me) {
    return (
      <div className="screen center">
        <p className="muted">Идёт расстановка армий в партии {state.roomCode}</p>
      </div>
    );
  }

  const gold = me.resources.gold;
  const ready = Boolean(me.deployReady);
  const squads = state.tiles.filter((t) => t.ownerId === me.id && armyCount(t.army) > 0);
  const selTile = selected ? state.tiles.find((t) => t.x === selected.x && t.y === selected.y) ?? null : null;
  const selMine = selTile && selTile.ownerId === me.id && armyCount(selTile.army) > 0 ? selTile : null;
  const selUnit = selMine ? squadUnit(selMine) : null;
  const goal = killGoalOf(state.settings);
  const picked = units[unit];

  const run = async (action: DeployAction) => {
    if (busy) return false;
    setBusy(true);
    haptic('light');
    try {
      return await deploy(action);
    } finally {
      setBusy(false);
    }
  };

  const pick = (tile: Tile) => {
    if (ready) return;
    if (tile.ownerId === me.id && armyCount(tile.army) > 0) {
      setSelected({ x: tile.x, y: tile.y });
      return;
    }
    if (zoneOwnerAt(state, tile.x, tile.y) !== me.id || !TERRAIN[tile.terrain].passable) {
      setSelected(null);
      return;
    }
    setSelected(null);
    void run({ type: 'buySquad', at: { x: tile.x, y: tile.y }, unit });
  };

  return (
    <div className="screen game deploy">
      <header className="topbar">
        <div className="topbar-row">
          <span className="round">
            ⚔️ Расстановка · {ERAS[era].icon} {ERAS[era].name}
          </span>
          <span className="turn">
            <span className="dot" style={{ background: me.color }} />
            {me.name}
          </span>
        </div>
        <div className="resources">
          <span title="Золото на армию">🪙 {gold}</span>
          <span title="Отрядов куплено">⚔️ {squads.length}</span>
          <span title="Укрепления в запасе">🪵 {(me.forts ?? []).length}</span>
          <span title="Цель">🎯 {goal > 0 ? `${goal} отр.` : 'всех'}</span>
        </div>
        <div className="deploy-ready-row">
          {state.players.map((p) => (
            <span key={p.id} className={`deploy-ready-chip${p.deployReady ? ' on' : ''}`}>
              <span className="dot" style={{ background: p.color }} />
              {p.name} {p.deployReady ? '✓' : '…'}
            </span>
          ))}
        </div>
      </header>

      <div className="map-wrap">
        <MapBoard
          state={state}
          meId={me.id}
          selected={selected}
          highlighted={new Set()}
          zones={ready ? undefined : zones}
          fx={null}
          onPick={pick}
        />
      </div>

      <div className="panel deploy-panel">
        {ready ? (
          <div className="deploy-wait">
            <div className="panel-title">Армия готова</div>
            <p className="muted small">Ждём остальных — бой начнётся, когда «Готов» нажмут все.</p>
            <button className="btn full" disabled={busy} onClick={() => void run({ type: 'ready', ready: false })}>
              Изменить армию
            </button>
          </div>
        ) : selMine && selUnit ? (
          <div className="deploy-squad">
            <div className="panel-title">
              {units[selUnit].icon} {units[selUnit].name} × {armyCount(selMine.army)}
              {selMine.commander ? ` · ${commanders[selMine.commander].icon} ${commanders[selMine.commander].name}` : ''}
            </div>
            <p className="muted small">{units[selUnit].description}</p>
            {selMine.commander ? (
              <button className="btn full" disabled={busy} onClick={() => void run({ type: 'sellCommander', at: selMine })}>
                Убрать командира (+🪙{commanderPrice(era, selMine.commander)})
              </button>
            ) : (
              <div className="choice-row wrap">
                {COMMANDER_IDS.map((id) => {
                  const price = commanderPrice(era, id);
                  return (
                    <button
                      key={id}
                      type="button"
                      className="choice"
                      disabled={busy || price > gold}
                      title={commanders[id].description}
                      onClick={() => void run({ type: 'buyCommander', at: selMine, commander: id })}
                    >
                      {commanders[id].icon} {commanders[id].name} 🪙{price}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="row">
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  void run({ type: 'sellSquad', at: selMine }).then((ok) => ok && setSelected(null));
                }}
              >
                Продать отряд (+🪙{squadPrice(era, selUnit) + (selMine.commander ? commanderPrice(era, selMine.commander) : 0)})
              </button>
              <button className="btn" onClick={() => setSelected(null)}>
                К магазину
              </button>
            </div>
          </div>
        ) : (
          <div className="deploy-shop">
            <p className="muted small">
              Выберите род войск и тапните клетку своей зоны (цветная кромка). Тап по своему отряду — командир или
              продажа.
            </p>
            <div className="unit-grid">
              {UNIT_IDS.map((id) => {
                const info = units[id];
                const price = squadPrice(era, id);
                return (
                  <button
                    key={id}
                    type="button"
                    className={`unit-pick unit-pick-${info.class}${info.mounted ? ' unit-pick-mounted' : ''}${info.shot === 'musket' && info.class === 'infantry' ? ' unit-pick-musket' : ''}${unit === id ? ' selected' : ''}`}
                    title={info.name}
                    onClick={() => setUnit(id)}
                  >
                    <span className="unit-pick-icon" aria-hidden>
                      {info.icon}
                    </span>
                    <span className="unit-pick-name">
                      {info.short} ×{squadSize(era, id)}
                    </span>
                    <span className={`unit-pick-cost${price <= gold ? '' : ' bad'}`}>🪙{price}</span>
                  </button>
                );
              })}
            </div>
            <p className="muted small">
              {picked.icon} {picked.name}: отряд из {squadSize(era, unit)} — {picked.description}
            </p>
            <div className="panel-title">Укрепления (ставите в бою под своим отрядом)</div>
            <div className="choice-row wrap">
              {WAR_FORTS.map((b) => {
                const owned = (me.forts ?? []).filter((f) => f === b).length;
                const price = fortPrice(era, b);
                return (
                  <span key={b} className="deploy-fort">
                    <button
                      type="button"
                      className="choice"
                      disabled={busy || price > gold}
                      title={`${buildings[b].description}, ставится ${WAR_FORT_TURNS[b]} х.`}
                      onClick={() => void run({ type: 'buyFort', building: b })}
                    >
                      + {buildings[b].icon} {buildings[b].name} 🪙{price}
                    </button>
                    {owned > 0 && (
                      <button
                        type="button"
                        className="choice"
                        disabled={busy}
                        onClick={() => void run({ type: 'sellFort', building: b })}
                      >
                        −{owned}
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {!ready && (
        <footer className="bottombar">
          <button className="btn" disabled={busy} onClick={() => void run({ type: 'auto' })} title="Докупить армию на остаток">
            🎲 Авто
          </button>
          <button className="btn" disabled={busy} onClick={() => void run({ type: 'clear' })}>
            Сбросить
          </button>
          <button
            className="btn primary grow"
            disabled={busy || squads.length === 0}
            onClick={() => {
              setSelected(null);
              void run({ type: 'ready', ready: true });
            }}
          >
            Готов
          </button>
        </footer>
      )}
      {ready && (
        <footer className="bottombar">
          <button className="btn grow" onClick={onExit}>
            Выйти в меню
          </button>
        </footer>
      )}
    </div>
  );
}
