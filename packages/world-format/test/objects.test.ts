import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ObjectsFormatError, maybeGunzip, parseObjects, type ObjectsFile } from "../src/index";

const goldenDir = fileURLToPath(new URL("../../../testdata/world-format/", import.meta.url));
const golden = (version: number): unknown =>
  JSON.parse(readFileSync(goldenDir + `objects-v${version}.json`, "utf8"));

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("objects file", () => {
  it("decodes a v2 file to the same instances as v1", () => {
    const v1 = parseObjects(golden(1));
    const v2 = parseObjects(golden(2));
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.instances).toEqual(v1.instances);
    // v2 stored the footprints as offsets in hundredths of a cell from the anchor
    const raw = golden(2) as ObjectsFile;
    expect(raw.instances[0]?.fp?.[0]).toEqual([-23, -28]);
    expect(v1.instances[0]?.fp?.[0]).toEqual([244.9, 12.6]);
    // instances without a footprint are untouched
    expect(v2.instances[1]).toEqual({ g: "tree", x: 3.5, y: 7.25, s: 7, r: 2 });
  });

  it("decodes courtyards (fh) relative to the anchor, as the footprint (D-088)", () => {
    const v2 = parseObjects({
      version: 2,
      instances: [{ g: "building.palace", x: 10, y: 20, s: 1, fp: [[-100, -100], [100, -100], [100, 100], [-100, 100]], fh: [[[-50, -50], [50, -50], [50, 50], [-50, 50]]] }],
    });
    expect(v2.instances[0]?.fp?.[0]).toEqual([9, 19]);
    expect(v2.instances[0]?.fh).toEqual([[[9.5, 19.5], [10.5, 19.5], [10.5, 20.5], [9.5, 20.5]]]);
  });

  it("reproduces v1's footprint numbers exactly", () => {
    // footprints written as two-decimal text and anchors as three-decimal text,
    // as the pipeline writes them, parsed back from JSON like a v1 file
    const next = rng(7);
    const v1Text: string[] = [];
    const v2Text: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const x = ((next() * 700 - 50) * 1000) | 0;
      const y = ((next() * 700 - 50) * 1000) | 0;
      // the anchor in hundredths as the writer rounds it: ⌊100·x + ½⌋ in doubles
      const ax = Math.floor((x / 1000) * 100 + 0.5);
      const ay = Math.floor((y / 1000) * 100 + 0.5);
      const pts = Array.from(
        { length: 4 },
        (): [number, number] => [ax + ((next() * 800 - 400) | 0), ay + ((next() * 800 - 400) | 0)],
      );
      const anchor = `"x":${x / 1000},"y":${y / 1000}`;
      v1Text.push(`{"g":"b",${anchor},"s":${i},"fp":[${pts.map(([px, py]) => `[${px / 100},${py / 100}]`).join(",")}]}`);
      v2Text.push(`{"g":"b",${anchor},"s":${i},"fp":[${pts.map(([px, py]) => `[${px - ax},${py - ay}]`).join(",")}]}`);
    }
    const v1 = parseObjects(JSON.parse(`{"version":1,"instances":[${v1Text.join(",")}]}`));
    const v2 = parseObjects(JSON.parse(`{"version":2,"instances":[${v2Text.join(",")}]}`));
    expect(v2.instances).toEqual(v1.instances);
  });

  it("reads gzipped files and rejects unknown versions", async () => {
    const z = gzipSync(readFileSync(goldenDir + "objects-v2.json"));
    const bytes = await maybeGunzip(z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer);
    expect(parseObjects(JSON.parse(new TextDecoder().decode(bytes))).instances).toEqual(
      parseObjects(golden(1)).instances,
    );
    expect(() => parseObjects({ version: 3, instances: [] })).toThrow(ObjectsFormatError);
    expect(() => parseObjects({ version: 2 })).toThrow(ObjectsFormatError);
    expect(() => parseObjects(null)).toThrow(ObjectsFormatError);
  });
});
