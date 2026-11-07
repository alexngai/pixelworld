/** GLSL ES 3.00 sources for the bake passes. See docs/architecture.md §8.1. */

const ATTRIBS = /* glsl */ `
layout(location = 0) in vec3 aPos;     // grid x, y, height steps
layout(location = 1) in vec3 aNormal;  // true 3D, z up
layout(location = 2) in vec3 aMat;     // material, face kind, ambient occlusion
layout(location = 3) in vec2 aCell;    // owning cell
`;

export const SHADOW_VS = /* glsl */ `#version 300 es
precision highp float;
${ATTRIBS}
uniform mat2 uRot;
uniform float uStepWorld;
uniform vec3 uSun;
uniform vec3 uLightRight;
uniform vec3 uLightUp;
uniform vec4 uLightRect;   // minX, minY, maxX, maxY
uniform vec2 uLightDepth;  // min/max distance toward the sun
void main() {
  vec3 P = vec3(uRot * aPos.xy, aPos.z * uStepWorld);
  float lx = dot(P, uLightRight);
  float ly = dot(P, uLightUp);
  float t = dot(P, uSun);
  gl_Position = vec4(
    2.0 * (lx - uLightRect.x) / (uLightRect.z - uLightRect.x) - 1.0,
    2.0 * (ly - uLightRect.y) / (uLightRect.w - uLightRect.y) - 1.0,
    1.0 - 2.0 * (t - uLightDepth.x) / (uLightDepth.y - uLightDepth.x),
    1.0);
}
`;

export const SHADOW_FS = /* glsl */ `#version 300 es
precision highp float;
void main() {}
`;

export const GBUFFER_VS = /* glsl */ `#version 300 es
precision highp float;
${ATTRIBS}
uniform mat2 uRot;
uniform vec2 uOrigin;      // screen px of the target's top-left corner
uniform vec2 uSize;        // target size in px
uniform vec2 uDepthRange;  // scene min/max depth
uniform float uStepWorld;
uniform vec3 uSun;
uniform vec3 uLightRight;
uniform vec3 uLightUp;

out vec3 vNormal;
out vec3 vLight;
out float vH;
out float vAo;
flat out vec2 vMat;
flat out vec2 vCell;

void main() {
  vec2 uv = uRot * aPos.xy;
  float h = aPos.z;
  float sx = 16.0 * (uv.x - uv.y);
  float sy = 8.0 * (uv.x + uv.y) - 8.0 * h;
  float d = uv.x + uv.y + h / 3.0;
  gl_Position = vec4(
    2.0 * (sx - uOrigin.x) / uSize.x - 1.0,
    2.0 * (sy - uOrigin.y) / uSize.y - 1.0,
    1.0 - 2.0 * (d - uDepthRange.x) / (uDepthRange.y - uDepthRange.x),
    1.0);
  vNormal = vec3(uRot * aNormal.xy, aNormal.z);
  vec3 P = vec3(uv, h * uStepWorld) + vNormal * 0.04;  // normal offset against acne
  vLight = vec3(dot(P, uLightRight), dot(P, uLightUp), dot(P, uSun));
  vH = h;
  vAo = aMat.z;
  vMat = aMat.xy;
  vCell = aCell;
}
`;

export const GBUFFER_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 vNormal;
in vec3 vLight;
in float vH;
in float vAo;
flat in vec2 vMat;
flat in vec2 vCell;

uniform vec2 uOrigin;
uniform vec3 uSun;
uniform vec3 uLightLevels;   // n·l of a lit top face, n·l spacing per shade, shadow drop
uniform int uShadowEnabled;
uniform sampler2D uShadowMap;
uniform vec4 uLightRect;
uniform vec2 uLightDepth;
uniform vec4 uOwned;         // x0, y0, x1, y1 (cells)
uniform float uAoStrength;

uniform int uSurfRamp[16];
uniform int uSurfPattern[16];
uniform float uSurfDensity[16];
uniform float uStrataMin[16];
uniform int uStrataRamp[16];
uniform int uStrataCount;

out vec4 oG;

const int PATTERN_TREES = 1;
const int PATTERN_SPECKLE = 2;
const int PATTERN_SPARKLE = 3;

uint hash3(uint x, uint y, uint z) {
  uint h = x * 0x8da6b343u ^ y * 0xd8163841u ^ z * 0xcb1ab31fu;
  h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
  return h;
}
float rnd(int x, int y, int salt) {
  return float(hash3(uint(x), uint(y), uint(salt)) & 0xffffffu) / 16777216.0;
}

void main() {
  int mat = int(vMat.x + 0.5);
  int kind = int(vMat.y + 0.5);
  bool vertical = kind == 2 || kind == 3;

  int ramp;
  int pattern;
  float density;
  if (mat >= 100) {
    ramp = mat - 100; pattern = 0; density = 0.0;
  } else {
    ramp = uSurfRamp[mat]; pattern = uSurfPattern[mat]; density = uSurfDensity[mat];
    if (vertical) { ramp = -1; pattern = PATTERN_SPECKLE; density = 0.025; }
  }
  float aboveBand = 99.0;
  if (ramp < 0) {
    ramp = uStrataRamp[uStrataCount - 1];
    for (int i = 0; i < 16; i++) {
      if (i >= uStrataCount) break;
      if (vH >= uStrataMin[i]) { ramp = uStrataRamp[i]; aboveBand = vH - uStrataMin[i]; break; }
    }
  }

  vec3 n = normalize(vNormal);
  float ndl = dot(n, uSun);
  bool shadowed = ndl <= 0.0;
  if (!shadowed && uShadowEnabled == 1) {
    vec2 luv = (vLight.xy - uLightRect.xy) / (uLightRect.zw - uLightRect.xy);
    if (all(greaterThanEqual(luv, vec2(0.0))) && all(lessThanEqual(luv, vec2(1.0)))) {
      float z = texture(uShadowMap, luv).r;
      float occluder = uLightDepth.x + (1.0 - z) * (uLightDepth.y - uLightDepth.x);
      shadowed = occluder > vLight.z + 0.02;
    }
  }
  float level = 4.0 + (ndl - uLightLevels.x) / uLightLevels.y;
  if (shadowed) level -= uLightLevels.z;
  level = floor(level + 0.5);

  ivec2 ap = ivec2(floor(gl_FragCoord.xy)) + ivec2(uOrigin);
  int col = int(floor(float(ap.x) * 0.5));
  int row = ap.y;
  if (pattern == PATTERN_TREES && !vertical) {
    if (rnd(col, row, 1) < density) level += 1.0;
    else if (rnd(col, row - 1, 1) < density) level -= 1.0;
    else if (rnd(col, row - 2, 1) < density) level -= 2.0;
  } else if (pattern == PATTERN_SPECKLE) {
    if (rnd(col, row, 2) < density) level -= 1.0;
  } else if (pattern == PATTERN_SPARKLE && !vertical) {
    if (rnd(col, row, 3) < density) level += 1.0;
  }
  if (vertical && aboveBand < 0.14) level -= 1.0;  // strata bedding line
  level = clamp(level, 1.0, 5.0);

  bool owned = vCell.x >= uOwned.x && vCell.y >= uOwned.y && vCell.x < uOwned.z && vCell.y < uOwned.w;
  // Dead zone: only real occlusion dithers; open ground stays clean.
  float aoDark = clamp((1.0 - vAo) * uAoStrength - 0.35, 0.0, 2.0);
  int flags = (owned ? 1 : 0) | (kind << 1);
  oG = vec4(float(ramp + 1), level, floor(aoDark * 127.5 + 0.5), float(flags)) / 255.0;
}
`;

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uG;
uniform sampler2D uDepth;
uniform ivec2 uPad;
uniform ivec2 uOrigin;      // absolute screen px of output pixel (0,0)
uniform vec2 uDepthRange;
uniform float uDepthBase;
uniform float uOutlineThreshold;
uniform int uShades;

out vec4 o;

const float BAYER[16] = float[16](
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0);

ivec4 G(ivec2 q) { return ivec4(texelFetch(uG, q, 0) * 255.0 + 0.5); }
float D(ivec2 q) {
  return uDepthRange.x + (1.0 - texelFetch(uDepth, q, 0).r) * (uDepthRange.y - uDepthRange.x);
}

void main() {
  ivec2 local = ivec2(gl_FragCoord.xy);
  ivec2 p = local + uPad;
  ivec4 g = G(p);
  if (g.r == 0 || (g.a & 1) == 0) { o = vec4(0.0); return; }

  const ivec2 N4[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  int ramp = g.r - 1;
  int level = g.g;

  // Cleanup: a pixel whose four neighbours all agree with each other but not
  // with it is noise; adopt the neighbours' ramp and shade.
  ivec4 n0 = G(p + N4[0]);
  bool agree = n0.r != 0;
  for (int i = 1; i < 4; i++) {
    ivec4 ni = G(p + N4[i]);
    agree = agree && ni.r == n0.r && ni.g == n0.g;
  }
  if (agree && (n0.r != g.r || n0.g != g.g)) { ramp = n0.r - 1; level = n0.g; }

  // Outlines: against empty background, and on the near side of depth jumps.
  float d = D(p);
  bool outline = false;
  for (int i = 0; i < 4; i++) {
    ivec2 q = p + N4[i];
    if (G(q).r == 0) { outline = true; break; }
    if (d - D(q) > uOutlineThreshold) { outline = true; break; }
  }

  ivec2 a = local + uOrigin;
  float bayer = (BAYER[(a.y & 3) * 4 + (a.x & 3)] + 0.5) / 16.0;
  float aoDark = float(g.b) / 127.5;
  int shade = clamp(level - int(floor(aoDark + bayer)), 1, uShades - 1);
  if (outline) shade = 0;

  int index = 1 + ramp * uShades + shade;
  float local16 = clamp(floor((d - uDepthBase) * 256.0 + 0.5), 0.0, 65535.0);
  o = vec4(float(index), floor(local16 / 256.0), mod(local16, 256.0), 255.0) / 255.0;
}
`;
