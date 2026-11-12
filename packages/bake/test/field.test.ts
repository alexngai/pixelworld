import { describe, expect, it } from "vitest";
import { frontEdges, nearFirst } from "../src/baker";

describe("field draw order and walls", () => {
  it("draws the walls that face the viewer in each rotation", () => {
    // rotation 0 looks from +x +y: the east (1) and south (2) edges face the camera
    expect(frontEdges(0)).toEqual([1, 2]);
    for (const r of [0, 1, 2, 3] as const) {
      const e = frontEdges(r);
      expect(e).toHaveLength(2);
      expect(new Set(e).size).toBe(2);
      expect(Math.abs(e[0] - e[1]) % 2).toBe(1); // adjacent edges, never opposite ones
    }
    expect(new Set([0, 1, 2, 3].map((r) => frontEdges(r as 0).join()))).toHaveProperty("size", 4);
  });

  it("orders micro-cells nearest first", () => {
    expect(nearFirst(0)).toEqual([1, 1]);
    expect(new Set([0, 1, 2, 3].map((r) => nearFirst(r as 0).join()))).toHaveProperty("size", 4);
  });
});

describe("face kinds in the shaders", () => {
  it("draws water planes with a kind of their own, not an object's (D-094)", async () => {
    const { FACE_OBJECT, FACE_WATER } = await import("@pixelworlds/generators");
    const { FIELD_GBUFFER_FS, FIELD_GBUFFER_VS, GBUFFER_FS } = await import("../src/shaders");
    expect(FACE_WATER).not.toBe(FACE_OBJECT);
    for (const src of [FIELD_GBUFFER_FS, FIELD_GBUFFER_VS, GBUFFER_FS])
      expect(src).toContain(`const int FACE_WATER = ${FACE_WATER};`);
  });
});
