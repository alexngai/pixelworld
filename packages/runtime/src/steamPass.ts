import { ISO_PROJECTION, type Projection } from "@pixelworlds/grid";
import { Uniforms, compileProgram, createTexture, type GL } from "@pixelworlds/bake";
import { FOG_NOISE_PERIOD, FOG_NOISE_TEXELS, fogNoiseTile, type FogLut } from "./fog";

/**
 * The steam pass (D-138), an atmosphere layer like the fog's: plumes rising
 * from vents, dithered into the frame's palette indices as a veil toward the
 * steam's colour (the fog's lookup and Bayer dither), so nothing is baked.
 *
 * - **A plume** is a column over its vent's screen point: it widens and thins
 *   as it rises, leans downwind more toward its top, and is cut into puffs by
 *   noise that scrolls upward with time.
 * - **In front or behind:** the plume's depth where it crosses a pixel is its
 *   vent's, raised by the height it has climbed there; a surface nearer the
 *   eye than that (a tree before the pool) keeps its colour.
 * - **How many:** the layer passes the plumes in view, at most MAX_PLUMES,
 *   and each pixel looks at those whose box holds it.
 */

/** The most plumes a frame draws (the nearest the view's middle when more are in view). */
export const MAX_PLUMES = 48;

const VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uIndex;   // frame: R index, G B A depth (24 bits, as gl_FragDepth)
uniform sampler2D uNoise;   // the fog's noise tile, linear, wrapping
uniform sampler2D uLut;     // 256 × rows: veiled index per index and level
uniform vec2 uOrigin;       // absolute screen (art) px of the target's top-left
uniform float uZoom;        // target px per art px
uniform vec2 uDepthRange;
uniform vec2 uDepthPx;      // depth per px up a vertical, and per px across (D-195)
uniform vec4 uA[${MAX_PLUMES}];  // vent: sx, sy (absolute art px), depth, radius (px)
uniform vec4 uB[${MAX_PLUMES}];  // height (px), density, seed, lean of its top (px)
uniform int uCount;
uniform float uRise;        // px the puffs have risen since the clock started
uniform float uStrength;
uniform int uLevels;
uniform int uLutRow;
out vec4 o;

const float BAYER[16] = float[16](
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0);

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
  float f = 0.0;
  for (int i = 0; i < uCount; i++) {
    vec4 a = uA[i];
    vec4 b = uB[i];
    float up = a.y - s.y;  // px above the vent
    if (up < -0.5 * a.w || up > b.x) continue;
    float t = clamp(up / b.x, 0.0, 1.0);
    float r = a.w * (0.6 + 1.6 * t);
    float ax = a.x + b.w * t * t;
    float dx = (s.x - ax) / r;
    if (abs(dx) >= 1.0) continue;
    // the plume's depth rises as it climbs and reaches nearer across its width: what stands nearer the eye hides it
    if (d > a.z + max(up, 0.0) * uDepthPx.x + r * uDepthPx.y) continue;
    // thickest along its axis and low down, thinning to its edges and top
    float body = pow(1.0 - dx * dx, 0.7) * pow(1.0 - t, 0.8) * smoothstep(-0.5 * a.w, 0.3 * a.w, up);
    vec2 q = vec2(s.x - ax, up - uRise) / (0.6 * a.w) + b.z;
    float n = 0.65 * texture(uNoise, q / ${FOG_NOISE_PERIOD}.0).r + 0.35 * texture(uNoise, (2.3 * q + 17.0) / ${FOG_NOISE_PERIOD}.0).r;
    // puffs: thicker and thinner, with the odd gap
    f = max(f, body * mix(0.15, 1.0, smoothstep(0.35, 0.75, n)) * b.y);
  }
  f *= uStrength;
  if (f <= 0.0) return;
  float th = (BAYER[(ap.y & 3) * 4 + (ap.x & 3)] + 0.5) / 16.0;
  int level = min(int(floor(f * float(uLevels) + th)), uLevels);
  if (level == 0) return;
  // the depth kept: another pass after this one reads it
  o = vec4(texelFetch(uLut, ivec2(c.r, uLutRow + level - 1), 0).r, src.gba);
}
`;

/** What the steam pass needs each frame. */
export interface SteamFrame {
  /** Per plume, four floats each (see the shader's uA and uB), `count` of them. */
  a: Float32Array;
  b: Float32Array;
  count: number;
  /** Px the puffs have risen (the clock times the rise speed). */
  rise: number;
  /** Thickness multiplier (night). */
  strength: number;
  lut: FogLut;
  night: boolean;
  /** How the view lays the world out (D-195); the 2:1 view if absent. */
  projection?: Projection;
}

export class SteamPass {
  private prog: WebGLProgram;
  private u: Uniforms;
  private noiseTex: WebGLTexture;
  private lutTex: WebGLTexture | null = null;
  private lut: FogLut | null = null;

  constructor(private readonly gl: GL) {
    this.prog = compileProgram(gl, VS, FS);
    this.u = new Uniforms(gl, this.prog);
    const n = FOG_NOISE_PERIOD * FOG_NOISE_TEXELS;
    this.noiseTex = createTexture(gl, n, n, gl.R8, gl.RED, gl.UNSIGNED_BYTE, fogNoiseTile());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of [this.lutTex, this.noiseTex]) if (t) gl.deleteTexture(t);
    gl.deleteProgram(this.prog);
    this.lutTex = null;
    this.lut = null;
  }

  /** Draw into the bound framebuffer: the frame's indices with steam. */
  draw(steam: SteamFrame, frame: WebGLTexture, origin: [number, number], zoom: number, depthRange: [number, number]): void {
    const gl = this.gl;
    const u = this.u;
    gl.useProgram(this.prog);
    if (this.lut !== steam.lut) {
      if (this.lutTex) gl.deleteTexture(this.lutTex);
      this.lutTex = createTexture(gl, 256, steam.lut.levels * 2, gl.R8, gl.RED, gl.UNSIGNED_BYTE, steam.lut.data);
      this.lut = steam.lut;
    }
    const units: [string, WebGLTexture | null][] = [
      ["uIndex", frame],
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
    // 2:1: depth u + v + h/3 with h a step per 8 px up gives 1/24; a cell across is 16 px, 1/16
    const p = steam.projection ?? ISO_PROJECTION;
    gl.uniform2f(u.loc("uDepthPx"), p.d[2] / -p.y[2], p.d[0] / p.x[0]);
    const count = Math.min(steam.count, MAX_PLUMES);
    if (count > 0) {
      gl.uniform4fv(u.loc("uA"), steam.a.subarray(0, count * 4));
      gl.uniform4fv(u.loc("uB"), steam.b.subarray(0, count * 4));
    }
    gl.uniform1i(u.loc("uCount"), count);
    gl.uniform1f(u.loc("uRise"), steam.rise);
    gl.uniform1f(u.loc("uStrength"), steam.strength);
    gl.uniform1i(u.loc("uLevels"), steam.lut.levels);
    gl.uniform1i(u.loc("uLutRow"), steam.night ? steam.lut.levels : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }
}
