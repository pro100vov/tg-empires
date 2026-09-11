import { HEX_COL_STEP, HEX_HEIGHT, HEX_ROW_STEP, HEX_WIDTH, MAP_SIZE, TERRAIN } from './config.js';
import { mulberry32 } from './rng.js';
import type { Coord, GameState, TerrainType, Tile } from './types.js';
import { armyCount } from './units.js';

/** Направления кубических координат (pointy-top). */
const CUBE_DIRS: Array<[number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/** odd-r: нечётный ряд сдвинут вправо. x = столбец, y = ряд. */
function oddrToCube(col: number, row: number): [number, number] {
  const q = col - (row - (row & 1)) / 2;
  const r = row;
  return [q, r];
}

function cubeToOddr(q: number, r: number): Coord {
  return { x: q + (r - (r & 1)) / 2, y: r };
}

function cubeRound(fq: number, fr: number, fs: number): Coord {
  let q = Math.round(fq);
  let r = Math.round(fr);
  let s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return cubeToOddr(q, r);
}

/** Клетки на прямой между a и b, включая концы (кубическая интерполяция). */
export function hexLine(a: Coord, b: Coord): Coord[] {
  const n = hexDistance(a, b);
  if (n === 0) return [{ x: a.x, y: a.y }];
  const [aq, ar] = oddrToCube(a.x, a.y);
  const [bq, br] = oddrToCube(b.x, b.y);
  const as = -aq - ar;
  const bs = -bq - br;
  const out: Coord[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(
      cubeRound(aq + (bq - aq) * t + 1e-6, ar + (br - ar) * t + 1e-6, as + (bs - as) * t - 2e-6),
    );
  }
  return out;
}

export function hexNeighborCoords(c: Coord): Coord[] {
  const [q, r] = oddrToCube(c.x, c.y);
  return CUBE_DIRS.map(([dq, dr]) => cubeToOddr(q + dq, r + dr));
}

export function tileIndex(state: { width: number }, x: number, y: number): number {
  return y * state.width + x;
}

export function tileAt(state: GameState, x: number, y: number): Tile | null {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return null;
  return state.tiles[tileIndex(state, x, y)] ?? null;
}

export function neighbors(state: GameState, c: Coord): Tile[] {
  const result: Tile[] = [];
  for (const d of hexNeighborCoords(c)) {
    const t = tileAt(state, d.x, d.y);
    if (t) result.push(t);
  }
  return result;
}

export function hexDistance(a: Coord, b: Coord): number {
  const [aq, ar] = oddrToCube(a.x, a.y);
  const [bq, br] = oddrToCube(b.x, b.y);
  const as = -aq - ar;
  const bs = -bq - br;
  return (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs(as - bs)) / 2;
}

export function isAdjacent(a: Coord, b: Coord): boolean {
  return hexDistance(a, b) === 1;
}

/**
 * Набег на 2 гекса: между ними есть проходимый «мост», не занятый чужой армией.
 * Свои и пустые клетки пропускают.
 */
export function chargePathOpen(state: GameState, from: Coord, to: Coord, playerId: string): boolean {
  if (hexDistance(from, to) !== 2) return false;
  return neighbors(state, from).some((bridge) => {
    if (!isAdjacent(bridge, to)) return false;
    if (!TERRAIN[bridge.terrain].passable) return false;
    if (bridge.terrain === 'forest') return false;
    if (armyCount(bridge.army) > 0 && bridge.ownerId !== playerId) return false;
    return true;
  });
}

function hexKey(c: Coord): string {
  return `${c.x},${c.y}`;
}

/**
 * Кратчайший проходимый путь до `to` не длиннее `maxSteps`.
 * Через чужие войска не ходим — они могут быть только целью последнего шага.
 */
export function walkPath(
  state: GameState,
  from: Coord,
  to: Coord,
  playerId: string,
  maxSteps: number,
  allowEnemy: boolean,
): Coord[] | null {
  if (maxSteps < 1) return null;
  const goal = hexKey(to);
  if (hexKey(from) === goal) return [{ x: from.x, y: from.y }];
  const dest = tileAt(state, to.x, to.y);
  if (!dest || !TERRAIN[dest.terrain].passable) return null;
  const destEnemy = dest.ownerId !== playerId && armyCount(dest.army) > 0;
  if (destEnemy && !allowEnemy) return null;

  const prev = new Map<string, Coord | null>();
  prev.set(hexKey(from), null);
  const queue: Coord[] = [{ x: from.x, y: from.y }];
  const dist = new Map<string, number>([[hexKey(from), 0]]);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = dist.get(hexKey(cur)) ?? 0;
    if (d >= maxSteps) continue;
    for (const n of neighbors(state, cur)) {
      const k = hexKey(n);
      if (prev.has(k)) continue;
      if (!TERRAIN[n.terrain].passable) continue;
      const enemy = n.ownerId !== playerId && armyCount(n.army) > 0;
      if (enemy && (k !== goal || !allowEnemy)) continue;
      prev.set(k, cur);
      dist.set(k, d + 1);
      if (k === goal) {
        const path: Coord[] = [{ x: n.x, y: n.y }];
        let step: Coord | null | undefined = cur;
        while (step) {
          path.push({ x: step.x, y: step.y });
          step = prev.get(hexKey(step));
        }
        path.reverse();
        return path;
      }
      if (!enemy) queue.push({ x: n.x, y: n.y });
    }
  }
  return null;
}

/** Клетки, на которые отряд может дойти за один ход. */
export function walkReachable(
  state: GameState,
  from: Coord,
  playerId: string,
  maxSteps: number,
  allowEnemy: boolean,
): Tile[] {
  if (maxSteps < 1) return [];
  const seen = new Set<string>([hexKey(from)]);
  const out: Tile[] = [];
  const queue: Array<{ x: number; y: number; d: number }> = [{ x: from.x, y: from.y, d: 0 }];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.d >= maxSteps) continue;
    for (const n of neighbors(state, cur)) {
      const k = hexKey(n);
      if (seen.has(k)) continue;
      if (!TERRAIN[n.terrain].passable) continue;
      const enemy = n.ownerId !== playerId && armyCount(n.army) > 0;
      if (enemy && !allowEnemy) continue;
      seen.add(k);
      out.push(n);
      if (!enemy) queue.push({ x: n.x, y: n.y, d: cur.d + 1 });
    }
  }
  return out;
}

export function hexBoardSize(cols: number, rows: number): { width: number; height: number } {
  const oddRowShift = rows > 0 && (rows - 1) & 1 ? HEX_COL_STEP / 2 : 0;
  return {
    width: Math.max(0, cols - 1) * HEX_COL_STEP + HEX_WIDTH + oddRowShift + 1,
    height: Math.max(0, rows - 1) * HEX_ROW_STEP + HEX_HEIGHT + 1,
  };
}

export function hexTileBox(col: number, row: number): { left: number; top: number; width: number; height: number } {
  return {
    left: col * HEX_COL_STEP + ((row & 1) ? HEX_COL_STEP / 2 : 0),
    top: row * HEX_ROW_STEP,
    width: HEX_WIDTH + 1,
    height: HEX_HEIGHT + 1,
  };
}

function rollTerrain(rand: () => number): TerrainType {
  const r = rand();
  if (r < 0.08) return 'water';
  if (r < 0.16) return 'mountains';
  if (r < 0.36) return 'hills';
  if (r < 0.6) return 'forest';
  return 'plains';
}

function inBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

/** Убирает одиночные вкрапления, чтобы карта выглядела как связные области. */
function smooth(tiles: TerrainType[], width: number, height: number): TerrainType[] {
  const out = [...tiles];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const counts = new Map<TerrainType, number>();
      const cells = [{ x, y }, ...hexNeighborCoords({ x, y })];
      for (const c of cells) {
        if (!inBounds(c.x, c.y, width, height)) continue;
        const t = tiles[c.y * width + c.x]!;
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      let best: TerrainType = tiles[y * width + x]!;
      let bestCount = 0;
      for (const [terrain, count] of counts) {
        if (count > bestCount) {
          best = terrain;
          bestCount = count;
        }
      }
      out[y * width + x] = best;
    }
  }
  return out;
}

function emptyTile(x: number, y: number, terrain: TerrainType): Tile {
  return {
    x,
    y,
    terrain,
    ownerId: null,
    building: null,
    army: {},
    capitalOf: null,
    construction: null,
    movesLeft: 0,
    shotsLeft: 0,
    commander: null,
    routedTurns: 0,
    square: false,
  };
}

export function blankTiles(size: number, fill: TerrainType = 'plains'): Tile[] {
  const tiles: Tile[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      tiles.push(emptyTile(x, y, fill));
    }
  }
  return tiles;
}

export function resizeTiles(tiles: Tile[], oldWidth: number, oldHeight: number, newSize: number): Tile[] {
  const next = blankTiles(newSize, 'plains');
  for (const tile of tiles) {
    if (tile.x < 0 || tile.y < 0 || tile.x >= newSize || tile.y >= newSize) continue;
    if (tile.x >= oldWidth || tile.y >= oldHeight) continue;
    const dest = next[tile.y * newSize + tile.x];
    if (dest) dest.terrain = tile.terrain;
  }
  return next;
}

/** Столица проходима. Случайная карта ещё и расчищает кольцо вокруг, иначе старт в западне. */
export function ensureCapitalApproaches(
  tiles: Tile[],
  size: number,
  playerCount: number,
  forceRing = true,
): void {
  const spots = capitalSpots(size, playerCount);
  for (const spot of spots) {
    const capital = tiles[spot.y * size + spot.x];
    if (capital) capital.terrain = 'plains';
    const around: Tile[] = [];
    for (const c of hexNeighborCoords(spot)) {
      if (!inBounds(c.x, c.y, size, size)) continue;
      const tile = tiles[c.y * size + c.x];
      if (tile) around.push(tile);
    }
    if (forceRing) {
      for (const tile of around) {
        if (!TERRAIN[tile.terrain].passable) tile.terrain = 'plains';
      }
    } else if (!around.some((tile) => TERRAIN[tile.terrain].passable) && around[0]) {
      around[0].terrain = 'plains';
    }
  }
}

export function mapSizeFor(_playerCount: number): number {
  return MAP_SIZE;
}

/** Стартовые углы: для двоих — по диагонали, дальше по остальным углам. */
export function capitalSpots(size: number, playerCount: number): Coord[] {
  const lo = 1;
  const hi = size - 2;
  const corners: Coord[] = [
    { x: lo, y: lo },
    { x: hi, y: hi },
    { x: hi, y: lo },
    { x: lo, y: hi },
  ];
  return corners.slice(0, playerCount);
}

export function generateTiles(size: number, playerCount: number, seed: number): Tile[] {
  const rand = mulberry32(seed);
  let terrain: TerrainType[] = [];
  for (let i = 0; i < size * size; i++) terrain.push(rollTerrain(rand));
  terrain = smooth(terrain, size, size);

  const tiles: Tile[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      tiles.push(emptyTile(x, y, terrain[y * size + x]!));
    }
  }
  ensureCapitalApproaches(tiles, size, playerCount);
  return tiles;
}
