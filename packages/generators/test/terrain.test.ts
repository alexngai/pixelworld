import { TerrainGrid, packShape } from "@pixelworlds/grid";
import { describe, expect, it } from "vitest";
import { FACE_CLIFF, FACE_SKIRT, buildBoxesMesh, buildTerrainMesh, type MeshData } from "../src/index";

function facesOfKind(mesh: MeshData, kind: number): number {
  let n = 0;
  for (let v = 0; v < mesh.vertexCount; v += 3) if (mesh.material[v * 3 + 1] === kind) n++;
  return n;
}

/** Total area of cliff faces in (cell × step) units; they are vertical, so this is exact. */
function cliffArea(mesh: MeshData): number {
  let area = 0;
  for (let v = 0; v < mesh.vertexCount; v += 3) {
    if (mesh.material[v * 3 + 1] !== FACE_CLIFF) continue;
    const p = (k: number) => [0, 1, 2].map((c) => mesh.position[(v + k) * 3 + c]!);
    const [a, b, c] = [p(0), p(1), p(2)];
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const cross = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    area += Math.hypot(cross[0]!, cross[1]!, cross[2]!) / 2;
  }
  return area;
}

describe("terrain mesh", () => {
  it("emits two top triangles per flat cell and skirts only at world edges", () => {
    const g = new TerrainGrid(3, 2);
    g.base.fill(5);
    const m = buildTerrainMesh(g, { x0: 0, y0: 0, x1: 3, y1: 2 }, { floor: 3 });
    expect(facesOfKind(m, 0)).toBe(12);
    expect(facesOfKind(m, FACE_CLIFF)).toBe(0);
    // perimeter of 10 edges, each a 2-step skirt split into 2 triangles
    expect(facesOfKind(m, FACE_SKIRT)).toBe(20);
  });

  it("emits each cliff once, from the higher side", () => {
    const g = new TerrainGrid(2, 1);
    g.base.set([7, 3]);
    const m = buildTerrainMesh(g, { x0: 0, y0: 0, x1: 2, y1: 1 }, { floor: 0 });
    expect(facesOfKind(m, FACE_CLIFF)).toBe(2);
    expect(cliffArea(m)).toBeCloseTo(4, 9); // 1 cell wide × 4 steps
    for (let v = 0; v < m.vertexCount; v++)
      if (m.material[v * 3 + 1] === FACE_CLIFF) expect(m.cell[v * 2]).toBe(0); // owned by the high cell
  });

  it("handles crossing edges with partial faces", () => {
    const g = new TerrainGrid(2, 1);
    // left cell: c1 raised (NE up), right cell: c3 raised (SW up) → shared edge crosses
    g.base.set([2, 2]);
    g.shape.set([packShape(0, 1, 0, 0), packShape(0, 0, 0, 1)]);
    const m = buildTerrainMesh(g, { x0: 0, y0: 0, x1: 2, y1: 1 }, { floor: 0 });
    expect(cliffArea(m)).toBeCloseTo(0.5, 9); // two triangles of 0.25
  });

  it("uses upward normals for top faces and outward normals for cliffs", () => {
    const g = new TerrainGrid(2, 1);
    g.base.set([4, 1]);
    g.shape.set([packShape(0, 1, 1, 0), 0]);
    const m = buildTerrainMesh(g, { x0: 0, y0: 0, x1: 2, y1: 1 }, { floor: 0 });
    for (let v = 0; v < m.vertexCount; v++) {
      const kind = m.material[v * 3 + 1];
      const nz = m.normal[v * 3 + 2]!;
      if (kind === 0 || kind === 1) expect(nz).toBeGreaterThan(0);
      if (kind === FACE_CLIFF) expect(Math.abs(nz)).toBe(0);
    }
  });

  it("darkens ambient occlusion at the foot of a cliff", () => {
    const g = new TerrainGrid(4, 4);
    g.base.fill(0);
    for (let y = 0; y < 4; y++) g.base[g.index(0, y)] = 8;
    const m = buildTerrainMesh(g, { x0: 0, y0: 0, x1: 4, y1: 4 });
    let foot = 1, open = 0;
    for (let v = 0; v < m.vertexCount; v++) {
      const [x, y, h] = [0, 1, 2].map((c) => m.position[v * 3 + c]!);
      const ao = m.material[v * 3 + 2]!;
      if (x === 1 && y === 2 && h === 0) foot = Math.min(foot, ao);
      if (x === 4 && y === 2 && h === 0) open = Math.max(open, ao);
    }
    expect(foot).toBeLessThan(open);
  });
});

describe("multi-step slopes", () => {
  it("joins a 3-step ramp to its neighbours without cliffs", () => {
    const g = new TerrainGrid(3, 1);
    g.base.set([0, 0, 3]);
    g.shape.set([0, packShape(0, 3, 3, 0), 0]); // flat → 3-step ramp → flat
    const m = buildTerrainMesh(g, { x0: 0, y0: 0, x1: 3, y1: 1 }, { floor: 0 });
    expect(facesOfKind(m, FACE_CLIFF)).toBe(0);
    expect(facesOfKind(m, 1)).toBe(2); // the ramp's two sloped triangles
  });
});

describe("box mesh", () => {
  it("emits 12 triangles per box", () => {
    const m = buildBoxesMesh([{ x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1, ramp: 3 }]);
    expect(m.vertexCount).toBe(36);
    expect(m.material[0]).toBe(103);
  });
});
