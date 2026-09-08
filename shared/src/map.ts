import { TERRAIN } from './config.js';
import { mulberry32 } from './rng.js';
import type { Coord, GameState, TerrainType, Tile } from './types.js';

export function tileIndex(state: { width: number }, x: number, y: number): number {
  return y * state.width + x;
}

export function tileAt(state: GameState, x: number, y: number): Tile | null {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return null;
  return state.tiles[tileIndex(state, x, y)] ?? null;
}

export function neighbors(state: GameState, c: Coord): Tile[] {
  const deltas: Coord[] = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
  ];
  const result: Tile[] = [];
  for (const d of deltas) {
    const t = tileAt(state, c.x + d.x, c.y + d.y);
    if (t) result.push(t);
  }
  return result;
}

export function isAdjacent(a: Coord, b: Coord): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

function rollTerrain(rand: () => number): TerrainType {
  const r = rand();
  if (r < 0.08) return 'water';
  if (r < 0.16) return 'mountains';
  if (r < 0.36) return 'hills';
  if (r < 0.6) return 'forest';
  return 'plains';
}

/** Убирает одиночные вкрапления, чтобы карта выглядела как связные области. */
function smooth(tiles: TerrainType[], width: number, height: number): TerrainType[] {
  const out = [...tiles];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const counts = new Map<TerrainType, number>();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const t = tiles[ny * width + nx]!;
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
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

export function mapSizeFor(playerCount: number): number {
  return 6 + Math.max(2, playerCount);
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

  const spots = capitalSpots(size, playerCount);
  for (const spot of spots) {
    // Столица и всё вокруг неё должны быть проходимы, иначе игрок заперт.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = spot.x + dx;
        const ny = spot.y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const idx = ny * size + nx;
        if (!TERRAIN[terrain[idx]!].passable) terrain[idx] = 'plains';
      }
    }
    terrain[spot.y * size + spot.x] = 'plains';
  }

  const tiles: Tile[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      tiles.push({
        x,
        y,
        terrain: terrain[y * size + x]!,
        ownerId: null,
        building: null,
        army: 0,
        capitalOf: null,
      });
    }
  }
  return tiles;
}
