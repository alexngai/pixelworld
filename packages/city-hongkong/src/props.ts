import { VoxelModel, type Generator } from "pixelworld/generators";

/**
 * Hong Kong's projecting neon signs (D-108): the boards that hang out over
 * Nathan Road and the side streets from both sides, a street's worth of them
 * in one model. Placed across the road (`streetProps` with `across: true`),
 * so the model's x runs across the street from one building line (x = 0) to
 * the other (x = span) and its y along it. From each side hang one to three
 * boards (`count` on average, by seed), each at its own place along the
 * street and its own height, so the two sides stagger: a board a voxel thick,
 * jutting out across the street a voxel off the wall, wide and low or tall
 * and narrow, its field one neon colour, its tube border and its blocks of
 * characters (no lettering: speckled cells) another. Each hangs on its steel
 * frame, drawn in one-pixel lines (D-098): an arm along its top from the
 * wall, a stay from higher up the wall to its far corner, a bracket at its
 * foot. The middle of the street stays clear. A prop, not a building: the
 * boards hang from the walls on their frames.
 * params: span (voxels between the building lines; 28), length (voxels along
 * the street; 18), low and high (the boards' lowest foot and highest top,
 * voxels; 10 and 32), reach (the widest board's voxels; 9), count (boards a
 * side on average; 2).
 * roles: sign (sign.* variants: a board's field and tube), frame (the arms).
 */
export const neonSign: Generator = ({ rand, ramp, ramps, param }) => {
  const S = Math.max(10, Math.round(param("span", 28)));
  const L = Math.max(3, Math.round(param("length", 18)));
  const low = Math.max(1, Math.round(param("low", 10)));
  const high = Math.max(low + 6, Math.round(param("high", 32)));
  const reach = Math.max(3, Math.min(Math.round(param("reach", 9)), Math.floor(S / 2) - 2));
  const per = Math.max(1, param("count", 2));
  const m = new VoxelModel(S, L, high + 6);
  const signs = (ramps("sign").length ? ramps("sign") : [ramp("sign")]).map((r) => m.material(r));
  const frame = m.material(ramp("frame"));
  const pick = () => signs[Math.floor(rand() * signs.length)]!;
  const boards: { x0: number; x1: number; y: number; z0: number; z1: number }[] = [];
  const clash = (b: (typeof boards)[number]) =>
    boards.some((o) => Math.abs(o.y - b.y) <= 1 && o.x0 <= b.x1 && b.x0 <= o.x1 && o.z0 <= b.z1 + 1 && b.z0 <= o.z1 + 1);

  for (const side of [0, 1]) {
    const n = 1 + Math.floor(rand() * (2 * per - 1));
    for (let k = 0; k < n; k++)
      for (let attempt = 0; attempt < 8; attempt++) {
        // wide and low, or tall and narrow (characters stacked down it)
        const tall = rand() < 0.45;
        const w = tall ? 3 + Math.floor(rand() * 3) : Math.min(reach, 5 + Math.floor(rand() * Math.max(1, reach - 4)));
        const h = Math.min(high - low, tall ? 9 + Math.floor(rand() * 8) : 4 + Math.floor(rand() * 5));
        const z0 = low + Math.floor(rand() * (high - low - h + 1));
        const x0 = side === 0 ? 1 : S - 1 - w;
        const b = { x0, x1: x0 + w - 1, y: Math.floor(rand() * L), z0, z1: z0 + h - 1 };
        if (clash(b)) continue;
        boards.push(b);
        board(m, b, pick(), pick, rand);
        // the frame, from the wall: an arm along the top, a stay to the far top corner, a bracket at the foot
        const wall = side === 0 ? 0 : S;
        const far = side === 0 ? b.x1 + 1 : b.x0;
        const near = side === 0 ? b.x0 : b.x1 + 1;
        const yc = b.y + 0.5;
        const top = b.z1 + 1;
        m.line([wall, yc, top], [far, yc, top], frame);
        m.line([wall, yc, top + Math.min(4, Math.max(2, Math.round(w * 0.4)))], [far, yc, top], frame);
        m.line([wall, yc, b.z0], [near, yc, b.z0], frame);
        break;
      }
  }
  return m;
};

/** A board a voxel thick: its tube border, and inside it cells of characters in the tube's colour on the field. */
function board(m: VoxelModel, b: { x0: number; x1: number; y: number; z0: number; z1: number }, field: number, pick: () => number, rand: () => number): void {
  let tube = pick();
  for (let i = 0; i < 3 && tube === field; i++) tube = pick();
  const iw = b.x1 - b.x0 - 1; // the inside's width
  // characters two voxels wide where there is room, one where not, a row of field between each
  const cw = iw >= 2 ? 2 : 1;
  for (let z = b.z0; z <= b.z1; z++)
    for (let x = b.x0; x <= b.x1; x++) {
      const edge = x === b.x0 || x === b.x1 || z === b.z0 || z === b.z1;
      const i = x - b.x0 - 1;
      const j = b.z1 - 1 - z;
      const inGlyph = i % (cw + 1) < cw && j % 3 < 2;
      m.set(x, b.y, z, edge || (inGlyph && rand() < 0.55) ? tube : field);
    }
}

/**
 * A boat afloat (D-133), moored in a typhoon shelter or out on the harbour,
 * standing on the water's level (the instance's `z0`), its hull's lowest
 * voxel under the plane. By seed, unless `kind` names one: a sampan (a small
 * open hull under an arched canopy of tarpaulin, 11 voxels long), a fishing
 * boat (a broad hull with a stripe, a wheelhouse aft and a mast, 24 long) or,
 * with `kind: 3`, a junk (a dark hull with a raised stern and two masts
 * carrying battened red sails, 28 long). Faces +x; the hull narrows to its bow.
 * params: kind (0: sampans and fishing boats by seed, 1 a sampan, 2 a fishing
 * boat, 3 a junk), fishing (0.35, the share of fishing boats).
 * roles: hull.*, stripe.*, canopy.*, cabin, window, sail, trim (masts, battens).
 */
export const boat: Generator = ({ rand, ramp, ramps, param }) => {
  const kind = Math.round(param("kind", 0)) || (rand() < param("fishing", 0.35) ? 2 : 1);
  const L = kind === 1 ? 11 : kind === 2 ? 24 : 28;
  const W = kind === 1 ? 3 : 7;
  const mast = kind === 1 ? 0 : kind === 2 ? 12 : 22;
  const m = new VoxelModel(L, W, 6 + mast);
  const one = (role: string) => {
    const ids = ramps(role);
    return m.material(ids.length ? ids[Math.floor(rand() * ids.length)]! : ramp(role));
  };
  const hull = one("hull");
  const stripe = kind === 3 ? hull : one("stripe");
  const trim = m.material(ramp("trim"));
  // the hull, narrowing to its bow over its last quarter; a stripe along its top
  const bow = Math.max(2, Math.round(L / 4));
  const half = (u: number) => (u < L - bow ? W / 2 : (W / 2) * Math.max(0.35, (L - u) / bow));
  const c = (W - 1) / 2;
  const deck = kind === 1 ? 2 : 3;
  for (let u = 0; u < L; u++)
    for (let v = 0; v < W; v++) {
      if (Math.abs(v - c) > half(u) - 0.25) continue;
      for (let z = 0; z < deck; z++) m.set(u, v, z, z === deck - 1 ? stripe : hull);
      if (kind === 3 && u < 4) for (let z = deck; z < deck + 2; z++) m.set(u, v, z, hull); // the raised stern
    }
  if (kind === 1) {
    // an arched canopy over the middle: tarpaulin in a barrel
    const canopy = one("canopy");
    for (let u = 2; u < L - 3; u++) {
      m.set(u, 0, deck, canopy);
      m.set(u, W - 1, deck, canopy);
      for (let v = 0; v < W; v++) m.set(u, v, deck + 1, canopy);
    }
    return m;
  }
  if (kind === 2) {
    // the wheelhouse aft, windows round its top; a mast forward of it
    const cabin = m.material(ramp("cabin"));
    const win = m.material(ramp("window"));
    for (let u = 2; u < 8; u++)
      for (let v = 1; v < W - 1; v++)
        for (let z = deck; z < deck + 3; z++) {
          const skin = u === 2 || u === 7 || v === 1 || v === W - 2;
          m.set(u, v, z, skin && z === deck + 1 && (u + v) % 2 === 0 ? win : cabin);
        }
    for (let z = deck; z < deck + mast; z++) m.set(11, Math.floor(c), z, trim);
    return m;
  }
  // a junk: two masts, each with a battened red sail along the hull, a voxel thick
  const sail = m.material(ramp("sail"));
  const v0 = Math.floor(c);
  for (const [u0, len, top] of [
    [7, 9, mast],
    [17, 7, mast - 5],
  ] as const) {
    for (let z = deck; z < deck + top; z++) m.set(u0 + len, v0, z, trim);
    for (let z = deck + 3; z < deck + top; z++)
      for (let u = u0 + Math.max(0, Math.floor((deck + top - z) / 4) - 1); u < u0 + len; u++)
        m.set(u, v0, z, (z - deck) % 3 === 0 ? trim : sail);
  }
  return m;
};

/**
 * A street market's stalls (D-134), down the middle of a market street (the
 * Ladies' Market, Temple Street, Chun Yeung Street): two rows back to back,
 * each stall its own tarpaulin over a table of goods, the aisles either side
 * left clear. Placed across the road (`streetProps` with `across: true`), so
 * the model's x runs from one building line (x = 0) to the other (x = span)
 * and its y along the street; its stalls fill the length, a voxel's gap
 * between them. Some stalls hang goods (clothes, bags) along a rail under the
 * canopy's edge; bare bulbs are strung along the tarpaulins' aisle edges, so
 * the market glows at night.
 * params: span (voxels between the building lines; 24), length (voxels along
 * the street; 18), depth (a row's depth; 4), height (the canopy's; 6).
 * roles: canopy.* (tarpaulins), goods.* (what's on the tables and the rails),
 * table, frame (posts and rails), lamp (the bulbs, lit at night).
 */
export const marketStalls: Generator = ({ rand, ramp, ramps, param }) => {
  const S = Math.max(10, Math.round(param("span", 24)));
  const L = Math.max(6, Math.round(param("length", 18)));
  const D = Math.max(2, Math.min(Math.round(param("depth", 4)), Math.floor(S / 2) - 2));
  const H = Math.max(4, Math.round(param("height", 6)));
  const m = new VoxelModel(S, L, H + 1);
  const pick = (role: string) => {
    const ids = ramps(role);
    return m.material(ids.length ? ids[Math.floor(rand() * ids.length)]! : ramp(role));
  };
  const table = m.material(ramp("table"));
  const frame = m.material(ramp("frame"));
  const lamp = m.material(ramp("lamp"));
  const mid = Math.floor(S / 2);
  for (const [x0, x1, out] of [
    [mid - D, mid, -1],
    [mid, mid + D, 1],
  ] as const) {
    let y = 0;
    while (y < L) {
      const len = Math.min(L - y, 4 + Math.floor(rand() * 3));
      const canopy = pick("canopy");
      const hangs = rand() < 0.4;
      for (let yy = y; yy < y + len - 1; yy++) {
        for (let x = x0; x < x1; x++) {
          const edge = out < 0 ? x === x0 : x === x1 - 1; // the aisle's side
          m.set(x, yy, 1, table);
          if (!edge) m.set(x, yy, 2, rand() < 0.75 ? pick("goods") : table);
          // the tarpaulin, a voxel lower over the aisle, bare bulbs strung along that edge
          m.set(x, yy, edge ? H - 1 : H, edge && (yy - y) % 2 === 1 ? lamp : canopy);
          // goods hung along a rail under the canopy's edge, a post at each end of the stall
          if (edge) {
            const post = yy === y || yy === y + len - 2;
            for (let z = 0; z < H - 1; z++) {
              if (post) m.set(x, yy, z, frame);
              else if (hangs && z >= H - 3) m.set(x, yy, z, pick("goods"));
            }
          }
        }
        // the inner posts hold the tarpaulin's high side up
        const inner = out < 0 ? x1 - 1 : x0;
        if (yy === y || yy === y + len - 2) for (let z = 0; z < H; z++) m.set(inner, yy, z, frame);
        else for (let z = 3; z < H; z++) m.set(inner, yy, z, frame);
      }
      y += len;
    }
  }
  return m;
};

export const PROP_GENERATORS: Record<string, Generator> = { neonSign, boat, marketStalls };
