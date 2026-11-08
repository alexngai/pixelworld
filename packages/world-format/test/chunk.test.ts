import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NO_WATER, TerrainGrid, packShape, shapeFromV0Mask, shapeRise } from "@pixelworld/grid";
import { describe, expect, it } from "vitest";
import {
  ChunkFormatError,
  assembleTerrain,
  decodeChunk,
  encodeChunk,
  isGzip,
  maybeGunzip,
  parseManifest,
  verticalExaggeration,
  type WorldManifest,
} from "../src/index";

const goldenDir = fileURLToPath(new URL("../../../testdata/world-format/", import.meta.url));

interface GoldenExpected {
  x: number;
  y: number;
  size: number;
  base: number[];
  shape?: number[];
  slope?: number[];
  surface: number[];
  water: number[];
  road?: number[];
  roadClass?: number[];
  geology?: number[];
}

function loadGolden(name: string) {
  const bin = readFileSync(goldenDir + `${name}.pxwc`);
  const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
  const expected = JSON.parse(readFileSync(goldenDir + `${name}.json`, "utf8")) as GoldenExpected;
  return { buffer, expected };
}

describe("chunk codec", () => {
  it("decodes the Python-written v1 golden file", () => {
    const { buffer, expected } = loadGolden("chunk-v1-small");
    const c = decodeChunk(buffer);
    expect([c.x, c.y, c.size]).toEqual([expected.x, expected.y, expected.size]);
    expect(Array.from(c.terrain.base)).toEqual(expected.base);
    expect(Array.from(c.terrain.shape)).toEqual(expected.shape);
    expect(Array.from(c.terrain.surface)).toEqual(expected.surface);
    expect(Array.from(c.terrain.water)).toEqual(expected.water);
    expect(Array.from(c.terrain.road)).toEqual(expected.road);
    expect(Array.from(c.terrain.roadClass)).toEqual(expected.roadClass);
    expect(Array.from(c.terrain.geology)).toEqual(expected.geology);
    expect(Math.max(...Array.from(c.terrain.shape, shapeRise))).toBe(3);
  });

  it("decodes gzip-compressed chunk files", async () => {
    const { buffer, expected } = loadGolden("chunk-v1-small");
    const gz = await new Response(
      new Blob([buffer]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    expect(isGzip(new Uint8Array(gz))).toBe(true);
    const c = decodeChunk(await maybeGunzip(gz));
    expect(Array.from(c.terrain.base)).toEqual(expected.base);
    expect(await maybeGunzip(buffer)).toBe(buffer); // uncompressed passes through
  });

  it("re-encodes the v1 golden file byte for byte", () => {
    const { buffer } = loadGolden("chunk-v1-small");
    const again = encodeChunk(decodeChunk(buffer));
    expect(new Uint8Array(again)).toEqual(new Uint8Array(buffer));
  });

  it("still decodes v0 files, converting slope masks to shapes", () => {
    const { buffer, expected } = loadGolden("chunk-v0-small");
    const c = decodeChunk(buffer);
    expect(Array.from(c.terrain.base)).toEqual(expected.base);
    expect(Array.from(c.terrain.shape)).toEqual(expected.slope!.map(shapeFromV0Mask));
  });

  it("omits the water section when there is no water", () => {
    const t = new TerrainGrid(2, 2);
    const c = decodeChunk(encodeChunk({ x: 0, y: 0, size: 2, terrain: t }));
    expect(Array.from(c.terrain.water)).toEqual([NO_WATER, NO_WATER, NO_WATER, NO_WATER]);
  });

  it("rejects corrupt input", () => {
    const { buffer } = loadGolden("chunk-v1-small");
    const bad = buffer.slice(0);
    new Uint8Array(bad)[0] = 0x58;
    expect(() => decodeChunk(bad)).toThrow(ChunkFormatError);
    const badVersion = buffer.slice(0);
    new DataView(badVersion).setUint16(4, 9, true);
    expect(() => decodeChunk(badVersion)).toThrow(ChunkFormatError);
    expect(() => decodeChunk(buffer.slice(0, 40))).toThrow(ChunkFormatError);
  });

  it("rejects shapes whose lowest corner isn't 0", () => {
    const t = new TerrainGrid(1, 1, { shape: new Uint8Array([packShape(1, 1, 2, 1)]) });
    expect(() => decodeChunk(encodeChunk({ x: 0, y: 0, size: 1, terrain: t }))).toThrow(
      ChunkFormatError,
    );
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

describe("micro-terrain sections (MHGT)", () => {
  it("decodes the Python-written micro golden and re-encodes it byte for byte", () => {
    const bin = readFileSync(goldenDir + "chunk-v1-micro.pxwc");
    const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
    const expected = JSON.parse(readFileSync(goldenDir + "chunk-v1-micro.json", "utf8")) as {
      k: number;
      microCorners: number[];
    };
    const chunk = decodeChunk(buffer);
    expect(chunk.terrain.micro?.k).toBe(expected.k);
    expect(Array.from(chunk.terrain.micro!.corners)).toEqual(expected.microCorners);
    expect(new Uint8Array(encodeChunk(chunk))).toEqual(new Uint8Array(buffer));
  });

  it("keeps micro-terrain when assembling a world", () => {
    const k = 2;
    const mk = (v: number) => {
      const t = new TerrainGrid(2, 2, { micro: { k, corners: new Int16Array(25).fill(v) } });
      return t;
    };
    const manifest = {
      format: "pixelworld-world",
      formatVersion: 0,
      id: "m",
      name: "m",
      chunkSize: 2,
      cellsX: 3,
      cellsY: 2,
      chunks: [],
      scale: { metersPerCell: 100, metersPerStep: 10, elevationDatumMeters: 0 },
      surfaces: {},
      style: "s",
      attribution: [],
      micro: { k },
    } satisfies WorldManifest;
    const grid = assembleTerrain(parseManifest(manifest), [
      { x: 0, y: 0, size: 2, terrain: mk(4) },
      { x: 1, y: 0, size: 2, terrain: mk(8) },
    ]);
    expect(grid.micro!.corners.length).toBe((3 * k + 1) * (2 * k + 1));
    expect(grid.surfaceHeightAt(0.5, 0.5)).toBe(2); // 4 micro-steps at k=2
    expect(grid.surfaceHeightAt(2.5, 0.5)).toBe(4);
    expect(() => parseManifest({ ...manifest, micro: { k: 3 } })).toThrow();
  });
});
