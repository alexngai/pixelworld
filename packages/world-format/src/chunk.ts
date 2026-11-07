import { MAX_SLOPE, NO_WATER, TerrainGrid } from "@pixelworld/grid";

/** Chunk binary codec, format v0. Spec: docs/world-format.md. */

export const CHUNK_MAGIC = "PXWC";
export const CHUNK_FORMAT_VERSION = 0;
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
  if (version !== CHUNK_FORMAT_VERSION)
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
  const slopS = section("SLOP", 1, true)!;
  const surfS = section("SURF", 1, true)!;
  const watrS = section("WATR", 2, false);

  const base = new Int16Array(n);
  const water = new Int16Array(n).fill(NO_WATER);
  for (let i = 0; i < n; i++) base[i] = view.getInt16(baseS.offset + i * 2, true);
  if (watrS) for (let i = 0; i < n; i++) water[i] = view.getInt16(watrS.offset + i * 2, true);
  const slope = new Uint8Array(buffer.slice(slopS.offset, slopS.offset + n));
  const surface = new Uint8Array(buffer.slice(surfS.offset, surfS.offset + n));
  for (let i = 0; i < n; i++)
    if (slope[i]! > MAX_SLOPE) throw new ChunkFormatError(`invalid slope ${slope[i]} at ${i}`);

  return { x, y, size, terrain: new TerrainGrid(size, size, { base, slope, surface, water }) };
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
  payloads.push(["BASE", i16(terrain.base)]);
  payloads.push(["SLOP", terrain.slope.slice()]);
  payloads.push(["SURF", terrain.surface.slice()]);
  if (hasWater) payloads.push(["WATR", i16(terrain.water)]);

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
