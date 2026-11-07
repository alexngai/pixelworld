import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NO_WATER, TerrainGrid } from "@pixelworld/grid";
import { describe, expect, it } from "vitest";
import {
  ChunkFormatError,
  assembleTerrain,
  decodeChunk,
  encodeChunk,
  parseManifest,
  verticalExaggeration,
  type WorldManifest,
} from "../src/index";

const goldenDir = fileURLToPath(new URL("../../../testdata/world-format/", import.meta.url));

function loadGolden() {
  const bin = readFileSync(goldenDir + "chunk-v0-small.pxwc");
  const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
  const expected = JSON.parse(readFileSync(goldenDir + "chunk-v0-small.json", "utf8")) as {
    x: number;
    y: number;
    size: number;
    base: number[];
    slope: number[];
    surface: number[];
    water: number[];
  };
  return { buffer, expected };
}

describe("chunk codec v0", () => {
  it("decodes the Python-written golden file", () => {
    const { buffer, expected } = loadGolden();
    const c = decodeChunk(buffer);
    expect([c.x, c.y, c.size]).toEqual([expected.x, expected.y, expected.size]);
    expect(Array.from(c.terrain.base)).toEqual(expected.base);
    expect(Array.from(c.terrain.slope)).toEqual(expected.slope);
    expect(Array.from(c.terrain.surface)).toEqual(expected.surface);
    expect(Array.from(c.terrain.water)).toEqual(expected.water);
  });

  it("re-encodes the golden file byte for byte", () => {
    const { buffer } = loadGolden();
    const again = encodeChunk(decodeChunk(buffer));
    expect(new Uint8Array(again)).toEqual(new Uint8Array(buffer));
  });

  it("omits the water section when there is no water", () => {
    const t = new TerrainGrid(2, 2);
    const c = decodeChunk(encodeChunk({ x: 0, y: 0, size: 2, terrain: t }));
    expect(Array.from(c.terrain.water)).toEqual([NO_WATER, NO_WATER, NO_WATER, NO_WATER]);
  });

  it("rejects corrupt input", () => {
    const { buffer } = loadGolden();
    const bad = buffer.slice(0);
    new Uint8Array(bad)[0] = 0x58;
    expect(() => decodeChunk(bad)).toThrow(ChunkFormatError);
    const badVersion = buffer.slice(0);
    new DataView(badVersion).setUint16(4, 9, true);
    expect(() => decodeChunk(badVersion)).toThrow(ChunkFormatError);
    expect(() => decodeChunk(buffer.slice(0, 40))).toThrow(ChunkFormatError);
  });
});

describe("manifest", () => {
  const manifest: WorldManifest = {
    format: "pixelworld-world",
    formatVersion: 0,
    id: "t",
    name: "test",
    chunkSize: 2,
    cellsX: 3,
    cellsY: 2,
    chunks: [],
    scale: { metersPerCell: 1, metersPerStep: 1, elevationDatumMeters: 0 },
    surfaces: { "0": "none" },
    style: "s",
    attribution: [],
  };

  it("validates required fields", () => {
    expect(parseManifest(structuredClone(manifest)).id).toBe("t");
    expect(() => parseManifest({ ...manifest, formatVersion: 3 })).toThrow();
    expect(() => parseManifest({ ...manifest, cellsX: 0 })).toThrow();
    expect(() =>
      parseManifest({ ...manifest, scale: { ...manifest.scale, verticalExaggeration: 0 } }),
    ).toThrow();
  });

  it("reports vertical exaggeration, explicit or implied by the scale", () => {
    const scale = { metersPerCell: 160, metersPerStep: 40, elevationDatumMeters: 0 };
    expect(verticalExaggeration(scale)).toBeCloseTo(1.633, 3);
    expect(verticalExaggeration({ ...scale, verticalExaggeration: 3 })).toBe(3);
  });

  it("assembles chunks into one grid, clipping padding", () => {
    const a = new TerrainGrid(2, 2, { base: new Int16Array([1, 2, 3, 4]) });
    const b = new TerrainGrid(2, 2, { base: new Int16Array([5, 6, 7, 8]) });
    const grid = assembleTerrain(manifest, [
      { x: 0, y: 0, size: 2, terrain: a },
      { x: 1, y: 0, size: 2, terrain: b },
    ]);
    expect(Array.from(grid.base)).toEqual([1, 2, 5, 3, 4, 7]);
  });
});
