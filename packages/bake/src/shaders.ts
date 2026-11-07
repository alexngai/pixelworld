/** GLSL ES 3.00 sources for the bake passes. See docs/architecture.md §8.1. */

const ATTRIBS = /* glsl */ `
layout(location = 0) in vec3 aPos;     // grid x, y, height steps
layout(location = 1) in vec3 aNormal;  // true 3D, z up
layout(location = 2) in vec3 aMat;     // material, face kind, ambient occlusion
layout(location = 3) in vec2 aCell;    // owning cell
layout(location = 4) in vec2 aRoad;    // road mask, road class (top faces)
layout(location = 5) in float aGeol;   // geology province id
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
out vec2 vGrid;
flat out vec2 vMat;
flat out vec2 vCell;
flat out vec2 vRoad;
flat out float vGeol;

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
  vGrid = aPos.xy;
  vMat = aMat.xy;
  vCell = aCell;
  vRoad = aRoad;
  vGeol = aGeol;
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
in vec2 vGrid;
flat in vec2 vMat;
flat in vec2 vCell;
flat in vec2 vRoad;
flat in float vGeol;

uniform vec2 uOrigin;
uniform vec3 uSun;
uniform vec3 uLightLevels;   // n·l of a lit top face, n·l spacing per shade, shadow drop
uniform int uShadowEnabled;
uniform sampler2D uShadowMap;
uniform vec4 uLightRect;
uniform vec2 uLightDepth;
uniform vec4 uOwned;         // x0, y0, x1, y1 (cells)
uniform float uAoStrength;

// Packed tables (see packages/style MaterialTables).
uniform vec4 uSurfaces[16];      // ramp (-1 = strata), pattern, density, -
uniform vec4 uStrataMin[16];     // 4 sets × 16 bands of lower bounds (steps)
uniform ivec4 uStrataRamp[16];
uniform ivec4 uStrataCount;
uniform ivec4 uProvinceSet[4];   // geology id → strata set
uniform vec4 uRoads[16];         // per road class: half width (cells), centre line
uniform int uAsphaltRamp;
uniform int uMarkingRamp;

out vec4 oG;

const int PATTERN_TREES = 1;
const int PATTERN_SPECKLE = 2;
const int PATTERN_SPARKLE = 3;
const int PATTERN_FIELDS = 4;
const int PATTERN_BLOCKS = 5;

uint hash3(uint x, uint y, uint z) {
  uint h = x * 0x8da6b343u ^ y * 0xd8163841u ^ z * 0xcb1ab31fu;
  h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
  return h;
}
float rnd(int x, int y, int salt) {
  return float(hash3(uint(x), uint(y), uint(salt)) & 0xffffffu) / 16777216.0;
}

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
  return length(p - a - ab * t);
}

// Distance from a point in the cell (0..1) to the road strip centre lines:
// centre → neighbour for each connection bit, plus diagonal roads of other
// cells that pass through this cell's corners.
float roadDistance(vec2 local, int mask) {
  const vec2 ENDS[8] = vec2[8](
    vec2(0.5, 0.0), vec2(1.0, 0.0), vec2(1.0, 0.5), vec2(1.0, 1.0),
    vec2(0.5, 1.0), vec2(0.0, 1.0), vec2(0.0, 0.5), vec2(0.0, 0.0));
  const vec2 CORNERS[4] = vec2[4](vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0));
  float d = 1e9;
  for (int i = 0; i < 8; i++)
    if (((mask >> i) & 1) == 1) d = min(d, segDist(local, vec2(0.5), ENDS[i]));
  for (int k = 0; k < 4; k++) {
    if (((mask >> (8 + k)) & 1) == 0) continue;
    vec2 P = CORNERS[k];
    vec2 u = normalize(vec2(0.5 - P.y, P.x - 0.5));  // perpendicular to the cell diagonal
    vec2 q = local - P;
    d = min(d, abs(q.x * u.y - q.y * u.x));
  }
  return d;
}

int strataRampAt(int set, float h, out float above) {
  int count = uStrataCount[set];
  int last = set * 16 + count - 1;
  int ramp = uStrataRamp[last >> 2][last & 3];
  above = 99.0;
  for (int i = 0; i < 16; i++) {
    if (i >= count) break;
    int k = set * 16 + i;
    float m = uStrataMin[k >> 2][k & 3];
    if (h >= m) { ramp = uStrataRamp[k >> 2][k & 3]; above = h - m; break; }
  }
  return ramp;
}

void main() {
  int mat = int(vMat.x + 0.5);
  int kind = int(vMat.y + 0.5);
  bool vertical = kind == 2 || kind == 3;
  int geol = int(vGeol + 0.5);
  int strataSet = uProvinceSet[geol >> 2][geol & 3];

  int ramp;
  int pattern;
  float density;
  if (mat >= 100) {
    ramp = mat - 100; pattern = 0; density = 0.0;
  } else {
    vec4 surf = uSurfaces[mat];
    ramp = int(surf.x); pattern = int(surf.y + 0.5); density = surf.z;
    if (vertical) { ramp = -1; pattern = PATTERN_SPECKLE; density = 0.025; }
  }
  float aboveBand = 99.0;
  if (ramp < 0) ramp = strataRampAt(strataSet, vH, aboveBand);

  // Road decal on top faces.
  int roadMask = int(vRoad.x + 0.5);
  if (roadMask != 0 && !vertical && mat < 100) {
    vec4 rc = uRoads[int(vRoad.y + 0.5)];
    if (rc.x > 0.0) {
      float d = roadDistance(vGrid - vCell, roadMask);
      if (d <= rc.x) {
        ramp = (rc.y > 0.5 && d < 0.022) ? uMarkingRamp : uAsphaltRamp;
        pattern = 0;
      }
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
  } else if (pattern == PATTERN_FIELDS && !vertical) {
    // world-anchored patchwork: each third of a cell is a field of its own shade
    ivec2 parcel = ivec2(floor(vGrid * 3.0));
    float r = rnd(parcel.x, parcel.y, 4);
    level += r < density * 0.5 ? -1.0 : (r > 1.0 - density * 0.5 ? 1.0 : 0.0);
  } else if (pattern == PATTERN_BLOCKS && !vertical) {
    // world-anchored city blocks: streets every third of a cell, lit roofs
    vec2 f = fract(vGrid * 3.0);
    ivec2 block = ivec2(floor(vGrid * 3.0));
    if (min(f.x, f.y) < 0.14) level -= 1.0;
    else if (rnd(block.x * 7 + col, block.y * 5 + row, 5) < density) level += 1.0;
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
