import { describe, expect, it } from "vitest";
import { project, ROTATIONS } from "@pixelworlds/grid";
import { Minimap, viewOnGround } from "../src/minimap";

/** The minimap's projection (D-146): no DOM is needed until it draws. */
const map = (iso: boolean, cellsX = 300, cellsY = 120) => {
  const m = new Minimap({ width: 0, height: 0 } as HTMLCanvasElement, { iso });
  m.setWorld({ cellsX, cellsY }, null, []);
  return m;
};

describe("minimap", () => {
  it("shows north where the view does, in each rotation", () => {
    // rotation 0 looks with north up and to the right; each Q/E turns it a quarter
    const expected = [
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ];
    const m = map(true);
    for (const r of ROTATIONS) {
      m.rotation = r;
      const [ax, ay] = m.toMap(50, 50);
      const [bx, by] = m.toMap(50, 49);
      expect([Math.sign(bx - ax), Math.sign(by - ay)]).toEqual(expected[r]);
      // the same direction as the view draws it
      const p = project(0, -1, 0, r);
      expect((by - ay) / (bx - ax)).toBeCloseTo(p.sy / p.sx);
    }
  });

  it("finds the cell under a point of the map", () => {
    for (const iso of [false, true])
      for (const r of ROTATIONS) {
        const m = map(iso);
        m.rotation = r;
        const [x, y] = m.toCell(...m.toMap(37.5, 101));
        expect(x).toBeCloseTo(37.5);
        expect(y).toBeCloseTo(101);
      }
  });

  it("fits any world in its box, touching each side", () => {
    const m = map(true, 1000, 50);
    for (const r of ROTATIONS) {
      m.rotation = r;
      const pts = [
        [0, 0],
        [1000, 0],
        [1000, 50],
        [0, 50],
      ].map(([x, y]) => m.toMap(x!, y!));
      expect(Math.min(...pts.map((p) => p[0]))).toBeCloseTo(0);
      expect(Math.max(...pts.map((p) => p[0]))).toBeCloseTo(m.canvas.width);
      expect(Math.min(...pts.map((p) => p[1]))).toBeCloseTo(0);
      expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(m.canvas.height);
    }
  });

  it("draws the ground on screen as the screen's own rectangle", () => {
    const m = map(true);
    for (const r of ROTATIONS) {
      m.rotation = r;
      // a 640×360 view (render px) at render scale 2, around cell (150, 60)
      const view = { camera: { x: 150, y: 60, rotation: r, internalWidth: 640, internalHeight: 360 }, world: { renderScale: 2 } };
      const [tl, tr, br, bl] = viewOnGround(view).map(([x, y]) => m.toMap(x, y));
      expect(tl![1]).toBeCloseTo(tr![1]); // top edge level
      expect(tr![0]).toBeCloseTo(br![0]); // right edge upright
      expect(bl![1]).toBeCloseTo(br![1]);
      expect((tr![0] - tl![0]) / (bl![1] - tl![1])).toBeCloseTo(640 / 360);
      const [cx, cy] = m.toMap(150, 60);
      expect((tl![0] + br![0]) / 2).toBeCloseTo(cx);
      expect((tl![1] + br![1]) / 2).toBeCloseTo(cy);
    }
  });
});
