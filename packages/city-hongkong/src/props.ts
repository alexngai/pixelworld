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

export const PROP_GENERATORS: Record<string, Generator> = { neonSign };
