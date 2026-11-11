import { VoxelModel, type GenContext, type Generator } from "pixelworld/generators";

/**
 * Paris's landmark shapes that the landmark kit has no generic for (D-085):
 * a Gothic cathedral and a triumphal arch. Generic types, no names, no
 * statues, no reliefs: where sculpture stands in life, a panel of darker stone.
 * Both are point landmarks sized from their height.
 */

const role = (ctx: GenContext, m: VoxelModel, name: string, fallback: string): number => m.material(ctx.ramps(name)[0] ?? ctx.ramp(fallback));

/**
 * A Gothic cathedral, its long axis along +x with the west front at x = 0:
 * a west front of two square towers with flat tops, three portals, a band of
 * niches and a rose window between them; a nave with aisles, tall clerestory
 * windows and flying buttresses at each bay under a steep roof; a transept
 * with a rose at each end; a rounded apse; and a slender spire over the
 * crossing. Proportions over the spire's height H: length 1.33, width 0.5,
 * towers 0.72, nave walls 0.34 (ridge 0.45), aisles 0.18.
 * params: towers (the towers' height over H; 0.72), length (1.33).
 * roles: wall, roof (the lead roofs and spire), window, detail (portals,
 * bands, pinnacles, buttresses; wall if absent), rose (the rose windows;
 * window if absent), door (detail if absent).
 */
export const cathedral: Generator = (ctx) => {
  const { param } = ctx;
  const H = Math.max(24, Math.round(ctx.heightVox ?? 120));
  const L = Math.round(H * param("length", 1.33));
  const D = Math.round(H * 0.55);
  const m = new VoxelModel(L, D, H + 2);
  const wall = m.material(ctx.ramp("wall"));
  const roof = m.material(ctx.ramp("roof"));
  const glass = m.material(ctx.ramp("window"));
  const detail = role(ctx, m, "detail", "wall");
  const rose = role(ctx, m, "rose", "window");
  const door = m.material(ctx.ramps("door")[0] ?? ctx.ramps("detail")[0] ?? ctx.ramp("wall"));

  const c = (D - 1) / 2;
  const half = Math.round(H * 0.21); // the aisles' outer walls
  const nave = Math.max(2, Math.round(H * 0.1)); // the central vessel's half-width
  const Ha = Math.round(H * 0.18);
  const Hn = Math.round(H * 0.34);
  const ridge = Math.round(H * 0.45);
  const Ht = Math.round(H * param("towers", 0.72));
  const tw = Math.round(H * 0.18); // the west front's depth
  const apse = half; // the apse's radius
  const ax = L - 1 - apse; // the apse's centre
  const xc = Math.round(tw + (ax - tw) * 0.62); // the crossing
  const tt = Math.max(3, Math.round(H * 0.12)); // the transept's width along x
  const bay = Math.max(4, Math.round(H * 0.055));

  // a gabled vessel: walls to hw, then a roof rising one voxel up for each half-voxel in
  const vessel = (x: number, y: number, dist: number, halfW: number, hw: number, top: number, windows: boolean) => {
    if (dist > halfW + 0.3) return;
    const zr = hw + Math.round(((halfW + 0.5 - dist) / (halfW + 0.5)) * (top - hw));
    for (let z = 0; z < zr; z++) {
      const skin = dist > halfW - 0.7;
      let mat = z < hw ? wall : roof;
      if (windows && skin && z < hw - 2 && z > Ha + 2 && x % 3 === 1) mat = glass;
      if (m.get(x, y, z) === 0 || mat === roof) m.set(x, y, z, mat);
    }
  };

  for (let x = 0; x < L; x++)
    for (let y = 0; y < D; y++) {
      const dy = Math.abs(y - c);
      if (x < tw) {
        // the west front: towers at the sides, the gallery between them
        if (dy > half + 0.3) continue;
        const tower = dy > half * 0.36;
        const h = tower ? Ht : Math.round(H * 0.47);
        for (let z = 0; z < h; z++) {
          let mat = wall;
          const face = x === 0;
          if (face) {
            // three pointed portals: the middle one and one under each tower
            const portal = [0, half * 0.68].some((o) => Math.abs(dy - o) <= H * 0.04 && z < H * 0.15 - Math.abs(dy - o) * 1.5);
            if (portal) mat = door;
            else if (Math.abs(z - Math.round(H * 0.2)) <= 1) mat = (y + z) % 2 === 0 ? detail : wall; // the band of niches
            else if (!tower && Math.hypot(dy, z - H * 0.3) < H * 0.065) mat = rose;
            else if (tower && z > Ht - Math.round(H * 0.16) && z < Ht - 3 && Math.round(dy) % 3 !== 0) mat = glass; // the belfries
          }
          if (z >= h - 1 || (z === Math.round(H * 0.47) - 1 && tower)) mat = detail; // the galleries
          m.set(x, y, z, mat);
        }
        continue;
      }
      if (x >= ax) {
        // the apse: the vessel's round end in the ambulatory's
        const r = Math.hypot(x - ax, y - c);
        if (r <= half + 0.3) for (let z = 0; z < Ha; z++) m.set(x, y, z, z === Ha - 1 ? roof : wall);
        if (r <= nave + 0.3) {
          const zr = Hn + Math.round(((nave + 0.5 - r) / (nave + 0.5)) * (ridge - Hn));
          for (let z = 0; z < zr; z++) m.set(x, y, z, z < Hn ? (r > nave - 0.7 && z > Ha + 2 && z < Hn - 2 && (x + y) % 3 === 0 ? glass : wall) : roof);
        }
        continue;
      }
      // the aisles, under a low roof
      if (dy <= half + 0.3) for (let z = 0; z < Ha; z++) m.set(x, y, z, z === Ha - 1 ? roof : dy > half - 0.7 && z > 2 && z < Ha - 3 && x % bay === Math.floor(bay / 2) ? glass : wall);
      // the nave
      vessel(x, y, dy, nave, Hn, ridge, true);
      // the transept, its roof across the nave's
      if (Math.abs(x - xc) <= tt) {
        vessel(x, y, Math.abs(x - xc), tt, Hn, ridge, false);
        if ((y === 0 || y === D - 1) && dy > half) {
          for (let z = 0; z < Hn; z++) if (Math.hypot(x - xc, z - Hn * 0.62) < tt * 0.75) m.set(x, y, z, rose);
        }
      }
    }
  // flying buttresses at each bay of the nave: a pier at the aisle wall, an arch up to the clerestory
  for (let x = tw + bay; x < ax; x += bay) {
    if (Math.abs(x - xc) <= tt + 1) continue;
    for (const s of [-1, 1]) {
      const yo = Math.round(c + s * half);
      for (let z = 0; z < Ha + Math.round(H * 0.05); z++) m.set(x, yo, z, detail);
      const z0 = Ha + Math.round(H * 0.04);
      const z1 = Hn - 2;
      const yi = Math.round(c + s * (nave + 1));
      const steps = Math.max(1, Math.abs(yo - yi));
      for (let t = 0; t <= steps; t++) {
        const y = yo - s * t;
        const z = Math.round(z0 + ((z1 - z0) * t) / steps);
        if (y >= 0 && y < D) m.set(x, y, z, detail);
      }
    }
  }
  // the spire over the crossing
  const sr = Math.max(1, Math.round(H * 0.022));
  for (let z = ridge - 2; z < H; z++) {
    const r = sr * (1 - (z - ridge) / Math.max(1, H - ridge));
    for (let y = Math.floor(c - sr); y <= Math.ceil(c + sr); y++)
      for (let x = xc - sr; x <= xc + sr; x++) if (Math.max(Math.abs(x - xc), Math.abs(y - c)) <= Math.max(0.5, r) && x >= 0 && x < L) m.set(x, y, z, z % 4 === 0 ? detail : roof);
  }
  return m;
};

/**
 * A triumphal arch: a near-cubic block of stone (over its height H, 0.9 wide
 * along x and 0.44 deep) with one great round arch through its wide faces
 * and smaller arches through its narrow faces, a cornice and an attic band
 * on top, and plain darker panels where reliefs are in life.
 * params: width (0.9), depth (0.44).
 * roles: wall, detail (cornices and panels; wall if absent), roof (wall if absent).
 */
export const triumphalArch: Generator = (ctx) => {
  const { param } = ctx;
  const H = Math.max(12, Math.round(ctx.heightVox ?? 60));
  const W = Math.round(H * param("width", 0.9));
  const D = Math.max(5, Math.round(H * param("depth", 0.44)));
  const m = new VoxelModel(W, D, H + 1);
  const wall = m.material(ctx.ramp("wall"));
  const detail = role(ctx, m, "detail", "wall");
  const roof = role(ctx, m, "roof", "wall");
  const cx = (W - 1) / 2;
  const cy = (D - 1) / 2;
  // an opening `w` wide whose round top springs at `spring`
  const open = (off: number, w: number, spring: number, z: number) => {
    const r = w / 2;
    return Math.abs(off) <= r && z < spring + Math.sqrt(Math.max(0, r * r - off * off));
  };
  const mainW = H * 0.29;
  const mainSpring = H * 0.58 - mainW / 2;
  const sideW = H * 0.17;
  const sideSpring = H * 0.38 - sideW / 2;
  const entab = Math.round(H * 0.64);
  const attic = Math.round(H * 0.74);
  for (let x = 0; x < W; x++)
    for (let y = 0; y < D; y++)
      for (let z = 0; z < H; z++) {
        if (open(x - cx, mainW, mainSpring, z) || open(y - cy, sideW, sideSpring, z)) continue;
        const face = y === 0 || y === D - 1 || x === 0 || x === W - 1;
        let mat = wall;
        if (z === H - 1) mat = roof;
        else if (face && (z === entab || z === entab + 1 || z === attic || (z > attic && z === H - 2))) mat = detail;
        else if (face && z > attic + 1 && z < H - 2 && Math.round(Math.abs(x - cx)) % Math.max(3, Math.round(H * 0.08)) === 0) mat = detail; // the attic's shields
        else if ((y === 0 || y === D - 1) && Math.abs(x - cx) > mainW / 2 + 2 && Math.abs(x - cx) < W / 2 - 2 && z > H * 0.12 && z < H * 0.42) mat = detail; // the relief panels
        m.set(x, y, z, mat);
      }
  return m;
};

export const LANDMARK_GENERATORS: Record<string, Generator> = { cathedral, triumphalArch };
