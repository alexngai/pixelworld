import { rotationMat2, type Rotation } from "@pixelworld/grid";
import { Uniforms, compileProgram, createTexture, type GL } from "@pixelworld/bake";
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
 *   with a 4×4 Bayer threshold anchored to absolute screen pixels (like the
 *   baker's AO dither, so panning moves the pattern with the world); the level's
 *   lookup row gives the pixel's new palette index (`fogLut`).
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
uniform ivec2 uOrigin;      // absolute screen px of target pixel (0, 0)
uniform vec2 uDepthRange;
uniform mat2 uUnrotate;     // view (u, v) → grid (x, y)
uniform float uRS;          // render units per cell
uniform vec2 uFieldSize;    // field extent in cells
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

// grid cell of the view point with u − v = a and u + v = b (render units)
vec2 toGrid(float a, float b) { return uUnrotate * (vec2(b + a, b - a) * 0.5) / uRS; }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 src = texelFetch(uIndex, p, 0);
  o = src;
  ivec4 c = ivec4(src * 255.0 + 0.5);
  if (c.r == 0) return;  // nothing drawn
  float z = float(c.g * 65536 + c.b * 256 + c.a) / 16777215.0;
  float d = uDepthRange.x + (1.0 - z) * (uDepthRange.y - uDepthRange.x);
  ivec2 ap = uOrigin + p;
  vec2 s = vec2(ap) + 0.5;
  // sx = 16(u − v), sy = 8(u + v) − 8h, depth = u + v + h/3
  float h = 0.75 * (d - s.y / 8.0);
  float vertical = clamp((uVertical.x - h) / uVertical.y, 0.0, 1.0);
  if (vertical <= 0.0) return;
  float a = s.x / 16.0;
  float area = texture(uField, toGrid(a, s.y / 8.0 + h) / uFieldSize).r;
  if (area <= 0.0) return;
  vec2 q = toGrid(a, s.y / 8.0 + uVertical.z) / uPatch.x - uPatch.yz;
  float n = texture(uNoise, q / ${FOG_NOISE_PERIOD}.0).r;
  float patchiness = mix(1.0, smoothstep(0.25, 0.75, n), uPatch.w);
  float f = area * vertical * patchiness * uStrength;
  float t = (BAYER[(ap.y & 3) * 4 + (ap.x & 3)] + 0.5) / 16.0;
  int level = min(int(floor(f * float(uLevels) + t)), uLevels);
  if (level == 0) return;
  o = vec4(texelFetch(uLut, ivec2(c.r, uLutRow + level - 1), 0).r, 0.0, 0.0, 1.0);
}
`;

/** What the fog pass needs each frame (all heights in render units). */
export interface FogFrame {
  rotation: Rotation;
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
  }

  /** Draw into the bound framebuffer: the frame's indices with fog. */
  draw(fog: FogFrame, frame: WebGLTexture, origin: [number, number], depthRange: [number, number]): void {
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
    gl.uniform2i(u.loc("uOrigin"), origin[0], origin[1]);
    gl.uniform2fv(u.loc("uDepthRange"), depthRange);
    // inverse of the view rotation: view (u, v) → grid (x, y)
    gl.uniformMatrix2fv(u.loc("uUnrotate"), false, rotationMat2(((4 - fog.rotation) % 4) as Rotation));
    gl.uniform1f(u.loc("uRS"), fog.renderScale);
    gl.uniform2fv(u.loc("uFieldSize"), this.fieldSize);
    gl.uniform3f(u.loc("uVertical"), fog.ceiling, fog.fade, fog.patchHeight);
    gl.uniform4f(u.loc("uPatch"), fog.patchCells, fog.patchOffset[0], fog.patchOffset[1], fog.contrast);
    gl.uniform1f(u.loc("uStrength"), fog.strength);
    gl.uniform1i(u.loc("uLevels"), fog.lut.levels);
    gl.uniform1i(u.loc("uLutRow"), fog.night ? fog.lut.levels : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }
}
