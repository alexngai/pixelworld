import { NO_WATER, TerrainGrid, VFAC_ONE, isValidShape, shapeFromV0Mask, type MicroLayers } from "@pixelworld/grid";

/** Chunk binary codec, format v1 (reads v0). Spec: docs/world-format.md. */

export const CHUNK_MAGIC = "PXWC";
export const CHUNK_FORMAT_VERSION = 1;
/** Versions decodeChunk accepts. v0 stored a 1-bit-per-corner slope mask (SLOP). */
export const READABLE_CHUNK_VERSIONS: readonly number[] = [0, 1];
const HEADER_BYTES = 20;
const SECTION_ENTRY_BYTES = 12;

export interface Chunk {
  x: number;
  y: number;
  size: number;
  terrain: TerrainGrid;
}

export class ChunkFormatError extends Error {}

function readTag(view: DataView, offset: number): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

function writeTag(view: DataView, offset: number, tag: string): void {
  if (tag.length !== 4) throw new ChunkFormatError(`tag must be 4 chars: ${tag}`);
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, tag.charCodeAt(i));
}

export function decodeChunk(buffer: ArrayBuffer): Chunk {
  const view = new DataView(buffer);
  if (buffer.byteLength < HEADER_BYTES) throw new ChunkFormatError("truncated header");
  if (readTag(view, 0) !== CHUNK_MAGIC) throw new ChunkFormatError("bad magic");
  const version = view.getUint16(4, true);
  if (!READABLE_CHUNK_VERSIONS.includes(version))
    throw new ChunkFormatError(`unsupported chunk version ${version}`);
  const x = view.getInt32(8, true);
  const y = view.getInt32(12, true);
  const size = view.getUint16(16, true);
  const count = view.getUint16(18, true);
  const n = size * size;

  const sections = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < count; i++) {
    const e = HEADER_BYTES + i * SECTION_ENTRY_BYTES;
    if (e + SECTION_ENTRY_BYTES > buffer.byteLength) throw new ChunkFormatError("truncated table");
    const tag = readTag(view, e);
    const offset = view.getUint32(e + 4, true);
    const length = view.getUint32(e + 8, true);
    if (offset + length > buffer.byteLength)
      throw new ChunkFormatError(`section ${tag} out of bounds`);
    if (sections.has(tag)) throw new ChunkFormatError(`duplicate section ${tag}`);
    sections.set(tag, { offset, length });
  }

  function section(tag: string, bytesPerCell: number, required: boolean) {
    const s = sections.get(tag);
    if (!s) {
      if (required) throw new ChunkFormatError(`missing section ${tag}`);
      return null;
    }
    if (s.length !== n * bytesPerCell)
      throw new ChunkFormatError(`section ${tag} has ${s.length} bytes, expected ${n * bytesPerCell}`);
    return s;
  }

  const baseS = section("BASE", 2, true)!;
  const shapeS = version === 0 ? section("SLOP", 1, true)! : section("CRNR", 1, true)!;
  const surfS = section("SURF", 1, true)!;
  const watrS = section("WATR", 2, false);
  const roadS = section("ROAD", 2, false);
  const rclsS = section("RCLS", 1, false);
  const geolS = section("GEOL", 1, false);
  const vrefS = section("VREF", 2, false);
  const vfacS = section("VFAC", 2, false);
  const rwidS = section("RWID", 1, false);
  const pathS = section("PATH", 2, false);
  const pclsS = section("PCLS", 1, false);
  const pwidS = section("PWID", 1, false);
  const railS = section("RAIL", 2, false);
  const micro = decodeMicro(view, sections.get("MHGT"), size);

  const base = new Int16Array(n);
  const water = new Int16Array(n).fill(NO_WATER);
  for (let i = 0; i < n; i++) base[i] = view.getInt16(baseS.offset + i * 2, true);
  if (watrS) for (let i = 0; i < n; i++) water[i] = view.getInt16(watrS.offset + i * 2, true);
  const road = new Uint16Array(n);
  if (roadS) for (let i = 0; i < n; i++) road[i] = view.getUint16(roadS.offset + i * 2, true);
  const vref = new Int16Array(n);
  if (vrefS) for (let i = 0; i < n; i++) vref[i] = view.getInt16(vrefS.offset + i * 2, true);
  const vfac = new Int16Array(n).fill(VFAC_ONE);
  if (vfacS) for (let i = 0; i < n; i++) vfac[i] = view.getInt16(vfacS.offset + i * 2, true);
  const bytesOf = (s: { offset: number } | null) =>
    s ? new Uint8Array(buffer.slice(s.offset, s.offset + n)) : new Uint8Array(n);
  const roadClass = bytesOf(rclsS);
  const geology = bytesOf(geolS);
  const roadWidth = bytesOf(rwidS);
  const path = new Uint16Array(n);
  if (pathS) for (let i = 0; i < n; i++) path[i] = view.getUint16(pathS.offset + i * 2, true);
  const pathClass = bytesOf(pclsS);
  const pathWidth = bytesOf(pwidS);
  const rail = new Uint16Array(n);
  if (railS) for (let i = 0; i < n; i++) rail[i] = view.getUint16(railS.offset + i * 2, true);
  const shape = new Uint8Array(buffer.slice(shapeS.offset, shapeS.offset + n));
  const surface = new Uint8Array(buffer.slice(surfS.offset, surfS.offset + n));
  if (version === 0) {
    for (let i = 0; i < n; i++) {
      if (shape[i]! > 14) throw new ChunkFormatError(`invalid v0 slope ${shape[i]} at ${i}`);
      shape[i] = shapeFromV0Mask(shape[i]!);
    }
  } else {
    for (let i = 0; i < n; i++)
      if (!isValidShape(shape[i]!)) throw new ChunkFormatError(`invalid shape ${shape[i]} at ${i}`);
  }

  return {
    x,
    y,
    size,
    terrain: new TerrainGrid(size, size, {
      base,
      shape,
      surface,
      water,
      road,
      roadClass,
      geology,
      vref,
      vfac,
      roadWidth,
      path,
      pathClass,
      pathWidth,
      rail,
      micro,
    }),
  };
}

/**
 * MHGT: (K·size + 1)² int16 micro-corner heights, rows delta-coded (each value
 * minus its left neighbour, the first of a row absolute; arithmetic wraps at 16 bits).
 */
function decodeMicro(
  view: DataView,
  s: { offset: number; length: number } | undefined,
  size: number,
): MicroLayers | null {
  if (!s) return null;
  const side = Math.round(Math.sqrt(s.length / 2));
  const k = size ? Math.floor((side - 1) / size) : 0;
  if (k < 1 || side !== k * size + 1 || side * side * 2 !== s.length)
    throw new ChunkFormatError(`MHGT has ${s.length} bytes, not (K·${size} + 1)² int16`);
  const corners = new Int16Array(side * side);
  for (let y = 0; y < side; y++) {
    let v = 0;
    for (let x = 0; x < side; x++) {
      const i = y * side + x;
      v = (v + view.getInt16(s.offset + i * 2, true)) << 16 >> 16;
      corners[i] = v;
    }
  }
  return { k, corners };
}

function encodeMicro(m: MicroLayers, size: number): Uint8Array {
  const side = m.k * size + 1;
  const out = new Uint8Array(side * side * 2);
  const v = new DataView(out.buffer);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const i = y * side + x;
      const d = x === 0 ? m.corners[i]! : m.corners[i]! - m.corners[i - 1]!;
      v.setInt16(i * 2, d << 16 >> 16, true);
    }
  return out;
}

export function encodeChunk(chunk: Chunk): ArrayBuffer {
  const { size, terrain } = chunk;
  if (terrain.width !== size || terrain.height !== size)
    throw new ChunkFormatError("terrain dimensions must equal chunk size");
  const n = size * size;
  const hasWater = terrain.water.some((w) => w !== NO_WATER);
  const payloads: [string, Uint8Array][] = [];
  const i16 = (arr: Int16Array) => {
    const out = new Uint8Array(n * 2);
    const v = new DataView(out.buffer);
    for (let i = 0; i < n; i++) v.setInt16(i * 2, arr[i]!, true);
    return out;
  };
  const u16 = (arr: Uint16Array) => {
    const out = new Uint8Array(n * 2);
    const v = new DataView(out.buffer);
    for (let i = 0; i < n; i++) v.setUint16(i * 2, arr[i]!, true);
    return out;
  };
  const any = (arr: ArrayLike<number>) => Array.prototype.some.call(arr, (v: number) => v !== 0);
  payloads.push(["BASE", i16(terrain.base)]);
  payloads.push(["CRNR", terrain.shape.slice()]);
  payloads.push(["SURF", terrain.surface.slice()]);
  if (hasWater) payloads.push(["WATR", i16(terrain.water)]);
  if (any(terrain.road)) payloads.push(["ROAD", u16(terrain.road)]);
  if (any(terrain.roadClass)) payloads.push(["RCLS", terrain.roadClass.slice()]);
  if (any(terrain.geology)) payloads.push(["GEOL", terrain.geology.slice()]);
  if (any(terrain.vref)) payloads.push(["VREF", i16(terrain.vref)]);
  if (terrain.vfac.some((v) => v !== VFAC_ONE)) payloads.push(["VFAC", i16(terrain.vfac)]);
  if (any(terrain.roadWidth)) payloads.push(["RWID", terrain.roadWidth.slice()]);
  if (any(terrain.path)) payloads.push(["PATH", u16(terrain.path)]);
  if (any(terrain.pathClass)) payloads.push(["PCLS", terrain.pathClass.slice()]);
  if (any(terrain.pathWidth)) payloads.push(["PWID", terrain.pathWidth.slice()]);
  if (any(terrain.rail)) payloads.push(["RAIL", u16(terrain.rail)]);
  if (terrain.micro) payloads.push(["MHGT", encodeMicro(terrain.micro, size)]);

  let offset = HEADER_BYTES + payloads.length * SECTION_ENTRY_BYTES;
  const placed = payloads.map(([tag, data]) => {
    offset = align4(offset);
    const at = offset;
    offset += data.length;
    return { tag, data, at };
  });
  const out = new ArrayBuffer(align4(offset));
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  writeTag(view, 0, CHUNK_MAGIC);
  view.setUint16(4, CHUNK_FORMAT_VERSION, true);
  view.setUint16(6, 0, true);
  view.setInt32(8, chunk.x, true);
  view.setInt32(12, chunk.y, true);
  view.setUint16(16, size, true);
  view.setUint16(18, placed.length, true);
  placed.forEach(({ tag, data, at }, i) => {
    const e = HEADER_BYTES + i * SECTION_ENTRY_BYTES;
    writeTag(view, e, tag);
    view.setUint32(e + 4, at, true);
    view.setUint32(e + 8, data.length, true);
    bytes.set(data, at);
  });
  return out;
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

/** True when bytes start with the gzip magic number. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Chunk files may be stored gzip-compressed (`.pxwc.gz`). Decompress if
 * needed using the platform DecompressionStream (browsers, Node 18+).
 */
export async function maybeGunzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (!isGzip(new Uint8Array(buffer))) return buffer;
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}
