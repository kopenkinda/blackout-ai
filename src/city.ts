// The city layout: a square grid of blocks and streets, the buildings on
// them, and the six powered nodes the player has to shut down. Pure data,
// no rendering. The same seed always produces the same city.

export type Vec2 = { x: number; z: number };
export type Rect = { x: number; z: number; w: number; d: number };
export type Building = Rect & { h: number; node: number | null };
export type NodeSite = {
  id: number;
  x: number;
  z: number;
  facing: Vec2;
  building: number;
};

export type City = {
  blocks: number;
  blockSize: number;
  streetWidth: number;
  half: number;
  buildings: Building[];
  nodes: NodeSite[];
  spawn: Vec2;
  hunterSpawn: Vec2;
};

export const NODE_COUNT = 6;
export const TERMINAL = { w: 1.2, d: 0.6, h: 2 };
export const SIDEWALK = 2.5;

const BLOCKS = 8;
const BLOCK = 24;
const STREET = 10;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function createCity(seed = 1): City {
  const rand = mulberry32(seed);
  const half = (BLOCKS * BLOCK + (BLOCKS + 1) * STREET) / 2;
  const center = (b: number) => -half + STREET + BLOCK / 2 + b * (BLOCK + STREET);
  const inner = BLOCK - 2 * SIDEWALK;
  const mid = BLOCKS / 2;

  // Node blocks sit outside the central 4x4 and never touch each other.
  const ring: [number, number][] = [];
  for (let i = 0; i < BLOCKS; i++) {
    for (let j = 0; j < BLOCKS; j++) {
      const central = (v: number) => v >= mid - 2 && v <= mid + 1;
      if (!(central(i) && central(j))) ring.push([i, j]);
    }
  }
  let nodeBlocks: [number, number][] = [];
  while (nodeBlocks.length < NODE_COUNT) {
    nodeBlocks = [];
    for (const c of shuffle(ring, rand)) {
      if (nodeBlocks.length === NODE_COUNT) break;
      const apart = nodeBlocks.every(
        ([i, j]) => Math.max(Math.abs(i - c[0]), Math.abs(j - c[1])) >= 2,
      );
      if (apart) nodeBlocks.push(c);
    }
  }

  const buildings: Building[] = [];
  for (let bi = -1; bi <= BLOCKS; bi++) {
    for (let bj = -1; bj <= BLOCKS; bj++) {
      const x = center(bi);
      const z = center(bj);
      const node = nodeBlocks.findIndex(([i, j]) => i === bi && j === bj);
      if (node >= 0) {
        buildings.push({ x, z, w: inner, d: inner, h: 9 + rand() * 4, node });
        continue;
      }
      // Taller downtown, lower toward the edge and the skyline ring beyond it.
      const t = Math.hypot(bi - (BLOCKS - 1) / 2, bj - (BLOCKS - 1) / 2) / mid;
      const height = () => clamp((10 + rand() * 28) * (1.35 - 0.7 * t), 6, 50);
      const outside = bi < 0 || bj < 0 || bi >= BLOCKS || bj >= BLOCKS;
      const layout = outside ? 0 : rand();
      const gap = 2;
      const s = (inner - gap) / 2;
      const off = (s + gap) / 2;
      if (layout < 0.45) {
        buildings.push({ x, z, w: inner, d: inner, h: height(), node: null });
      } else if (layout < 0.8) {
        const alongX = rand() < 0.5;
        for (const k of [-1, 1]) {
          buildings.push(
            alongX
              ? { x: x + k * off, z, w: s, d: inner, h: height(), node: null }
              : { x, z: z + k * off, w: inner, d: s, h: height(), node: null },
          );
        }
      } else {
        for (const kx of [-1, 1]) {
          for (const kz of [-1, 1]) {
            buildings.push({
              x: x + kx * off,
              z: z + kz * off,
              w: s,
              d: s,
              h: height(),
              node: null,
            });
          }
        }
      }
    }
  }

  const sides: Vec2[] = [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 },
  ];
  const nodes = nodeBlocks.map((_, id) => {
    const building = buildings.findIndex((b) => b.node === id);
    const b = buildings[building];
    const facing = sides[Math.floor(rand() * 4)];
    const off = BLOCK / 2 - SIDEWALK / 2;
    return { id, x: b.x + facing.x * off, z: b.z + facing.z * off, facing, building };
  });

  const city: City = {
    blocks: BLOCKS,
    blockSize: BLOCK,
    streetWidth: STREET,
    half,
    buildings,
    nodes,
    spawn: { x: 0, z: 0 },
    hunterSpawn: { x: 0, z: 0 },
  };
  city.spawn = intersection(city, mid, mid);
  city.hunterSpawn = intersection(city, 0, 0);
  return city;
}

/** World position of the street intersection at grid column i, row j. */
export function intersection(city: City, i: number, j: number): Vec2 {
  const step = city.blockSize + city.streetWidth;
  const origin = -city.half + city.streetWidth / 2;
  return { x: origin + i * step, z: origin + j * step };
}

export function nearestIntersection(city: City, p: Vec2): { i: number; j: number } {
  const step = city.blockSize + city.streetWidth;
  const origin = -city.half + city.streetWidth / 2;
  const snap = (v: number) => clamp(Math.round((v - origin) / step), 0, city.blocks);
  return { i: snap(p.x), j: snap(p.z) };
}

/** The footprint of a node's switch terminal, for collision. */
export function terminalRect(site: NodeSite): Rect {
  const alongX = site.facing.x !== 0;
  return {
    x: site.x,
    z: site.z,
    w: alongX ? TERMINAL.d : TERMINAL.w,
    d: alongX ? TERMINAL.w : TERMINAL.d,
  };
}
