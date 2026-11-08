import type { Generator } from "./assets";
import { VoxelModel } from "./voxel";

/**
 * Chinatown's street pieces (M3.5): a ceremonial gate over a street and red
 * lanterns strung across it. Generic depictions, as every landmark is
 * (D-051): no names, lettering or logos; a gate's plaque is a blank panel.
 */

/**
 * A ceremonial gate over a street (a paifang): three openings between four
 * stone piers on plinths, the middle one for the roadway and lower ones for
 * the sidewalks either side. A red beam spans each opening under a stone
 * frieze and a band of red brackets, and a blank gold plaque in a red frame
 * hangs over the middle one. Each opening carries its own hipped roof of
 * green glazed tile whose corners turn up, the middle one highest, with gold
 * ornaments on its ridge. The span runs along x (orient turns it); the
 * roofs' eaves stand a voxel proud of the piers front and back.
 * params (over the height, to the middle ridge): width (the span; 1.3),
 * depth (front to back, eaves included; 0.22), middle (the middle opening's
 * share of the span; 0.4).
 * roles: stone (piers and friezes), tile (roofs), beam (beams, brackets,
 * the plaque's frame), gold (ornaments, the plaque), base (plinths; stone if
 * absent).
 */
const gate: Generator = ({ ramp, ramps, param, heightVox }) => {
  const H = Math.max(10, Math.round(heightVox ?? 22));
  let W = Math.max(15, Math.round(H * param("width", 1.3)));
  if (W % 2 === 0) W++; // a middle column, so the gate is symmetric
  const D = Math.max(3, Math.round(H * param("depth", 0.22)));
  const m = new VoxelModel(W, D, H + 2);
  const stone = m.material(ramp("stone"));
  const tile = m.material(ramp("tile"));
  const beam = m.material(ramp("beam"));
  const gold = m.material(ramp("gold"));
  const base = m.material(ramps("base")[0] ?? ramp("stone"));
  const c = (W - 1) / 2;
  // across the span from the middle: half the middle opening, a pier, a side opening, a pier
  const pw = Math.max(1, Math.round(W * 0.07));
  let hm = Math.max(2, Math.floor((W * param("middle", 0.4)) / 2));
  while (hm > 2 && c - hm - 2 * pw < 2) hm--; // keep a side opening at least two wide
  const innerL = c - hm - pw; // the inner piers' outer edges
  const innerR = c + hm + pw;
  const isOuter = (x: number) => x < pw || x >= W - pw;
  const isInner = (x: number) => (x >= innerL && x < c - hm) || (x > c + hm && x <= innerR);
  const inMiddle = (x: number) => Math.abs(x - c) <= hm;
  // the piers stand inside the eaves (front and back), on plinths the full depth
  const y0 = D >= 4 ? 1 : 0;
  const y1 = D >= 4 ? D - 2 : D - 1;
  // a hipped roof from x0 to x1 with its eave at z0: each row in a voxel front and back
  const rise = Math.ceil(D / 2);
  const roof = (x0: number, x1: number, z0: number) => {
    for (let k = 0; k < rise; k++)
      for (let x = x0 + k; x <= x1 - k; x++) for (let y = k; y <= D - 1 - k; y++) m.set(x, y, z0 + k, tile);
    // the eave's corners turn up; gold ornaments on the ridge's ends
    for (const x of [x0, x1]) for (const y of [0, D - 1]) m.set(x, y, z0 + 1, tile);
    const ry = Math.floor((D - 1) / 2);
    for (const x of [x0 + rise, x1 - rise]) m.set(x, ry, z0 + rise, gold);
  };
  const zMidRoof = H - rise; // the middle ridge at H - 1
  const zSideRoof = Math.max(4, Math.round(H * 0.55));
  const zMidOpen = Math.min(zMidRoof - 4, Math.max(3, Math.round(H * 0.47)));
  const zSideOpen = Math.min(zSideRoof - 3, Math.max(2, Math.round(H * 0.36)));
  for (let x = 0; x < W; x++)
    for (let y = 0; y < D; y++) {
      const pierY = y >= y0 && y <= y1;
      if (isOuter(x) || isInner(x)) {
        const top = isOuter(x) ? zSideRoof : zMidRoof;
        for (let z = 0; z < top; z++) {
          if (z < 2) m.set(x, y, z, base); // the plinth
          else if (pierY) m.set(x, y, z, z === top - 1 ? beam : stone);
        }
        continue;
      }
      if (!pierY) continue;
      // over an opening: a red beam, a stone frieze, red brackets under the roof
      const [zo, zr] = inMiddle(x) ? [zMidOpen, zMidRoof] : [zSideOpen, zSideRoof];
      for (let z = zo; z < zr; z++) m.set(x, y, z, z === zo || z === zr - 1 ? beam : stone);
    }
  // the plaque over the middle opening: blank gold in a red frame, on the front and back
  const ph = Math.max(1, Math.floor(hm / 2));
  for (let x = Math.round(c - ph); x <= Math.round(c + ph); x++)
    for (let z = zMidOpen + 1; z <= zMidRoof - 2; z++)
      for (const y of [y0, y1]) {
        const frame = Math.abs(x - c) === ph || z === zMidOpen + 1 || z === zMidRoof - 2;
        m.set(x, y, z, frame ? beam : gold);
      }
  // the roofs: the sides' first, then the middle one over them
  roof(0, Math.round(c - hm - 1), zSideRoof);
  roof(Math.round(c + hm + 1), W - 1, zSideRoof);
  roof(Math.max(0, innerL - 1), Math.min(W - 1, innerR + 1), zMidRoof);
  m.set(Math.round(c), Math.floor((D - 1) / 2), H, gold); // a pearl on the middle ridge
  return m;
};

/**
 * Red lanterns strung across a street: a wire sagging between the facades on
 * either side, with round lanterns hanging from it every few voxels, gold
 * ones between the red on some strings. Chinatown red glows at night. The
 * string runs along x; the pipeline turns it across its street.
 * params: span (voxels; 24), height (the wire at its ends; 12), every
 * (voxels from one lantern to the next; 4), sag (voxels; 2).
 * roles: lantern, wire, gold (lantern if absent).
 */
const lanterns: Generator = ({ rand, ramp, ramps, param }) => {
  const S = Math.max(6, Math.round(param("span", 24)));
  const h = Math.max(4, Math.round(param("height", 12)));
  const every = Math.max(3, Math.round(param("every", 4)));
  const sag = Math.max(0, Math.round(param("sag", 2)));
  const m = new VoxelModel(S, 2, h + 1);
  const wire = m.material(ramp("wire"));
  const red = m.material(ramp("lantern"));
  const gold = m.material(ramps("gold")[0] ?? ramp("lantern"));
  const golden = rand() < 0.35;
  const off = 1 + Math.floor(rand() * every);
  const wireZ = (x: number) => {
    const t = (2 * x) / (S - 1) - 1;
    return h - Math.round(sag * (1 - t * t));
  };
  for (let x = 0; x < S; x++) {
    const z = wireZ(x);
    // the wire steps down toward the middle and up again, unbroken
    const zPrev = x > 0 ? wireZ(x - 1) : z;
    for (let zz = Math.min(z, zPrev); zz <= Math.max(z, zPrev); zz++) m.set(x, 0, zz, wire);
    const k = x - off;
    if (k < 0 || k % every !== 0 || x + 1 >= S - 1) continue;
    // a lantern under the wire's lowest voxel here, a gold tassel under it
    const lo = Math.min(z, zPrev);
    const mat = golden && (k / every) % 2 === 1 ? gold : red;
    for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 1; dz <= 2; dz++) m.set(x + dx, dy, lo - dz, mat);
    m.set(x, 0, lo - 3, gold);
  }
  return m;
};

export const CHINATOWN_GENERATORS: Record<string, Generator> = { gate, lanterns };
