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
 * Each tower's two legs stand at the band's edges and the cables run over
 * them, so the deck is a little narrower than the band.
 * params:
 * - spans: independent suspension bridges in a row, joined at central anchorages (1)
 * - side: side span fraction of each bridge (0.17)
 * - towerRatio: tower top over deck height (3)
 * - hangers: voxels between hangers (6)
 * - tower: 0 for portal towers (legs tapering in stages, portal struts with
 *   stepped corners, recessed vertical panels), 1 for braced towers (X-bracing
 *   between the legs)
 * - portals: struts (portal towers) or braced panels (braced towers) above the deck (4)
 * - leg, legDepth: a leg's width across the bridge and its depth along it at
 *   the base, over the band's half-width (0.3, 0.4)
 * - taper: the legs' setback at each strut, a fraction of their base size
 *   (0.12 portal towers, 0.05 braced)
 * - decks: 1, or 2 for a double deck inside its truss
 * - truss: the stiffening truss's depth over the deck height (0.08)
 * - pierTop: the piers' top over the deck height (0.15)
 * roles: structure (towers, cables), truss (truss, railings; structure if
 * absent), deck (road decks), pier (piers, anchorages).
 */
const suspensionBridge: Generator = ({ ramp, ramps, param, mask, heightVox, frame }) => {
  if (!mask) throw new Error("suspension bridge needs a footprint");
  const H = Math.max(6, Math.round(heightVox ?? 30));
  const spans = Math.max(1, Math.round(param("spans", 1)));
  const side = param("side", 0.17);
  const T = Math.round(H * param("towerRatio", 3));
  const hangers = Math.max(2, Math.round(param("hangers", 6))); // voxels between hangers
  const braced = param("tower", 0) >= 1;
  const portals = Math.max(1, Math.round(param("portals", 4)));
  const decks = param("decks", 1) >= 2 ? 2 : 1;
  const D = Math.max(2, Math.min(H - 2, Math.round(H * param("truss", 0.08)))); // truss depth
  const zPier = Math.max(1, Math.min(H - D - 1, Math.round(H * param("pierTop", 0.15))));
  const m = new VoxelModel(mask.sx, mask.sy, T + 3);
  const steel = m.material(ramp("structure"));
  const truss = m.material(ramps("truss")[0] ?? ramp("structure"));
  const deck = m.material(ramp("deck"));
  const pier = m.material(ramp("pier"));
  const b = bandAxis(mask, frame);
  if (!b.cells.length) return m;
  // across the band: legs at its edges, the cable plane through their middles at ±cp
  const legW = Math.max(1, b.half * param("leg", 0.3));
  const legD = Math.max(1, b.half * param("legDepth", 0.4));
  const cp = Math.max(0.5, b.half - legW / 2);
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
  const zb = H - D; // the truss's bottom chord (and a double deck's lower deck)
  // deck, truss, railings, cables, hangers
  const P = 2 * (D - 1); // a Warren truss panel
  b.cells.forEach(([x, y], i) => {
    const ac = Math.abs(b.across[i]!);
    if (ac > cp + 0.6) return; // beyond the cable planes: only towers and anchorages
    const al = b.along[i]!;
    const t = b.t[i]!;
    m.set(x, y, H, deck);
    if (ac < cp - 0.6) {
      if (decks === 2) m.set(x, y, zb, deck);
      return;
    }
    // the stiffening truss down the deck's edge: chords, verticals, diagonals
    const s = ((Math.round(al) % P) + P) % P;
    const zd = zb + (s < D ? s : P - s);
    for (let z = zb; z < H; z++) if (z === zb || z === H - 1 || z === zd || s % (D - 1) === 0) m.set(x, y, z, truss);
    m.set(x, y, H + 1, truss); // railing
    // the cable over it (steep runs filled so it stays continuous), hangers down to the deck
    const c = cableZ(t);
    const prev = cableZ(Math.max(0, t - 1 / Math.max(1, b.length)));
    for (let z = Math.min(c, prev); z <= Math.max(c, prev); z++) m.set(x, y, z, steel);
    if (Math.round(al) % hangers === 0) for (let z = H + 2; z < c; z++) m.set(x, y, z, steel);
  });

  // towers: struts above the deck, each the top of a stage where the legs step in
  const sh = Math.max(braced ? 1 : 2, Math.round((T - H) * (braced ? 0.025 : 0.05))); // strut height
  // braced towers carry their first strut just over the traffic, the rest evenly to the top
  const z1 = braced ? H + Math.max(4, Math.round((T - H) * 0.08)) + sh : H + Math.round((T - H) / portals);
  const tops: number[] = [];
  const strutH: number[] = [];
  for (let k = 1; k <= portals; k++) {
    tops.push(k === portals ? T - 1 : k === 1 ? z1 : Math.round(z1 + ((T - 1 - z1) * (k - 1)) / (portals - 1)));
    strutH.push(k === portals ? Math.round(sh * 1.5) : sh);
  }
  const taper = param("taper", braced ? 0.05 : 0.12); // the legs' setback per stage
  const nearStrut = (z: number) => tops.some((top, k) => z >= top - strutH[k]! - 1 && z <= top + 1);
  /** X-bracing between the legs from lo up to hi: true where a diagonal crosses (ac, z). */
  const brace = (ac: number, z: number, inner: number, lo: number, hi: number) => {
    if (z < lo || z >= hi || hi - lo < 3) return false;
    const x = inner * Math.abs(1 - (2 * (z - lo)) / (hi - lo - 1));
    return Math.abs(ac - x) <= Math.max(0.6, inner / (hi - lo) + 0.35);
  };
  /** A tower's voxel at da along from its centre, ac across from the axis, height z. */
  const towerVoxel = (da: number, ac: number, z: number): number => {
    const ada = Math.abs(da);
    if (z < zPier) {
      // a pier with chamfered corners, the width of the band
      const pa = legD + 1.5;
      const c = Math.min(2.5, pa / 2);
      return ada <= pa && ada - (pa - c) + (ac - (b.half - c)) <= c ? pier : 0;
    }
    let stage = 0;
    while (stage < portals - 1 && z >= tops[stage]!) stage++;
    const f = 1 - stage * taper;
    const w = Math.max(0.5, (legW * f) / 2); // a leg's half-width across
    const d = Math.max(0.5, legD * f); // and half-depth along
    const off = Math.abs(ac - cp);
    if (off <= w && ada <= d) {
      if (z >= T) return off <= w - 1 && ada <= d - 1 ? steel : 0; // a cap a step in
      if (!braced && w >= 1.5 && d >= 1.5 && z > zPier + 1 && (z < zb - 2 || z > H + 2) && !nearStrut(z)) {
        // recessed vertical panels: grooves down the legs' faces
        if (ada > d - 1 && off < w - 1 && Math.abs(Math.round(ac - cp)) % 2 === 1) return 0;
        if (off > w - 1 && ada < d - 1 && Math.abs(Math.round(da)) % 2 === 1) return 0;
      }
      return steel;
    }
    const inner = cp - w; // the opening between the legs, half its width
    if (ac > inner + 0.5 || ada > Math.max(0.5, d - 1)) return 0; // struts and braces sit back from the legs' faces
    for (let k = 0; k < portals; k++) {
      let h = strutH[k]!;
      if (!braced) {
        // the opening's top corners step down to the legs
        const step = Math.max(1, inner * 0.14);
        const u = Math.max(1, Math.round(h * 0.6));
        const din = inner - ac;
        h += din < step ? 3 * u : din < 2 * step ? 2 * u : din < 3 * step ? u : 0;
      }
      if (z < tops[k]! && z >= tops[k]! - h) return steel;
    }
    // under the deck: a strut below the truss, X-bracing down to the pier
    if (z >= zb - sh && z < zb) return steel;
    if (brace(ac, z, inner, zPier, zb - sh)) return steel;
    if (braced) for (let k = 1; k < portals; k++) if (brace(ac, z, inner, tops[k - 1]!, tops[k]! - strutH[k]!)) return steel;
    return 0;
  };
  const towerAl = towers.map((tt) => tt * b.length);
  const reach = legD + 2;
  b.cells.forEach(([x, y], i) => {
    const al = b.along[i]!;
    const ac = Math.abs(b.across[i]!);
    for (const A of towerAl) {
      if (Math.abs(al - A) > reach) continue;
      for (let z = 0; z <= T; z++) {
        const v = towerVoxel(al - A, ac, z);
        if (v) m.set(x, y, z, v);
      }
    }
    // anchorages where the cables come down: a central one a block through the deck; at
    // the ends a block under the deck and a housing over each cable beside the road
    const k = anchors.findIndex((ta) => Math.abs(b.t[i]! - ta) <= 2 * towerHalf + 0.012);
    if (k < 0) return;
    const top = k >= 2 ? H + 2 : Math.abs(ac - cp) <= Math.max(1, legW / 2) ? H + 3 : zb - 1;
    for (let z = 0; z <= top; z++) m.set(x, y, z, pier);
  });
  return m;
};

const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * A slender four-sided pyramid tower: windowed faces tapering straight up
 * into a clad spire, two vertical wings (lift and stair shafts) on the east
 * and west faces that stand clear of them as the faces slope in, and an open
 * arcade at its foot.
 * params: base (the base's width over the height; 0.2), spire (the clad
 * spire's share of the height; 0.2), wing (where the wings come clear of the
 * faces, over the height; 0.45).
 */
const pyramidTower: Generator = ({ ramp, param, heightVox }) => {
  const H = Math.max(20, Math.round(heightVox ?? 120));
  const B = Math.max(4, Math.round(H * param("base", 0.2)));
  const body = Math.round(H * (1 - param("spire", 0.2))); // windowed floors below, the clad spire above
  const size = B + 3;
  const m = new VoxelModel(size, size, H + 1);
  const wall = m.material(ramp("structure"));
  const glass = m.material(ramp("window"));
  const c = (size - 1) / 2;
  const R = (z: number) => (B / 2) * (1 - z / H); // the faces' half-width: straight to the tip
  const wingOut = R(H * param("wing", 0.45)) + 0.5; // the wings' outer faces are vertical
  const wingHalf = Math.max(1, B * 0.08);
  const wingTop = Math.round(body * 0.97);
  const arcade = Math.max(2, Math.round(H * 0.03));
  for (let z = 0; z < H; z++) {
    const r = R(z) + 0.5;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const dx = Math.abs(x - c);
        const dy = Math.abs(y - c);
        const dm = Math.max(dx, dy);
        if (dm > r) {
          // a wing beyond the face: solid, a slit of windows down its middle, its top stepped
          if (dx > dy && dx <= wingOut && dy <= wingHalf && z < wingTop - Math.max(0, Math.round(dx - wingOut + 2)))
            m.set(x, y, z, dx > wingOut - 1 && dy < 0.6 && z % 3 !== 0 ? glass : wall);
          continue;
        }
        const skin = dm > r - 1;
        if (!skin || z >= body) {
          m.set(x, y, z, z < arcade ? glass : wall); // the core (a glazed lobby at the foot), the clad spire
          continue;
        }
        const along = dx > dy ? y : x;
        // an open arcade of piers at the foot
        if (z < arcade - 1 && mod(Math.round(along), 3) !== 0) continue;
        // windows in vertical strips on the skin, solid edges
        const win = z >= arcade && z % 3 !== 0 && mod(Math.round(along), 2) === 0 && Math.abs(dx - dy) > 1;
        m.set(x, y, z, win ? glass : wall);
      }
  }
  return m;
};

/**
 * A tapering office tower with rounded corners and an open crown: a glass
 * shaft banded with pale floor lines and fins, narrowing faster toward the
 * top as its corners round off, its top an open lattice around a shorter core.
 * params: base (the base's width over the height; 0.12), top (the top's width
 * over the base's; 0.75), corner (corner radius over the half-width at the
 * base; 0.3), crown (the crown's share of the height; 0.1), turn (1 turns the
 * plan 45°, for a diagonal street grid; 0).
 * roles: structure (fins, floor lines, lattice), window (glass).
 */
const obeliskTower: Generator = ({ ramp, param, heightVox }) => {
  const H = Math.max(24, Math.round(heightVox ?? 150));
  const r0 = Math.max(3, (H * param("base", 0.12)) / 2);
  const r1 = r0 * param("top", 0.75);
  const c0 = param("corner", 0.3);
  const crown = Math.max(3, Math.round(H * param("crown", 0.1)));
  const turn = param("turn", 0) >= 1;
  // turned 45°, the plan reaches its rounded corners along the axes
  const reach = Math.ceil(turn ? (r0 - r0 * c0) * Math.SQRT2 + r0 * c0 : r0) + 1;
  const size = 2 * reach + 1;
  const m = new VoxelModel(size, size, H + 1);
  const white = m.material(ramp("structure"));
  const glass = m.material(ramp("window"));
  const core = H - Math.round(crown * 0.6); // the core stops short of the crown's top
  for (let z = 0; z < H; z++) {
    const f = z / H;
    const r = r0 - (r0 - r1) * f ** 1.8; // narrowing faster toward the top
    const rc = r * (c0 + (0.8 - c0) * f ** 2); // the corners round off as it rises
    const inCrown = z >= H - crown;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let u = x - reach;
        let v = y - reach;
        if (turn) [u, v] = [(u + v) / Math.SQRT2, (u - v) / Math.SQRT2];
        const au = Math.abs(u);
        const av = Math.abs(v);
        // signed distance to the rounded square's edge (negative inside)
        const qx = au - (r - rc);
        const qy = av - (r - rc);
        const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rc;
        if (sd > 0.35) continue;
        const skin = sd > -0.9;
        // a fin's position along the face, in voxel steps (also even along a turned plan's diagonal faces)
        const along = Math.abs(x - reach) > Math.abs(y - reach) ? y : x;
        if (inCrown) {
          if (skin) {
            const open = z < H - 1 && mod(along, 2) === 1 && z % 3 !== 0;
            if (!open) m.set(x, y, z, white);
          } else if (sd < -2.2 && z < core) m.set(x, y, z, glass);
          continue;
        }
        m.set(x, y, z, skin && z % 4 !== 0 && mod(along, 2) !== 0 ? glass : white); // pale fins and floor lines
      }
  }
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
 * landmark): an arcaded hall under a roof with a skylight down its ridge; the
 * tower a square shaft with a clock on each face under a cornice, then an open
 * arched belvedere, a smaller lantern, a pointed cap and a flagpole.
 * params: hall (hall height over the tower's).
 * roles: wall, roof, window, accent (clock faces), cap (roof if absent).
 */
const towerHall: Generator = ({ ramp, ramps, param, mask, heightVox, frame }) => {
  if (!mask) throw new Error("tower hall needs a footprint");
  const H = Math.max(12, Math.round(heightVox ?? 40));
  const hallH = Math.max(3, Math.round(H * param("hall", 0.25)));
  const m = new VoxelModel(mask.sx, mask.sy, H + 1);
  const wall = m.material(ramp("wall"));
  const roof = m.material(ramp("roof"));
  const glass = m.material(ramp("window"));
  const clock = m.material(ramp("accent"));
  const cap = m.material(ramps("cap")[0] ?? ramp("roof"));
  const b = bandAxis(mask, frame);
  const tw = Math.max(2, Math.round(H * 0.08)); // the shaft's half-width
  // the tower's stages, bottom to top
  const shaftTop = Math.round(H * 0.66);
  const clockZ = shaftTop - Math.max(2, Math.round(tw * 0.9)); // the clocks' centre
  const clockR = Math.max(1.2, tw * 0.6);
  const belvTop = Math.round(H * 0.8);
  const lantTop = Math.round(H * 0.87);
  const capTop = H - Math.max(2, Math.round(H * 0.04));
  /** The tower's voxel at a along and c across its centre, height z. */
  const tower = (a: number, c: number, z: number): number => {
    const d = Math.max(Math.abs(a), Math.abs(c)); // square rings out from the centre
    const u = Math.abs(a) > Math.abs(c) ? c : a; // position along a face
    if (z < shaftTop) {
      if (d > tw) return 0;
      if (d > tw - 1 && Math.hypot(u, (z - clockZ) * 0.9) <= clockR + 0.6)
        return Math.hypot(u, (z - clockZ) * 0.9) <= clockR - 0.4 ? clock : glass; // a clock face with a dark rim
      return d > tw - 1 && Math.abs(u) < 0.6 && z % 4 === 1 && z < clockZ - clockR - 2 ? glass : wall; // slit windows
    }
    if (z < shaftTop + 2) return d <= tw + (z === shaftTop + 1 ? 1 : 0) ? wall : 0; // the cornice
    const arch = (r: number, lo: number, hi: number) => d > r - 1 && Math.abs(u) < r - 1.4 && z >= lo && z < hi - (Math.abs(u) > r - 2.4 ? 1 : 0);
    if (z < belvTop) {
      const r = tw - 1;
      if (d > r) return 0;
      if (arch(r, shaftTop + 3, belvTop - 2)) return 0; // open arches
      return d > r - 2 || z >= belvTop - 2 ? wall : 0; // hollow behind the arches
    }
    if (z < lantTop) {
      const r = Math.max(1.5, tw - 2.5);
      if (d > r) return 0;
      if (z === belvTop && d > r - 1) return wall;
      return arch(r, belvTop + 1, lantTop - 1) ? 0 : wall;
    }
    if (z < capTop) {
      const r = Math.max(0.5, (tw - 1.5) * (1 - (z - lantTop) / Math.max(1, capTop - lantTop)));
      return d <= r ? cap : 0;
    }
    return d < 0.6 ? cap : 0; // the flagpole
  };
  b.cells.forEach(([x, y], i) => {
    const al = b.along[i]!;
    const ac = b.across[i]!;
    const outer = Math.abs(ac) >= b.half - 0.75;
    // two storeys of arched windows, the ground floor an arcade
    for (let z = 0; z < hallH; z++) {
      const bay = mod(Math.round(al), 3);
      m.set(x, y, z, outer && z % 4 !== 0 && bay !== 0 && !(z % 4 === 3 && bay === 2) ? glass : wall);
    }
    m.set(x, y, hallH, Math.abs(ac) < Math.max(1, b.half * 0.15) ? glass : roof); // a skylight down the ridge
    const a = al - b.length / 2;
    if (Math.abs(a) <= tw + 1 && Math.abs(ac) <= tw + 1)
      for (let z = hallH; z <= H; z++) {
        const v = tower(a, ac, z);
        if (v) m.set(x, y, z, v);
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

/**
 * An open domed rotunda with a curved colonnade sweeping behind it, as by a
 * lagoon: eight column clusters under a ring entablature and a dome, and a
 * colonnade on an arc that passes just behind the rotunda and opens to the
 * east (+x, toward the water), with planter boxes along its top and a pylon
 * at each end.
 * params (lengths over the height): radius (the rotunda's; 0.35), dome (the
 * dome's radius; 0.23), arc (the colonnade's radius; 1.6), arcCentre (the
 * arc's centre east of the rotunda; 1.16), arcHeight (the colonnade's
 * height; 0.4), open (the arc's ends, degrees from east; 115).
 * roles: stone, dome, detail (entablatures and planters).
 */
const rotunda: Generator = ({ ramp, param, heightVox }) => {
  const H = Math.max(16, Math.round(heightVox ?? 48));
  const Ro = Math.max(4, H * param("radius", 0.35));
  const Rd = Math.max(3, H * param("dome", 0.23));
  const Ra = H * param("arc", 1.6);
  const Ca = H * param("arcCentre", 1.16);
  const Ha = Math.max(4, Math.round(H * param("arcHeight", 0.4)));
  const open = (param("open", 115) * Math.PI) / 180;
  const hx = Math.ceil(Math.max(Ro, Ra - Ca, Ca + Ra * Math.cos(open))) + 4;
  const hy = Math.ceil(Math.max(Ro, Ra * Math.sin(open))) + 4;
  const m = new VoxelModel(2 * hx + 1, 2 * hy + 1, H + 1);
  const stone = m.material(ramp("stone"));
  const dome = m.material(ramp("dome"));
  const detail = m.material(ramp("detail"));
  const zE = Math.round(H * 0.68); // the rotunda's entablature
  const zD = zE + Math.max(2, Math.round(H * 0.07)); // where the dome springs
  const clusters = [...Array(8).keys()].map((k) => ((k + 0.5) * Math.PI) / 4);
  const zC = Ha - 2; // the colonnade's columns, then its entablature
  for (let j = 0; j < m.sy; j++)
    for (let i = 0; i < m.sx; i++) {
      const x = i - hx;
      const y = j - hy;
      const r = Math.hypot(x, y);
      const oct = Math.max(Math.abs(x), Math.abs(y), (Math.abs(x) + Math.abs(y)) / Math.SQRT2);
      // the rotunda: a stepped base, column clusters, a ring entablature, the dome and a finial
      if (oct <= Ro + 1) m.set(i, j, 0, detail);
      if (clusters.some((a) => Math.max(Math.abs(x - (Ro - 3) * Math.cos(a)), Math.abs(y - (Ro - 3) * Math.sin(a))) <= 2))
        for (let z = 1; z < zE; z++) m.set(i, j, z, stone);
      if (oct <= Ro && oct >= Ro - 5) for (let z = zE; z < zD; z++) m.set(i, j, z, z === zD - 1 ? detail : stone);
      if (r <= Rd + 0.4) {
        const top = zD + Math.round((H - 2 - zD) * Math.sqrt(Math.max(0, 1 - (r / (Rd + 0.4)) ** 2)));
        for (let z = zE; z <= top; z++) m.set(i, j, z, z < zD ? stone : dome);
      }
      if (r < 0.8) for (let z = H - 2; z <= H; z++) m.set(i, j, z, detail);
      // the colonnade: two rows of columns on the arc, an entablature, planters, end pylons
      const ax = x - Ca;
      const ra = Math.hypot(ax, y);
      const th = Math.abs(Math.atan2(y, ax));
      if (th < open || Math.abs(ra - Ra) > 2.6) continue;
      const s = Ra * (Math.PI - th); // arc length from the apex
      const end = th - open < 4 / Ra;
      if (end) {
        for (let z = 0; z < Ha + 3; z++) m.set(i, j, z, z >= Ha ? detail : stone);
        continue;
      }
      const column = Math.abs(Math.abs(ra - Ra) - 1.5) < 0.6 && mod(Math.round(s), 3) === 0;
      for (let z = 0; z < Ha; z++) if (z >= zC || column || z === 0) m.set(i, j, z, z >= zC ? detail : stone);
      if (mod(Math.round(s), 14) < 3 && Math.abs(ra - Ra) < 1.6) for (let z = Ha; z < Ha + 2; z++) m.set(i, j, z, stone);
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
  obeliskTower,
  column,
  towerHall,
  domedHall,
  rotunda,
  tripodMast,
};

export type { GenContext };
