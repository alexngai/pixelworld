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
 * - sideBrace: 1 to brace braced towers' legs along the bridge too, so they read
 *   as X-braced side-on, where the bracing between the legs is seen edge-on (0)
 * - sideDepth: a side-braced leg's least half-depth along the bridge, in voxels,
 *   so its panels stay legible at small scales (3)
 * - decks: 1, or 2 for a double deck inside its truss
 * - truss: the stiffening truss's depth over the deck height (0.08)
 * - pierTop: the piers' top over the deck height (0.15)
 * - sag: the main cables' low point above the deck, over the towers' height
 *   above it (0: they come down to the railings at mid-span)
 * - anchorTop: where the cables land on a central anchorage, the same way (0)
 * The side spans' cables hang with the main span's curvature (as under the same
 * load and pull), eased so they still meet their anchorages at a slope.
 * roles: structure (towers, cables), truss (truss, railings; structure if
 * absent), deck (road decks), pier (piers, anchorages), plate (optional: fills
 * side-braced panels behind their diagonals, so the far leg's bracing doesn't
 * show through and blur the near one's).
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
  const plateRamp = ramps("plate")[0];
  const plate = plateRamp !== undefined ? m.material(plateRamp) : 0;
  const whole = bandAxis(mask, frame);
  if (!whole.cells.length) return m;
  // the approaches (D-131): beyond each anchorage the line runs on over land, where the
  // deck comes down to the ground it lands on (the frame's rise at the line's ends)
  const line = frame?.line;
  const lineLen = line ? Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1]) : 0;
  const [apA, apB] = line?.approach && lineLen > 0 ? line.approach : [0, 0];
  const f0 = Math.min(0.45, Math.max(0, apA) / Math.max(lineLen, 1e-9));
  const f1 = Math.min(0.45, Math.max(0, apB) / Math.max(lineLen, 1e-9));
  const span = 1 - f0 - f1;
  // the suspension bridge, anchorage to anchorage: t 0..1 between them (outside on the approaches)
  const b = {
    ...whole,
    t: whole.t.map((t) => (t - f0) / span),
    along: whole.along.map((al) => al - f0 * whole.length),
    length: whole.length * span,
  };
  // across the band: legs at its edges, the cable plane through their middles at ±cp
  const legW = Math.max(1, b.half * param("leg", 0.3));
  const legD = Math.max(1, b.half * param("legDepth", 0.4));
  const cp = Math.max(0.5, b.half - legW / 2);
  const [riseA, riseB] = line?.rise ?? [0, 0];
  const landA = Math.max(0, Math.min(H, Math.round(riseA)));
  const landB = Math.max(0, Math.min(H, Math.round(riseB)));
  /** An approach's column: its deck sloping from the ground at the line's end up to the
   * anchorage, railings and a girder along its edges, piers under it. */
  const approach = (x: number, y: number, i: number, ac: number) => {
    if (ac > cp + 0.6) return;
    const t = whole.t[i]!;
    const h = t < f0 ? Math.round(landA + ((H - landA) * t) / f0) : Math.round(landB + ((H - landB) * (1 - t)) / f1);
    m.set(x, y, h, deck);
    if (ac >= cp - 0.6) {
      m.set(x, y, h + 1, truss); // railing
      for (let z = Math.max(0, h - 2); z < h; z++) m.set(x, y, z, truss); // girder
    } else if (((Math.round(whole.along[i]!) % 16) + 16) % 16 < 2) {
      for (let z = 0; z < h - 2; z++) m.set(x, y, z, pier);
    }
  };
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
  // the cables: a parabola between each bridge's towers; down each side span a parabola
  // of the same curvature, at most 3/4 of the one that would meet its anchorage level
  const top = T - 1;
  const low = Math.min(top - 2, H + 2 + Math.round((T - H) * param("sag", 0)));
  const zCentral = Math.min(top - 2, H + 2 + Math.round((T - H) * param("anchorTop", 0)));
  const cableZ = (t: number): number => {
    const k = Math.min(spans - 1, Math.floor(t * spans));
    const s0 = k / spans;
    const s1 = (k + 1) / spans;
    const ta = s0 + side * (s1 - s0);
    const tb = s1 - side * (s1 - s0);
    if (t >= ta && t <= tb) {
      const u = (2 * (t - ta)) / (tb - ta) - 1;
      return Math.round(low + (top - low) * u * u);
    }
    // s along the side span from its anchorage (voxels), Ls its length
    const Ls = (ta - s0) * b.length;
    const s = Math.max(0, t < ta ? t - s0 : s1 - t) * b.length;
    const central = t < ta ? k > 0 : k + 1 < spans; // or at an end of the whole line
    const za = central ? zCentral : H + 1;
    const Lm = ((tb - ta) / 2) * b.length;
    const curve = Math.min((top - low) / Math.max(1, Lm * Lm), (0.75 * (top - za)) / Math.max(1, Ls * Ls));
    return Math.round(za + ((top - za) * s) / Math.max(1, Ls) - curve * s * (Ls - s));
  };
  const zb = H - D; // the truss's bottom chord (and a double deck's lower deck)
  // deck, truss, railings, cables, hangers
  const P = 2 * (D - 1); // a Warren truss panel
  b.cells.forEach(([x, y], i) => {
    const ac = Math.abs(b.across[i]!);
    const t = b.t[i]!;
    if (t < 0 || t > 1) return approach(x, y, i, ac);
    if (ac > cp + 0.6) return; // beyond the cable planes: only towers and anchorages
    const al = b.along[i]!;
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
  // braced towers seen from the side (sideBrace): each leg a braced frame along the
  // bridge, at least sideDepth voxels either side of its middle, so the X-bracing reads
  // side-on too; the bracing between the legs then sits in the legs' front plane,
  // hidden side-on behind their posts
  const sideBrace = braced && param("sideBrace", 0) >= 1;
  const legDs = sideBrace ? Math.max(legD, param("sideDepth", 3)) : legD;
  // the side panels: under the deck from the pier, split so none is much taller than wide;
  // over it between the struts
  const sidePanels: [number, number][] = [];
  if (sideBrace) {
    const lo = zPier + 1;
    const hi = zb - sh;
    const n = Math.max(1, Math.round((hi - lo) / Math.max(4, 3 * legDs)));
    for (let k = 0; k < n; k++) sidePanels.push([Math.round(lo + ((hi - lo) * k) / n) + (k ? 1 : 0), Math.round(lo + ((hi - lo) * (k + 1)) / n)]);
    for (let k = 1; k < portals; k++) sidePanels.push([tops[k - 1]!, tops[k]! - strutH[k]!]);
  }
  /** A braced leg's side face at da along its middle (half-depth ds), height z. */
  const sideFace = (ada: number, z: number, ds: number): boolean => {
    const pw = Math.max(1, ds * 0.2); // the posts at its front and back
    if (ada > ds - pw) return true;
    const p = sidePanels.find(([lo, hi]) => z >= lo && z < hi);
    if (!p) return true; // struts, the deck's band
    const [lo, hi] = p;
    if (hi - lo < 3) return true;
    const x = (ds - pw) * Math.abs(1 - (2 * (z - lo)) / (hi - lo - 1));
    return Math.abs(ada - x) <= Math.max(0.6, (ds - pw) / (hi - lo) + 0.35);
  };
  /** A tower's voxel at da along from its centre, ac across from the axis, height z. */
  const towerVoxel = (da: number, ac: number, z: number): number => {
    const ada = Math.abs(da);
    if (z < zPier) {
      // a pier with chamfered corners, the width of the band
      const pa = legDs + 1.5;
      const c = Math.min(2.5, pa / 2);
      return ada <= pa && ada - (pa - c) + (ac - (b.half - c)) <= c ? pier : 0;
    }
    let stage = 0;
    while (stage < portals - 1 && z >= tops[stage]!) stage++;
    const f = 1 - stage * taper;
    const w = Math.max(0.5, (legW * f) / 2); // a leg's half-width across
    const d = Math.max(0.5, legD * f); // and half-depth along
    const ds = sideBrace ? Math.max(d, legDs * f) : d;
    const off = Math.abs(ac - cp);
    if (off <= w && ada <= ds) {
      if (z >= T) return off <= w - 1 && ada <= ds - 1 ? steel : 0; // a cap a step in
      if (sideBrace) return sideFace(ada, z, ds) ? steel : plate;
      if (!braced && w >= 1.5 && d >= 1.5 && z > zPier + 1 && (z < zb - 2 || z > H + 2) && !nearStrut(z)) {
        // recessed vertical panels: grooves down the legs' faces
        if (ada > d - 1 && off < w - 1 && Math.abs(Math.round(ac - cp)) % 2 === 1) return 0;
        if (off > w - 1 && ada < d - 1 && Math.abs(Math.round(da)) % 2 === 1) return 0;
      }
      return steel;
    }
    const inner = cp - w; // the opening between the legs, half its width
    if (ac > inner + 0.5) return 0;
    // struts and braces sit back from the legs' faces, or in their front plane
    if (sideBrace ? da < ds - Math.max(1, ds * 0.2) || da > ds : ada > Math.max(0.5, d - 1)) return 0;
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
  const reach = legDs + 2;
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
    // anchorages where the cables come down: at the ends a block under the deck and a
    // housing over each cable beside the road; a central one a block up to the deck,
    // its housings rising to where the cables land
    const k = anchors.findIndex((ta) => Math.abs(b.t[i]! - ta) <= 2 * towerHalf + 0.012);
    if (k < 0) return;
    const housing = Math.abs(ac - cp) <= Math.max(1, legW / 2);
    const top = k >= 2 ? (housing ? zCentral + 1 : ac >= cp - 0.6 ? H + 2 : H - 1) : housing ? H + 3 : zb - 1;
    for (let z = 0; z <= top; z++) m.set(x, y, z, pier);
  });
  return m;
};

const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * A tower's window panes: its `window` glass, or, where the asset names `lit`
 * (lit.* variants: one per tower, by seed), lit by night at `litFraction`
 * (0.35) of the windows, as a building's are (D-135). Without `lit` it draws
 * nothing random, so a pack's towers stay as they were.
 */
function towerPanes(ctx: Pick<GenContext, "rand" | "ramps" | "param">, m: VoxelModel, glass: number): () => number {
  const lits = ctx.ramps("lit");
  if (!lits.length) return () => glass;
  const lit = m.material(lits[Math.floor(ctx.rand() * lits.length)]!);
  const share = ctx.param("litFraction", 0.35);
  return () => (ctx.rand() < share ? lit : glass);
}

/**
 * A slender four-sided pyramid tower: windowed faces tapering straight up
 * into a clad spire, two vertical wings (lift and stair shafts) on the east
 * and west faces that stand clear of them as the faces slope in, and an open
 * arcade at its foot.
 * params: base (the base's width over the height; 0.2), spire (the clad
 * spire's share of the height; 0.2), wing (where the wings come clear of the
 * faces, over the height; 0.45), litFraction (with `lit`; 0.35).
 * roles: structure, window, lit (optional: lit.* variants, windows lit by night).
 */
const pyramidTower: Generator = (ctx) => {
  const { ramp, param, heightVox } = ctx;
  const H = Math.max(20, Math.round(heightVox ?? 120));
  const B = Math.max(4, Math.round(H * param("base", 0.2)));
  const body = Math.round(H * (1 - param("spire", 0.2))); // windowed floors below, the clad spire above
  const size = B + 3;
  const m = new VoxelModel(size, size, H + 1);
  const wall = m.material(ramp("structure"));
  const glass = m.material(ramp("window"));
  const pane = towerPanes(ctx, m, glass);
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
            m.set(x, y, z, dx > wingOut - 1 && dy < 0.6 && z % 3 !== 0 ? pane() : wall);
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
        m.set(x, y, z, win ? pane() : wall);
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
 * plan 45°, for a diagonal street grid; 0), litFraction (with `lit`; 0.35).
 * roles: structure (fins, floor lines, lattice), window (glass), lit
 * (optional: lit.* variants, windows lit by night).
 */
const obeliskTower: Generator = (ctx) => {
  const { ramp, param, heightVox } = ctx;
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
  const pane = towerPanes(ctx, m, glass);
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
        m.set(x, y, z, skin && z % 4 !== 0 && mod(along, 2) !== 0 ? pane() : white); // pale fins and floor lines
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

/** Distance from the axis in an octagonal plan (a smock mill's or a lighthouse's). */
const octagon = (dx: number, dy: number) => Math.max(Math.abs(dx), Math.abs(dy), (Math.abs(dx) + Math.abs(dy)) / Math.SQRT2);

/**
 * A smock windmill: an octagonal tower tapering to a rounded cap, an optional
 * stage (a gallery) around it, and four lattice sails in an X on the side the
 * wind comes from, held on spars from a hub at the cap.
 * params (lengths over the height, to the cap's top): scale (drawn this much
 * taller than its height, to read over oversized trees; 1), base (the tower's
 * radius at its foot; 0.17), top (its radius under the cap; 0.09), sail (a
 * sail's length from the hub; 0.5), gallery (the stage's height; 0 for none),
 * face (where the sails are: 0 west (−x), 1 north (−y), 2 east, 3 south).
 * Short sails are drawn solid: a lattice that small reads as noise.
 * roles: wall (the tower), cap, sail (the lattice), stock (spars and hub;
 * sail if absent), detail (the stage, the door, bands).
 */
const windmill: Generator = ({ ramp, ramps, param, heightVox }) => {
  const H = Math.max(12, Math.round((heightVox ?? 24) * param("scale", 1)));
  const R0 = Math.max(2, H * param("base", 0.17));
  const R1 = Math.max(1.2, H * param("top", 0.09));
  const L = Math.max(4, Math.round(H * param("sail", 0.5)));
  const capZ = Math.round(H * 0.8);
  const hubZ = capZ + Math.max(1, Math.round((H - capZ) * 0.35));
  const r = (z: number) => R0 + ((R1 - R0) * z) / capZ;
  // the sails' plane stands clear of the tower wherever they pass it
  const lowest = Math.max(0, Math.floor(hubZ - L * Math.SQRT1_2));
  const plane = Math.ceil(Math.max(r(lowest), R1) + 1.5);
  const half = Math.ceil(Math.max(R0 + 3, L * Math.SQRT1_2 + 1, plane + 1));
  const size = 2 * half + 1;
  const m = new VoxelModel(size, size, Math.ceil(hubZ + L * Math.SQRT1_2) + 2);
  const wall = m.material(ramp("wall"));
  const cap = m.material(ramp("cap"));
  const sail = m.material(ramp("sail"));
  const stock = m.material(ramps("stock")[0] ?? ramp("sail"));
  const detail = m.material(ramp("detail"));
  const face = mod(Math.round(param("face", 0)), 4);
  // local (u toward the sails, w across them) to model coordinates
  const put = (u: number, w: number, z: number, mat: number) => {
    const [x, y] = face === 0 ? [half - u, half + w] : face === 1 ? [half + w, half - u] : face === 2 ? [half + u, half - w] : [half - w, half + u];
    m.set(Math.round(x), Math.round(y), z, mat);
  };
  const gz = param("gallery", 0) > 0 ? Math.round(H * param("gallery", 0)) : -1;
  for (let z = 0; z < capZ; z++) {
    const rz = r(z);
    for (let v = -half; v <= half; v++)
      for (let u = -half; u <= half; u++) {
        const d = octagon(u, v);
        if (d <= rz + 0.3) {
          const door = z < Math.max(2, Math.round(H * 0.08)) && Math.abs(v) < 1 && u > 0 && d > rz - 1;
          put(u, v, z, door || (gz > 0 && z === gz + 1 && d > rz - 1) ? detail : wall);
        } else if (z === gz && d <= rz + 2.3) put(u, v, z, detail); // the stage
        else if (gz > 0 && z === gz + 1 && d > rz + 1.4 && d <= rz + 2.3 && mod(u + v, 2) === 0) put(u, v, z, detail); // its rail
      }
  }
  // the cap: a rounded hood over the top of the tower
  const capH = H - capZ;
  for (let z = capZ; z <= H; z++) {
    const rc = (R1 + 0.6) * Math.sqrt(Math.max(0, 1 - ((z - capZ) / (capH + 0.5)) ** 2));
    for (let v = -half; v <= half; v++) for (let u = -half; u <= half; u++) if (octagon(u, v) <= rc + 0.2) put(u, v, z, cap);
  }
  // the hub on its axle, and four sails in an X: a spar down each, a lattice on its trailing side
  for (let u = 0; u <= plane; u++) put(u, 0, hubZ, stock);
  const W = Math.max(1.6, L * 0.2);
  for (const [ca, sa] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const) {
    const ax = ca * Math.SQRT1_2;
    const az = sa * Math.SQRT1_2;
    for (let dz = -L - 1; dz <= L + 1; dz++)
      for (let w = -L - 1; w <= L + 1; w++) {
        const s = w * ax + dz * az; // along the arm
        const t = -w * az + dz * ax; // across it (positive: the trailing side)
        if (s < 0.5 || s > L + 0.3) continue;
        const z = hubZ + dz;
        if (z < 0) continue;
        if (Math.abs(t) <= 0.55) put(plane, w, z, stock);
        else if (s >= L * 0.22 && t > 0.55 && t <= W + 0.3) {
          const frame = L < 20 || t > W - 0.6 || s > L - 0.7 || mod(Math.round(s), 2) === 0;
          if (frame) put(plane, w, z, sail);
        }
      }
  }
  return m;
};

/**
 * A lighthouse: a tapering tower (octagonal, or square with `square` 1), a
 * gallery with a rail under a glazed lantern that glows at night, and a
 * domed cap with a vent.
 * params: base (the tower's radius at its foot over the height; 0.11), top
 * (under the gallery; 0.07), square (0 or 1).
 * roles: wall, detail (gallery, rail and cap), lamp (the lantern's light),
 * window (its glazing bars; detail if absent).
 */
const lighthouse: Generator = ({ ramp, ramps, param, heightVox }) => {
  const H = Math.max(10, Math.round(heightVox ?? 30));
  const R0 = Math.max(1.6, H * param("base", 0.11));
  const R1 = Math.max(1.1, H * param("top", 0.07));
  const square = param("square", 0) >= 1;
  const half = Math.ceil(Math.max(R0, R1 + 1.5)) + 1;
  const size = 2 * half + 1;
  const m = new VoxelModel(size, size, H + 2);
  const wall = m.material(ramp("wall"));
  const detail = m.material(ramp("detail"));
  const lamp = m.material(ramp("lamp"));
  const bars = m.material(ramps("window")[0] ?? ramp("detail"));
  const zt = Math.round(H * 0.74); // the gallery
  const zl = zt + Math.max(2, Math.round(H * 0.12)); // the lantern's top
  const dist = (dx: number, dy: number) => (square ? Math.max(Math.abs(dx), Math.abs(dy)) : octagon(dx, dy));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = x - half;
      const dy = y - half;
      const d = dist(dx, dy);
      for (let z = 0; z < zt; z++) {
        const rz = R0 + ((R1 - R0) * z) / zt;
        if (d > rz + 0.3) continue;
        // a door at the foot, small windows up the shaft
        const slit = d > rz - 1 && Math.abs(dx) < 0.6 && dy > 0 && (z < 2 || (z % 5 === 3 && z < zt - 2));
        m.set(x, y, z, slit ? bars : wall);
      }
      if (d <= R1 + 1.5) m.set(x, y, zt, detail); // the gallery
      if (d > R1 + 0.6 && d <= R1 + 1.5 && mod(dx + dy, 2) === 0) m.set(x, y, zt + 1, detail); // its rail
      const rl = Math.max(0.7, R1 - 0.4);
      for (let z = zt + 1; z < zl; z++) if (d <= rl + 0.3) m.set(x, y, z, d > rl - 0.8 && mod(dx + dy + z, 3) === 0 ? bars : lamp);
      // the cap: a low dome, then the vent
      const rc = rl + 0.5;
      for (let z = zl; z <= H; z++) {
        const k = (z - zl) / Math.max(1, H - zl);
        if (d <= rc * Math.sqrt(Math.max(0, 1 - k * k)) + 0.2 || (d < 0.6 && z <= H)) m.set(x, y, z, detail);
      }
    }
  return m;
};

/**
 * A cellhouse along its footprint band (line landmark): a long hall of tall
 * barred windows under a flat roof with a skylight monitor down its middle and
 * a parapet, a taller block across its head and a narrower, lower wing at its
 * tail. The head is the band's east end (along grows toward +x; toward +y
 * for a band running north–south); `flip` 1 puts it at the west end.
 * params (lengths over the band's length or the landmark's height): head (the
 * head block's share of the length; 0.14), tail (the wing's; 0.3), tailWidth
 * (the wing's width over the band's; 0.45), hall (the hall's height; 0.8),
 * wing (the wing's height; 0.55).
 * roles: wall, roof, window, detail (parapets, bands; wall if absent).
 */
const cellhouse: Generator = ({ ramp, ramps, param, mask, heightVox, frame }) => {
  if (!mask) throw new Error("cellhouse needs a footprint");
  const H = Math.max(6, Math.round(heightVox ?? 16));
  const m = new VoxelModel(mask.sx, mask.sy, H + 3);
  const wall = m.material(ramp("wall"));
  const roof = m.material(ramp("roof"));
  const glass = m.material(ramp("window"));
  const detail = m.material(ramps("detail")[0] ?? ramp("wall"));
  const b = bandAxis(mask, frame);
  const flip = param("flip", 0) >= 1;
  const head = param("head", 0.14);
  const tail = param("tail", 0.3);
  const tailW = param("tailWidth", 0.45);
  const hallH = Math.max(4, Math.round(H * param("hall", 0.8)));
  const wingH = Math.max(3, Math.round(H * param("wing", 0.55)));
  // per column: which part it belongs to and that part's height (0 outside)
  const idx = new Int32Array(mask.sx * mask.sy).fill(-1);
  b.cells.forEach(([x, y], i) => (idx[y * mask.sx + x] = i));
  const part = (i: number): 0 | 1 | 2 | 3 => {
    const t = flip ? 1 - b.t[i]! : b.t[i]!;
    if (t >= 1 - head) return 1; // the head block
    if (t <= tail) return Math.abs(b.across[i]!) <= b.half * tailW ? 3 : 0; // the wing (or open ground beside it)
    return 2; // the hall
  };
  const heightOf = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= mask.sx || y >= mask.sy) return 0;
    const i = idx[y * mask.sx + x]!;
    if (i < 0) return 0;
    const p = part(i);
    return p === 1 ? H : p === 2 ? hallH : p === 3 ? wingH : 0;
  };
  b.cells.forEach(([x, y], i) => {
    const h = heightOf(x, y);
    if (!h) return;
    const p = part(i);
    const al = Math.round(b.along[i]!);
    for (let z = 0; z < h; z++) {
      // outer wall at this height: a neighbour stands lower
      const skin = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => heightOf(x + dx!, y + dy!) <= z);
      let mat = wall;
      if (skin) {
        if (p === 1) mat = z > 0 && z % 3 === 1 && mod(al, 2) === 0 ? glass : z === h - 2 ? detail : wall; // a grid of windows
        else if (z >= 2 && z < h - 1 && mod(al, 3) !== 0 && z % 4 !== 0) mat = glass; // tall barred windows
        else if (z === 0 || z === h - 1) mat = detail;
      }
      m.set(x, y, z, mat);
    }
    // roofs: a parapet at the edges, a skylight monitor down the hall
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => heightOf(x + dx!, y + dy!) < h);
    if (edge) m.set(x, y, h, detail);
    else if (p === 2 && Math.abs(b.across[i]!) <= Math.max(1, b.half * 0.2)) {
      m.set(x, y, h, mod(al, 2) === 0 ? glass : roof);
      m.set(x, y, h + 1, roof);
    } else m.set(x, y, h - 1, roof);
  });
  return m;
};

/**
 * A natural stone arch (D-139): a slab of rock along x with an opening under
 * its span, which a DEM can't hold. Its outline is a superellipse `span` × H
 * wide (exponent `round`: 2 a dome, larger a blocky fin), thinner across
 * (`depth` × H at the foot) toward its top, its faces wavy and ledged; the
 * opening a half-ellipse `opening` × H wide and `clear` × H tall. `waist`
 * pinches the legs a third of the way up, `skew` thins the +x leg, `turret`
 * stands a tower that many times H tall beside the −x leg, `double: 1` adds a
 * second arch along y that shares the +x leg, and `diagonal: 1` runs the slab
 * along x = y (quarter turns give the other diagonal). Edges are weathered by
 * the seed.
 * roles: rock, base (the foot's darker member; rock if absent), cap (the pale
 * top; rock if absent).
 */
const stoneArch: Generator = ({ rand, ramp, ramps, param, heightVox }) => {
  const H = Math.max(10, Math.round(heightVox ?? 30));
  const W = Math.max(5, Math.round(H * param("span", 1)));
  const D = Math.max(2, H * param("depth", 0.25));
  const n = param("round", 2.5);
  const ow = (H * param("opening", 0.6)) / 2;
  const oh = H * param("clear", 0.8);
  const waist = param("waist", 0);
  const skew = param("skew", 0);
  const turret = param("turret", 0);
  const double = param("double", 0) >= 1;
  const diagonal = !double && param("diagonal", 0) >= 1;
  const tw = turret > 0 ? Math.max(3, Math.round(D * 1.3)) : 0;
  const Ht = Math.round(H * Math.max(1, turret));
  const L = W + tw; // the slab's length, its turret's included
  const sx = diagonal ? Math.ceil((L + D) / Math.SQRT2) + 2 : L + 2;
  const sy = double || diagonal ? sx : Math.ceil(D) + 2;
  const m = new VoxelModel(sx, sy, Math.max(H, Ht) + 1);
  const rock = m.material(ramp("rock"));
  const base = m.material(ramps("base")[0] ?? ramp("rock"));
  const cap = m.material(ramps("cap")[0] ?? ramp("rock"));
  const foot = Math.round(H * param("foot", 0.12));
  const capZ = H - Math.max(1, Math.round(H * param("capShare", 0.08)));
  const [p1, p2] = [rand() * 6.3, rand() * 6.3];
  // whether the slab is solid at u voxels along it from the arch's middle and height z (open under the span)
  const solid = (u: number, z: number) => {
    if (tw && Math.abs(u + W / 2 + tw / 2 - 1) <= (tw / 2) * Math.pow(Math.max(0, 1 - (z / Ht) ** 4), 0.25)) return true;
    const t = z / H;
    if (t >= 1) return false;
    const outer = (W / 2) * Math.pow(1 - t ** n, 1 / n);
    const open = z < oh ? ow * Math.sqrt(1 - (z / oh) ** 2) : 0;
    let leg = (outer - open) * (1 - waist * Math.exp(-(((t - 0.3) / 0.12) ** 2)));
    if (u > 0) leg *= 1 - skew;
    return Math.abs(u) >= open && Math.abs(u) <= open + leg;
  };
  // a slab: each column's place along it (u) and across it (v), from the column's middle
  const slab = (frame: (x: number, y: number) => [number, number]) => {
    for (let z = 0; z < m.sz; z++) {
      const ledge = z % 6 === 0 ? 0.7 : 0; // bedding: a ledge every few voxels
      const half = (D / 2) * (1 - 0.4 * Math.min(1, z / H)) + 0.3 - ledge;
      for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++) {
          const [u, v] = frame(x + 0.5, y + 0.5);
          if (!solid(u, z)) continue;
          let above = 0; // the top rounds across the slab, a ridge and not a deck
          while (above < D / 2 && solid(u, z + above + 1)) above++;
          const crown = above < D / 2 ? Math.sqrt((above + 0.5) / (D / 2)) : 1;
          const wave = 0.9 * Math.sin(u * 0.37 + p1) + 0.5 * Math.sin(u * 0.91 + z * 0.2 + p2); // wavy faces
          if (Math.abs(v) > (half + wave * Math.sign(v || 1) * 0.5) * crown + (rand() - 0.5) * 0.9) continue;
          if (!solid(u + 0.9, z) && !solid(u - 0.9, z) && rand() < 0.5) continue; // a weathered sliver
          m.set(x, y, z, z < foot ? base : z >= capZ + 1.5 * Math.sin(u * 0.29 + p2) ? cap : rock); // the cap's foot wanders
        }
    }
  };
  const u0 = 1 + tw + W / 2; // the arch's middle along a slab drawn from the box's edge
  if (diagonal) {
    // the slab's whole length centred in the box
    slab((x, y) => [(x - sx / 2 + (y - sy / 2)) / Math.SQRT2 - tw / 2, (x - sx / 2 - (y - sy / 2)) / Math.SQRT2]);
  } else if (double) {
    const far = sx - D / 2 - 1; // both slabs along the box's far sides, meeting in its far corner
    slab((x, y) => [x - u0, y - far]);
    slab((x, y) => [y - u0, x - far]);
  } else slab((x, y) => [x - u0, y - sy / 2]);
  return m;
};

/**
 * A balanced rock (D-139): a boulder on a pedestal of softer rock. The
 * pedestal flares from a neck `neck` × H wide under the boulder to a skirt
 * `base` × H wide; the boulder is `cap` × H tall and `capWidth` × H across, a
 * rounded block longer along x than y, overhanging the neck.
 * roles: rock (the boulder), base (the pedestal; rock if absent).
 */
const balancedRock: Generator = ({ rand, ramp, ramps, param, heightVox }) => {
  const H = Math.max(12, Math.round(heightVox ?? 40));
  const capH = Math.max(4, Math.round(H * param("cap", 0.42)));
  const pedH = H - capH;
  const rb = (H * param("base", 0.5)) / 2;
  const rn = (H * param("neck", 0.14)) / 2;
  const rc = (H * param("capWidth", 0.32)) / 2;
  const R = Math.ceil(Math.max(rb, rc) * 1.2) + 1;
  const size = 2 * R + 1;
  const m = new VoxelModel(size, size, H + 1);
  const boulder = m.material(ramp("rock"));
  const pedestal = m.material(ramps("base")[0] ?? ramp("rock"));
  for (let z = 0; z < H; z++) {
    const ped = z < pedH;
    const w = (z - pedH) / capH;
    const r = ped
      ? rn + (rb - rn) * Math.pow(1 - z / pedH, 2.2)
      : Math.max(rn, rc * Math.pow(Math.max(0, 1 - Math.abs(2 * w - 1) ** 4), 1 / 4));
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const d = Math.hypot((x - R) / 1.15, (y - R) / 0.9);
        if (d <= r + (rand() - 0.5) * 0.8) m.set(x, y, z, ped ? pedestal : boulder);
      }
  }
  return m;
};

export const LANDMARK_KIT: Record<string, Generator> = {
  stoneArch,
  balancedRock,
  suspensionBridge,
  pyramidTower,
  obeliskTower,
  column,
  towerHall,
  domedHall,
  rotunda,
  tripodMast,
  windmill,
  lighthouse,
  cellhouse,
};

export type { GenContext };
