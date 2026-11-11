import { VoxelModel, type GenContext, type Generator } from "pixelworld/generators";
import { backWindows, bays, chimney, clamp, columnAt, dormer, facadeOf, frontDir, frontPainter, paints, pick, wallsAndRoof, type Facade, type Paints } from "./facade";

/**
 * Paris's street fabric (D-085): the Haussmann block, the faubourg's narrow
 * plastered house and the brick HBM block of the 1920s and 30s. Storeys are
 * counted as in France and as IGN's BD TOPO counts them: the ground floor
 * (rez-de-chaussée) is storey 0, and the hint's count includes it and the
 * storeys in the roof. Shopfronts and signs carry no lettering.
 */

/** Storey bases of a wall Hw tall with n storeys: a taller ground storey, the rest fh each. */
function storeyBases(Hw: number, n: number, groundRatio: number): { bases: number[]; fh: number; g: number } {
  const fh = Math.max(3, Math.floor(Hw / (n - 1 + groundRatio)));
  const g = Math.max(fh, Hw - fh * (n - 1));
  const bases = [0];
  for (let k = 1; k < n; k++) bases.push(g + (k - 1) * fh);
  return { bases, fh, g };
}

/** The storeys a wall of Hw voxels can hold, at least 3 voxels each: the wanted count, else fewer. */
function fit(want: number, Hw: number, lo: number): number {
  return Math.max(lo, Math.min(want, Math.floor(Hw / 3)));
}

/** A role's material if the asset has it, else `fallback`. */
function optional(ctx: GenContext, m: VoxelModel, role: string, fallback: number): number {
  const xs = ctx.ramps(role);
  return xs.length ? m.material(pick(ctx.rand, xs)) : fallback;
}

/** Tall French windows in each bay of storey base z0: glass from the sill row up, a lintel on taller storeys. */
function frenchWindows(paint: (a: number, z: number, mat: number) => void, spans: [number, number][], z0: number, fh: number, zTop: number, p: Paints): void {
  for (const [a0, a1] of spans)
    for (let zf = 1; zf < fh; zf++) {
      const z = z0 + zf;
      if (z >= zTop) break;
      const lintel = fh >= 4 && zf === fh - 1;
      for (let a = a0; a <= a1; a++) paint(a, z, lintel ? p.trim : p.pane());
    }
}

/** A balcony painted on storey z0: a stone slab at the floor line, an iron rail over the lower window rows (balusters, then a handrail). */
function balcony(paint: (a: number, z: number, mat: number) => void, a0: number, a1: number, z0: number, fh: number, p: Paints): void {
  const rail = fh >= 6 ? 2 : 1;
  for (let a = a0; a <= a1; a++) {
    paint(a, z0, p.trim);
    for (let r = 1; r <= rail; r++) if (r === rail || a % 2 === 0 || a === a0 || a === a1) paint(a, z0 + r, p.iron);
  }
}

/** Chimney stacks on the party walls, a little behind the front, with pots. */
function partyChimneys(ctx: GenContext, m: VoxelModel, f: Facade, h: number, mats: { body: number; pot: number }): void {
  if (f.width < 4 || f.maxDepth < 3) return;
  const d0 = Math.max(1, Math.round(f.maxDepth * (0.3 + ctx.rand() * 0.3)));
  for (const a of [0, f.width - 1]) {
    if (ctx.rand() < 0.25) continue;
    const len = clamp(Math.round(f.maxDepth * 0.15), 1, 4);
    for (let k = 0; k < len; k++) {
      const at = columnAt(f, a, d0 + k);
      if (at) chimney(m, at[0], at[1], h, mats, k % 2 === 0);
    }
  }
}

/** The model for a footprint: tall enough for H, chimneys and dormers. */
function modelFor(f: Facade, H: number, fh: number): VoxelModel {
  return new VoxelModel(f.sx, f.sy, H + Math.max(4, Math.round(fh * 1.2)) + 2);
}

/**
 * A Haussmann block: 6–7 storeys in all. A shop band at the street (shop
 * glass in painted frames, the porte-cochère in the middle of wider fronts)
 * under a stone band; dressed-stone coursing on the lower storeys; tall
 * French windows in regular bays; a continuous black-iron balcony on
 * storeys 2 and 5 (painted flush: nothing projects); a cornice; and over it a
 * zinc mansard, its steep brisis stepping in from the front and rear walls
 * to a flat terrasson, with dormers in line with the bays and chimney stacks
 * on the party walls.
 * params: shops (share of fronts with shops; 0.8), balconies (1: a balcony
 * on every storey's windows between the continuous ones; 0), awnings (share
 * of shop fronts with a café awning; 0.3), roof (the mansard's share of the
 * height; 0.22), litFraction.
 * roles: wall (wall.* variants), trim, cornice, iron, shop (shop.* variants),
 * door, awning (optional), roof (roof.* variants), chimney (wall if absent),
 * pot (chimney if absent), window, lit.
 */
export const haussmann: Generator = (ctx) => {
  const { rand, mask, hints, param } = ctx;
  if (!mask) throw new Error("haussmann needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const H = clamp(Math.round((ctx.heightVox ?? param("height", 50)) * (1 + (rand() - 0.5) * 0.06)), 8, 400);
  const total = clamp(Math.round(hints?.floors ?? 6 + Math.floor(rand() * 2)), 3, 9);
  // the top storey (two on the tallest) is in the mansard
  const inRoof = total >= 8 ? 2 : total >= 4 ? 1 : 0;
  const Hr = inRoof ? clamp(Math.round(H * param("roof", 0.22)), 3, Math.max(3, Math.round(H * 0.35))) : 0;
  const Hw = H - Hr;
  const n = fit(total - inRoof, Hw, 2);
  const { bases, fh, g } = storeyBases(Hw, n, 1.3);
  const fine = fh >= 6;
  const m = modelFor(f, H, fh);
  const p = paints(ctx, m);
  // the mansard: the brisis rises about three voxels for each it steps in, from a
  // voxel behind the cornice, then the terrasson closes it almost flat
  const brisis = Math.max(1, Math.round(Hr * 0.8));
  const inset = (dz: number) => (dz < brisis ? 1 + Math.floor(dz / 3) : 1 + Math.floor(brisis / 3) + (dz - brisis + 1) * 3);
  wallsAndRoof(m, f, Hw, Hr, p.body, p.roof, inset);
  const { paint } = frontPainter(m, f, 0);
  const cornice = Math.min(fine ? 2 : 1, Math.max(0, fh - 3));
  const zTop = Hw - cornice;
  const { spans, n: nb } = bays(W, Math.max(1, Math.round(W / (fine ? 4 : 3))), fine && W >= 8 ? 2 : 1);

  // the street: shops, or a rusticated base with windows, and the carriage door
  const shops = rand() < param("shops", 0.8);
  const door = nb >= 3 ? Math.floor(nb / 2) : -1;
  const awning = shops && rand() < param("awnings", 0.3) ? optional(ctx, m, "awning", 0) : 0;
  for (let b = 0; b < nb; b++) {
    const [a0, a1] = spans[b]!;
    const isDoor = b === door;
    const lo = isDoor ? Math.max(0, a0 - (fine ? 1 : 0)) : shops ? Math.max(0, a0 - 1) : a0;
    const hi = isDoor ? Math.min(W - 1, a1 + (fine ? 1 : 0)) : shops ? Math.min(W - 1, a1 + 1) : a1;
    for (let a = lo; a <= hi; a++)
      for (let z = 1; z < g - 1; z++) {
        if (isDoor) paint(a, z, z === g - 2 && g >= 5 ? p.trim : p.door);
        else if (shops) paint(a, z, a === lo || a === hi ? p.shop : awning && z >= g - 3 && z < g - 1 && g >= 6 ? awning : z === 1 && g >= 5 ? p.shop : p.pane());
        else if (z >= 2 && z < g - 2) paint(a, z, p.pane());
      }
  }
  // stone bands: over the shops, and the coursing of the bare wall up to the first storey's top
  const { cols } = frontPainter(m, f, 0);
  for (let a = 0; a < W; a++) {
    paint(a, g - 1, p.trim);
    if (!fine) continue;
    for (let z = 2; z < (bases[2] ?? g); z += 3)
      if (z !== g - 1 && (a + Math.floor(z / 3)) % 2 === 0) for (const [x, y] of cols[a] ?? []) if (m.get(x, y, z) === p.body) paint(a, z, p.trim);
  }
  // the storeys: French windows, the continuous balconies on 2 and 5
  for (let k = 1; k < n; k++) {
    const z0 = bases[k]!;
    frenchWindows(paint, spans, z0, fh, zTop, p);
    if (k === 2 || k === 5) balcony(paint, 0, W - 1, z0, fh, p);
    else if (param("balconies", 0) >= 1) for (const [a0, a1] of spans) balcony(paint, Math.max(0, a0 - 1), Math.min(W - 1, a1 + 1), z0, fh, p);
  }
  // the cornice
  for (let a = 0; a < W; a++) for (let z = zTop; z < Hw; z++) paint(a, z, p.cornice);

  // dormers in the brisis, over every bay but the ends
  if (Hr >= 4) {
    const h = Math.min(Hr - 1, Math.max(4, fh));
    for (const [a0, a1] of spans) dormer(m, f, a0, a1, 1, Hw, h, { frame: p.trim, cap: p.roof, pane: p.pane });
  }
  backWindows(m, f, bases, zTop, p.pane, 3, hints?.corner ? 2 : 0);
  const stack = optional(ctx, m, "chimney", p.body);
  partyChimneys(ctx, m, f, Math.max(3, Math.round(fh * 0.8)), { body: stack, pot: optional(ctx, m, "pot", stack) });
  return m;
};

/**
 * A faubourg house from before 1850: narrow, 3–5 storeys, its plaster in
 * off-white, ochre or grey, plain window surrounds and shutters on some, a
 * steep pitched roof of tile or slate with its ridge along the street, a
 * dormer or two and tall chimneys; at the street a small shop or a carriage
 * door.
 * params: shutters (share of houses with shutters; 0.5), pitch (voxels the
 * roof steps in for each it rises; 0.7), litFraction.
 * roles: wall (wall.* variants), trim, shutter (shutter.* variants; none
 * without), shop (shop.* variants), door, roof (roof.* variants), chimney,
 * pot, window, lit.
 */
export const faubourg: Generator = (ctx) => {
  const { rand, mask, hints, param } = ctx;
  if (!mask) throw new Error("faubourg needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const H = clamp(Math.round((ctx.heightVox ?? param("height", 36)) * (1 + (rand() - 0.5) * 0.1)), 6, 300);
  const total = clamp(Math.round(hints?.floors ?? 4 + Math.floor(rand() * 2)), 2, 7);
  // a steep roof over the half-depth: as tall as the footprint lets it be, a storey at most
  const pitch = param("pitch", 0.7);
  const Hr = clamp(Math.round((f.maxDepth / 2) / pitch), 2, Math.max(2, Math.round(H * 0.3)));
  const Hw = H - Hr;
  const n = fit(total - (total >= 4 ? 1 : 0), Hw, 1);
  const { bases, fh, g } = storeyBases(Hw, n, 1.15);
  const m = modelFor(f, H, fh);
  const p = paints(ctx, m);
  wallsAndRoof(m, f, Hw, Hr, p.body, p.roof, (dz) => Math.floor((dz + 1) * pitch));
  const { paint } = frontPainter(m, f, 0);
  const zTop = Hw - (fh >= 5 ? 1 : 0);
  const { spans, n: nb } = bays(W, clamp(Math.round(W / 3.5), 1, 4), W >= 10 && fh >= 6 ? 2 : 1);
  const shutters = rand() < param("shutters", 0.5) && ctx.ramps("shutter").length ? m.material(pick(rand, ctx.ramps("shutter"))) : 0;

  // the street: a shop across most of the front, or windows and a door
  const shop = W >= 4 && rand() < 0.6;
  const doorBay = nb >= 2 ? (rand() < 0.5 ? 0 : nb - 1) : 0;
  for (let b = 0; b < nb; b++) {
    const [a0, a1] = spans[b]!;
    for (let a = a0; a <= a1; a++)
      for (let z = 1; z < g - 1; z++) {
        if (b === doorBay) paint(a, z, p.door);
        else if (shop) paint(a, z, z === 1 ? p.shop : p.pane());
        else if (z >= 2) paint(a, z, p.pane());
      }
    if (shop && b !== doorBay) {
      if (a0 > 0) for (let z = 1; z < g - 1; z++) paint(a0 - 1, z, p.shop);
      if (a1 < W - 1) for (let z = 1; z < g - 1; z++) paint(a1 + 1, z, p.shop);
    }
  }
  for (let a = 0; a < W; a++) paint(a, g - 1, p.trim);
  // the storeys: windows in plain surrounds, shutters folded back beside them
  for (let k = 1; k < n; k++) {
    const z0 = bases[k]!;
    for (const [a0, a1] of spans)
      for (let zf = 1; zf < fh; zf++) {
        const z = z0 + zf;
        if (z >= zTop) break;
        const sill = zf === 1 && fh >= 5;
        for (let a = a0; a <= a1; a++) paint(a, z, sill || (fh >= 4 && zf === fh - 1) ? p.trim : p.pane());
        if (shutters && !sill) {
          if (a0 > 0) paint(a0 - 1, z, shutters);
          if (a1 < W - 1) paint(a1 + 1, z, shutters);
        }
      }
  }
  // a plain band under the eaves
  if (zTop < Hw) for (let a = 0; a < W; a++) paint(a, Hw - 1, p.trim);
  // a dormer or two in the roof
  if (Hr >= 4) {
    const h = Math.min(Hr - 1, Math.max(3, fh - 1));
    const picks = nb >= 3 ? [spans[1]!] : spans.slice(0, 1);
    for (const [a0, a1] of picks) dormer(m, f, a0, a1, 1, Hw, h, { frame: p.trim, cap: p.roof, pane: p.pane });
  }
  backWindows(m, f, bases, zTop, p.pane, 3, hints?.corner ? 2 : 0);
  const stack = optional(ctx, m, "chimney", p.body);
  partyChimneys(ctx, m, f, Math.max(3, Math.round(fh * 1.1)), { body: stack, pot: optional(ctx, m, "pot", stack) });
  return m;
};

/**
 * An HBM block (habitations à bon marché, 1920s–30s): 6–7 storeys of
 * red-orange brick on a pale base storey, pale bands at the floor lines,
 * windows in bays with a bay of brick bow-windows (flush) every few, loggias
 * on the top storey, and a low tiled roof behind a band, with brick stacks.
 * params: bows (bays between bow-window bays; 3), litFraction.
 * roles: wall (wall.* variants: the brick), trim (the bands and surrounds),
 * base (the ground storey; trim if absent), roof, chimney, pot, door, window, lit.
 */
export const hbm: Generator = (ctx) => {
  const { rand, mask, hints, param } = ctx;
  if (!mask) throw new Error("hbm needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const H = clamp(Math.round((ctx.heightVox ?? param("height", 52)) * (1 + (rand() - 0.5) * 0.04)), 8, 400);
  const total = clamp(Math.round(hints?.floors ?? 7), 3, 9);
  const Hr = Math.min(4, Math.max(2, Math.round(H * 0.06)));
  const Hw = H - Hr;
  const n = fit(total, Hw, 2);
  const { bases, fh, g } = storeyBases(Hw, n, 1.1);
  const m = modelFor(f, H, fh);
  const p = paints(ctx, m);
  const base = optional(ctx, m, "base", p.trim);
  // a low hipped roof: two voxels in for each up, from a voxel behind the band
  wallsAndRoof(m, f, Hw, Hr, p.body, p.roof, (dz) => 1 + dz * 2);
  const { paint } = frontPainter(m, f, 0);
  const zTop = Hw - 1;
  const { spans, n: nb } = bays(W, Math.max(1, Math.round(W / 3)), fh >= 6 && W >= 8 ? 2 : 1);
  const bowEvery = Math.max(2, Math.round(param("bows", 3)));

  // the base storey in pale stone or render, its door in the middle
  const door = Math.floor(nb / 2);
  for (let a = 0; a < W; a++) for (let z = 0; z < g; z++) paint(a, z, base);
  spans.forEach(([a0, a1], b) => {
    for (let a = a0; a <= a1; a++) for (let z = 1; z < g - 1; z++) paint(a, z, b === door ? p.door : z >= 2 ? p.pane() : base);
  });
  // the storeys: windows, bands at the floor lines, bow-window bays framed in trim
  for (let k = 1; k < n; k++) {
    const z0 = bases[k]!;
    const top = k === n - 1;
    for (let a = 0; a < W; a++) paint(a, z0, p.trim);
    spans.forEach(([a0, a1], b) => {
      const bow = b % bowEvery === 1 % bowEvery && nb >= 3 && !top;
      for (let zf = 1; zf < fh; zf++) {
        const z = z0 + zf;
        if (z >= zTop) break;
        for (let a = a0; a <= a1; a++) paint(a, z, top && zf < fh - 1 ? (a % 2 === 0 ? p.iron : p.pane()) : zf === fh - 1 && fh >= 4 ? p.trim : p.pane());
        if (bow) {
          if (a0 > 0) paint(a0 - 1, z, p.trim);
          if (a1 < W - 1) paint(a1 + 1, z, p.trim);
        }
      }
    });
  }
  for (let a = 0; a < W; a++) paint(a, Hw - 1, p.trim);
  backWindows(m, f, bases, zTop, p.pane, 3, hints?.corner ? 2 : 0);
  const stack = optional(ctx, m, "chimney", p.body);
  partyChimneys(ctx, m, f, Math.max(3, Math.round(fh * 0.7)), { body: stack, pot: optional(ctx, m, "pot", stack) });
  return m;
};

export const BUILDING_GENERATORS: Record<string, Generator> = { haussmann, faubourg, hbm };
