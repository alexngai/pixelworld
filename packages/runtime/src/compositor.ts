import { INDEX_SILHOUETTE } from "@pixelworlds/style";
import {
  Uniforms,
  compileProgram,
  framebuffer,
  rgba8Texture,
  type BakedImage,
  type GL,
} from "@pixelworlds/bake";
import type { FogField } from "./fog";
import { FogPass, type FogFrame } from "./fogPass";
import { SteamPass, type SteamFrame } from "./steamPass";

/** A fog pass to draw over a frame: the layer's id (its field, `setFogField`) and its parameters. */
export interface FogDraw {
  id: string;
  frame: FogFrame;
}

/** A steam layer's pass (D-138), drawn in the layers' order with the fogs'. */
export interface SteamDraw {
  id: string;
  steam: SteamFrame;
}

/** How far back (depth units) `behind` tiles are drawn: beyond a depth's 1/256 quantisation, short of anything standing in front. */
const BEHIND_DEPTH = 0.5;

/**
 * Runtime compositor (architecture §8.2): draws baked tiles and sprites into
 * an index + depth framebuffer at the canvas's own resolution, each art pixel
 * a zoom × zoom block, then maps indices through the palette. Tiles sit on
 * the art-pixel grid; sprites may sit between its lines (to the canvas
 * pixel), so a moving sprite glides over the world instead of stepping a whole
 * art pixel at a time, and the camera's sub-pixel offset is just where the
 * blocks fall. An atmosphere pass (fog) may rewrite the indices in between,
 * reading the depth the tiles also write beside each index; without one the
 * palette pass reads the indices directly. Dithers (fog, the reveal, the
 * silhouette) are worked out per art pixel, so they stay pixel art.
 */

const QUAD_VS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRectOrigin;   // target px, top-left
uniform vec2 uRectSize;     // art px
uniform float uZoom;        // target px per art px
uniform vec2 uTarget;       // framebuffer size (target px)
void main() {
  vec2 unit = vec2(float(gl_VertexID == 1 || gl_VertexID == 2 || gl_VertexID == 4),
                   float(gl_VertexID == 2 || gl_VertexID == 4 || gl_VertexID == 5));
  vec2 p = uRectOrigin + unit * uRectSize * uZoom;
  gl_Position = vec4(2.0 * p / uTarget - 1.0, 0.0, 1.0);  // row 0 = top of image
}
`;

/** How many sprites can see through what stands in front of them at once (D-154). */
export const MAX_REVEALS = 12;

const QUAD_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uImage;
uniform vec2 uRectOrigin;   // target px
uniform vec2 uRectArt;      // absolute screen (art) px of the image's top-left
uniform float uZoom;
uniform float uDepthBase;
uniform vec2 uDepthRange;
uniform int uMode;          // 0 = normal, 1 = occluded silhouette, 2 = bare tile inside the reveal
uniform float uSilhouette;  // palette index / 255
uniform int uRevealOn;      // tiles in front of a player see-through (normal mode)
uniform int uRevealCount;
uniform vec4 uReveal[${MAX_REVEALS}];       // each reveal's ellipse: centre, radii (absolute art px)
uniform float uRevealS[${MAX_REVEALS}];     // its sprite's u + v
uniform float uRevealDensity[${MAX_REVEALS}];
out vec4 o;

const float BAYER[16] = float[16](
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0);

void main() {
  // the image's art pixel under this target pixel, and where that art pixel is on the (absolute) screen
  vec2 tf = floor((gl_FragCoord.xy - uRectOrigin) / uZoom);
  ivec2 tp = ivec2(tf);
  vec2 art = uRectArt + tf + 0.5;
  vec4 t = texelFetch(uImage, tp, 0);
  if (t.a < 0.5) discard;
  float local = (floor(t.g * 255.0 + 0.5) * 256.0 + floor(t.b * 255.0 + 0.5)) / 256.0;
  float d = uDepthBase + local;
  float z = clamp(1.0 - (d - uDepthRange.x) / (uDepthRange.y - uDepthRange.x), 0.0, 1.0);
  if (uRevealOn == 1 || uMode == 2) {
    // sx = 16(u − v), sy = 8(u + v) − 8h, depth = u + v + h/3: the surface's u + v from sy and depth
    float s = art.y / 32.0 + 0.75 * d;
    ivec2 ap = ivec2(floor(art));
    float dither = (BAYER[(ap.y & 3) * 4 + (ap.x & 3)] + 0.5) / 16.0;
    bool inside = false;
    for (int i = 0; i < ${MAX_REVEALS}; i++) {
      if (i >= uRevealCount) break;
      float r = length((art - uReveal[i].xy) / uReveal[i].zw);
      if (r >= 1.0) continue;
      inside = true;
      if (uMode != 2 && s > uRevealS[i] + 0.5) {
        // a dithered edge, or at full density a clean cut
        float k = uRevealDensity[i] >= 1.0 ? 1.0 : uRevealDensity[i] * smoothstep(1.0, 0.7, r);
        if (dither < k) discard;
      }
    }
    if (uMode == 2 && !inside) discard;  // a bare tile fills only the reveals, where the tiles let it through
  }
  gl_FragDepth = z;
  if (uMode == 1) {
    if (((tp.x + tp.y) & 1) == 1) discard;  // a checker on the sprite's own art pixels
    o = vec4(uSilhouette, 0.0, 0.0, 1.0);
  } else {
    // the depth again, 24 bits in the spare channels, for atmosphere passes
    // (cheaper to read back than a depth texture; the palette pass reads R only)
    float e = floor(z * 16777215.0 + 0.5);
    o = vec4(t.r, floor(e / 65536.0) / 255.0, mod(floor(e / 256.0), 256.0) / 255.0, mod(e, 256.0) / 255.0);
  }
}
`;

const PALETTE_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const PALETTE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uIndex;
uniform highp sampler2D uPalette;
uniform vec2 uCanvas;
uniform int uLut;
uniform highp sampler2D uGhost;  // the uncut tiles (D-160): index and depth, as the target holds them
uniform float uGhostAlpha;       // how much of them shows where they stood in front, 0 for none
uniform int uGhostMasked;        // 1: how much, per pixel, from the mask's red (D-161), over the canvas, top row first
uniform sampler2D uGhostMask;
out vec4 o;
void main() {
  ivec2 q = ivec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);  // the target's rows run top down
  vec4 m = texelFetch(uIndex, q, 0);
  int index = int(m.r * 255.0 + 0.5);
  o = texelFetch(uPalette, ivec2(index, uLut), 0);
  if (uGhostAlpha > 0.0) {
    // a building cut down shows faintly where it stood in front of what's drawn now (its depth nearer)
    vec4 g = texelFetch(uGhost, q, 0);
    float zm = dot(floor(m.gba * 255.0 + 0.5), vec3(65536.0, 256.0, 1.0));
    float zg = dot(floor(g.gba * 255.0 + 0.5), vec3(65536.0, 256.0, 1.0));
    int gi = int(g.r * 255.0 + 0.5);
    float a = uGhostMasked == 1 ? texture(uGhostMask, vec2(gl_FragCoord.x / uCanvas.x, 1.0 - gl_FragCoord.y / uCanvas.y)).r : uGhostAlpha;
    if (zg + 2.0 < zm && gi != index) o = mix(o, texelFetch(uPalette, ivec2(gi, uLut), 0), a);
  }
}
`;

export interface GpuImage {
  image: BakedImage;
  texture: WebGLTexture;
}

export interface SpriteInstance {
  sprite: GpuImage;
  /** Screen position (absolute art px) of the object's origin: fractions place it between art pixels. */
  sx: number;
  sy: number;
  /** Depth of the object's origin. */
  depth: number;
  silhouette: boolean;
  /** The palette index its silhouette is drawn in (default the style's silhouette colour): a side's colour, say. */
  silhouetteIndex?: number;
  /**
   * Show what this sprite stands behind (D-079): within `margin` px of it,
   * world pixels in front of it are dithered away (`density` of them, 0–1;
   * at 1 a clean cut) over the bare tiles (`TileRequest.bare`). The first
   * `MAX_REVEALS` such sprites of a frame count.
   */
  reveal?: Reveal | null;
}

export interface Reveal {
  margin: number;
  density: number;
}

/** The ellipse a revealing sprite clears (absolute screen px), for choosing bare tiles. */
export function revealRect(s: SpriteInstance): { left: number; top: number; right: number; bottom: number } | null {
  if (!s.reveal) return null;
  const img = s.sprite.image;
  const m = s.reveal.margin;
  const left = s.sx + img.left - m;
  const top = s.sy + img.top - m;
  return { left, top, right: left + img.width + 2 * m, bottom: top + img.height + 2 * m };
}

export interface FrameParams {
  left: number; // integer internal-px origin
  top: number;
  fracX: number;
  fracY: number;
  zoom: number;
  depthRange: [number, number];
}

export class Compositor {
  readonly gl: GL;
  private quadProg: WebGLProgram;
  private palProg: WebGLProgram;
  private quadU: Uniforms;
  private palU: Uniforms;
  private vao: WebGLVertexArrayObject;
  private paletteTex: WebGLTexture | null = null;
  /** How much of what's cut shows, per pixel (D-161): an app's mask over the canvas, or null for one opacity. */
  private ghostMask: WebGLTexture | null = null;
  private target: {
    w: number;
    h: number;
    color: WebGLTexture;
    depth: WebGLRenderbuffer;
    fb: WebGLFramebuffer;
    /** The fog passes' outputs, two to take turns, made when a frame first has fog. */
    fogColor: (WebGLTexture | null)[];
    fogFb: (WebGLFramebuffer | null)[];
    /** The uncut tiles' own index, depth and depth buffer (D-160), made when a frame first has them. */
    ghost: { color: WebGLTexture; depth: WebGLRenderbuffer; fb: WebGLFramebuffer } | null;
  } | null = null;
  /** A fog pass per layer that has one (the style's fog, a game's veil: D-125), by its id. */
  private readonly fogPasses = new Map<string, FogPass>();
  private steamPass: SteamPass | null = null;
  lut = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("WebGL2 is required");
    this.gl = gl;
    this.quadProg = compileProgram(gl, QUAD_VS, QUAD_FS);
    this.palProg = compileProgram(gl, PALETTE_VS, PALETTE_FS);
    this.quadU = new Uniforms(gl, this.quadProg);
    this.palU = new Uniforms(gl, this.palProg);
    this.vao = gl.createVertexArray()!;
  }

  /** The ghost's opacity per pixel (D-161): an image over the canvas (its red, 0–1), stretched to it; null for `ghosts.alpha` everywhere. */
  setGhostMask(source: TexImageSource | null): void {
    const gl = this.gl;
    if (!source) {
      if (this.ghostMask) gl.deleteTexture(this.ghostMask);
      this.ghostMask = null;
      return;
    }
    if (!this.ghostMask) {
      this.ghostMask = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.ghostMask);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.ghostMask);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  setPalette(rgba: Uint8Array, rows = 1): void {
    const gl = this.gl;
    if (this.paletteTex) gl.deleteTexture(this.paletteTex);
    this.paletteTex = rgba8Texture(gl, 256, rows, rgba);
  }

  upload(image: BakedImage): GpuImage {
    return { image, texture: rgba8Texture(this.gl, image.width, image.height, image.pixels) };
  }

  release(img: GpuImage): void {
    this.gl.deleteTexture(img.texture);
  }

  private releaseTarget(): void {
    const gl = this.gl;
    const t = this.target;
    if (!t) return;
    gl.deleteFramebuffer(t.fb);
    gl.deleteTexture(t.color);
    gl.deleteRenderbuffer(t.depth);
    for (const fb of t.fogFb) if (fb) gl.deleteFramebuffer(fb);
    for (const c of t.fogColor) if (c) gl.deleteTexture(c);
    if (t.ghost) {
      gl.deleteFramebuffer(t.ghost.fb);
      gl.deleteTexture(t.ghost.color);
      gl.deleteRenderbuffer(t.ghost.depth);
    }
    this.target = null;
  }

  /**
   * Let go of the compositor's own GPU objects (programs, frame targets,
   * palette, fog pass). The canvas's context stays: another compositor may
   * share it (a view replacing another on the same canvas). Textures handed
   * out by `upload` are the owner's to release.
   */
  dispose(): void {
    const gl = this.gl;
    this.releaseTarget();
    if (this.paletteTex) gl.deleteTexture(this.paletteTex);
    this.paletteTex = null;
    if (this.ghostMask) gl.deleteTexture(this.ghostMask);
    this.ghostMask = null;
    for (const p of this.fogPasses.values()) p.dispose();
    this.fogPasses.clear();
    this.steamPass?.dispose();
    this.steamPass = null;
    gl.deleteProgram(this.quadProg);
    gl.deleteProgram(this.palProg);
    gl.deleteVertexArray(this.vao);
  }

  private ensureTarget(w: number, h: number) {
    const gl = this.gl;
    if (this.target && this.target.w === w && this.target.h === h) return this.target;
    this.releaseTarget();
    const color = rgba8Texture(gl, w, h);
    const fb = framebuffer(gl, color, null);
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    this.target = { w, h, color, depth, fb, fogColor: [null, null], fogFb: [null, null], ghost: null };
    return this.target;
  }

  /** A fog layer's coverage over the world's cells, by the layer's id (default the style's fog); null lets its pass go. */
  setFogField(field: FogField | null, id = "fog"): void {
    let pass = this.fogPasses.get(id);
    if (!field) {
      pass?.dispose();
      this.fogPasses.delete(id);
      return;
    }
    if (!pass) this.fogPasses.set(id, (pass = new FogPass(this.gl)));
    pass.setField(field);
  }

  /**
   * Draw a frame. With `bare` tiles (those under the revealing sprites, all
   * of them baked), the first `MAX_REVEALS` sprites with `reveal` see through
   * what stands in front of them. `behind` (tiles' ground alone, while they bake) fills only
   * what nothing else covers: drawn a little further back than it stands.
   */
  render(
    frame: FrameParams,
    tiles: GpuImage[],
    sprites: SpriteInstance[],
    fogs: readonly (FogDraw | SteamDraw)[] = [],
    bare: GpuImage[] = [],
    behind: GpuImage[] = [],
    ghosts: { images: GpuImage[]; alpha: number } | null = null,
  ): void {
    const gl = this.gl;
    // the canvas's own pixels; the view's top-left in absolute art px, and target px per art px
    const w = this.canvas.width;
    const h = this.canvas.height;
    const t = this.ensureTarget(w, h);
    const ox = frame.left + frame.fracX;
    const oy = frame.top + frame.fracY;
    const k = frame.zoom;

    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.useProgram(this.quadProg);
    gl.bindVertexArray(this.vao);
    const u = this.quadU;
    gl.uniform2f(u.loc("uTarget"), w, h);
    gl.uniform1f(u.loc("uZoom"), k);
    gl.uniform2fv(u.loc("uDepthRange"), frame.depthRange);
    gl.uniform1f(u.loc("uSilhouette"), INDEX_SILHOUETTE / 255);
    gl.uniform1i(u.loc("uImage"), 0);
    gl.activeTexture(gl.TEXTURE0);

    const draw = (img: GpuImage, left: number, top: number, depthBase: number, mode: number) => {
      const x = (left - ox) * k;
      const y = (top - oy) * k;
      if (x >= w || y >= h || x + img.image.width * k <= 0 || y + img.image.height * k <= 0) return;
      gl.bindTexture(gl.TEXTURE_2D, img.texture);
      gl.uniform2f(u.loc("uRectOrigin"), x, y);
      gl.uniform2f(u.loc("uRectArt"), left, top);
      gl.uniform2f(u.loc("uRectSize"), img.image.width, img.image.height);
      gl.uniform1f(u.loc("uDepthBase"), depthBase);
      gl.uniform1i(u.loc("uMode"), mode);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    const spriteAt = (s: SpriteInstance) =>
      [
        s.sx + s.sprite.image.left,
        s.sy + s.sprite.image.top,
        s.depth + s.sprite.image.depthBase,
      ] as const;
    const reveals = bare.length ? sprites.filter((s) => s.reveal).slice(0, MAX_REVEALS) : [];
    const box = reveals.length > 0;
    if (box) {
      const ellipses = new Float32Array(4 * MAX_REVEALS);
      const fronts = new Float32Array(MAX_REVEALS);
      const densities = new Float32Array(MAX_REVEALS);
      reveals.forEach((rv, i) => {
        // the ellipse in absolute art px; the sprite's u + v, as the shader works it out
        const b = revealRect(rv)!;
        ellipses.set([(b.left + b.right) / 2, (b.top + b.bottom) / 2, (b.right - b.left) / 2, (b.bottom - b.top) / 2], 4 * i);
        fronts[i] = rv.sy / 32 + 0.75 * rv.depth;
        densities[i] = Math.min(1, Math.max(0, rv.reveal!.density));
      });
      gl.uniform4fv(u.loc("uReveal"), ellipses);
      gl.uniform1fv(u.loc("uRevealS"), fronts);
      gl.uniform1fv(u.loc("uRevealDensity"), densities);
      gl.uniform1i(u.loc("uRevealCount"), reveals.length);
    }
    gl.uniform1i(u.loc("uRevealOn"), box ? 1 : 0);
    for (const tile of tiles) draw(tile, tile.image.left, tile.image.top, tile.image.depthBase, 0);
    gl.uniform1i(u.loc("uRevealOn"), 0);
    // the bare tiles fill what the reveal let through: the depth test keeps what's still there
    if (box) for (const tile of bare) draw(tile, tile.image.left, tile.image.top, tile.image.depthBase, 2);
    // a tile's own baked ground is at the same depth as its ground alone: pushed back, the baked one wins
    for (const tile of behind) draw(tile, tile.image.left, tile.image.top, tile.image.depthBase - BEHIND_DEPTH, 0);
    for (const s of sprites) {
      const [l, tp, d] = spriteAt(s);
      draw(s.sprite, l, tp, d, 0);
    }
    // Occluded parts of player sprites: dithered highlight where the depth test fails.
    gl.depthFunc(gl.GREATER);
    gl.depthMask(false);
    for (const s of sprites) {
      if (!s.silhouette) continue;
      const [l, tp, d] = spriteAt(s);
      gl.uniform1f(u.loc("uSilhouette"), (s.silhouetteIndex ?? INDEX_SILHOUETTE) / 255);
      draw(s.sprite, l, tp, d, 1);
    }
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);

    // Buildings cut down (D-159), shown faintly where they stood (D-160): the uncut tiles in a target of their own,
    // nearest surface kept, cleared to the farthest depth; the palette pass blends them where they're nearer
    const ghostOn = !!ghosts && ghosts.alpha > 0 && ghosts.images.length > 0;
    if (ghostOn) {
      if (!t.ghost) {
        const color = rgba8Texture(gl, w, h);
        const fb = framebuffer(gl, color, null);
        const depth = gl.createRenderbuffer()!;
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
        t.ghost = { color, depth, fb };
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.ghost.fb);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 1, 1, 1);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniform1i(u.loc("uRevealOn"), 0);
      for (const tile of ghosts!.images) draw(tile, tile.image.left, tile.image.top, tile.image.depthBase, 0);
      gl.clearColor(0, 0, 0, 1);
    }
    gl.disable(gl.DEPTH_TEST);

    // Atmosphere: fog dithered into the indices, from the depth beside them; each pass after the last, taking turns between two targets.
    let shown = t.color;
    let turn = 0;
    for (const item of fogs) {
      const fog = "frame" in item ? this.fogPasses.get(item.id) : null;
      if (fog !== null && !fog?.hasField) continue;
      if (!t.fogFb[turn]) {
        t.fogColor[turn] = rgba8Texture(gl, w, h);
        t.fogFb[turn] = framebuffer(gl, t.fogColor[turn]!, null);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fogFb[turn]!);
      gl.viewport(0, 0, w, h);
      if ("steam" in item) (this.steamPass ??= new SteamPass(gl)).draw(item.steam, shown, [ox, oy], k, frame.depthRange);
      else fog!.draw(item.frame, shown, [ox, oy], k, frame.depthRange);
      shown = t.fogColor[turn]!;
      turn = 1 - turn;
    }

    // Palette + integer upscale to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.palProg);
    const p = this.palU;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, shown);
    gl.uniform1i(p.loc("uIndex"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.uniform1i(p.loc("uPalette"), 1);
    gl.uniform2f(p.loc("uCanvas"), this.canvas.width, this.canvas.height);
    gl.uniform1i(p.loc("uLut"), this.lut);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, ghostOn ? t.ghost!.color : null);
    gl.uniform1i(p.loc("uGhost"), 2);
    gl.uniform1f(p.loc("uGhostAlpha"), ghostOn ? ghosts!.alpha : 0);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, ghostOn ? this.ghostMask : null);
    gl.uniform1i(p.loc("uGhostMask"), 3);
    gl.uniform1i(p.loc("uGhostMasked"), ghostOn && this.ghostMask ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
