import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePng } from "../src/png";

/** Encode an 8-bit PNG with a given filter on every row (the encoder side of each filter). */
function encode(width: number, height: number, channels: 1 | 4, data: Uint8Array, filter: number): ArrayBuffer {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  const at = (x: number, y: number) => (x < 0 || y < 0 ? 0 : data[y * stride + x]!);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const a = at(x - channels, y);
      const b = at(x, y - 1);
      const c = at(x - channels, y - 1);
      const p = a + b - c;
      const pred = [0, a, b, (a + b) >> 1, Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c][filter]!;
      raw[y * (stride + 1) + 1 + x] = (at(x, y) - pred) & 255;
    }
  }
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
    out.set(body, 8);
    return out; // the decoder does not check CRCs
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 3 : 6;
  const z = new Uint8Array(deflateSync(raw));
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
  if (channels === 1) parts.push(chunk("PLTE", new Uint8Array(256 * 3)));
  // split the image data over two IDAT chunks, as encoders may
  parts.push(chunk("IDAT", z.subarray(0, 7)), chunk("IDAT", z.subarray(7)), chunk("IEND", new Uint8Array(0)));
  const total = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((o, p) => (total.set(p, o), o + p.length), 0);
  return total.buffer;
}

const noise = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 73 + ((i * i) >> 3)) & 255);

describe("decodePng", () => {
  for (const filter of [0, 1, 2, 3, 4])
    it(`decodes indexed and RGBA images with filter ${filter}`, async () => {
      for (const channels of [1, 4] as const) {
        const data = noise(7 * 5 * channels);
        const img = await decodePng(encode(7, 5, channels, data, filter));
        expect(img).toMatchObject({ width: 7, height: 5, channels });
        expect(Array.from(img.data)).toEqual(Array.from(data));
      }
    });

  it("rejects what it does not read", async () => {
    await expect(decodePng(new ArrayBuffer(16))).rejects.toThrow("not a PNG");
    const buf = new Uint8Array(encode(2, 2, 4, noise(16), 0));
    buf[8 + 8 + 9] = 2; // colour type 2 (RGB)
    await expect(decodePng(buf.buffer)).rejects.toThrow("unsupported PNG");
  });
});
