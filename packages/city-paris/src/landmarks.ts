import { VoxelModel, type GenContext, type Generator } from "pixelworld/generators";

/**
 * Paris's landmark shapes (D-085, D-087): a Gothic cathedral, a triumphal
 * arch, a lattice tower on arched piers, an opera house and a steel arch
 * bridge, each drawn on the proportions of the Paris landmark of its type.
 * No names, no statues, no reliefs, no lighting: where sculpture stands in
 * life, a recessed panel of darker stone or a plain gilt block.
 */

const role = (ctx: GenContext, m: VoxelModel, name: string, fallback: string): number => m.material(ctx.ramps(name)[0] ?? ctx.ramp(fallback));

/** Fill the box from (x0, y0, z0) to (x1, y1, z1), both corners included (VoxelModel.fill excludes the far one). */
const box = (m: VoxelModel, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: number): void =>
  m.fill(x0, y0, z0, x1 + 1, y1 + 1, z1 + 1, mat);

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
            else if (Math.abs(z - Math.round(H * 0.2)) <= 1) mat = (y + z) % 2 === 0 ? detail : wall; // the gallery of kings
            else if (z >= Math.round(H * 0.41) && z < Math.round(H * 0.46)) mat = Math.round(dy) % 2 === 0 || z === Math.round(H * 0.41) ? detail : glass; // the open gallery
            else if (!tower) {
              // the rose: a ring of tracery round spokes
              const d = Math.hypot(dy, z - H * 0.3);
              const R = H * 0.07;
              if (d < R) mat = d > R - 1.2 || d < 1.2 || Math.round((Math.atan2(z - H * 0.3, y - c) / Math.PI) * 8) % 2 === 0 ? detail : rose;
            }
          }
          if (z >= h - 1 || (z === Math.round(H * 0.47) - 1 && tower)) mat = detail; // the balustrades
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
          for (let z = 0; z < Hn; z++) {
            const d = Math.hypot(x - xc, z - Hn * 0.62);
            const R = tt * 0.75;
            if (d < R) m.set(x, y, z, d > R - 1.2 || d < 1.2 || Math.round((Math.atan2(z - Hn * 0.62, x - xc) / Math.PI) * 8) % 2 === 0 ? detail : rose);
          }
        }
      }
    }
  // the belfries: two tall lancets on every face of each tower, and a pierced balustrade on top
  const yIn = Math.ceil(half * 0.36);
  for (const s of [-1, 1]) {
    const y0 = s < 0 ? Math.round(c - half) : Math.round(c + yIn);
    const y1 = s < 0 ? Math.round(c - yIn) : Math.round(c + half);
    const zb0 = Ht - Math.round(H * 0.2);
    const zb1 = Ht - Math.round(H * 0.03);
    const faces: [number, number, number, number][] = [
      [0, y0, 0, y1], // west: x = 0, along y
      [tw - 1, y0, tw - 1, y1], // east
      [0, y0, tw - 1, y0], // the two sides: along x
      [0, y1, tw - 1, y1],
    ];
    for (const [xa, ya, xb, yb] of faces) {
      const n = Math.max(xb - xa, yb - ya) + 1;
      for (let k = 0; k < n; k++) {
        const u = (k + 0.5) / n;
        const lancet = [1 / 3, 2 / 3].find((cl) => Math.abs(u - cl) < 0.09);
        if (lancet === undefined) continue;
        const off = Math.abs(u - lancet) / 0.09; // 0 at its middle, 1 at its edge
        const x = xa === xb ? xa : xa + k;
        const y = ya === yb ? ya : ya + k;
        for (let z = zb0; z < zb1 - Math.round(off * 3); z++) m.set(x, y, z, glass);
      }
    }
    for (let x = 0; x < tw; x++)
      for (let y = y0; y <= y1; y++) {
        const rim = x === 0 || x === tw - 1 || y === y0 || y === y1;
        if (rim && (x + y) % 2 === 0) m.set(x, y, Ht, detail);
      }
  }
  // flying buttresses at each bay of the nave: a pier at the aisle wall, an arch up to the clerestory
  for (let x = tw + bay; x < ax; x += bay) {
    if (Math.abs(x - xc) <= tt + 1) continue;
    for (const s of [-1, 1]) {
      const yo = Math.round(c + s * half);
      for (let z = 0; z < Ha + Math.round(H * 0.08); z++) m.set(x, yo, z, detail); // the pier and its pinnacle
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
  // the chevet: flying buttresses radiating round the apse
  for (let k = -3; k <= 3; k++) {
    const a = (k * Math.PI) / 8;
    const z0 = Ha + Math.round(H * 0.04);
    const z1 = Hn - 2;
    const steps = Math.max(1, half - nave - 1);
    for (let z = 0; z < Ha + Math.round(H * 0.08); z++) {
      const x = Math.round(ax + Math.cos(a) * half);
      const y = Math.round(c + Math.sin(a) * half);
      if (x < L && y >= 0 && y < D) m.set(x, y, z, detail);
    }
    for (let t = 0; t <= steps; t++) {
      const r = half - t;
      const x = Math.round(ax + Math.cos(a) * r);
      const y = Math.round(c + Math.sin(a) * r);
      if (x < L && y >= 0 && y < D) m.set(x, y, Math.round(z0 + ((z1 - z0) * t) / steps), detail);
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
 * A triumphal arch (the Arc de Triomphe's type): a near-cubic block of stone
 * (over its height H, 0.9 wide along x and 0.44 deep) with one great round
 * arch through its wide faces, framed by an archivolt and springing from an
 * impost band, and smaller arches through its narrow faces. Where sculpture
 * stands in life, plain panels of darker stone: the four great groups at the
 * piers' feet, the reliefs above them and over the side arches. Above, a
 * frieze, a cornice, and the attic with its row of shields under a top
 * cornice. No figures.
 * params: width (0.9), depth (0.44).
 * roles: wall, detail (panels, bands, shields; wall if absent), roof (the
 * cornices and the top; wall if absent).
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
  const mainW = H * 0.29;
  const mainSpring = H * 0.58 - mainW / 2;
  const sideW = H * 0.17;
  const sideSpring = H * 0.38 - sideW / 2;
  // how far inside an opening `w` wide whose round top springs at `spring` a point is (> 0 inside)
  const inside = (off: number, w: number, spring: number, z: number) => {
    const r = w / 2;
    if (Math.abs(off) > r) return r - Math.abs(off);
    return z < spring ? r - Math.abs(off) : r - Math.hypot(off, z - spring);
  };
  const f = (k: number) => Math.round(H * k);
  const frieze = [f(0.62), f(0.64)];
  const cornice = [f(0.64), f(0.67)];
  const attic = f(0.74);
  const pierIn = mainW / 2 + H * 0.05; // the panels between the archivolt and the corners
  const pierOut = W / 2 - H * 0.06;
  for (let x = 0; x < W; x++)
    for (let y = 0; y < D; y++)
      for (let z = 0; z < H; z++) {
        const main = inside(x - cx, mainW, mainSpring, z);
        const side = inside(y - cy, sideW, sideSpring, z);
        if (main > 0 || side > 0) continue;
        const wide = y === 0 || y === D - 1;
        const narrow = x === 0 || x === W - 1;
        const dx = Math.abs(x - cx);
        // the sculpture panels are recessed a voxel, so they catch shadow
        const panelZ = (z > f(0.05) && z < f(0.3)) || (z > f(0.36) && z < f(0.5));
        const panel = dx > pierIn && dx < pierOut && panelZ;
        const overSide = Math.abs(y - cy) < sideW / 2 + 1 && z > sideSpring + sideW / 2 + 2 && z < f(0.56);
        if ((wide && panel) || (narrow && overSide)) continue;
        if (((y === 1 || y === D - 2) && panel) || ((x === 1 || x === W - 2) && overSide)) {
          m.set(x, y, z, detail);
          continue;
        }
        let mat = wall;
        if (z >= H - 2 || (z >= cornice[0]! && z < cornice[1]!)) mat = roof;
        else if (!wide && !narrow) mat = wall;
        else if (z >= frieze[0]! && z < frieze[1]!) mat = (x + y + z) % 3 === 0 ? detail : wall;
        else if (z > attic + 1 && z < H - 3 && Math.round(wide ? dx : Math.abs(y - cy)) % Math.max(3, f(0.07)) === 0 && (z - attic) % 4 < 2) mat = detail; // the shields
        else if (z === attic) mat = detail;
        else if (wide && main > -1.6 && z >= mainSpring) mat = detail; // the archivolt
        else if (wide && Math.abs(z - mainSpring) < 1) mat = detail; // the impost band
        else if (narrow && side > -1.6 && z >= sideSpring) mat = detail;
        m.set(x, y, z, mat);
      }
  return m;
};

/**
 * A wrought-iron lattice tower on four arched piers (the Eiffel Tower's
 * type), sized from its height H to the top of its mast. Four hollow piers of
 * X-braced lattice rise on the tower's curve: their outer edges stand
 * 0.186·e^(−z/0.30H) + 0.003 of H from the axis, so the piers splay at the
 * foot and draw together toward the top, where they merge into one shaft.
 * Between the piers, a great arch on each face under the first platform; the
 * first platform is a hollow square with a frieze and glazed pavilions; the
 * second has two decks; the top platform carries a small campanile and a
 * mast. Lengths over H: the platforms at 0.175, 0.35 and 0.84, the
 * campanile's top at 0.91.
 * roles: structure (the lattice), deck (platforms and girders), accent (the
 * frieze; deck if absent), window (the pavilions' glass; deck if absent).
 */
export const latticeArchTower: Generator = (ctx) => {
  const H = Math.max(40, Math.round(ctx.heightVox ?? 330));
  const outer = (z: number) => H * (0.186 * Math.exp(-z / (0.2965 * H)) + 0.003);
  const pier = (z: number) => H * (0.068 * Math.exp(-z / (0.22 * H)) + 0.01);
  const B = Math.ceil(outer(0) + H * 0.016) + 1; // the model's half-size: the first platform overhangs
  const size = 2 * B;
  const m = new VoxelModel(size, size, H + 2);
  const iron = m.material(ctx.ramp("structure"));
  const deck = m.material(ctx.ramp("deck"));
  const accent = role(ctx, m, "accent", "deck");
  const glass = role(ctx, m, "window", "deck");
  // the voxels of a square of half-width r about the axis (between voxels B - 1 and B)
  const lo = (r: number) => Math.max(0, Math.round(B - r));
  const hi = (r: number) => Math.min(size - 1, Math.round(B + r) - 1);
  const P = Math.max(4, Math.round(H * 0.012)); // a lattice panel
  const p1 = Math.round(H * 0.175);
  const p2 = Math.round(H * 0.35);
  const p3 = Math.round(H * 0.836);
  const brace = (s: number, z: number) => (((s + z) % P) + P) % P === 0 || (((s - z) % P) + P) % P === 0;

  // the piers: the lattice skin of each corner square between the inner and outer edges
  for (let z = 0; z < p3; z++) {
    const ro = outer(z);
    const ri = ro - pier(z);
    const o0 = lo(ro);
    const o1 = hi(ro);
    const girder = z % (2 * P) === 0 || z < 2;
    const boxes: [number, number][] = ri >= 1.5 ? [[o0, lo(ri) - 1], [hi(ri) + 1, o1]] : [[o0, o1]];
    for (const [xa, xb] of boxes)
      for (const [ya, yb] of boxes)
        for (let y = ya; y <= yb; y++)
          for (let x = xa; x <= xb; x++) {
            const onX = x === xa || x === xb;
            const onY = y === ya || y === yb;
            if (!onX && !onY) continue; // hollow
            if ((onX && onY) || girder || brace(onX ? y : x, z)) m.set(x, y, z, iron);
          }
  }
  // the great arches between the piers, one on each face, and their lattice spandrels
  const zs = Math.round(H * 0.03);
  const za = Math.round(H * 0.155);
  const gap = outer(zs) - pier(zs);
  for (let s = lo(gap); s <= hi(gap); s++) {
    const u = (s + 0.5 - B) / gap;
    const zArch = Math.round(zs + (za - zs) * Math.sqrt(Math.max(0, 1 - u * u)));
    const rib = Math.max(2, Math.round(H * 0.006));
    for (let z = zArch; z < p1; z++) {
      if (z >= zArch + rib && !brace(s, z)) continue;
      const a = lo(outer(z));
      const b = hi(outer(z));
      for (const [x, y] of [[s, a], [s, b], [a, s], [b, s]] as const) m.set(x, y, z, z < zArch + rib ? deck : iron);
    }
  }
  // the first platform: a hollow square, its girder faced with a frieze, glazed pavilions on it
  const t1 = Math.max(3, Math.round(H * 0.012));
  const r1o = outer(p1) + H * 0.014;
  const r1i = outer(p1) - pier(p1) - H * 0.006;
  for (let z = p1; z < p1 + t1; z++)
    for (let y = lo(r1o); y <= hi(r1o); y++)
      for (let x = lo(r1o); x <= hi(r1o); x++) {
        if (x >= lo(r1i) && x <= hi(r1i) && y >= lo(r1i) && y <= hi(r1i)) continue;
        const rim = x === lo(r1o) || x === hi(r1o) || y === lo(r1o) || y === hi(r1o);
        const frieze = rim && z > p1 && z < p1 + t1 - 1 && (x + y + z) % 3 === 0;
        m.set(x, y, z, frieze ? accent : deck);
      }
  const ph = Math.max(2, Math.round(H * 0.012));
  const band = (r1o - r1i) * 0.55;
  for (let z = p1 + t1; z < p1 + t1 + ph; z++)
    for (let y = lo(r1o - 1); y <= hi(r1o - 1); y++)
      for (let x = lo(r1o - 1); x <= hi(r1o - 1); x++) {
        const d = Math.min(x - lo(r1o - 1), hi(r1o - 1) - x, y - lo(r1o - 1), hi(r1o - 1) - y);
        const corner = Math.min(Math.abs(x + 0.5 - B), Math.abs(y + 0.5 - B)) > r1o * 0.62;
        if (d >= band || corner) continue;
        m.set(x, y, z, z === p1 + t1 + ph - 1 ? deck : d === 0 ? glass : deck);
      }
  // the second platform: a deck, and a smaller upper deck on posts
  const t2 = Math.max(2, Math.round(H * 0.008));
  const r2 = outer(p2) + H * 0.008;
  box(m, lo(r2), lo(r2), p2, hi(r2), hi(r2), p2 + t2 - 1, deck);
  const up = p2 + Math.max(3, Math.round(H * 0.025));
  const r2u = r2 * 0.7;
  for (let z = p2 + t2; z < up; z++)
    for (const x of [lo(r2u), hi(r2u)]) for (const y of [lo(r2u), hi(r2u)]) m.set(x, y, z, iron);
  box(m, lo(r2u), lo(r2u), up, hi(r2u), hi(r2u), up, deck);
  // the top: a platform, the campanile (glazed, then a lantern) and the mast
  const r3 = outer(p3) + H * 0.01;
  box(m, lo(r3), lo(r3), p3, hi(r3), hi(r3), p3 + 1, deck);
  const rc = Math.max(1.5, H * 0.011);
  const zc = Math.round(H * 0.875);
  for (let z = p3 + 2; z < zc; z++)
    for (let y = lo(rc); y <= hi(rc); y++)
      for (let x = lo(rc); x <= hi(rc); x++) {
        const skin = x === lo(rc) || x === hi(rc) || y === lo(rc) || y === hi(rc);
        m.set(x, y, z, skin && (x + y + z) % 2 === 0 && z < zc - 1 ? glass : deck);
      }
  const rl = Math.max(1, rc * 0.55);
  const zl = Math.round(H * 0.91);
  box(m, lo(rl), lo(rl), zc, hi(rl), hi(rl), zl, iron);
  for (let z = zl; z < H; z++) m.set(B - 1, B - 1, z, z > H - 3 ? accent : iron);
  return m;
};

/**
 * A Second Empire opera house (the Palais Garnier's type), its long axis along
 * +x with the main front at x = 0, sized from its height H to the stage
 * house's ridge. From the front back: the front block, an arcade of seven
 * arches under a loggia of paired columns, a frieze and an attic, between two
 * taller end pavilions crowned with gilt groups, under a copper hipped roof;
 * the foyer and staircase block with a copper cupola; the auditorium, a drum
 * under a low copper dome with gilt ribs and a crown, with a domed rotunda on
 * each side; the stage house, the tallest block, with a pediment gable at
 * each end under a copper roof; and the administration block behind. No
 * statues: the gilt groups are plain gilt blocks. Over H: 3.1 long, 2.2
 * wide; the front 0.55 tall, the dome's crown 0.8.
 * roles: wall, roof (flat roofs), dome (the copper roofs and domes),
 * window (openings and shadows), detail (bands, cornices; wall if absent),
 * column (the loggia's columns; detail if absent), gilt (detail if absent).
 */
export const operaHouse: Generator = (ctx) => {
  const H = Math.max(30, Math.round(ctx.heightVox ?? 90));
  const L = Math.round(H * 3.1);
  const D = Math.round(H * 2.2);
  const m = new VoxelModel(L, D, H + 2);
  const wall = m.material(ctx.ramp("wall"));
  const flat = m.material(ctx.ramp("roof"));
  const copper = m.material(ctx.ramp("dome"));
  const shade = m.material(ctx.ramp("window"));
  const detail = role(ctx, m, "detail", "wall");
  const column = m.material(ctx.ramps("column")[0] ?? ctx.ramps("detail")[0] ?? ctx.ramp("wall"));
  const gilt = m.material(ctx.ramps("gilt")[0] ?? ctx.ramps("detail")[0] ?? ctx.ramp("wall"));
  const c = D / 2;
  const h = (f: number) => Math.round(H * f);
  const ys = (half: number) => [Math.max(0, Math.round(c - half)), Math.min(D - 1, Math.round(c + half) - 1)] as const;
  // a block from x0 to x1 (exclusive), half-width `half`, walls to z1 under a flat roof
  const block = (x0: number, x1: number, half: number, z1: number, roof = flat) => {
    const [y0, y1] = ys(half);
    box(m, x0, y0, 0, x1 - 1, y1, z1 - 2, wall);
    box(m, x0, y0, z1 - 1, x1 - 1, y1, z1 - 1, roof);
  };
  // a hipped roof over a block's plan, rising one voxel for each `run` in
  const hipped = (x0: number, x1: number, half: number, z0: number, rise: number, run: number) => {
    const [y0, y1] = ys(half);
    for (let k = 0; k < rise; k++) {
      const i = Math.floor(k * run);
      if (x0 + i > x1 - 1 - i || y0 + i > y1 - i) break;
      box(m, x0 + i, y0 + i, z0 + k, x1 - 1 - i, y1 - i, z0 + k, copper);
    }
  };
  // a cylinder of radius r about (cx, cy), and a dome of height dh on it
  const drum = (cx: number, cy: number, r: number, z1: number, windows: boolean) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d > r || x < 0 || y < 0 || x >= L || y >= D) continue;
        for (let z = 0; z < z1; z++) m.set(x, y, z, windows && d > r - 1 && z > z1 * 0.55 && z < z1 - 2 && (x + y) % 4 === 0 ? shade : z === z1 - 1 ? detail : wall);
      }
  };
  const dome = (cx: number, cy: number, r: number, z0: number, dh: number, ribs: boolean) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d > r || x < 0 || y < 0 || x >= L || y >= D) continue;
        const top = z0 + Math.round(dh * Math.sqrt(Math.max(0, 1 - (d / r) ** 2)));
        const rib = ribs && Math.round((Math.atan2(y + 0.5 - cy, x + 0.5 - cx) / Math.PI) * 8 * (r / 6)) % Math.max(2, Math.round(r / 6)) === 0;
        for (let z = z0; z <= top; z++) m.set(x, y, z, rib && z === top ? gilt : copper);
      }
  };

  const xa = h(0.42);
  const xb = h(0.95);
  const xd = h(1.8);
  const xe = h(2.35);
  const front = 0.62 * H;
  // the back blocks first, the front last (it paints its own face)
  block(xe, L, 0.8 * H, h(0.5));
  block(xd, xe, 0.6 * H, h(0.8), wall);
  // the stage house's roof: a ridge along x, a pediment at each end
  const pitch = (0.2 * H) / (0.6 * H);
  for (let x = xd; x < xe; x++)
    for (let y = ys(0.6 * H)[0]; y <= ys(0.6 * H)[1]; y++) {
      const top = h(0.8) + Math.round((0.6 * H - Math.abs(y + 0.5 - c)) * pitch);
      const gable = x === xd || x === xe - 1;
      for (let z = h(0.8) - 1; z < Math.min(top, H); z++) m.set(x, y, z, gable ? (z === top - 1 ? detail : wall) : copper);
    }
  for (const x of [xd, xe - 1]) box(m, x, Math.floor(c) - 1, H - 1, x, Math.floor(c), H + 1, gilt); // the groups at the apexes
  block(xb, xd, 0.85 * H, h(0.48));
  const cx = h(1.36);
  drum(cx, c, 0.4 * H, h(0.56), true);
  dome(cx, c, 0.4 * H, h(0.56), h(0.17), true);
  box(m, cx - 1, Math.floor(c) - 1, h(0.73), cx, Math.floor(c), h(0.8), gilt); // the crown
  for (const s of [-1, 1]) {
    const cy = c + s * 0.9 * H;
    drum(cx, cy, 0.19 * H, h(0.42), true);
    dome(cx, cy, 0.19 * H, h(0.42), h(0.09), false);
    box(m, cx - 1, Math.round(cy) - 1, h(0.51), cx, Math.round(cy), h(0.55), gilt);
  }
  block(xa, xb, 0.78 * H, h(0.6));
  dome(h(0.68), c, 0.09 * H, h(0.6) - 1, h(0.08), false);
  // the front block and its end pavilions
  block(0, xa, front, h(0.55));
  hipped(0, xa, front * 0.78, h(0.55) - 1, h(0.09), 1.4);
  for (const s of [-1, 1]) {
    const y0 = Math.round(c + s * front * 0.8);
    const [ya, yb] = s < 0 ? [ys(front)[0], y0] : [y0, ys(front)[1]];
    box(m, 0, ya, 0, Math.round(xa * 0.7), yb, h(0.6) - 1, wall);
    box(m, 0, ya, h(0.6), Math.round(xa * 0.7), yb, h(0.6), copper);
    const gy = s < 0 ? ya + 1 : yb - 2;
    box(m, 1, gy, h(0.6) + 1, 2, gy + 1, h(0.68), gilt); // the gilt group
  }
  // the main front: an arcade of seven arches, a loggia of paired columns, a frieze, an attic
  const [fy0, fy1] = ys(front * 0.8);
  const bayW = (fy1 - fy0 + 1) / 7;
  const g = h(0.2);
  for (let y = fy0; y <= fy1; y++) {
    const u = (y - fy0 + 0.5) / bayW;
    const k = u - Math.floor(u) - 0.5; // -0.5 … 0.5 across a bay
    for (let z = 1; z < h(0.55); z++) {
      let mat = -1;
      if (z < g) {
        const r = bayW * 0.3;
        if (Math.abs(k * bayW) < r && z < g - 2 - r + Math.sqrt(Math.max(0, r * r - (k * bayW) ** 2))) mat = shade;
      } else if (z <= g + 1 || (z >= h(0.43) && z < h(0.47))) mat = z >= h(0.43) && (y + z) % 4 === 0 ? gilt : detail;
      else if (z < h(0.43)) {
        const edge = Math.abs(Math.abs(k) - 0.36);
        mat = edge < 0.08 ? column : Math.abs(k) < 0.22 ? shade : -1;
      } else if (z === h(0.55) - 2) mat = gilt;
      if (mat >= 0) m.set(0, y, z, mat);
    }
  }
  // windows down the long sides
  for (let x = 2; x < L - 2; x++)
    for (let y = 0; y < D; y++)
      for (let z = 3; z < H; z++) {
        if (!m.get(x, y, z) || m.get(x, y, z) !== wall) continue;
        const side = !m.get(x, y - 1, z) || !m.get(x, y + 1, z);
        if (side && x % 6 >= 3 && x % 6 <= 4 && z % h(0.1) >= 2 && z % h(0.1) <= Math.max(3, h(0.07))) m.set(x, y, z, shade);
      }
  return m;
};

/**
 * A footprint band's long axis: per column, position along (0..1) and across
 * (voxels from the axis), measured against the whole line when the landmark
 * is drawn in pieces (ctx.frame.line), so the pieces join up. As the landmark
 * kit's, copied so the pack stands alone.
 */
function bandAxis(mask: { sx: number; sy: number; on: Uint8Array }, frame?: GenContext["frame"]) {
  const cells: [number, number][] = [];
  for (let y = 0; y < mask.sy; y++) for (let x = 0; x < mask.sx; x++) if (mask.on[y * mask.sx + x]) cells.push([x, y]);
  if (frame?.line) {
    const { a, b, half } = frame.line;
    const v = frame.voxel;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / Math.max(len, 1e-9);
    const uy = (b[1] - a[1]) / Math.max(len, 1e-9);
    const t: number[] = [];
    const across: number[] = [];
    for (const [x, y] of cells) {
      const wx = frame.x0 + (x + 0.5) * v - a[0];
      const wy = frame.y0 + (y + 0.5) * v - a[1];
      t.push(Math.min(1, Math.max(0, (wx * ux + wy * uy) / Math.max(1e-9, len))));
      across.push((-wx * uy + wy * ux) / v);
    }
    return { cells, t, across, length: len / v, half: Math.max(0.5, half / v) };
  }
  const mx = cells.reduce((s, [x]) => s + x, 0) / Math.max(1, cells.length);
  const my = cells.reduce((s, [, y]) => s + y, 0) / Math.max(1, cells.length);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of cells) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const along = cells.map(([x, y]) => (x - mx) * Math.cos(ang) + (y - my) * Math.sin(ang));
  const across = cells.map(([x, y]) => -(x - mx) * Math.sin(ang) + (y - my) * Math.cos(ang));
  const a0 = Math.min(...along);
  const a1 = Math.max(...along);
  return { cells, t: along.map((a) => (a - a0) / Math.max(1e-6, a1 - a0)), across, length: a1 - a0, half: Math.max(0.5, ...across.map(Math.abs)) };
}

/**
 * A single-span steel arch bridge of the Belle Époque (the Pont Alexandre
 * III's type), along its footprint band (a line landmark), its deck H above
 * its foot: a very flat arch of many parallel steel ribs from stone abutment
 * to stone abutment, open spandrels of posts and rings on its outer faces, a
 * deck with stone sidewalks, a balustrade and lamp standards, and at each corner a tall
 * stone pylon crowned in gilt (no statues: plain gilt blocks).
 * params: abutment (each abutment's share of the length; 0.12), pylon (the
 * pylons' height above the deck over H; 2.1), ribs (the arch's ribs; 15).
 * roles: structure (the steel), deck, stone (abutments, balustrade, pylons;
 * structure if absent), gilt (the pylons' crowns; stone if absent), lamp (the
 * lamps; none if absent).
 */
export const steelArchBridge: Generator = (ctx) => {
  const { mask, param } = ctx;
  if (!mask) throw new Error("steel arch bridge needs a footprint");
  const H = Math.max(6, Math.round(ctx.heightVox ?? 14));
  const ph = Math.round(H * param("pylon", 2.1));
  const m = new VoxelModel(mask.sx, mask.sy, H + ph + Math.max(3, Math.round(H * 0.4)) + 2);
  const steel = m.material(ctx.ramp("structure"));
  const deck = m.material(ctx.ramp("deck"));
  const stone = role(ctx, m, "stone", "structure");
  const gilt = m.material(ctx.ramps("gilt")[0] ?? ctx.ramps("stone")[0] ?? ctx.ramp("structure"));
  const lamp = ctx.ramps("lamp").length ? m.material(ctx.ramps("lamp")[0]!) : 0;
  const { cells, t, across, length, half } = bandAxis(mask, ctx.frame);
  const ta = param("abutment", 0.12);
  const ribs = Math.max(3, Math.round(param("ribs", 15)));
  const ribEvery = Math.max(2, (2 * half) / ribs);
  const pw = Math.max(2, Math.round(H * 0.75)); // a pylon's side
  const crown = H - 2; // the arch's crown, just under the deck
  const spring = Math.max(1, Math.round(H * 0.2));
  cells.forEach(([x, y], i) => {
    const ti = t[i]!;
    const a = across[i]!;
    const edge = Math.abs(a) >= half - 1;
    const along = ti * length;
    const pylon = Math.abs(a) >= half - pw && (along < pw || along > length - pw);
    if (pylon) {
      for (let z = 0; z < H + ph; z++) m.set(x, y, z, z === H + ph - 2 ? gilt : stone);
      if (Math.abs(Math.abs(a) - (half - pw / 2)) < Math.max(1, pw * 0.3) && Math.abs(along - (along < pw ? pw / 2 : length - pw / 2)) < Math.max(1, pw * 0.3))
        for (let z = H + ph; z < H + ph + Math.max(3, Math.round(H * 0.4)); z++) m.set(x, y, z, gilt);
      return;
    }
    if (ti < ta || ti > 1 - ta) {
      // the abutments: stone to the deck
      for (let z = 0; z < H; z++) m.set(x, y, z, stone);
    } else {
      const u = (ti - ta) / (1 - 2 * ta);
      const zr = Math.round(spring + (crown - spring) * 4 * u * (1 - u));
      const rib = edge || Math.abs(a) % ribEvery < 1;
      if (rib) {
        m.set(x, y, zr, steel);
        m.set(x, y, zr - 1, steel);
      }
      // the spandrels on the outer faces: posts and rings between the arch and the deck
      if (edge) {
        const k = Math.round(along) % 6;
        for (let z = zr + 1; z < H; z++) if (k === 0 || ((z - zr) % 4 === 2 && (k === 2 || k === 4))) m.set(x, y, z, steel);
      }
    }
    m.set(x, y, H, Math.abs(a) >= half - Math.max(2, half * 0.12) ? stone : deck); // the sidewalks in stone
    if (edge) {
      if (Math.round(along) % 2 === 0) m.set(x, y, H + 1, stone); // the balusters
      if (lamp && Math.round(along) % Math.max(6, Math.round(H * 0.9)) === 0 && ti > ta && ti < 1 - ta) {
        for (let z = H + 1; z < H + 4; z++) m.set(x, y, z, steel);
        m.set(x, y, H + 4, lamp);
      }
    }
  });
  return m;
};

export const LANDMARK_GENERATORS: Record<string, Generator> = { cathedral, triumphalArch, latticeArchTower, operaHouse, steelArchBridge };
