import { ISO_PROJECTION, groundInverse, projectionInverse, rotationMat2, type Projection, type Rotation } from "@pixelworlds/grid";
import { Uniforms, compileProgram, createTexture, type GL } from "@pixelworlds/bake";
import { FOG_NOISE_PERIOD, FOG_NOISE_TEXELS, fogNoiseTile, type FogField, type FogLut } from "./fog";

/**
 * The fog pass (an atmosphere layer over the baked world): reads the frame's
 * palette indices and the depth beside them, and writes indices with fog
 * dithered in. Nothing is baked, so nothing re-bakes.
 *
 * - **Where:** the pixel's surface point comes from its screen position and
 *   depth (the projection is invertible: sx, sy and depth give x, y and h), so
 *   the area coverage is looked up at the ground the pixel shows.
 * - **How thick:** the share of the fog layer between that surface and the eye
 *   (`fogVertical`): low ground is buried, hills and towers rise out of it.
 * - **Patches:** noise on a horizontal plane inside the fog, drifting with the
 *   wind, so a patch is one shape on screen rather than streaks down walls.
 * - **Veil:** coverage picks a veil level, dithered between neighbouring levels
 *   with a 4×4 Bayer threshold anchored to absolute screen (art) pixels (like
 *   the baker's AO dither, so panning moves the pattern with the world); the
 *   level's lookup row gives the pixel's new palette index (`fogLut`). The
 *   frame is at canvas resolution: each target pixel is worked out at the art
 *   pixel it falls in, so the fog stays pixel art.
 */

const FOG_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FOG_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uIndex;   // frame: R index, G B A depth (24 bits, as gl_FragDepth)
uniform sampler2D uField;   // area coverage over world cells, linear
uniform sampler2D uNoise;   // patch noise tile, linear, wrapping
uniform sampler2D uLut;     // 256 × rows: veiled index per index and level
uniform vec2 uOrigin;       // absolute screen (art) px of the target's top-left
uniform float uZoom;        // target px per art px
uniform vec2 uDepthRange;
uniform mat2 uUnrotate;     // view (u, v) → grid (x, y)
uniform mat3 uUnproject;    // screen (sx, sy) and depth → view (u, v, h) (D-195)
uniform mat2 uGroundInv;    // screen (sx, sy) at h = 0 → view (u, v)
uniform vec2 uProjH;        // screen px per step of height
uniform float uRS;          // render units per cell
uniform vec2 uFieldSize;    // field extent in cells
uniform vec2 uFieldOrigin;  // the cell the field starts at
uniform vec3 uVertical;     // ceiling, fade, patch plane height (render units)
uniform vec4 uPatch;        // cells per lattice unit, offset (lattice units), contrast
uniform float uStrength;
uniform int uLevels;        // veil levels
uniform int uLutRow;        // first row: 0 by day, uLevels by night
out vec4 o;

const float BAYER[16] = float[16](
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0);

// grid cell of a view point (u, v) (render units)
vec2 toGrid(vec2 uv) { return uUnrotate * uv / uRS; }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 src = texelFetch(uIndex, p, 0);
  o = src;
  ivec4 c = ivec4(src * 255.0 + 0.5);
  if (c.r == 0) return;  // nothing drawn
  float z = float(c.g * 65536 + c.b * 256 + c.a) / 16777215.0;
  float d = uDepthRange.x + (1.0 - z) * (uDepthRange.y - uDepthRange.x);
  ivec2 ap = ivec2(floor(uOrigin + (vec2(p) + 0.5) / uZoom));
  vec2 s = vec2(ap) + 0.5;
  // the surface drawn here: the projection is invertible, so screen point and depth give (u, v, h)
  vec3 at = uUnproject * vec3(s, d);
  float h = at.z;
  float vertical = clamp((uVertical.x - h) / uVertical.y, 0.0, 1.0);
  if (vertical <= 0.0) return;
  float area = texture(uField, (toGrid(at.xy) - uFieldOrigin) / uFieldSize).r;
  if (area <= 0.0) return;
  // where the view ray crosses the plane the patches float in
  vec2 q = toGrid(uGroundInv * (s - uVertical.z * uProjH)) / uPatch.x - uPatch.yz;
  float n = texture(uNoise, q / ${FOG_NOISE_PERIOD}.0).r;
  float patchiness = mix(1.0, smoothstep(0.25, 0.75, n), uPatch.w);
  float f = area * vertical * patchiness * uStrength;
  float t = (BAYER[(ap.y & 3) * 4 + (ap.x & 3)] + 0.5) / 16.0;
  int level = min(int(floor(f * float(uLevels) + t)), uLevels);
  if (level == 0) return;
  // the depth kept: another pass after this one reads it (D-125)
  o = vec4(texelFetch(uLut, ivec2(c.r, uLutRow + level - 1), 0).r, src.gba);
}
`;

/** What the fog pass needs each frame (all heights in render units). */
export interface FogFrame {
  rotation: Rotation;
  /** How the view lays the world out (D-195); the 2:1 view if absent. */
  projection?: Projection;
  renderScale: number;
  ceiling: number;
  fade: number;
  /** Height of the plane the patches float in. */
  patchHeight: number;
  /** Cells per noise lattice unit, the noise offset (lattice units) and contrast (0 = even fog). */
  patchCells: number;
  patchOffset: [number, number];
  contrast: number;
  /** Coverage multiplier (level, night). */
  strength: number;
  lut: FogLut;
  /** Use the night rows of the lookup (emissive ramps show through). */
  night: boolean;
}

export class FogPass {
  private prog: WebGLProgram;
  private u: Uniforms;
  private fieldTex: WebGLTexture | null = null;
  private fieldSize: [number, number] = [1, 1];
  private fieldOrigin: [number, number] = [0, 0];
  private noiseTex: WebGLTexture;
  private lutTex: WebGLTexture | null = null;
  private lut: FogLut | null = null;

  constructor(private readonly gl: GL) {
    this.prog = compileProgram(gl, FOG_VS, FOG_FS);
    this.u = new Uniforms(gl, this.prog);
    const n = FOG_NOISE_PERIOD * FOG_NOISE_TEXELS;
    this.noiseTex = createTexture(gl, n, n, gl.R8, gl.RED, gl.UNSIGNED_BYTE, fogNoiseTile());
    this.filter(gl.LINEAR, gl.REPEAT);
  }

  private filter(f: number, wrap?: number): void {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    if (wrap !== undefined) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    }
  }

  get hasField(): boolean {
    return this.fieldTex !== null;
  }

  setField(field: FogField | null): void {
    const gl = this.gl;
    if (this.fieldTex) gl.deleteTexture(this.fieldTex);
    this.fieldTex = null;
    if (!field) return;
    this.fieldTex = createTexture(gl, field.width, field.height, gl.R8, gl.RED, gl.UNSIGNED_BYTE, field.data);
    this.filter(gl.LINEAR);
    this.fieldSize = [field.width * field.cellsPerTexel, field.height * field.cellsPerTexel];
    this.fieldOrigin = [field.x0 ?? 0, field.y0 ?? 0];
  }

  /** Let go of the pass's GPU objects. */
  dispose(): void {
    const gl = this.gl;
    for (const t of [this.fieldTex, this.lutTex, this.noiseTex]) if (t) gl.deleteTexture(t);
    gl.deleteProgram(this.prog);
    this.fieldTex = null;
    this.lutTex = null;
    this.lut = null;
  }

  /** Draw into the bound framebuffer: the frame's indices with fog. */
  draw(fog: FogFrame, frame: WebGLTexture, origin: [number, number], zoom: number, depthRange: [number, number]): void {
    const gl = this.gl;
    const u = this.u;
    gl.useProgram(this.prog);
    if (this.lut !== fog.lut) {
      if (this.lutTex) gl.deleteTexture(this.lutTex);
      this.lutTex = createTexture(gl, 256, fog.lut.levels * 2, gl.R8, gl.RED, gl.UNSIGNED_BYTE, fog.lut.data);
      this.lut = fog.lut;
    }
    const units: [string, WebGLTexture | null][] = [
      ["uIndex", frame],
      ["uField", this.fieldTex],
      ["uNoise", this.noiseTex],
      ["uLut", this.lutTex],
    ];
    units.forEach(([name, tex], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(u.loc(name), i);
    });
    gl.uniform2f(u.loc("uOrigin"), origin[0], origin[1]);
    gl.uniform1f(u.loc("uZoom"), zoom);
    gl.uniform2fv(u.loc("uDepthRange"), depthRange);
    // inverse of the view rotation: view (u, v) → grid (x, y)
    gl.uniformMatrix2fv(u.loc("uUnrotate"), false, rotationMat2(((4 - fog.rotation) % 4) as Rotation));
    const proj = fog.projection ?? ISO_PROJECTION;
    gl.uniformMatrix3fv(u.loc("uUnproject"), false, projectionInverse(proj));
    gl.uniformMatrix2fv(u.loc("uGroundInv"), false, groundInverse(proj));
    gl.uniform2f(u.loc("uProjH"), proj.x[2], proj.y[2]);
    gl.uniform1f(u.loc("uRS"), fog.renderScale);
    gl.uniform2fv(u.loc("uFieldSize"), this.fieldSize);
    gl.uniform2fv(u.loc("uFieldOrigin"), this.fieldOrigin);
    gl.uniform3f(u.loc("uVertical"), fog.ceiling, fog.fade, fog.patchHeight);
    gl.uniform4f(u.loc("uPatch"), fog.patchCells, fog.patchOffset[0], fog.patchOffset[1], fog.contrast);
    gl.uniform1f(u.loc("uStrength"), fog.strength);
    gl.uniform1i(u.loc("uLevels"), fog.lut.levels);
    gl.uniform1i(u.loc("uLutRow"), fog.night ? fog.lut.levels : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }
}
