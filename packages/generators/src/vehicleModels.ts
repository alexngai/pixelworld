import type { GenContext, Generator } from "./assets";
import { VoxelModel } from "./voxel";

/**
 * Traffic vehicles (D-064): procedural voxel models for the ambient traffic
 * layer (D-060), one generator per kind, so vehicles are drawn in the same
 * voxels as buildings and props instead of plain boxes.
 *
 * A model faces +x (its front at x = length − 1), is centred across y, and
 * stands on z = 0. Its size comes from the traffic layer (`ctx.size`, in
 * object voxels for the level), its seed picks the body type and paint, and
 * `ctx.part` says which car of a consist it is (0 the head, then wagons).
 * Generic shapes and paint: no lettering, numbers or emblems.
 *
 * Shared roles (an asset maps them to ramps): `glass` (car windows), `window`
 * (transit windows: `lit` glows at night), `tyre` (wheels, undercarriage),
 * `light` (headlights), `tail` (tail lights), `trim` (bumpers, railings,
 * fittings), `roof`. Each generator lists its own.
 */

interface Size {
  L: number;
  W: number;
  H: number;
}

function sizeOf(ctx: GenContext, fallback: [number, number, number]): Size {
  const s = ctx.size;
  return {
    L: Math.max(2, Math.round(s?.length ?? fallback[0])),
    W: Math.max(1, Math.round(s?.width ?? fallback[1])),
    H: Math.max(2, Math.round(s?.height ?? fallback[2])),
  };
}

/** The ramp of a role, or undefined when the asset doesn't name it. */
function has(ctx: GenContext, role: string): number | undefined {
  try {
    return ctx.ramp(role);
  } catch {
    return undefined;
  }
}

/** The ramp of the first role the asset names. */
function first(ctx: GenContext, ...roles: string[]): number {
  for (const r of roles) {
    const id = has(ctx, r);
    if (id !== undefined) return id;
  }
  return ctx.ramp(roles[roles.length - 1]!); // throws, naming the missing role
}

/** One of the ramps named `role` or `role.*`, by seed. */
function oneOf(ctx: GenContext, role: string): number {
  const ids = ctx.ramps(role);
  if (!ids.length) return ctx.ramp(role);
  return ids[Math.floor(ctx.rand() * ids.length)]!;
}

/**
 * Index k of a paired livery (`a.<k>` with `b.<k>`), by seed, and its two ramps.
 * The roles pair by sorted name, as `ramps` lists them.
 */
function livery(ctx: GenContext, a: string, b: string): [number, number] {
  const as = ctx.ramps(a);
  const bs = ctx.ramps(b);
  const n = Math.min(as.length, bs.length);
  if (!n) return [first(ctx, a), first(ctx, b)];
  const k = Math.floor(ctx.rand() * n);
  return [as[k]!, bs[k]!];
}

/** Box fill in the model's frame: [u0, u1) along, [v0, v1) across, [z0, z1) up. */
function put(m: VoxelModel, u0: number, u1: number, v0: number, v1: number, z0: number, z1: number, mat: number): void {
  m.fill(u0, v0, z0, u1, v1, z1, mat);
}

/**
 * A vehicle too small for detail (flying levels): a body under a roof, with a
 * window band where there's room.
 */
function block(L: number, W: number, H: number, body: number, roof: number, window?: number): VoxelModel {
  const m = new VoxelModel(L, W, H);
  const b = m.material(body);
  put(m, 0, L, 0, W, 0, H - 1, b);
  put(m, 0, L, 0, W, H - 1, H, m.material(roof));
  if (window !== undefined && H >= 3 && L >= 3) {
    const w = m.material(window);
    for (let u = 1; u < L - 1; u += 2) {
      m.set(u, 0, H - 2, w);
      m.set(u, W - 1, H - 2, w);
    }
  }
  return m;
}

/** Wheels at two axles (or more) along both sides, a dark chassis between. */
function wheels(m: VoxelModel, L: number, W: number, axles: number[], tyre: number, wide: boolean): void {
  put(m, 1, L - 1, Math.min(1, W - 1), Math.max(1, W - 1), 0, 1, tyre);
  for (const a of axles)
    for (const u of wide ? [a, a + 1] : [a]) {
      if (u < 0 || u >= L) continue;
      m.set(u, 0, 0, tyre);
      m.set(u, W - 1, 0, tyre);
    }
}

const CAR_TYPES = ["sedan", "sedan", "hatch", "hatch", "suv", "suv", "wagon", "coupe", "pickup", "van", "taxi"] as const;
type CarType = (typeof CAR_TYPES)[number];

/**
 * A car of one of several body types, by seed: sedan, hatchback, SUV, wagon,
 * coupe, pickup (a cab and an open bed), van (a minivan's windows or a cargo
 * van's blank sides) and taxi (the `taxi` paint and a roof sign).
 * Proportions come from the type (hood, cabin and trunk lengths, beltline);
 * wheels show at the corners, headlights and tail lights at the beltline.
 * roles: paint.* (body colours, by seed: list a ramp twice to make it
 * commoner), taxi, glass, tyre, light, tail, trim, sign (the taxi's).
 */
const car: Generator = (ctx) => {
  const { rand } = ctx;
  const { L, W, H } = sizeOf(ctx, [9, 4, 5]);
  const taxi = has(ctx, "taxi");
  let type: CarType = CAR_TYPES[Math.floor(rand() * CAR_TYPES.length)]!;
  if (type === "taxi" && taxi === undefined) type = "sedan";
  const paintId = type === "taxi" ? taxi! : oneOf(ctx, "paint");
  const glassId = ctx.ramp("glass");
  if (L < 6 || W < 3 || H < 4) return block(L, W, H, paintId, glassId);
  const sign = type === "taxi" && has(ctx, "sign") !== undefined;
  const m = new VoxelModel(L, W, H + (sign ? 1 : 0));
  const paint = m.material(paintId);
  const glass = m.material(glassId);
  const tyre = m.material(ctx.ramp("tyre"));
  const head = m.material(first(ctx, "light", "glass"));
  const tail = m.material(first(ctx, "tail", "tyre"));
  const trim = m.material(first(ctx, "trim", "tyre"));
  const f = (x: number) => Math.round(x * L);
  let roof = H - 1;
  let belt = Math.max(1, Math.round(H * 0.42));
  let [c0, c1] = [f(0.2), L - f(0.3)];
  switch (type) {
    case "coupe":
      [c0, c1] = [f(0.24), L - f(0.32)];
      if (H >= 6) roof = H - 2;
      break;
    case "hatch":
      [c0, c1] = [f(0.06), L - f(0.32)];
      break;
    case "wagon":
      [c0, c1] = [f(0.06), L - f(0.28)];
      break;
    case "suv":
      [c0, c1] = [f(0.06), L - f(0.25)];
      belt = Math.min(roof - 1, belt + (H >= 6 ? 1 : 0));
      break;
    case "van":
      [c0, c1] = [0, L - Math.max(1, f(0.12))];
      break;
    case "pickup":
      [c0, c1] = [f(0.4), L - f(0.26)];
      break;
  }
  c0 = Math.max(0, Math.min(c0, L - 3));
  c1 = Math.max(c0 + 2, Math.min(c1, L));
  belt = Math.max(1, Math.min(belt, roof - 1));
  // the chassis, and a wheel at each corner
  const wide = L >= 9;
  wheels(m, L, W, [Math.max(1, f(0.14)), Math.min(L - (wide ? 3 : 2), L - 1 - f(0.18))], tyre, wide);
  // the body up to the beltline, bumpers below, lights at the corners
  put(m, 0, L, 0, W, 1, belt + 1, paint);
  for (let v = 0; v < W; v++) {
    m.set(0, v, 1, trim);
    m.set(L - 1, v, 1, trim);
  }
  for (const v of [0, W - 1]) {
    m.set(L - 1, v, belt, head);
    m.set(0, v, belt, tail);
  }
  // a pickup's bed: low walls round the open back
  if (type === "pickup" && belt + 1 < roof)
    for (let u = 0; u < c0; u++)
      for (let v = 0; v < W; v++) if (v === 0 || v === W - 1 || u === 0) m.set(u, v, belt + 1, paint);
  // the cabin: glass all round between pillars; a cargo van's sides are blank behind the doors
  const cargo = type === "van" && rand() < 0.5;
  const len = c1 - c0;
  const bPillar = len >= 6 ? c0 + Math.floor(len / 2) : -1;
  for (let z = belt + 1; z < roof; z++)
    for (let u = c0; u < c1; u++)
      for (let v = 0; v < W; v++) {
        const side = v === 0 || v === W - 1;
        const end = u === c0 || u === c1 - 1;
        let mat = glass;
        if (side && (len >= 4 ? end || u === bPillar : false)) mat = paint;
        if (side && cargo && u < c1 - 3) mat = paint;
        if (!side && !end) mat = paint; // inside: hidden under the roof
        m.set(u, v, z, mat);
      }
  // the roof: the body's colour, or a contrasting one on some
  const roofMat = rand() < 0.15 ? trim : paint;
  put(m, c0, c1, 0, W, roof, roof + 1, roofMat);
  if ((type === "wagon" || type === "suv") && rand() < 0.35 && roof + 1 < m.sz) {
    for (const v of [0, W - 1]) put(m, c0 + 1, c1 - 1, v, v + 1, roof + 1, roof + 2, trim); // roof rails
  }
  if (sign) {
    const s = m.material(ctx.ramp("sign"));
    const mid = Math.floor((c0 + c1) / 2);
    put(m, mid, mid + 1, Math.max(0, Math.floor(W / 2) - 1), Math.min(W, Math.floor(W / 2) + 1), roof + 1, roof + 2, s);
  }
  return m;
};

/**
 * A city bus: a livery band below a long band of windows between narrow
 * pillars, a wide windscreen with a blank destination sign over it, doors on
 * the kerb side, and air-conditioning units on a light roof. Long ones are
 * articulated, with dark bellows and a third axle.
 * roles: body.*, band.* (paired liveries, by seed), window, door, tyre, light,
 * tail, roof, trim, sign.
 */
const bus: Generator = (ctx) => {
  const { rand } = ctx;
  const { L, W, H } = sizeOf(ctx, [14, 5, 11]);
  const [bodyId, bandId] = livery(ctx, "body", "band");
  const windowId = ctx.ramp("window");
  if (L < 8 || W < 3 || H < 5) return block(L, W, H, bodyId, ctx.ramp("roof"), windowId);
  const m = new VoxelModel(L, W, H + 1);
  const body = m.material(bodyId);
  const band = m.material(bandId);
  const win = m.material(windowId);
  const door = m.material(first(ctx, "door", "window"));
  const tyre = m.material(ctx.ramp("tyre"));
  const head = m.material(first(ctx, "light", "window"));
  const tail = m.material(first(ctx, "tail", "tyre"));
  const roof = m.material(ctx.ramp("roof"));
  const trim = m.material(first(ctx, "trim", "roof"));
  const sign = m.material(first(ctx, "sign", "window"));
  const f = (x: number) => Math.round(x * L);
  const articulated = L >= 18 && rand() < 0.35;
  const joint = articulated ? f(0.56) : -1;
  const axles = [Math.max(1, f(0.12)), L - 3 - Math.max(0, f(0.08))];
  if (articulated) axles.push(joint - 3);
  wheels(m, L, W, axles, tyre, L >= 12);
  put(m, 0, L, 0, W, 1, H - 1, body);
  put(m, 0, L, 0, W, H - 1, H, roof);
  const lo = Math.max(2, Math.round(H * 0.42));
  const hi = H - 2;
  // the livery band under the windows, round the whole bus
  for (let u = 0; u < L; u++) for (const v of [0, W - 1]) m.set(u, v, lo - 1, band);
  for (let v = 0; v < W; v++) {
    m.set(0, v, lo - 1, band);
    m.set(L - 1, v, lo - 1, band);
  }
  // side windows between pillars
  for (let z = lo; z <= hi; z++)
    for (let u = 1; u < L - 1; u++) if (u % 3 !== 0) for (const v of [0, W - 1]) m.set(u, v, z, win);
  // the windscreen and the sign over it; a rear window
  for (let v = 1; v < W - 1; v++) {
    for (let z = Math.max(2, Math.round(H * 0.3)); z < hi; z++) m.set(L - 1, v, z, win);
    m.set(L - 1, v, hi, sign);
    for (let z = lo + 1; z <= hi; z++) m.set(0, v, z, win);
  }
  for (const v of [0, W - 1]) {
    m.set(L - 1, v, 2, head);
    m.set(0, v, 2, tail);
  }
  // doors on the kerb side (+y, on the right going +x): by the front and in the middle
  for (const u0 of [L - 3, f(0.45)]) for (let u = u0; u < u0 + 2; u++) for (let z = 1; z <= hi; z++) m.set(u, W - 1, z, door);
  if (articulated) put(m, joint, joint + 1, 0, W, 1, H, tyre);
  // air-conditioning units along the roof
  for (const [a, b] of [[f(0.2), f(0.35)], [f(0.62), f(0.78)]] as const) put(m, a, b, 1, W - 1, H, H + 1, trim);
  return m;
};

/**
 * A cable car: an enclosed cabin between two open ends with outward-facing
 * benches and corner posts, running boards along both sides (when the car is
 * five voxels wide or more) with riders standing on them, a letterboard and a
 * roof with a raised clerestory.
 * roles: body.* (lower panels and end walls, by seed), trim (posts, the
 * letterboard), accent (the letterboard over the cabin), roof, wood
 * (benches, boards), window, tyre (undercarriage), rider.* (clothes), skin.
 */
const cableTram: Generator = (ctx) => {
  const { rand } = ctx;
  const { L, W, H } = sizeOf(ctx, [12, 5, 11]);
  const bodyId = oneOf(ctx, "body");
  if (L < 8 || W < 3 || H < 7) return block(L, W, H, bodyId, ctx.ramp("roof"), ctx.ramp("window"));
  const m = new VoxelModel(L, W, H);
  const body = m.material(bodyId);
  const trim = m.material(ctx.ramp("trim"));
  const accent = m.material(first(ctx, "accent", "trim"));
  const roof = m.material(ctx.ramp("roof"));
  const wood = m.material(first(ctx, "wood", "trim"));
  const win = m.material(ctx.ramp("window"));
  const frame = m.material(ctx.ramp("tyre"));
  const clothes = ctx.ramps("rider");
  const skin = clothes.length ? m.material(first(ctx, "skin", "trim")) : 0;
  const boards = W >= 5;
  const v0 = boards ? 1 : 0;
  const v1 = boards ? W - 2 : W - 1; // the body's outer columns
  const open = Math.max(2, Math.round(L * 0.22));
  const isOpen = (u: number) => u < open || u >= L - open;
  const zWinLo = 3;
  const zLetter = H - 3;
  const zRoof = H - 2;
  // the undercarriage, the floor and the running boards
  put(m, 1, L - 1, v0 + 1, v1, 0, 1, frame);
  put(m, 0, L, v0, v1 + 1, 1, 2, body);
  if (boards) for (let u = 0; u < L; u++) if (isOpen(u)) for (const v of [0, W - 1]) m.set(u, v, 1, wood);
  for (let u = 0; u < L; u++)
    for (let v = v0; v <= v1; v++) {
      const side = v === v0 || v === v1;
      const end = u === 0 || u === L - 1;
      if (isOpen(u)) {
        // benches facing out, posts at the corners of each open end
        if (side) m.set(u, v, 2, wood);
        else if (end) m.set(u, v, 2, body);
        const corner = side && (u === 0 || u === open - 1 || u === L - open || u === L - 1);
        if (corner) for (let z = zWinLo; z < zLetter; z++) m.set(u, v, z, trim);
      } else {
        // the cabin: body-coloured panels, then windows between posts; end walls
        if (side) m.set(u, v, 2, body);
        const endWall = u === open || u === L - open - 1;
        for (let z = zWinLo; z < zLetter; z++) {
          if (endWall) m.set(u, v, z, body);
          else if (side) m.set(u, v, z, (u - open) % 2 === 1 ? win : trim);
        }
      }
      // the letterboard ring and the roof (with eaves over the boards at the open ends)
      if (side || end || u === open || u === L - open - 1) m.set(u, v, zLetter, side && !isOpen(u) ? accent : trim);
      m.set(u, v, zRoof, roof);
    }
  if (boards) for (let u = 0; u < L; u++) if (isOpen(u)) for (const v of [0, W - 1]) m.set(u, v, zRoof, roof);
  put(m, 1, L - 1, v0 + 1, v1, zRoof + 1, zRoof + 2, roof); // the clerestory
  // riders on the running boards (or at the open ends' benches on narrow cars)
  if (clothes.length)
    for (const v of boards ? [0, W - 1] : [v0, v1])
      for (const u0 of [0, L - open])
        if (rand() < 0.6) {
          const u = u0 + Math.floor(rand() * open);
          const c = m.material(clothes[Math.floor(rand() * clothes.length)]!);
          const top = Math.min(zLetter - 1, zWinLo + 2);
          for (let z = 2; z < top; z++) m.set(u, v, z, c);
          m.set(u, v, top, skin);
        }
  return m;
};

/**
 * A streetcar or light-rail car: a lower and an upper livery colour, a band
 * of large windows between posts, doors toward each end, rounded ends with a
 * cab windscreen, a roof, and a trolley pole (streetcars) or a pantograph
 * (light rail, `pantograph: 1`) above. Light-rail cars (`joints: n`) have dark
 * bellows between their sections.
 * roles: upper.*, lower.* (paired liveries, by seed), roof, window, tyre
 * (bogies, pole, bellows), light, tail.
 * params: pantograph (0), joints (0).
 */
const tram: Generator = (ctx) => {
  const { param } = ctx;
  const { L, W, H } = sizeOf(ctx, [16, 4, 10]);
  const [upperId, lowerId] = livery(ctx, "upper", "lower");
  if (L < 8 || W < 2 || H < 5) return block(L, W, H, lowerId, ctx.ramp("roof"), ctx.ramp("window"));
  const panto = param("pantograph", 0) >= 1;
  const joints = Math.max(0, Math.round(param("joints", 0)));
  const m = new VoxelModel(L, W, H + 2);
  const upper = m.material(upperId);
  const lower = m.material(lowerId);
  const roof = m.material(ctx.ramp("roof"));
  const win = m.material(ctx.ramp("window"));
  const frame = m.material(ctx.ramp("tyre"));
  const head = m.material(first(ctx, "light", "window"));
  const tail = m.material(first(ctx, "tail", "tyre"));
  const f = (x: number) => Math.round(x * L);
  const isJoint = (u: number) => {
    for (let j = 1; j <= joints; j++) if (u === Math.round((j * L) / (joints + 1))) return true;
    return false;
  };
  const lo = Math.max(2, Math.round(H * 0.38));
  const hi = H - 3;
  const nose = (u: number, v: number) => (u === 0 || u === L - 1) && (v === 0 || v === W - 1) && W >= 3;
  // bogies near each end
  for (const a of [f(0.12), L - 1 - f(0.12) - 1]) put(m, a, a + 2, Math.min(1, W - 1), Math.max(1, W - 1), 0, 1, frame);
  for (let u = 0; u < L; u++)
    for (let v = 0; v < W; v++) {
      if (nose(u, v)) continue;
      if (isJoint(u)) {
        put(m, u, u + 1, v, v + 1, 1, H - 1, frame);
        continue;
      }
      const side = v === 0 || v === W - 1;
      const end = u === 0 || u === L - 1;
      for (let z = 1; z < lo; z++) m.set(u, v, z, lower);
      for (let z = lo; z <= hi; z++) {
        let mat = side || end ? upper : lower;
        if (side && !end) {
          const door = u === 2 || u === L - 3;
          mat = door || (u - 1) % 3 !== 0 ? win : upper;
        }
        if (end && !side) mat = win; // the cab windscreens
        m.set(u, v, z, mat);
      }
      m.set(u, v, H - 2, side || end ? upper : roof);
      if (!end) m.set(u, v, H - 1, roof);
    }
  // lamps on the ends, inside the rounded corners
  for (const v of W >= 3 ? [1, W - 2] : [0, W - 1]) {
    m.set(L - 1, v, lo - 1, head);
    m.set(0, v, lo - 1, tail);
  }
  const mid = Math.floor(W / 2);
  if (panto) {
    // a pantograph's frame folded over the roof of the first section
    const u0 = Math.round(L / (2 * (joints + 1))) - 1;
    for (const u of [u0, u0 + 2]) m.set(u, mid, H, frame);
    put(m, u0, u0 + 3, Math.max(0, mid - 1), Math.min(W, mid + 1), H + 1, H + 2, frame);
  } else {
    // a trolley pole from near the back, rising toward the front
    // (a stair of voxels: each joined face to face to the one before)
    for (let t = 0; t < Math.min(6, L - 6); t++) {
      const z = H + Math.floor(t / 3);
      m.set(4 + t, mid, z, frame);
      if (t > 0 && t % 3 === 0) m.set(4 + t, mid, z - 1, frame);
    }
  }
  return m;
};

const WAGONS = ["box", "tank", "hopper", "container", "gondola"] as const;

/**
 * A train's cars. Part 0 is the locomotive: on freight trains (even variants)
 * a hood unit (a narrow long hood with grilles and roof fans behind a cab with
 * a windscreen), on passenger trains (odd variants) a full-width cab unit with
 * a sloped nose. Later parts are freight wagons (box, tank, hopper, container
 * flat, gondola, by part and seed) or bilevel coaches with two rows of windows.
 * roles: loco.*, stripe.* (paired liveries), wagon.*, container.*, coach,
 * band, window, tyre, light, tail, roof, trim.
 */
const train: Generator = (ctx) => {
  const { rand } = ctx;
  const { L, W, H } = sizeOf(ctx, [18, 4, 7]);
  const part = ctx.part ?? 0;
  const passenger = (ctx.variant ?? 0) % 2 === 1;
  const tyreId = ctx.ramp("tyre");
  const windowId = ctx.ramp("window");
  if (L < 8 || W < 2 || H < 4) {
    const body = part === 0 ? livery(ctx, "loco", "stripe")[0] : passenger ? ctx.ramp("coach") : oneOf(ctx, "wagon");
    return block(L, W, H, body, ctx.ramp("roof"), passenger || part === 0 ? windowId : undefined);
  }
  const m = new VoxelModel(L, W, H + 1);
  const tyre = m.material(tyreId);
  const win = m.material(windowId);
  const roof = m.material(ctx.ramp("roof"));
  const trim = m.material(first(ctx, "trim", "roof"));
  // two bogies under every car
  for (const a of [1, L - 4]) put(m, a, a + 3, 0, W, 0, 1, tyre);
  put(m, 0, L, 0, W, 1, 2, trim); // the frame and walkways
  if (part === 0) {
    const [bodyId, stripeId] = livery(ctx, "loco", "stripe");
    const body = m.material(bodyId);
    const stripe = m.material(stripeId);
    const head = m.material(first(ctx, "light", "window"));
    if (passenger) {
      // a full-width cab unit: a sloped nose, windscreen, side grilles
      put(m, 0, L, 0, W, 2, H, body);
      for (let u = 0; u < L; u++) for (const v of [0, W - 1]) m.set(u, v, 3, stripe);
      for (let v = 0; v < W; v++) {
        m.set(L - 1, v, H - 1, 0);
        for (let z = H - 3; z < H - 1; z++) m.set(L - 2, v, z, win);
      }
      for (let u = 3; u < L - 4; u += 2) for (const v of [0, W - 1]) m.set(u, v, H - 2, tyre);
      put(m, 0, L - 2, 0, W, H, H + 1, roof);
    } else {
      // a hood unit: the cab at the front, a narrower long hood behind
      const cab = L - Math.max(3, Math.round(L * 0.22));
      const hv0 = W >= 4 ? 1 : 0;
      const hv1 = W >= 4 ? W - 1 : W;
      put(m, 0, cab, hv0, hv1, 2, H - 1, body);
      for (let u = 1; u < cab - 1; u += 2) for (const v of [hv0, hv1 - 1]) m.set(u, v, H - 3, tyre); // grilles
      for (const u of [Math.round(cab * 0.3), Math.round(cab * 0.65)]) put(m, u, u + 2, hv0, hv1, H - 1, H, tyre); // fans
      put(m, cab, L, 0, W, 2, H, body);
      for (let u = cab; u < L; u++) for (const v of [0, W - 1]) m.set(u, v, H - 2, win);
      for (let v = 0; v < W; v++) m.set(L - 1, v, H - 2, win);
      put(m, cab, L, 0, W, H, H + 1, roof);
      for (let u = 0; u < cab; u++) for (const v of [hv0, hv1 - 1]) m.set(u, v, 2, stripe);
      for (let u = cab; u < L; u++) for (const v of [0, W - 1]) m.set(u, v, 2, stripe);
      for (let v = 0; v < W; v++) m.set(L - 1, v, 2, stripe);
    }
    m.set(L - 1, 0, 3, head);
    m.set(L - 1, W - 1, 3, head);
    return m;
  }
  if (passenger) {
    // a bilevel coach: two rows of windows, a band between, a rounded roof
    const coach = m.material(ctx.ramp("coach"));
    const band = m.material(first(ctx, "band", "coach"));
    put(m, 0, L, 0, W, 2, H, coach);
    const rows = H >= 7 ? [3, H - 2] : [H - 2];
    for (const z of rows) for (let u = 1; u < L - 1; u++) if (u % 3 !== 0) for (const v of [0, W - 1]) m.set(u, v, z, win);
    if (rows.length > 1) for (let u = 0; u < L; u++) for (const v of [0, W - 1]) m.set(u, v, Math.floor((3 + H - 2) / 2), band);
    put(m, 1, L - 1, 0, W, H, H + 1, roof);
    for (const v of [0, W - 1]) {
      m.set(1, v, H, 0);
      m.set(L - 2, v, H, 0);
    }
    return m;
  }
  const kind = WAGONS[(part + Math.floor(rand() * WAGONS.length)) % WAGONS.length]!;
  const wagon = m.material(oneOf(ctx, "wagon"));
  switch (kind) {
    case "box": {
      put(m, 0, L, 0, W, 2, H, wagon);
      for (let u = 1; u < L - 1; u += 2) for (const v of [0, W - 1]) m.set(u, v, H - 1, trim); // ribs
      const d = Math.floor(L / 2) - 1;
      for (let z = 2; z < H; z++) for (const v of [0, W - 1]) for (const u of [d, d + 1, d + 2]) m.set(u, v, z, tyre); // doors
      put(m, 0, L, 0, W, H, H + 1, roof);
      break;
    }
    case "tank":
      // a long cylinder: corners cut top and bottom, a dome in the middle
      for (let z = 2; z <= H; z++)
        for (let v = 0; v < W; v++) {
          const edge = (v === 0 || v === W - 1) && (z === 2 || z === H) && W >= 3;
          if (!edge) put(m, 1, L - 1, v, v + 1, z, z + 1, wagon);
        }
      put(m, Math.floor(L / 2) - 1, Math.floor(L / 2) + 1, Math.max(0, Math.floor(W / 2) - 1), Math.min(W, Math.floor(W / 2) + 1), H, H + 1, trim);
      break;
    case "hopper":
      // sloped ends: shorter at the bottom
      for (let z = 2; z <= H - 1; z++) {
        const cut = Math.max(0, H - 2 - z);
        put(m, cut, L - cut, 0, W, z, z + 1, wagon);
      }
      put(m, 1, L - 1, 0, W, H - 1, H, trim);
      break;
    case "container": {
      // a flat car with one or two containers in different colours
      const two = L >= 14;
      const n = two ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const c = m.material(oneOf(ctx, "container"));
        const a = 1 + Math.round((i * (L - 2)) / n);
        const b = 1 + Math.round(((i + 1) * (L - 2)) / n) - (two ? 1 : 0);
        put(m, a, b, 0, W, 2, H, c);
        for (let u = a; u < b; u += 2) for (const v of [0, W - 1]) m.set(u, v, H - 1, tyre); // corrugation
      }
      break;
    }
    case "gondola":
      // an open wagon: low walls, empty inside
      for (let z = 2; z < Math.max(3, H - 2); z++)
        for (let u = 0; u < L; u++) for (let v = 0; v < W; v++) if (u === 0 || u === L - 1 || v === 0 || v === W - 1) m.set(u, v, z, wagon);
      put(m, 1, L - 1, 1, Math.max(1, W - 1), 2, 3, tyre);
      break;
  }
  return m;
};

/**
 * A passenger ferry: a hull narrowing to the bow, a stripe at its top, decks
 * with railings, a main cabin with a band of windows, a smaller upper cabin,
 * a wheelhouse with glass all round and a mast.
 * roles: hull.*, band.* (paired liveries, by seed), cabin, window, roof,
 * trim (railings, mast).
 */
const ferry: Generator = (ctx) => {
  const { L, W, H } = sizeOf(ctx, [26, 10, 11]);
  const [hullId, bandId] = livery(ctx, "hull", "band");
  const cabinId = ctx.ramp("cabin");
  if (L < 10 || W < 4 || H < 6) return block(L, W, H, hullId, cabinId, ctx.ramp("window"));
  const f = (x: number) => Math.round(x * L);
  const hz = Math.max(2, Math.round(H * 0.3)); // the hull's height
  const d1 = Math.max(2, Math.round(H * 0.26));
  const d2 = Math.max(2, Math.round(H * 0.2));
  const sz = Math.max(H, hz + 1 + d1 + 1 + d2 + 1 + d2 + 3);
  const m = new VoxelModel(L, W, sz);
  const hull = m.material(hullId);
  const band = m.material(bandId);
  const cabin = m.material(cabinId);
  const win = m.material(ctx.ramp("window"));
  const roof = m.material(ctx.ramp("roof"));
  const trim = m.material(first(ctx, "trim", "roof"));
  // the hull's outline: narrowing over the front quarter to the bow, the stern's corners cut
  const bow = f(0.74);
  const inside = (u: number, v: number) => {
    let half = (W - 1) / 2;
    if (u > bow) half *= 1 - ((u - bow) / Math.max(1, L - 1 - bow)) * 0.75;
    if (u === 0) half -= 1;
    return Math.abs(v - (W - 1) / 2) <= half + 0.01;
  };
  const edge = (u: number, v: number) =>
    inside(u, v) && (!inside(u - 1, v) || !inside(u + 1, v) || !inside(u, v - 1) || !inside(u, v + 1) || u === 0 || u === L - 1);
  for (let u = 0; u < L; u++)
    for (let v = 0; v < W; v++) {
      if (!inside(u, v)) continue;
      for (let z = 0; z < hz; z++) m.set(u, v, z, z === hz - 1 ? band : hull);
      m.set(u, v, hz, roof); // the main deck
      if (edge(u, v)) m.set(u, v, hz + 1, trim); // railings
    }
  // cabins: a long main cabin, a shorter upper one, the wheelhouse forward on top
  const cabinBox = (u0: number, u1: number, v0: number, v1: number, z0: number, d: number, glassAll: boolean) => {
    for (let u = u0; u < u1; u++)
      for (let v = v0; v < v1; v++)
        for (let z = z0; z < z0 + d; z++) {
          const wall = u === u0 || u === u1 - 1 || v === v0 || v === v1 - 1;
          const band = z === z0 + d - 1 || (d >= 3 && z === z0 + 1);
          const glass = wall && band && (glassAll || (u + v) % 3 !== 0);
          m.set(u, v, z, glass ? win : cabin);
        }
    put(m, u0, u1, v0, v1, z0 + d, z0 + d + 1, roof);
  };
  const z1 = hz + 1;
  cabinBox(f(0.1), f(0.76), 1, W - 1, z1, d1, false);
  const z2 = z1 + d1 + 1;
  const in2 = W >= 8 ? 2 : 1;
  cabinBox(f(0.22), f(0.62), in2, W - in2, z2, d2, false);
  for (let u = f(0.22); u < f(0.62); u++) for (const v of [in2 - 1, W - in2]) m.set(u, v, z2, trim); // upper deck railings
  const z3 = z2 + d2 + 1;
  const in3 = Math.min(Math.floor(W / 2) - 1, in2 + 1);
  cabinBox(f(0.5), f(0.62), in3, W - in3, z3, d2, true);
  // a mast on the wheelhouse
  const mu = Math.round((f(0.5) + f(0.62)) / 2);
  const mv = Math.floor(W / 2);
  for (let z = z3 + d2 + 1; z < sz; z++) m.set(mu, mv, z, trim);
  return m;
};

/** A symmetric band across a model `W` wide: [v0, v1) of about `w` columns, about the centre line. */
function band(W: number, w: number): [number, number] {
  let n = Math.max(1, Math.min(W, Math.round(w)));
  if ((W - n) % 2) n = n + 1 <= W ? n + 1 : n - 1; // same parity as W, so it sits on the centre line
  const v0 = (W - n) / 2;
  return [v0, v0 + n];
}

/** The plane's own shape: a high-wing single-engine light aircraft. */
function planeModel(ctx: GenContext, L: number, W: number, H: number): VoxelModel {
  const [bodyId, stripeId] = livery(ctx, "body", "stripe");
  const m = new VoxelModel(L, W, H);
  const body = m.material(bodyId);
  const stripe = m.material(stripeId);
  const f = (x: number) => Math.round(x * L);
  if (L < 8 || W < 6 || H < 3) {
    // too small for detail: a fuselage, a wing and a tailplane
    const [c0, c1] = band(W, 1);
    put(m, 0, L, c0, c1, 0, Math.min(H, 2), body);
    put(m, f(0.45), Math.max(f(0.45) + 1, f(0.7)), 0, W, Math.min(H, 2) - 1, Math.min(H, 2), body);
    const [t0, t1] = band(W, W * 0.4);
    put(m, 0, Math.max(1, f(0.15)), t0, t1, Math.min(H, 2) - 1, Math.min(H, 2), stripe);
    return m;
  }
  const glass = m.material(ctx.ramp("glass"));
  const trim = m.material(first(ctx, "trim", "tyre"));
  const tyre = m.material(ctx.ramp("tyre"));
  const light = m.material(first(ctx, "light", "glass"));
  const tail = m.material(first(ctx, "tail", "stripe"));
  // the fuselage: a box from the firewall back, narrowing and rising into a tail boom
  const top = Math.max(2, Math.min(H - 2, Math.round(H * 0.55))); // the cabin roof (z), where the wing sits
  const [fv0, fv1] = band(W, Math.max(2, W * 0.16));
  const [bv0, bv1] = band(W, 1);
  const boom = f(0.38); // the cabin ends here; the boom runs aft
  for (let u = 0; u < L - 1; u++) {
    const t = u < boom ? u / Math.max(1, boom) : 1; // 0 at the tail, 1 at the cabin
    const [v0, v1] = u < boom ? (t < 0.5 ? [bv0, bv1] : band(W, Math.max(1, (fv1 - fv0) * t))) : [fv0, fv1];
    const z0 = u < boom ? Math.round((1 - t) * (top - 2)) + 1 : 1;
    put(m, u, u + 1, v0, v1, z0, top, body);
  }
  // a stripe down each side, on the fuselage's outermost voxels
  const sz = Math.max(1, Math.round(top * 0.45));
  for (let u = 1; u < L - 1; u++) {
    let lo = -1;
    let hi = -1;
    for (let v = 0; v < W; v++)
      if (m.get(u, v, sz)) {
        if (lo < 0) lo = v;
        hi = v;
      }
    if (lo >= 0) {
      m.set(u, lo, sz, stripe);
      m.set(u, hi, sz, stripe);
    }
  }
  // the cabin's side windows between frames, and the windscreen at its front
  const c0 = f(0.52);
  const c1 = Math.min(L - 3, f(0.76));
  for (let u = c0; u < c1; u++)
    for (const v of [fv0, fv1 - 1]) for (let z = sz + 1; z < top; z++) if ((u - c0) % 3 !== 2 || u === c1 - 1) m.set(u, v, z, glass);
  for (let v = fv0; v < fv1; v++) for (let z = sz + 1; z < top; z++) m.set(c1, v, z, glass);
  // the cowling ahead of it sits a voxel lower, then the propeller: a hub on the nose, its blades a cross
  put(m, c1 + 1, L - 1, fv0, fv1, top - 1, top, 0);
  const hub = Math.max(1, Math.floor(top / 2));
  const blade = Math.max(1, Math.round(W * 0.12));
  put(m, L - 1, L, ...band(W, 2 * blade + 1), hub, hub + 1, trim);
  put(m, L - 1, L, bv0, bv1, Math.max(0, hub - blade), Math.min(H, hub + blade + 1), trim);
  // the wing on the cabin roof, its tips in the stripe and navigation lights at the ends
  const w0 = f(0.5);
  const w1 = Math.max(w0 + 2, f(0.72));
  put(m, w0, w1, 0, W, top, top + 1, body);
  for (const v of [0, W - 1]) {
    put(m, w0, w1, v, v + 1, top, top + 1, stripe);
    m.set(w1 - 1, v, top, light);
  }
  // struts from the fuselage's sides up and out to the wing, in face-joined steps
  for (let k = 0; fv0 - 1 - k >= 0 && sz + k < top; k++) {
    const v = fv0 - 1 - k;
    const z = sz + k;
    for (const s of [v, W - 1 - v]) {
      m.set(w0 + 1, s, z, trim);
      if (z + 1 < top) m.set(w0 + 1, s, z + 1, trim);
    }
  }
  // the tail: a tailplane and a fin in the stripe, a light at the top
  const tw = Math.max(1, f(0.16));
  const [s0, s1] = band(W, W * 0.42);
  const tz = Math.min(H - 2, top - 1);
  put(m, 0, tw, s0, s1, tz, tz + 1, body);
  put(m, 0, Math.max(1, tw - 1), bv0, bv1, tz + 1, H, stripe);
  put(m, 0, 1, bv0, bv1, H - 1, H, tail);
  // the landing gear: main wheels on legs, a nose wheel
  const g = Math.round((w0 + w1) / 2);
  for (const v of [Math.max(0, fv0 - 1), Math.min(W - 1, fv1)]) {
    m.set(g, v, 0, tyre);
    m.set(g, v, 1, trim);
  }
  put(m, L - 2, L - 1, bv0, bv1, 0, 1, tyre);
  return m;
}

/**
 * A light aircraft (M4's player plane): a high-wing single-engine plane with
 * a cabin, a strut-braced wing, a tailplane and fin, a propeller and fixed
 * gear, painted in a body colour with a stripe. Generic: no registration,
 * lettering or emblems. It faces +x; `ctx.size` is length × wingspan ×
 * height (voxels).
 *
 * `part` 1 is its drop shadow: the plane's outline seen from above, one
 * voxel thick, dithered (every other voxel, so the ground shows through), in
 * the `shadow` ramp.
 * roles: body.*, stripe.* (paired liveries, by seed), glass, trim (propeller,
 * struts, gear legs), tyre, light (navigation lights), tail (the fin's
 * light), shadow.
 */
const plane: Generator = (ctx) => {
  const { L, W, H } = sizeOf(ctx, [20, 22, 7]);
  const model = planeModel(ctx, L, W, H);
  if (ctx.part !== 1) return model;
  const shadow = new VoxelModel(L, W, 1);
  const s = shadow.material(first(ctx, "shadow", "tyre"));
  for (let u = 0; u < L; u++)
    for (let v = 0; v < W; v++) {
      if ((u + v) % 2) continue;
      for (let z = 0; z < model.sz; z++)
        if (model.get(u, v, z)) {
          shadow.set(u, v, 0, s);
          break;
        }
    }
  return shadow;
};

export const VEHICLE_MODEL_GENERATORS: Record<string, Generator> = { car, bus, cableTram, tram, train, ferry, plane };
