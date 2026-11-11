/**
 * Mesh buffers shared by all generators. Non-indexed triangles; every vertex
 * carries grid-space position, a true-3D normal and material/ownership data.
 *
 * position: (x, y, h)       grid cells and height steps
 * normal:   (nx, ny, nz)    true 3D (z up, height scaled by STEP_WORLD)
 * material: (mat, kind, ao) mat < 100: surface id; mat >= 100: direct ramp id + 100
 * cell:     (cx, cy)        owning cell, for bake-tile ownership
 * road:     (mask, class)   the owning cell's road layer (top faces only)
 * geology:  province id     selects the strata set for rock and cliffs
 */

export const FACE_TOP = 0;
export const FACE_SLOPE = 1;
export const FACE_CLIFF = 2;
export const FACE_SKIRT = 3;
export const FACE_OBJECT = 4;
/** A micro-terrain field's water plane (D-094), drawn by the baker's field shader. */
export const FACE_WATER = 5;

export const DIRECT_RAMP_BASE = 100;
/** Material of a face drawn from texels (`MeshData.texels`): voxel faces of several colours merged into one rectangle. */
export const FACE_TEXELS = 99;
/** Texels per row of a mesh's texel texture: `faceRef` splits offsets by it, to keep them exact as floats. */
export const TEXEL_ROW = 4096;

export interface MeshData {
  vertexCount: number;
  position: Float32Array;
  normal: Float32Array;
  material: Float32Array;
  cell: Float32Array;
  road: Float32Array;
  geology: Float32Array;
  /** Faces drawn from texels (FACE_TEXELS), per vertex: its place on its face, in texels (u, v). */
  faceUv?: Float32Array;
  /** …and its face's texels: offset in `texels` (÷ TEXEL_ROW, % TEXEL_ROW), width, height. */
  faceRef?: Float32Array;
  /** A ramp id per voxel face of the faces drawn from texels, row by row. */
  texels?: Uint8Array;
}

/** Per-vertex extras that most faces leave at zero. */
export interface VertexExtras {
  roadMask?: number;
  roadClass?: number;
  geology?: number;
  /** A face drawn from texels: the vertex's place on it, and the face's texels (offset, width, height). */
  faceU?: number;
  faceV?: number;
  texels?: readonly [number, number, number];
}

export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private mat: number[] = [];
  private cel: number[] = [];
  private rd: number[] = [];
  private geo: number[] = [];
  private uv: number[] | null = null;
  private ref: number[] | null = null;
  private tex: Uint8Array | null = null;
  private texLength = 0;

  /** `texels`: faces may be drawn from texels (`reserveTexels`), as objects' merged meshes are. */
  constructor(opts: { texels?: boolean } = {}) {
    if (opts.texels) {
      this.uv = [];
      this.ref = [];
      this.tex = new Uint8Array(1 << 16);
    }
  }

  /** Whether faces may be drawn from texels. */
  get texels(): boolean {
    return this.tex !== null;
  }

  /** Room for `n` texels: their offset in `texelData`, to fill. */
  reserveTexels(n: number): number {
    const off = this.texLength;
    if (off + n > this.tex!.length) {
      const grown = new Uint8Array(Math.max(this.tex!.length * 2, off + n));
      grown.set(this.tex!.subarray(0, off));
      this.tex = grown;
    }
    this.texLength += n;
    return off;
  }

  get texelData(): Uint8Array {
    return this.tex!;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vertex(
    p: readonly [number, number, number],
    n: readonly [number, number, number],
    material: number,
    kind: number,
    ao: number,
    cx: number,
    cy: number,
    extras?: VertexExtras,
  ): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.mat.push(material, kind, ao);
    this.cel.push(cx, cy);
    this.rd.push(extras?.roadMask ?? 0, extras?.roadClass ?? 0);
    this.geo.push(extras?.geology ?? 0);
    if (this.uv) {
      const t = extras?.texels;
      this.uv.push(extras?.faceU ?? 0, extras?.faceV ?? 0);
      this.ref!.push(t ? Math.floor(t[0] / TEXEL_ROW) : 0, t ? t[0] % TEXEL_ROW : 0, t?.[1] ?? 0, t?.[2] ?? 0);
    }
  }

  build(): MeshData {
    return {
      vertexCount: this.vertexCount,
      position: new Float32Array(this.pos),
      normal: new Float32Array(this.nrm),
      material: new Float32Array(this.mat),
      cell: new Float32Array(this.cel),
      road: new Float32Array(this.rd),
      geology: new Float32Array(this.geo),
      ...(this.uv
        ? { faceUv: new Float32Array(this.uv), faceRef: new Float32Array(this.ref!), texels: this.tex!.slice(0, this.texLength) }
        : {}),
    };
  }
}

/** Unit normal of triangle (a, b, c) with heights scaled by stepWorld, oriented upward/outward hint. */
export function triangleNormal(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  stepWorld: number,
  hint: readonly [number, number, number],
): [number, number, number] {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = (b[2] - a[2]) * stepWorld;
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = (c[2] - a[2]) * stepWorld;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) return [-nx, -ny, -nz];
  return [nx, ny, nz];
}

/** Scale a mesh's positions in place (world units → render units). */
export function scaleMesh(mesh: MeshData, s: number): MeshData {
  for (let i = 0; i < mesh.position.length; i++) mesh.position[i]! *= s;
  return mesh;
}
