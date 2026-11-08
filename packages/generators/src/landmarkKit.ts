import type { GenContext, Generator } from "./assets";
import { VoxelModel } from "./voxel";

/**
 * More of the landmark component kit (M3, D-051): generic types, no names or
 * logos. Line landmarks (bridges, halls along a waterfront) get their
 * footprint as a mask and find its long axis; point landmarks size themselves
 * from their height.
 */

/**
 * A footprint band's long axis: per column, position along (0..1), along (voxels
 * from the start) and across (voxels from the axis). A piece of a long landmark
 * measures against its whole line (ctx.frame.line), so the pieces join up.
 */
function bandAxis(mask: { sx: number; sy: number; on: Uint8Array }, frame?: GenContext["frame"]) {
  const cells: [number, number][] = [];
  for (let y = 0; y < mask.sy; y++) for (let x = 0; x < mask.sx; x++) if (mask.on[y * mask.sx + x]) cells.push([x, y]);
  if (frame?.line) {
    const { a, b, half } = frame.line;
    const v = frame.voxel;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / Math.max(L, 1e-9);
    const uy = (b[1] - a[1]) / Math.max(L, 1e-9);
    const along: number[] = [];
    const across: number[] = [];
    for (const [x, y] of cells) {
      const wx = frame.x0 + (x + 0.5) * v - a[0];
      const wy = frame.y0 + (y + 0.5) * v - a[1];
      along.push((wx * ux + wy * uy) / v);
      across.push((-wx * uy + wy * ux) / v);
    }
    const length = L / v;
    return {
      cells,
      t: along.map((al) => Math.min(1, Math.max(0, al / Math.max(1e-6, length)))),
      along,
      across,
      length,
      half: Math.max(0.5, half / v),
    };
  }
  const mx = cells.reduce((a, [x]) => a + x, 0) / Math.max(1, cells.length);
  const my = cells.reduce((a, [, y]) => a + y, 0) / Math.max(1, cells.length);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of cells) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const along = cells.map(([x, y]) => (x - mx) * ux + (y - my) * uy);
  const across = cells.map(([x, y]) => -(x - mx) * uy + (y - my) * ux);
  const a0 = Math.min(...along);
  const a1 = Math.max(...along);
  const half = Math.max(0.5, ...across.map(Math.abs));
  return {
    cells,
    t: along.map((a) => (a - a0) / Math.max(1e-6, a1 - a0)),
    along: along.map((a) => a - a0),
    across,
    length: a1 - a0,
    half,
  };
}

/**
 * A suspension bridge along its footprint: towers, two main cables hanging
 * between them and back to anchorages, hangers, a deck on a stiffening truss.
 * params: spans (independent suspension bridges in a row, joined at central
 * anchorages; 1), side (side span fraction of each bridge; 0.17), towerRatio
 * (tower top over deck height; 3), hangers (voxels between them; 6).
 */
const suspensionBridge: Generator = ({ ramp, param, mask, heightVox, frame }) => {
  if (!mask) throw new Error("suspension bridge needs a footprint");
  const H = Math.max(6, Math.round(heightVox ?? 30));
  const spans = Math.max(1, Math.round(param("spans", 1)));
  const side = param("side", 0.17);
  const T = Math.round(H * param("towerRatio", 3));
  const hangers = Math.max(2, Math.round(param("hangers", 6))); // voxels between hangers
  const m = new VoxelModel(mask.sx, mask.sy, T + 3);
  const steel = m.material(ramp("structure"));
  const deck = m.material(ramp("deck"));
  const pier = m.material(ramp("pier"));
  const b = bandAxis(mask, frame);
  if (!b.cells.length) return m;
  // towers and anchorages along the line (fractions of its length)
  const towers: number[] = [];
  const anchors: number[] = [0, 1];
  for (let k = 0; k < spans; k++) {
    const s0 = k / spans;
    const s1 = (k + 1) / spans;
    towers.push(s0 + side * (s1 - s0), s1 - side * (s1 - s0));
    if (k > 0) anchors.push(s0);
  }
  const towerHalf = 1.2 / Math.max(1, b.length); // about a voxel either side of each tower
  const cableZ = (t: number): number => {
    // within one bridge: hang between its towers, run straight down to its anchorages
    const k = Math.min(spans - 1, Math.floor(t * spans));
    const s0 = k / spans;
    const s1 = (k + 1) / spans;
    const ta = s0 + side * (s1 - s0);
    const tb = s1 - side * (s1 - s0);
    const top = T - 1;
    const low = H + 2;
    if (t >= ta && t <= tb) {
      const u = (2 * (t - ta)) / (tb - ta) - 1;
      return Math.round(low + (top - low) * u * u);
    }
    const u = t < ta ? (t - s0) / (ta - s0) : (s1 - t) / (s1 - tb);
    return Math.round(H + 1 + (top - H - 1) * Math.pow(Math.max(0, u), 1.3));
  };
  // deck, truss, cables, hangers
  const edge = (i: number) => Math.abs(b.across[i]!) >= b.half - 0.75;
  b.cells.forEach(([x, y], i) => {
    const t = b.t[i]!;
    m.set(x, y, H, deck);
    if (Math.round(b.along[i]!) % 2 === 0 || edge(i)) m.set(x, y, H - 1, steel); // the stiffening truss
    if (edge(i)) {
      const c = cableZ(t);
      m.set(x, y, c, steel);
      // fill steep runs so the cable stays continuous
      const prev = cableZ(Math.max(0, t - 1 / Math.max(1, b.length)));
      for (let z = Math.min(c, prev); z < Math.max(c, prev); z++) m.set(x, y, z, steel);
      if (Math.round(b.along[i]!) % hangers === 0) for (let z = H + 1; z < c; z++) m.set(x, y, z, steel); // hangers
    }
  });
  // towers: two legs at the edges, portal braces between them, a pier in the water
  b.cells.forEach(([x, y], i) => {
    const t = b.t[i]!;
    if (towers.some((tt) => Math.abs(t - tt) <= towerHalf)) {
      for (let z = 0; z < Math.round(H * 0.35); z++) m.set(x, y, z, pier);
      const leg = edge(i) || Math.abs(b.across[i]!) >= b.half - 1.75;
      for (let z = Math.round(H * 0.35); z < T; z++) {
        const brace = z > H && (z - H) % Math.max(4, Math.round((T - H) / 4)) === 0;
        if (leg || brace || (z < H && Math.abs(b.across[i]!) < 1)) m.set(x, y, z, steel);
      }
      m.set(x, y, T, steel);
    }
    // anchorages: concrete blocks where the cables come down
    if (anchors.some((ta) => Math.abs(t - ta) <= 2 * towerHalf + 0.012)) for (let z = 0; z <= H + 2; z++) m.set(x, y, z, pier);
  });
  return m;
};

/** A slender four-sided pyramid tower with two wings and a spire (params: base, the base over the height). */
const pyramidTower: Generator = ({ ramp, param, heightVox }) => {
  const H = Math.max(20, Math.round(heightVox ?? 120));
  const B = Math.max(4, Math.round(H * param("base", 0.2)));
  const spire = Math.round(H * 0.2);
  const size = B + 4;
  const m = new VoxelModel(size, size, H + 2);
  const wall = m.material(ramp("structure"));
  const glass = m.material(ramp("window"));
  const c = (size - 1) / 2;
  const body = H - spire;
  for (let z = 0; z < body; z++) {
    const r = (B / 2) * (1 - z / body) + 0.5;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const dx = Math.abs(x - c);
        const dy = Math.abs(y - c);
        if (Math.max(dx, dy) > r) continue;
        const skin = Math.max(dx, dy) > r - 1;
        // windows in vertical strips on the skin, solid edges
        const win = skin && z % 3 !== 0 && (dx > dy ? Math.round(y) : Math.round(x)) % 2 === 0 && Math.abs(dx - dy) > 1;
        m.set(x, y, z, win ? glass : wall);
      }
    // the two wings (elevator and stair shafts) on opposite faces, up to the top third
    if (z < body * 0.78) {
      const w = Math.max(1, Math.round(B * 0.12));
      const reach = Math.round(r + 1);
      for (let k = -w; k <= w; k++) {
        m.set(Math.round(c + k), Math.round(c - reach), z, wall);
        m.set(Math.round(c + k), Math.round(c + reach), z, wall);
      }
    }
  }
  for (let z = body; z < H; z++) m.set(Math.round(c), Math.round(c), z, wall);
  return m;
};

/** A fluted column on a hill: a cylinder with flutes, an arcade at the top, a low cap (param radius over height). */
const column: Generator = ({ ramp, param, heightVox }) => {
  const H = Math.max(12, Math.round(heightVox ?? 40));
  const R = Math.max(2, Math.round(H * param("radius", 0.09)));
  const size = 2 * R + 3;
  const m = new VoxelModel(size, size, H + 2);
  const stone = m.material(ramp("stone"));
  const shade = m.material(ramp("detail"));
  const glass = m.material(ramp("window"));
  const c = (size - 1) / 2;
  for (let z = 0; z < H; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - c, y - c);
        const r = z < 2 ? R + 1 : z >= H - 2 ? R - 1 : R;
        if (d > r + 0.3) continue;
        const skin = d > r - 0.9;
        const flute = skin && Math.round((Math.atan2(y - c, x - c) / Math.PI) * 2 * R) % 2 === 0;
        const arcade = skin && z >= H - Math.round(H * 0.12) && z < H - 2 && Math.round(Math.atan2(y - c, x - c) * R) % 3 !== 0;
        m.set(x, y, z, arcade ? glass : flute ? shade : stone);
      }
  return m;
};

/**
 * A long hall with a clock tower at its middle, along a waterfront (line
 * landmark): two storeys of arcades, the tower a third of the height wide.
 * params: hall (hall height over the tower's).
 */
const towerHall: Generator = ({ ramp, param, mask, heightVox, frame }) => {
  if (!mask) throw new Error("tower hall needs a footprint");
  const H = Math.max(12, Math.round(heightVox ?? 40));
  const hallH = Math.max(3, Math.round(H * param("hall", 0.25)));
  const m = new VoxelModel(mask.sx, mask.sy, H + 3);
  const wall = m.material(ramp("wall"));
  const roof = m.material(ramp("roof"));
  const glass = m.material(ramp("window"));
  const clock = m.material(ramp("accent"));
  const b = bandAxis(mask, frame);
  const tw = Math.max(2, Math.round(H * 0.08));
  b.cells.forEach(([x, y], i) => {
    const mid = Math.abs(b.along[i]! - b.length / 2);
    const outer = Math.abs(b.across[i]!) >= b.half - 0.75;
    for (let z = 0; z < hallH; z++) m.set(x, y, z, outer && z % 3 !== 0 && Math.round(b.along[i]!) % 3 !== 0 ? glass : wall);
    m.set(x, y, hallH, roof);
    if (mid <= tw && Math.abs(b.across[i]!) <= tw) {
      for (let z = hallH; z < H; z++) {
        const face = mid > tw - 1 || Math.abs(b.across[i]!) > tw - 1;
        m.set(x, y, z, face && z >= H - Math.round(H * 0.22) && z < H - Math.round(H * 0.15) ? clock : wall);
      }
      if (mid <= 1 && Math.abs(b.across[i]!) <= 1) for (let z = H; z < H + 3; z++) m.set(x, y, z, roof);
    }
  });
  return m;
};

/** A domed civic hall: a long block, a drum and a dome with a lantern at its middle (params: hall height, dome radius). */
const domedHall: Generator = ({ ramp, param, heightVox }) => {
  const H = Math.max(16, Math.round(heightVox ?? 60));
  const L = Math.round(H * param("length", 1.6));
  const D = Math.round(H * param("depth", 1.1));
  const hallH = Math.round(H * param("hall", 0.32));
  const R = Math.max(3, Math.round(H * param("dome", 0.18)));
  const m = new VoxelModel(L, D, H + 2);
  const stone = m.material(ramp("wall"));
  const glass = m.material(ramp("window"));
  const dome = m.material(ramp("dome"));
  const roof = m.material(ramp("roof"));
  const cx = (L - 1) / 2;
  const cy = (D - 1) / 2;
  for (let y = 0; y < D; y++)
    for (let x = 0; x < L; x++) {
      const skin = x === 0 || y === 0 || x === L - 1 || y === D - 1;
      for (let z = 0; z < hallH; z++) m.set(x, y, z, skin && z % 3 !== 0 && (x + y) % 2 === 0 && z > 1 ? glass : stone);
      m.set(x, y, hallH, roof);
      const d = Math.hypot(x - cx, y - cy);
      const drumTop = hallH + Math.round(R * 0.8);
      if (d <= R + 0.4) {
        for (let z = hallH; z < drumTop; z++) m.set(x, y, z, d > R - 0.8 && z % 2 === 0 ? glass : stone);
        const domeH = Math.round(Math.sqrt(Math.max(0, (R + 0.4) ** 2 - d * d)) * 1.3);
        for (let z = drumTop; z < drumTop + domeH; z++) m.set(x, y, z, dome);
      }
      if (d <= 1.2) for (let z = drumTop; z < H; z++) m.set(x, y, z, z > H - 3 ? dome : stone);
    }
  return m;
};

/** A three-legged broadcast mast: legs converging to a waist, crossbars, three prongs above (param: spread). */
const tripodMast: Generator = ({ ramp, param, heightVox }) => {
  const H = Math.max(20, Math.round(heightVox ?? 120));
  const S = Math.max(3, Math.round(H * param("spread", 0.12)));
  const size = 2 * S + 3;
  const m = new VoxelModel(size, size, H + 1);
  const red = m.material(ramp("structure"));
  const white = m.material(ramp("band"));
  const c = (size - 1) / 2;
  const waist = Math.round(H * 0.62);
  const legs = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
  for (let z = 0; z < H; z++) {
    const spread = z < waist ? S * (1 - (0.75 * z) / waist) : S * 0.25 + (S * 0.35 * (z - waist)) / (H - waist);
    const mat = Math.floor(z / Math.max(3, Math.round(H / 14))) % 2 === 0 ? red : white;
    for (const a of legs) m.set(Math.round(c + spread * Math.cos(a)), Math.round(c + spread * Math.sin(a)), z, mat);
    // crossbars at two heights
    if (z === Math.round(H * 0.3) || z === waist) {
      for (let k = 0; k < 3; k++) {
        const a0 = legs[k]!;
        const a1 = legs[(k + 1) % 3]!;
        for (let s = 0; s <= 8; s++) {
          const u = s / 8;
          m.set(
            Math.round(c + spread * ((1 - u) * Math.cos(a0) + u * Math.cos(a1))),
            Math.round(c + spread * ((1 - u) * Math.sin(a0) + u * Math.sin(a1))),
            z,
            red,
          );
        }
      }
    }
  }
  return m;
};

export const LANDMARK_KIT: Record<string, Generator> = {
  suspensionBridge,
  pyramidTower,
  column,
  towerHall,
  domedHall,
  tripodMast,
};

export type { GenContext };
