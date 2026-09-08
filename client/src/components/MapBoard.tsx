import { BUILDINGS, TERRAIN, coordKey } from '@tge/shared';
import type { Coord, GameState, Tile } from '@tge/shared';

interface Props {
  state: GameState;
  meId: string;
  selected: Coord | null;
  highlighted: Set<string>;
  onPick: (tile: Tile) => void;
}

const TERRAIN_ICON: Record<string, string> = {
  plains: '',
  forest: '🌲',
  hills: '⛰️',
  mountains: '🗻',
  water: '🌊',
};

export default function MapBoard({ state, meId, selected, highlighted, onPick }: Props) {
  return (
    <div
      className="board"
      style={{ gridTemplateColumns: `repeat(${state.width}, 1fr)` }}
    >
      {state.tiles.map((tile) => {
        const owner = tile.ownerId ? state.players.find((p) => p.id === tile.ownerId) : null;
        const key = coordKey(tile);
        const isSelected = selected != null && selected.x === tile.x && selected.y === tile.y;
        const classes = ['tile'];
        if (isSelected) classes.push('selected');
        if (highlighted.has(key)) classes.push('highlight');
        if (owner?.id === meId) classes.push('mine');

        return (
          <button
            key={key}
            className={classes.join(' ')}
            style={{
              background: TERRAIN[tile.terrain].color,
              boxShadow: owner ? `inset 0 0 0 3px ${owner.color}` : undefined,
            }}
            onClick={() => onPick(tile)}
          >
            <span className="tile-terrain">{TERRAIN_ICON[tile.terrain]}</span>
            {tile.capitalOf && <span className="tile-capital">★</span>}
            {tile.building && <span className="tile-building">{BUILDINGS[tile.building].icon}</span>}
            {tile.army > 0 && (
              <span className="tile-army" style={{ background: owner?.color ?? '#333' }}>
                {tile.army}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
