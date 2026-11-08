/**
 * A small PNG decoder for hero landmark files (M3, D-053): 8-bit indexed
 * images (artists' paint-overs, decoded to palette indices rather than
 * colours) and 8-bit RGBA images (offline bakes: index, depth, coverage).
 * Non-interlaced only; zlib streams go through the platform DecompressionStream.
 */
export interface DecodedPng {
  width: number;
  height: number;
  /** 1 byte per pixel (indexed) or 4 (RGBA). */
  channels: 1 | 4;
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodePng(buffer: ArrayBuffer): Promise<DecodedPng> {
  const bytes = new Uint8Array(buffer);
  if (!SIGNATURE.every((v, i) => bytes[i] === v)) throw new Error("not a PNG");
  const view = new DataView(buffer);
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < bytes.length; ) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const depth = body[8];
      colorType = body[9]!;
      if (depth !== 8 || (colorType !== 3 && colorType !== 6) || body[12] !== 0)
        throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${colorType}, interlace ${body[12]}`);
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  idat.reduce((o, c) => (joined.set(c, o), o + c.length), 0);
  const raw = await inflate(joined);
  const channels = colorType === 3 ? 1 : 4;
  const stride = width * channels;
  const out = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[row + x - channels]! : 0;
      const b = y > 0 ? out[row - stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[row - stride + x - channels]! : 0;
      let v = raw[src + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[row + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}
