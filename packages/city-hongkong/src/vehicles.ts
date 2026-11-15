import { VoxelModel, type GenContext, type Generator } from "pixelworld/generators";

/**
 * Hong Kong's double-deckers (D-133): the trams of the island's north shore
 * and the buses. The traffic layer sizes every streetcar and bus alike
 * (`ctx.size`, voxels), so an asset reshapes that box by its params:
 * `length`, `width` and `height`, factors of the given size. A Hong Kong tram
 * is 12 m long, 2 m wide and 4.6 m tall (0.8, 0.8, 1.45 of a streetcar); a
 * double-decker bus is a bus 1.4 times as tall. A model faces +x, is centred
 * across y and stands on z = 0, as the traffic layer draws vehicles (D-064).
 * Generic shapes and paint: no lettering, numbers or adverts' pictures.
 */

interface Shape {
  L: number;
  W: number;
  H: number;
}

/** The traffic layer's size, reshaped by the asset's params. */
function shape(ctx: GenContext, fallback: [number, number, number]): Shape {
  const s = ctx.size;
  return {
    L: Math.max(2, Math.round((s?.length ?? fallback[0]) * ctx.param("length", 1))),
    W: Math.max(1, Math.round((s?.width ?? fallback[1]) * ctx.param("width", 1))),
    H: Math.max(2, Math.round((s?.height ?? fallback[2]) * ctx.param("height", 1))),
  };
}

/** One of the ramps named `role` or `role.*`, by seed. */
function pick(ctx: GenContext, role: string): number {
  const ids = ctx.ramps(role);
  return ids.length ? ids[Math.floor(ctx.rand() * ids.length)]! : ctx.ramp(role);
}

/** The ramp of a role, or of the fallback role when the asset doesn't name it. */
function or(ctx: GenContext, role: string, fallback: string): number {
  try {
    return ctx.ramp(role);
  } catch {
    return ctx.ramp(fallback);
  }
}

/** Too small for decks (flying levels): a body under a roof. */
function block({ L, W, H }: Shape, body: number, roof: number): VoxelModel {
  const m = new VoxelModel(L, W, H);
  m.fill(0, 0, 0, L, W, H - 1, m.material(body));
  m.fill(0, 0, H - 1, L, W, H, m.material(roof));
  return m;
}

interface Decks {
  /** The two decks' window rows: [first, last] z of each. */
  lower: [number, number];
  upper: [number, number];
  /** The band between the decks, and the rail under the roof. */
  mid: number;
  rail: number;
  roof: number;
}

/** Where the decks fall in a body H voxels tall: a skirt, windows, a band, windows, a rail, the roof. */
function decks(H: number): Decks {
  const roof = H - 1;
  const rail = H - 2;
  const mid = Math.max(3, Math.floor(H / 2));
  return { lower: [2, mid - 1], upper: [mid + 1, rail - 1], mid, rail, roof };
}

/**
 * A Hong Kong tram (the "ding ding"): a narrow double-decker, the same at both
 * ends, in a band of windows on each deck between pillars, windscreens on
 * both decks at both ends with a lit destination box over the upper one, a
 * door at each end of the lower deck, a roof with rounded corners and one
 * trolley pole. Its livery by seed: the classic green with cream bands
 * (`classic`, the share of them), else an advertising wrap: one colour over
 * the whole body (`ad.*`) with its bands in another.
 * roles: classic, band, ad.* (wrap colours), window, door, roof, tyre
 * (trucks, the pole's base), trim (the pole), light, tail, sign.
 * params: length (0.8), width (0.8), height (1.45), classic (0.35).
 */
export const doubleDeckTram: Generator = (ctx) => {
  const { rand } = ctx;
  const s = shape(ctx, [24, 4, 7]);
  const { L, W, H } = s;
  const classic = rand() < ctx.param("classic", 0.35);
  const bodyId = classic ? ctx.ramp("classic") : pick(ctx, "ad");
  let bandId = classic ? ctx.ramp("band") : pick(ctx, "ad");
  if (bandId === bodyId) bandId = ctx.ramp("band");
  if (L < 8 || W < 2 || H < 7) return block(s, bodyId, ctx.ramp("roof"));
  const m = new VoxelModel(L, W, H + 2);
  const body = m.material(bodyId);
  const band = m.material(bandId);
  const win = m.material(ctx.ramp("window"));
  const door = m.material(or(ctx, "door", "window"));
  const roof = m.material(ctx.ramp("roof"));
  const tyre = m.material(ctx.ramp("tyre"));
  const trim = m.material(or(ctx, "trim", "roof"));
  const head = m.material(or(ctx, "light", "window"));
  const tail = m.material(or(ctx, "tail", "tyre"));
  const sign = m.material(or(ctx, "sign", "window"));
  const d = decks(H);
  // a tram's lower deck stands on a deep panel: the advert's colour shows under its windows
  if (d.lower[1] - d.lower[0] >= 2) d.lower[0] += 1;
  const inner = (v: number) => W < 3 || (v > 0 && v < W - 1);
  // a truck under each half
  for (const a of [1, L - 4]) m.fill(a, 0, 0, a + 3, W, 1, tyre);
  for (let u = 0; u < L; u++)
    for (let v = 0; v < W; v++) {
      const side = v === 0 || v === W - 1;
      const end = u === 0 || u === L - 1;
      for (let z = 1; z <= d.roof; z++) {
        let mat = body;
        if (z === d.roof) {
          if (end && side && W >= 3) continue; // the roof's rounded corners
          mat = roof;
        } else if (z === d.mid || z === d.rail) mat = band;
        else if (z === 1) mat = classic ? body : band;
        else if (z < d.lower[0]) mat = body;
        else {
          const row = z <= d.lower[1] ? d.lower : d.upper;
          if (z >= row[0] && z <= row[1]) {
            if (end) mat = inner(v) ? win : body; // windscreens between corner posts
            else if (side) mat = u % 3 === 0 ? body : win; // windows between pillars
          }
        }
        m.set(u, v, z, mat);
      }
    }
  // doors at both ends of the lower deck (one side), lamps and destination boxes at the ends
  for (const u0 of [1, L - 3]) for (let u = u0; u < u0 + 2; u++) for (let z = 1; z <= d.lower[1]; z++) m.set(u, 0, z, door);
  for (let v = 0; v < W; v++) {
    if (!inner(v)) continue;
    m.set(L - 1, v, d.rail, sign);
    m.set(0, v, d.rail, sign);
  }
  for (const v of W >= 3 ? [0, W - 1] : [0]) {
    m.set(L - 1, v, 1, head);
    m.set(0, v, 1, tail);
  }
  // the trolley pole: from its base mid-roof, rising toward the back
  const mid = Math.floor(W / 2);
  const base = Math.floor(L / 2) + 1;
  m.set(base, mid, H, tyre);
  for (let t = 1; t <= Math.min(6, base - 1); t++) m.set(base - t, mid, H + (t > 3 ? 1 : 0), trim);
  return m;
};

/**
 * A double-decker bus: a tall box with a band of windows on each deck between
 * pillars, a windscreen and a panoramic window over it at the front, the
 * destination display between them, a door by the front, a mostly blank
 * back, a dark chassis, a roof. Body and band colours pair by seed
 * (`body.*` with `band.*`): cream with red, yellow, white.
 * roles: body.*, band.*, window, door, roof, tyre, light, tail, sign.
 * params: length (1), width (1), height (1.4).
 */
export const doubleDeckBus: Generator = (ctx) => {
  const s = shape(ctx, [19, 4, 7]);
  const { L, W, H } = s;
  const bodies = ctx.ramps("body");
  const bands = ctx.ramps("band");
  const k = Math.floor(ctx.rand() * Math.max(1, Math.min(bodies.length, bands.length)));
  const bodyId = bodies[k] ?? ctx.ramp("body");
  const bandId = bands[k] ?? ctx.ramp("band");
  if (L < 8 || W < 2 || H < 7) return block(s, bodyId, ctx.ramp("roof"));
  const m = new VoxelModel(L, W, H);
  const body = m.material(bodyId);
  const band = m.material(bandId);
  const win = m.material(ctx.ramp("window"));
  const door = m.material(or(ctx, "door", "window"));
  const roof = m.material(ctx.ramp("roof"));
  const tyre = m.material(ctx.ramp("tyre"));
  const head = m.material(or(ctx, "light", "window"));
  const tail = m.material(or(ctx, "tail", "tyre"));
  const sign = m.material(or(ctx, "sign", "window"));
  const d = decks(H);
  const inner = (v: number) => W < 3 || (v > 0 && v < W - 1);
  // the chassis
  m.fill(1, 0, 0, L - 1, W, 1, tyre);
  for (let u = 0; u < L; u++)
    for (let v = 0; v < W; v++) {
      const side = v === 0 || v === W - 1;
      const front = u === L - 1;
      const back = u === 0;
      for (let z = 1; z <= d.roof; z++) {
        let mat = body;
        if (z === d.roof) mat = roof;
        else if (z === 1 || z === d.mid) mat = band;
        else {
          const row = z <= d.lower[1] ? d.lower : d.upper;
          if (z >= row[0] && z <= row[1]) {
            if (front) mat = inner(v) ? win : body; // the windscreen, and the panoramic window over it
            else if (back) mat = row === d.upper && inner(v) && z === row[1] ? win : body;
            else if (side) mat = u % 4 === 0 ? body : win;
          }
        }
        m.set(u, v, z, mat);
      }
    }
  for (let v = 0; v < W; v++) if (inner(v)) m.set(L - 1, v, d.mid, sign); // the destination display
  for (let u = L - 4; u < L - 2; u++) for (let z = 1; z <= d.lower[1]; z++) m.set(u, 0, z, door);
  for (const v of W >= 3 ? [0, W - 1] : [0]) {
    m.set(L - 1, v, 1, head);
    m.set(0, v, 1, tail);
  }
  return m;
};

export const VEHICLE_GENERATORS: Record<string, Generator> = { doubleDeckTram, doubleDeckBus };
