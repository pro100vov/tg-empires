import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, type CSSProperties } from 'react';
import {
  MIN_PLAYERS,
  TERRAIN,
  unitsFor,
  buildingsFor,
  commandersFor,
  eraOf,
  armyCount,
  canDetectArmyOn,
  canWatchTile,
  capitalSpots,
  coordKey,
  dominantUnit,
  hexBoardSize,
  hexTileBox,
  relationOf,
  takeArmy,
  unitShotKind,
  wingMoveRange,
} from '@tge/shared';
import type { Coord, GameFx, GameState, ShotKind, Tile } from '@tge/shared';

/** Управление картой снаружи: центрирование и доступ к прокручиваемой области (мини-карта). */
export interface MapHandle {
  /** Центрирует карту на клетке. */
  centerOn: (x: number, y: number, smooth?: boolean) => void;
  /** Центрирует карту на точке в пикселях доски. */
  centerOnPoint: (px: number, py: number, smooth?: boolean) => void;
  viewport: () => HTMLDivElement | null;
}

interface Props {
  state: GameState;
  meId: string;
  selected: Coord | null;
  highlighted: Set<string>;
  chargeHighlighted?: Set<string>;
  supportHighlighted?: Set<string>;
  highlightKind?: 'move' | 'shoot';
  fx: GameFx | null;
  onPick: (tile: Tile) => void;
}

const TERRAIN_ICON: Record<string, string> = {
  plains: '',
  forest: '🌲',
  hills: '⛰️',
  mountains: '🗻',
  water: '🌊',
};

function ShootBurst({ kind }: { kind: ShotKind }) {
  const fly = kind === 'cannon' ? '●' : kind === 'musket' ? '•' : '➤';
  const impact = kind === 'cannon' ? '💥' : kind === 'musket' ? '✴️' : '💥';
  const n = kind === 'cannon' ? 3 : kind === 'musket' ? 7 : 5;
  const stagger = kind === 'musket' ? 28 : kind === 'cannon' ? 70 : 55;
  return (
    <>
      {(kind === 'musket' || kind === 'cannon') && (
        <span className={`fx-muzzle fx-muzzle-${kind}`}>{kind === 'cannon' ? '💥' : '🔥'}</span>
      )}
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="fx-arrow" style={{ animationDelay: `${i * stagger}ms` }}>
          <span className="fx-arrow-icon">{fly}</span>
        </span>
      ))}
      <span className={`fx-impact fx-impact-${kind}`}>{impact}</span>
    </>
  );
}

const MapBoard = forwardRef<MapHandle, Props>(function MapBoard(
  { state, meId, selected, highlighted, chargeHighlighted, supportHighlighted, highlightKind = 'move', fx, onPick },
  ref,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const centeredKey = useRef<string | null>(null);
  const board = hexBoardSize(state.width, state.height);

  /** Прокручивает так, чтобы точка доски (px) оказалась в центре видимой области. */
  const centerOnPoint = useCallback((px: number, py: number, smooth = false) => {
    const viewport = viewportRef.current;
    const boardEl = viewport?.querySelector('.board');
    if (!viewport || !(boardEl instanceof HTMLElement)) return;
    const viewRect = viewport.getBoundingClientRect();
    const boardRect = boardEl.getBoundingClientRect();
    if (viewRect.width < 8 || viewRect.height < 8) return;
    // Начало доски в координатах прокрутки — не зависит от отступов и центрирования.
    const originX = boardRect.left - viewRect.left + viewport.scrollLeft;
    const originY = boardRect.top - viewRect.top + viewport.scrollTop;
    viewport.scrollTo({
      left: originX + px - viewRect.width / 2,
      top: originY + py - viewRect.height / 2,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }, []);

  const centerOn = useCallback(
    (x: number, y: number, smooth = false) => {
      const box = hexTileBox(x, y);
      centerOnPoint(box.left + box.width / 2, box.top + box.height / 2, smooth);
    },
    [centerOnPoint],
  );

  useImperativeHandle(ref, () => ({ centerOn, centerOnPoint, viewport: () => viewportRef.current }), [centerOn, centerOnPoint]);

  useLayoutEffect(() => {
    const key = `${state.roomCode}:${meId}:${state.width}x${state.height}`;
    if (centeredKey.current === key) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const mineIdx = state.players.findIndex((p) => p.id === meId);
    const spots = capitalSpots(state.width, Math.max(MIN_PLAYERS, state.players.length));
    const spot = (mineIdx >= 0 ? spots[mineIdx] : spots[0]) ?? { x: 1, y: 1 };
    const capital =
      state.tiles.find((tile) => tile.capitalOf === meId) ??
      state.tiles.find((tile) => tile.x === spot.x && tile.y === spot.y);
    if (!capital) return;
    const viewRect = viewport.getBoundingClientRect();
    if (viewRect.width < 8 || viewRect.height < 8) return;
    centerOn(capital.x, capital.y);
    centeredKey.current = key;
  }, [state.roomCode, state.width, state.height, state.tiles, meId, centerOn]);

  const fromBox = fx ? hexTileBox(fx.from.x, fx.from.y) : null;
  const toBox = fx ? hexTileBox(fx.to.x, fx.to.y) : null;
  const fxFrom = fx ? state.tiles.find((tile) => tile.x === fx.from.x && tile.y === fx.from.y) : null;
  const fxTo = fx ? state.tiles.find((tile) => tile.x === fx.to.x && tile.y === fx.to.y) : null;
  const showFx =
    fx != null &&
    fxFrom != null &&
    fxTo != null &&
    (state.phase !== 'playing' ||
      state.settings?.fogOfWar === false ||
      (fx.kind === 'shoot' || fx.battle !== 'none'
        ? canWatchTile(state, meId, fxFrom) || canWatchTile(state, meId, fxTo)
        : canDetectArmyOn(state, meId, fxTo)));
  const dx = fromBox && toBox ? toBox.left + toBox.width / 2 - (fromBox.left + fromBox.width / 2) : 0;
  const dy = fromBox && toBox ? toBox.top + toBox.height / 2 - (fromBox.top + fromBox.height / 2) : 0;
  const rot = `${Math.atan2(dy, dx) * (180 / Math.PI)}deg`;
  const fxStyle =
    fromBox && toBox
      ? ({
          left: fromBox.left + fromBox.width / 2,
          top: fromBox.top + fromBox.height / 2,
          ['--dx' as string]: `${dx}px`,
          ['--dy' as string]: `${dy}px`,
          ['--rot' as string]: rot,
        } as CSSProperties)
      : undefined;

  const era = eraOf(state.settings);
  const units = unitsFor(era);
  const buildings = buildingsFor(era);
  const commanders = commandersFor(era);

  const lobbyCapitals =
    state.phase === 'lobby'
      ? new Set(
          capitalSpots(state.width, Math.max(MIN_PLAYERS, state.players.length)).map((c) => coordKey(c)),
        )
      : null;

  return (
    <div className="board-viewport" ref={viewportRef}>
      <div className="board-sizer">
        <div className="board" style={{ width: board.width, height: board.height }}>
          {state.tiles.map((tile) => {
            const owner = tile.ownerId ? state.players.find((p) => p.id === tile.ownerId) : null;
            const key = coordKey(tile);
            const isSelected = selected != null && selected.x === tile.x && selected.y === tile.y;
            let army = tile.army;
            if (showFx && fx && (fx.kind === 'move' || fx.kind === 'charge')) {
              if (fx.from.x === tile.x && fx.from.y === tile.y) {
                army = takeArmy(tile.army, fx.count).rest;
              } else if (fx.battle === 'none' && fx.to.x === tile.x && fx.to.y === tile.y) {
                army = takeArmy(tile.army, fx.count).rest;
              }
            }
            const mineTurn =
              state.phase === 'playing' &&
              tile.ownerId === meId &&
              state.order[state.turnIndex] === meId;
            const count = armyCount(army);
            const lead = dominantUnit(army);
            const unit = lead ? units[lead] : null;
            const mp = wingMoveRange(tile);
            const classes = ['tile'];
            if (isSelected) classes.push('selected');
            if (highlighted.has(key)) classes.push(highlightKind === 'shoot' ? 'highlight-shot' : 'highlight');
            if (chargeHighlighted?.has(key)) classes.push('highlight-charge');
            if (supportHighlighted?.has(key)) classes.push('highlight-support');
            if (count > 0) classes.push('has-army');
            if (tile.routedTurns > 0) classes.push('routed');
            if (tile.square) classes.push('in-square');
            if (tile.commander) classes.push('has-commander');
            if (owner?.id === meId) classes.push('mine');
            if (owner && owner.id !== meId && state.phase === 'playing') {
              const treaty = relationOf(state, meId, owner.id)?.kind;
              if (treaty === 'alliance') classes.push('ally');
              else if (treaty === 'truce') classes.push('truce');
            }
            if (tile.building) classes.push('has-building');
            if (tile.construction) classes.push('has-construction');
            if (lobbyCapitals?.has(key)) classes.push('capital-spot');
            if (state.phase === 'playing' && owner?.id !== meId && !canWatchTile(state, meId, tile)) {
              classes.push('fog');
            }
            const box = hexTileBox(tile.x, tile.y);
            const ring = isSelected
              ? '#ffffff'
              : chargeHighlighted?.has(key)
                ? '#ff9a4a'
                : supportHighlighted?.has(key)
                  ? '#6ee7b7'
                : highlighted.has(key)
                ? highlightKind === 'shoot'
                  ? '#ff7a7a'
                  : '#ffe08a'
                : lobbyCapitals?.has(key)
                  ? '#f2d36b'
                  : owner
                    ? owner.color
                    : 'rgba(0,0,0,0.55)';

            return (
              <button
                key={key}
                type="button"
                className={classes.join(' ')}
                data-x={tile.x}
                data-y={tile.y}
                style={{
                  left: box.left,
                  top: box.top,
                  width: box.width,
                  height: box.height,
                }}
                onClick={() => onPick(tile)}
              >
                <span className="tile-ring" style={{ background: ring }} />
                <span className="tile-fill" style={{ background: TERRAIN[tile.terrain].color }} />
                <span className="tile-terrain">{TERRAIN_ICON[tile.terrain]}</span>
                {tile.capitalOf && <span className="tile-capital">★</span>}
                {tile.building && (
                  <span className={`tile-building tile-building-${tile.building}`} title={buildings[tile.building].name}>
                    <span className="tile-building-icon">{buildings[tile.building].icon}</span>
                  </span>
                )}
                {tile.construction && (
                  <span
                    className={`tile-construction tile-building-${tile.construction.building}`}
                    title={`Стройка: ещё ${tile.construction.turnsLeft}`}
                  >
                    <span className="tile-building-icon">{buildings[tile.construction.building].icon}</span>
                    <span className="tile-construction-turns">{tile.construction.turnsLeft}</span>
                  </span>
                )}
                {tile.commander && (
                  <span className="tile-commander" title={commanders[tile.commander].name}>
                    {commanders[tile.commander].icon}
                  </span>
                )}
                {tile.routedTurns > 0 && <span className="tile-routed">💨</span>}
                {tile.square && count > 0 && (
                  <span className="tile-square" title="Каре">
                    ⬛
                  </span>
                )}
                {count > 0 && unit && (
                  <>
                    <span className={`tile-unit tile-unit-${unit.class} tile-unit-${unit.tier}${unit.mounted ? ' tile-unit-mounted' : ''}${unit.shot === 'musket' && unit.class === 'infantry' ? ' tile-unit-musket' : ''}`} aria-hidden>
                      {unit.icon}
                    </span>
                    <span className="tile-army" style={{ background: owner?.color ?? '#333' }}>
                      {count}
                    </span>
                    {mineTurn && mp.max > 0 && (
                      <span
                        className="tile-mp"
                        title={
                          mp.min === mp.max
                            ? `Запас хода: ${mp.max}`
                            : `Запас хода: ${mp.min}–${mp.max} кл.`
                        }
                      >
                        {mp.min === mp.max ? mp.max : `${mp.min}–${mp.max}`}
                      </span>
                    )}
                  </>
                )}
              </button>
            );
          })}
          {showFx && fx && fxStyle && (
            <div
              key={`${fx.from.x},${fx.from.y}-${fx.to.x},${fx.to.y}-${fx.unit}-${fx.count}-${fx.battle}`}
              className={`fx-token fx-${units[fx.unit].class} fx-tier-${units[fx.unit].tier}${fx.kind === 'shoot' ? ` fx-shoot fx-shot-${unitShotKind(fx.unit, era) ?? 'arrow'}` : ''}${fx.kind === 'charge' ? ' fx-charge' : ''}${fx.battle !== 'none' ? ' fx-battle' : ''}${fx.battle === 'lost' ? ' fx-lost' : ''}${fx.battle === 'won' ? ' fx-won' : ''}${fx.battle === 'rout' ? ' fx-rout' : ''}`}
              style={fxStyle}
            >
              {fx.kind === 'shoot' ? (
                <ShootBurst kind={unitShotKind(fx.unit, era) ?? 'arrow'} />
              ) : (
                <>
                  <span className="fx-shadow" />
                  <span className="fx-icon">{units[fx.unit].icon}</span>
                  <span className="fx-count">{fx.count}</span>
                  {fx.battle !== 'none' && (
                    <span className="fx-boom">{fx.battle === 'won' ? '💥' : fx.battle === 'rout' ? '💨' : '🛡️'}</span>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default MapBoard;
