import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { TERRAIN, armyCount, canWatchTile, hexBoardSize, hexTileBox } from '@tge/shared';
import type { GameState } from '@tge/shared';
import type { MapHandle } from './MapBoard';

interface Props {
  state: GameState;
  meId: string;
  mapRef: RefObject<MapHandle>;
}

/** Длинная сторона мини-карты, px. */
const MINI = 124;

interface Cell {
  key: string;
  points: string;
  fill: string;
  fog: boolean;
  capital: boolean;
  stack: { x: number; y: number } | null;
}

/** Мини-карта: клетки цветом владельца, туман, столицы, свои стеки и рамка видимой области. */
export default function MiniMap({ state, meId, mapRef }: Props) {
  const board = hexBoardSize(state.width, state.height);
  const scale = MINI / Math.max(board.width, board.height);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const [frame, setFrame] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const cells = useMemo<Cell[]>(() => {
    const playing = state.phase === 'playing';
    return state.tiles.map((tile) => {
      const box = hexTileBox(tile.x, tile.y);
      const cx = (box.left + box.width / 2) * scale;
      const cy = (box.top + box.height / 2) * scale;
      const hw = (box.width / 2) * scale;
      const hh = (box.height / 2) * scale;
      const points = [
        [cx, cy - hh],
        [cx + hw, cy - hh / 2],
        [cx + hw, cy + hh / 2],
        [cx, cy + hh],
        [cx - hw, cy + hh / 2],
        [cx - hw, cy - hh / 2],
      ]
        .map(([px, py]) => `${px!.toFixed(1)},${py!.toFixed(1)}`)
        .join(' ');
      const owner = tile.ownerId ? state.players.find((p) => p.id === tile.ownerId) : null;
      const fog = playing && tile.ownerId !== meId && !canWatchTile(state, meId, tile);
      const mineStack = tile.ownerId === meId && armyCount(tile.army) > 0;
      return {
        key: `${tile.x},${tile.y}`,
        points,
        fill: owner ? owner.color : TERRAIN[tile.terrain].color,
        fog,
        capital: Boolean(tile.capitalOf) && (!fog || tile.capitalOf === meId),
        stack: mineStack ? { x: cx, y: cy } : null,
      };
    });
  }, [state, meId, scale]);

  // Рамка видимой области следует за прокруткой и размером окна.
  useEffect(() => {
    const viewport = mapRef.current?.viewport();
    if (!viewport) return;
    const update = () => {
      const boardEl = viewport.querySelector('.board');
      if (!(boardEl instanceof HTMLElement)) return;
      const vr = viewport.getBoundingClientRect();
      const br = boardEl.getBoundingClientRect();
      const x0 = Math.max(0, vr.left - br.left);
      const y0 = Math.max(0, vr.top - br.top);
      const x1 = Math.min(board.width, vr.right - br.left);
      const y1 = Math.min(board.height, vr.bottom - br.top);
      setFrame({ x: x0 * scale, y: y0 * scale, w: Math.max(0, x1 - x0) * scale, h: Math.max(0, y1 - y0) * scale });
    };
    update();
    viewport.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(viewport);
    return () => {
      viewport.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [mapRef, board.width, scale, state.width, state.height]);

  const jump = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    mapRef.current?.centerOnPoint((clientX - rect.left) / scale, (clientY - rect.top) / scale);
  };

  const w = board.width * scale;
  const h = board.height * scale;

  return (
    <div className="minimap" style={{ width: w, height: h }}>
      <svg
        ref={svgRef}
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        onPointerDown={(e) => {
          dragging.current = true;
          (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
          jump(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (dragging.current) jump(e.clientX, e.clientY);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        {cells.map((cell) => (
          <g key={cell.key}>
            <polygon points={cell.points} fill={cell.fill} stroke="rgba(0,0,0,0.35)" strokeWidth={0.4} />
            {cell.fog && <polygon points={cell.points} fill="rgba(6,10,16,0.62)" />}
          </g>
        ))}
        {cells.map((cell) =>
          cell.stack ? <circle key={`s-${cell.key}`} cx={cell.stack.x} cy={cell.stack.y} r={2} fill="#fff" stroke="#000" strokeWidth={0.5} /> : null,
        )}
        {state.tiles.map((tile, i) => {
          const cell = cells[i]!;
          if (!cell.capital) return null;
          const box = hexTileBox(tile.x, tile.y);
          return (
            <text
              key={`c-${cell.key}`}
              x={(box.left + box.width / 2) * scale}
              y={(box.top + box.height / 2) * scale + 3}
              textAnchor="middle"
              className="minimap-star"
            >
              ★
            </text>
          );
        })}
        {frame && frame.w > 0 && (
          <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} className="minimap-frame" />
        )}
      </svg>
    </div>
  );
}
