/** GLSL ES 3.00 sources for the bake passes. See docs/architecture.md §8.1. */

const ATTRIBS = /* glsl */ `
layout(location = 0) in vec3 aPos;     // grid x, y, height steps
layout(location = 1) in vec3 aNormal;  // true 3D, z up
layout(location = 2) in vec3 aMat;     // material, face kind, ambient occlusion
layout(location = 3) in vec2 aCell;    // owning cell
layout(location = 4) in vec2 aRoad;    // road mask, road class (top faces)
layout(location = 5) in float aGeol;   // geology province id
layout(location = 6) in vec3 aInstOffset; // instanced objects: position offset (0 otherwise)
layout(location = 7) in vec2 aInstCell;   // instanced objects: owning cell (0 otherwise)
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
  vec3 pos = aPos + aInstOffset;
  vec3 P = vec3(uRot * pos.xy, pos.z * uStepWorld);
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
uniform float uScale;      // render units per world cell (1, or < 1 for fine worlds)

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
  vec3 pos = aPos + aInstOffset;
  vec2 uv = uRot * pos.xy;
  float h = pos.z;
  float sx = 16.0 * (uv.x - uv.y);
  float sy = 8.0 * (uv.x + uv.y) - 8.0 * h;
  float d = uv.x + uv.y + h / 3.0;
  gl_Position = vec4(
    2.0 * (sx - uOrigin.x) / uSize.x - 1.0,
    2.0 * (sy - uOrigin.y) / uSize.y - 1.0,
    1.0 - 2.0 * (d - uDepthRange.x) / (uDepthRange.y - uDepthRange.x),
    1.0);
  vNormal = vec3(uRot * aNormal.xy, aNormal.z);
  vec3 P = vec3(uv, h * uStepWorld) + vNormal * 0.04 * uScale;  // normal offset against acne
  vLight = vec3(dot(P, uLightRight), dot(P, uLightUp), dot(P, uSun));
  vH = h;
  vAo = aMat.z;
  vGrid = pos.xy / uScale;  // world cell coordinates
  vMat = aMat.xy;
  vCell = aCell + aInstCell;
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
uniform float uScale;

// Packed tables (see packages/style MaterialTables).
uniform vec4 uSurfaces[16];      // ramp (-1 = strata), pattern, density, -
uniform vec4 uStrataMin[16];     // 4 sets × 16 bands of lower bounds (steps)
uniform ivec4 uStrataRamp[16];
uniform ivec4 uStrataCount;
uniform ivec4 uProvinceSet[4];   // geology id → strata set
uniform vec4 uRoads[16];         // per road class: half width (cells), centre line, ramp (-1 asphalt)
uniform int uAsphaltRamp;
uniform int uMarkingRamp;
#ifdef FIELD_WAYS
uniform isampler2D uFieldWays;   // W × H: road mask, class | half-width << 8, path mask, class | half-width << 8
uniform int uWayReach;           // cells a road or path can reach beyond its own; 0 = style widths
uniform vec4 uPaths[16];         // per path class: ramp (-1 = unstyled), stripes
#endif

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

#ifdef FIELD_WAYS
uniform mat2 uRot;
uniform isampler2D uFieldRails;  // W × H: rails drawn in the street (M3.5): connections | kind << 12
uniform int uRailRamp;           // -1: the style draws no rails

// Rails in the street (M3.5), on tops over the way decal: a track along each
// rail line (street tracks on their road's drawn centre line), cable-car
// tracks with a dark slot between their rails, a train's on a ballast bed.
// Returns the shade change it asks for.
float railsDecal(inout int ramp, inout int pattern) {
  if (uRailRamp < 0) return 0.0;
  ivec2 own = ivec2(floor(vCell + 0.5)) - uSliceOrigin;
  float best = 9.0;
  int kind = 0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 c = own + ivec2(dx, dy);
      if (c.x < 0 || c.y < 0 || c.x >= uSliceSize.x || c.y >= uSliceSize.y) continue;
      int r = texelFetch(uFieldRails, c, 0).r;
      if ((r & 255) == 0) continue;
      vec2 local = vGrid - vec2(uSliceOrigin + c);
      if (length(max(max(-local, local - 1.0), 0.0)) > 0.3) continue;
      float d = roadDistance(local, r & 255);
      if (d < best) { best = d; kind = (r >> 12) & 15; }
    }
  }
  // in cells: rails about a pixel wide at the native scale
  const float GAUGE = 0.08;  // a rail's centre from its track's
  const float RAIL = 0.035;  // a rail's half-width
  if (kind == 0) return 0.0;
  if (abs(best - GAUGE) < RAIL) { ramp = uRailRamp; pattern = 0; return 0.0; }
  if (kind == 2 && best < 0.03) { ramp = uAsphaltRamp; pattern = 0; return -2.0; }  // the cable's slot
  if (kind == 3 && best < GAUGE + 0.08) { ramp = uRailRamp; pattern = 0; return -2.0; }  // ballast
  return 0.0;
}

// Height (micro-steps) at a slice cell's centre, on the drawn micro-terrain.
float cellCentreHeight(ivec2 c) {
  ivec2 m = clamp(c * uK + uK / 2, ivec2(0), microSize() - 1);
  ivec4 h = cornersAt(m);
  return uK % 2 == 0 ? float(h.x) : dot(vec4(h), vec4(0.25));
}

// The grade of a way through slice cell c (micro-steps per cell, x and y),
// from the centre heights of the cells it connects to: two cells along where
// it runs on straight, so a steady climb drawn as flats and ramps (heights are
// whole steps per cell) reads as one slope. No grade across a way.
vec2 wayGrade(ivec2 c, int mask, bool path) {
  const ivec2 DIRS[8] = ivec2[8](ivec2(0, -1), ivec2(1, -1), ivec2(1, 0), ivec2(1, 1),
    ivec2(0, 1), ivec2(-1, 1), ivec2(-1, 0), ivec2(-1, -1));
  float h0 = cellCentreHeight(c);
  mat2 a = mat2(1e-3);
  vec2 b = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    if (((mask >> i) & 1) == 0) continue;
    ivec2 d = DIRS[i];
    ivec2 n = c + d;
    if (n.x < 0 || n.y < 0 || n.x >= uSliceSize.x || n.y >= uSliceSize.y) continue;
    ivec2 far = n + d;
    ivec4 nw = texelFetch(uFieldWays, n, 0);
    bool on = far.x >= 0 && far.y >= 0 && far.x < uSliceSize.x && far.y < uSliceSize.y &&
      ((((path ? nw.z : nw.x) >> i) & 1) == 1);
    ivec2 to = on ? far : n;
    vec2 v = vec2(to - c);
    a += outerProduct(v, v);
    b += v * (cellCentreHeight(to) - h0);
  }
  return inverse(a) * b;
}

// Real widths (D-050): a road or path can be wider than its cells, so look at
// the cells within reach and take the nearest way (relative to its half-width)
// that covers this point. Roads are at least the style's width for their class.
// Paths (sidewalks, crosswalks) draw over roads.
// The way drawn at a point (face kind: 0 flat top, 1 sloped top, 2 wall), with
// its grade as a normal (rotated like vNormal). Crosswalk stripes are drawn on
// gentle crossings only: on a steep street, screen-space stripes stand up like a
// fence. On a riser (a terrace wall) stripes and centre lines are left off.
void waysDecal(inout int ramp, inout int pattern, int kind, out bool paved, out vec3 gradeN) {
  bool riser = kind == 2;
  paved = false;
  gradeN = vec3(0.0, 0.0, 1.0);
  ivec2 own = ivec2(floor(vCell + 0.5)) - uSliceOrigin;
  float roadBest = 2.0;
  float roadD = 0.0;
  int roadCls = 0;
  ivec2 roadCell = ivec2(0);
  int roadMask = 0;
  float pathBest = 2.0;
  int pathCls = 0;
  ivec2 pathCell = ivec2(0);
  int pathMask = 0;
  int reach = min(uWayReach, 3);
  for (int dy = -reach; dy <= reach; dy++) {
    for (int dx = -reach; dx <= reach; dx++) {
      ivec2 c = own + ivec2(dx, dy);
      if (c.x < 0 || c.y < 0 || c.x >= uSliceSize.x || c.y >= uSliceSize.y) continue;
      ivec4 w = texelFetch(uFieldWays, c, 0);
      if (w.x == 0 && w.z == 0) continue;
      vec2 local = vGrid - vec2(uSliceOrigin + c);
      // a way's strips stay inside its cell: skip cells further than its half-width
      float gap = length(max(max(-local, local - 1.0), 0.0));
      if (w.x != 0) {
        int cls = w.y & 255;
        // never narrower than the style's width for the class: coarse maps keep
        // their road hierarchy, fine ones grow roads to their real width
        float hw = max(float(w.y >> 8) / 32.0, uRoads[cls].x);
        if (gap <= hw) {
          // centre-to-neighbour strips only: crossing flags would extend past the cell
          float d = roadDistance(local, w.x & 255);
          if (d <= hw && d / hw < roadBest) { roadBest = d / hw; roadD = d; roadCls = cls; roadCell = c; roadMask = w.x & 255; }
        }
      }
      if (w.z != 0) {
        float hw = float(w.w >> 8) / 32.0;
        if (hw > 0.0 && gap <= hw) {
          float d = roadDistance(local, w.z & 255);
          if (d <= hw && d / hw < pathBest) { pathBest = d / hw; pathCls = w.w & 255; pathCell = c; pathMask = w.z & 255; }
        }
      }
    }
  }
  bool path = pathCls > 0 && uPaths[pathCls].x >= 0.0;
  if (!path && roadCls == 0) return;
  paved = true;
  // the road's grade where a road runs here (sidewalks and crossings lie on
  // its bed; a crossing runs across the climb), else the path's own; in
  // micro-steps per cell → rise per run in world units
  vec2 g = (roadCls > 0 ? wayGrade(roadCell, roadMask, false) : wayGrade(pathCell, pathMask, true)) * uStepWorld / float(uK);
  vec3 n = normalize(vec3(-g, 1.0));
  gradeN = vec3(uRot * n.xy, n.z);
  pattern = 0;
  if (path) {
    vec4 pc = uPaths[pathCls];
    ivec2 ap = ivec2(floor(gl_FragCoord.xy)) + ivec2(uOrigin);
    // 2 px zebra stripes, on crossings flatter than about a third of a step per cell
    // (a crossing's own grade runs across the climb: off a road, trust flat tops only)
    bool gentle = length(g) <= 0.35 * uStepWorld && kind != 2 && (roadCls > 0 || kind == 0);
    bool gap = pc.y > 0.5 && gentle && ((ap.x >> 1) & 1) == 1;
    ramp = gap ? uAsphaltRamp : int(pc.x);
  } else {
    vec4 rc = uRoads[roadCls];
    ramp = (rc.y > 0.5 && !riser && roadD * uScale < 0.022) ? uMarkingRamp : (rc.z >= 0.0 ? int(rc.z) : uAsphaltRamp);
  }
}
#endif

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
  bool realWidths = false;
  vec3 n = normalize(vNormal);
  bool riser = false;
  float railShade = 0.0;
#ifdef FIELD_WAYS
  if (uWayReach > 0) {
    realWidths = true;
    // Pavement is lit by its way's grade rather than its micro-tiles, so a
    // steep street drawn as flats and ramps reads as one slope, not stripes.
    // Terrace walls (risers) on pavement take the pavement a shade darker
    // rather than pale strata.
    bool paved = false;
    vec3 gradeN;
    if (kind != 3 && mat < 100) waysDecal(ramp, pattern, kind, paved, gradeN);
    if (paved) {
      n = gradeN;
      riser = vertical;
    }
    if (!vertical && mat < 100) railShade = railsDecal(ramp, pattern);
  }
#endif
  if (!realWidths && roadMask != 0 && !vertical && mat < 100) {
    vec4 rc = uRoads[int(vRoad.y + 0.5)];
    if (rc.x > 0.0) {
      float d = roadDistance(vGrid - vCell, roadMask);
      if (d <= rc.x) {
        ramp = (rc.y > 0.5 && d * uScale < 0.022) ? uMarkingRamp : uAsphaltRamp;
        pattern = 0;
      }
    }
  }

  float ndl = dot(n, uSun);
  bool shadowed = ndl <= 0.0;
  if (!shadowed && uShadowEnabled == 1) {
    vec2 luv = (vLight.xy - uLightRect.xy) / (uLightRect.zw - uLightRect.xy);
    if (all(greaterThanEqual(luv, vec2(0.0))) && all(lessThanEqual(luv, vec2(1.0)))) {
      float z = texture(uShadowMap, luv).r;
      float occluder = uLightDepth.x + (1.0 - z) * (uLightDepth.y - uLightDepth.x);
      shadowed = occluder > vLight.z + 0.02 * uScale;
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
    // world-anchored patchwork: each third of a render cell is a field of its own shade
    ivec2 parcel = ivec2(floor(vGrid * uScale * 3.0));
    float r = rnd(parcel.x, parcel.y, 4);
    level += r < density * 0.5 ? -1.0 : (r > 1.0 - density * 0.5 ? 1.0 : 0.0);
  } else if (pattern == PATTERN_BLOCKS && !vertical) {
    // world-anchored city blocks: streets every third of a render cell, lit roofs
    vec2 f = fract(vGrid * uScale * 3.0);
    ivec2 block = ivec2(floor(vGrid * uScale * 3.0));
    if (min(f.x, f.y) < 0.14) level -= 1.0;
    else if (rnd(block.x * 7 + col, block.y * 5 + row, 5) < density) level += 1.0;
  }
  level += railShade;
  if (riser) level -= 1.0;  // a riser on pavement: the pavement's own colour, a shade darker
  else if (vertical && aboveBand < 0.14) level -= 1.0;  // strata bedding line
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

// ---------------------------------------------------------------------------
// Micro-terrain fields (M1.6): geometry built in the vertex shader. One
// instance per micro-cell, 18 vertices: the top (two triangles, split like
// packages/grid splitDiagonal) and the walls on the two edges that face the
// viewer, which are also the two the sun lights (SUN_DIR has +u and +v), so
// both passes need nothing else. Mirrors buildTerrainMesh for cells.

const FIELD_COMMON = /* glsl */ `
precision highp isampler2D;
uniform isampler2D uFieldCorners; // (k·W) × (k·H): drawn corners c0..c3 of each micro-cell, micro-steps
uniform isampler2D uFieldCells;   // W × H: surface, road mask, road class | geology << 8, water
uniform isampler2D uFieldVmap;    // W × H: relief reference (1/16 steps), inverse factor (1/4096)
uniform int uK;
uniform ivec2 uSliceOrigin;       // world cell of the slice's cell (0, 0)
uniform ivec2 uSliceSize;         // cells
uniform ivec2 uWorldSize;         // cells
uniform float uFloor;             // skirt bottom, steps
uniform ivec2 uNearFirst;         // 1 where instances run from high to low x / y (nearest first)
uniform int uWallEdge;            // -1: draw tops (one instance per micro-cell); else walls on this edge
uniform float uStepWorld;

const ivec2 CORNER_OFF[4] = ivec2[4](ivec2(0, 0), ivec2(1, 0), ivec2(1, 1), ivec2(0, 1));
const ivec2 EDGE_CORNERS[4] = ivec2[4](ivec2(0, 1), ivec2(1, 2), ivec2(2, 3), ivec2(3, 0));
const ivec2 EDGE_NEIGHBOR[4] = ivec2[4](ivec2(0, -1), ivec2(1, 0), ivec2(0, 1), ivec2(-1, 0));
const ivec2 EDGE_NB_CORNERS[4] = ivec2[4](ivec2(3, 2), ivec2(0, 3), ivec2(1, 0), ivec2(2, 1));

ivec2 microSize() { return uSliceSize * uK; }
bool inSlice(ivec2 m) {
  ivec2 s = microSize();
  return m.x >= 0 && m.y >= 0 && m.x < s.x && m.y < s.y;
}
bool inWorld(ivec2 m) {
  ivec2 w = uSliceOrigin * uK + m;
  ivec2 s = uWorldSize * uK;
  return w.x >= 0 && w.y >= 0 && w.x < s.x && w.y < s.y;
}
ivec4 cornersAt(ivec2 m) { return texelFetch(uFieldCorners, m, 0); }

int splitDiag(ivec4 h) {
  int d02 = abs(h.x - h.z);
  int d13 = abs(h.y - h.w);
  if (d02 != d13) return d02 < d13 ? 0 : 1;
  return h.y + h.w > h.x + h.z ? 1 : 0;
}

// Height (micro-steps) on micro-cell m's top at fraction f, same split as the mesh.
float topHeight(ivec4 h, vec2 f) {
  vec4 c = vec4(h);
  if (splitDiag(h) == 0)
    return f.x >= f.y ? c.x + (c.y - c.x) * f.x + (c.z - c.y) * f.y
                      : c.x + (c.w - c.x) * f.y + (c.z - c.w) * f.x;
  return f.x + f.y <= 1.0 ? c.x + (c.y - c.x) * f.x + (c.w - c.x) * f.y
                          : c.z + (c.w - c.z) * (1.0 - f.x) + (c.y - c.z) * (1.0 - f.y);
}


`;

/** Vertex-shader-only part of the field code (uses gl_InstanceID / gl_VertexID). */
const FIELD_VERTEX = /* glsl */ `
uniform isampler2D uWallList;  // wall draws: micro-cells (row-major index) with a wall on uWallEdge, 4096 per row
// One vertex of the instance. pos: world cells and steps. hm: its height in
// micro-steps; corner: the micro-corner it sits on (for AO). kind: face kind.
void fieldVertex(out vec3 pos, out vec3 nrm, out int kind, out ivec2 corner, out float hm, out ivec2 m) {
  // One plain draw per part, six vertices per micro-cell (instancing is slow in
  // software renderers): the micro-cell from gl_VertexID / 6.
  ivec2 ms = microSize();
  int item = gl_VertexID / 6;
  int vid = gl_VertexID % 6;
  if (uWallEdge < 0) {
    m = ivec2(item % ms.x, item / ms.x);
    // draw nearest micro-cells first so hidden fragments fail the depth test early
    if (uNearFirst.x == 1) m.x = ms.x - 1 - m.x;
    if (uNearFirst.y == 1) m.y = ms.y - 1 - m.y;
  } else {
    int cell = texelFetch(uWallList, ivec2(item % 4096, item / 4096), 0).r;
    m = ivec2(cell % ms.x, cell / ms.x);
  }
  ivec4 h = cornersAt(m);
  float k = float(uK);
  vec2 org = vec2(uSliceOrigin) + vec2(m) / k;
  if (uWallEdge < 0) {
    ivec3 t = splitDiag(h) == 0
      ? (vid < 3 ? ivec3(0, 1, 2) : ivec3(0, 2, 3))
      : (vid < 3 ? ivec3(0, 1, 3) : ivec3(1, 2, 3));
    int c = t[vid % 3];
    hm = float(h[c]);
    pos = vec3(org + vec2(CORNER_OFF[c]) / k, hm / k);
    vec3 a = vec3(vec2(CORNER_OFF[t.x]) / k, float(h[t.x]) / k * uStepWorld);
    vec3 b = vec3(vec2(CORNER_OFF[t.y]) / k, float(h[t.y]) / k * uStepWorld);
    vec3 d = vec3(vec2(CORNER_OFF[t.z]) / k, float(h[t.z]) / k * uStepWorld);
    nrm = normalize(cross(b - a, d - a));
    if (nrm.z < 0.0) nrm = -nrm;
    kind = (h.x == h.y && h.y == h.z && h.z == h.w) ? 0 : 1;
    corner = m + CORNER_OFF[c];
    return;
  }
  int e = uWallEdge;
  int j = vid;
  ivec2 ec = EDGE_CORNERS[e];
  ivec2 nb = m + EDGE_NEIGHBOR[e];
  float ta = float(h[ec.x]);
  float tb = float(h[ec.y]);
  float ba = ta;
  float bb = tb;
  kind = 2;
  if (inSlice(nb)) {
    ivec4 nh = cornersAt(nb);
    ivec2 nc = EDGE_NB_CORNERS[e];
    ba = float(nh[nc.x]);
    bb = float(nh[nc.y]);
  } else if (!inWorld(nb)) {
    ba = uFloor * k;
    bb = ba;
    kind = 3;
  }  // else: slice edge inside the world, no wall (the neighbour is another slice's)
  vec2 pa = org + vec2(CORNER_OFF[ec.x]) / k;
  vec2 pb = org + vec2(CORNER_OFF[ec.y]) / k;
  nrm = vec3(vec2(EDGE_NEIGHBOR[e]), 0.0);
  float da = ta - ba;
  float db = tb - bb;
  vec3 v = vec3(pa, ta);  // degenerate unless a case below applies
  if (da >= 0.0 && db >= 0.0) {
    if (j < 3 && da > 0.0) v = j == 0 ? vec3(pa, ta) : j == 1 ? vec3(pb, tb) : vec3(pa, ba);
    if (j >= 3 && db > 0.0) v = j == 3 ? vec3(pb, tb) : j == 4 ? vec3(pb, bb) : vec3(pa, ba);
  } else if (da > 0.0 || db > 0.0) {
    // edges cross: only the part where this side is higher
    float f = da / (da - db);
    vec3 cr = vec3(mix(pa, pb, f), ta + (tb - ta) * f);
    if (j < 3) {
      if (da > 0.0) v = j == 0 ? vec3(pa, ta) : j == 1 ? cr : vec3(pa, ba);
      else v = j == 0 ? vec3(pb, tb) : j == 1 ? vec3(pb, bb) : cr;
    }
  }
  hm = v.z;
  pos = vec3(v.xy, v.z / k);
  corner = m + (distance(v.xy, pa) <= distance(v.xy, pb) ? CORNER_OFF[ec.x] : CORNER_OFF[ec.y]);
}
`;

export const FIELD_SHADOW_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${FIELD_COMMON}
${FIELD_VERTEX}
uniform mat2 uRot;
uniform vec3 uSun;
uniform vec3 uLightRight;
uniform vec3 uLightUp;
uniform vec4 uLightRect;
uniform vec2 uLightDepth;
void main() {
  vec3 pos; vec3 nrm; int kind; ivec2 corner; float hm; ivec2 m;
  fieldVertex(pos, nrm, kind, corner, hm, m);
  vec3 P = vec3(uRot * pos.xy, pos.z * uStepWorld);
  gl_Position = vec4(
    2.0 * (dot(P, uLightRight) - uLightRect.x) / (uLightRect.z - uLightRect.x) - 1.0,
    2.0 * (dot(P, uLightUp) - uLightRect.y) / (uLightRect.w - uLightRect.y) - 1.0,
    1.0 - 2.0 * (dot(P, uSun) - uLightDepth.x) / (uLightDepth.y - uLightDepth.x),
    1.0);
}
`;

export const FIELD_GBUFFER_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${FIELD_COMMON}
${FIELD_VERTEX}
uniform mat2 uRot;
uniform vec2 uOrigin;
uniform vec2 uSize;
uniform vec2 uDepthRange;
uniform vec3 uSun;
uniform vec3 uLightRight;
uniform vec3 uLightUp;
uniform float uScale;
uniform sampler2D uFieldAo;      // (k·W + 1) × (k·H + 1): AO at each corner's lowest and highest height
uniform int uSteepDrop;          // micro-steps; tops this far above a neighbour are bare rock (0 = off)
uniform int uRockSurface;        // surface id drawn on steep tops (-1 = none)
uniform int uWaterSurface;
uniform int uSnowSurface;

out vec3 vNormal;
out vec3 vLight;
out float vH;
out float vAo;
out vec2 vGrid;
flat out vec2 vMat;
flat out vec2 vCell;
flat out vec2 vRoad;
flat out float vGeol;

// Real height (steps) of a drawn point, for strata: undo the relief exaggeration
// (ref + (h − ref)·invR), interpolated between cell centres.
float realHeight(vec3 pos) {
  vec2 g = pos.xy - vec2(uSliceOrigin) - 0.5;
  ivec2 i0 = ivec2(floor(g));
  vec2 f = g - vec2(i0);
  vec2 acc = vec2(0.0);
  for (int j = 0; j < 4; j++) {
    ivec2 o = ivec2(j & 1, j >> 1);
    ivec2 c = clamp(i0 + o, ivec2(0), uSliceSize - 1);
    vec2 v = vec2(texelFetch(uFieldVmap, c, 0).rg) * vec2(1.0 / 16.0, 1.0 / 4096.0);
    acc += v * (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
  }
  return acc.x + (pos.z - acc.x) * acc.y;
}

float cornerAo(ivec2 c, float hm) {
  // the corner's height range over the micro-cells that share it
  float lo = 1e9;
  float hi = -1e9;
  for (int i = 0; i < 4; i++) {
    ivec2 mc = c - CORNER_OFF[i];  // the micro-cell whose corner i is c
    if (!inSlice(mc)) continue;
    float v = float(cornersAt(mc)[i]);
    lo = min(lo, v);
    hi = max(hi, v);
  }
  vec2 ao = texelFetch(uFieldAo, c, 0).rg;
  float t = hi > lo ? clamp((hm - lo) / (hi - lo), 0.0, 1.0) : 0.0;
  return mix(ao.r, ao.g, t);
}

void main() {
  vec3 pos; vec3 nrm; int kind; ivec2 corner; float hm; ivec2 m;
  fieldVertex(pos, nrm, kind, corner, hm, m);
  ivec2 cell = m / uK;
  ivec4 attr = texelFetch(uFieldCells, cell, 0);
  int surface = attr.x;
  // Ragged land-cover borders: each micro-cell takes its surface from a point
  // jittered by up to ±0.4 cell (hashed in world coordinates, so tiles agree).
  // Water keeps its exact cells: its geometry is flat only there.
  {
    ivec2 wm = uSliceOrigin * uK + m;
    uint hx = uint(wm.x) * 0x8da6b343u ^ uint(wm.y) * 0xd8163841u;
    hx ^= hx >> 16; hx *= 0x7feb352du; hx ^= hx >> 15; hx *= 0x846ca68bu; hx ^= hx >> 16;
    vec2 jit = vec2(float(hx & 0xffffu), float(hx >> 16)) / 65536.0 - 0.5;
    ivec2 jc = clamp(ivec2(floor((vec2(m) + 0.5) / float(uK) + jit * 0.8)), ivec2(0), uSliceSize - 1);
    int js = texelFetch(uFieldCells, jc, 0).x;
    if (surface != uWaterSurface && js != uWaterSurface) surface = js;
  }
  if (kind <= 1 && uSteepDrop > 0 && uRockSurface >= 0 && surface != uWaterSurface && surface != uSnowSurface) {
    ivec4 h = cornersAt(m);
    bool steep = false;
    for (int e = 0; e < 4; e++) {
      ivec2 nb = m + EDGE_NEIGHBOR[e];
      if (!inSlice(nb)) continue;
      ivec4 nh = cornersAt(nb);
      ivec2 ec = EDGE_CORNERS[e];
      ivec2 nc = EDGE_NB_CORNERS[e];
      if (min(h[ec.x], h[ec.y]) - max(nh[nc.x], nh[nc.y]) >= uSteepDrop) steep = true;
    }
    if (steep) surface = uRockSurface;
  }

  vec2 uv = uRot * pos.xy;
  float h = pos.z;
  float sx = 16.0 * (uv.x - uv.y);
  float sy = 8.0 * (uv.x + uv.y) - 8.0 * h;
  float d = uv.x + uv.y + h / 3.0;
  gl_Position = vec4(
    2.0 * (sx - uOrigin.x) / uSize.x - 1.0,
    2.0 * (sy - uOrigin.y) / uSize.y - 1.0,
    1.0 - 2.0 * (d - uDepthRange.x) / (uDepthRange.y - uDepthRange.x),
    1.0);
  vNormal = vec3(uRot * nrm.xy, nrm.z);
  vec3 P = vec3(uv, h * uStepWorld) + vNormal * 0.04 * uScale;
  vLight = vec3(dot(P, uLightRight), dot(P, uLightUp), dot(P, uSun));
  vH = realHeight(pos);
  vAo = cornerAo(corner, hm);
  vGrid = pos.xy / uScale;
  vMat = vec2(float(surface), float(kind));
  vCell = vec2(uSliceOrigin + cell);
  vRoad = kind <= 1 ? vec2(float(attr.y), float(attr.z & 255)) : vec2(0.0);
  vGeol = float(attr.z >> 8);
}
`;

/** AO for every micro-corner at its lowest (r) and highest (g) height; mirrors AoSampler. */
export const FIELD_AO_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${FIELD_COMMON}
out vec4 o;

float heightAt(vec2 p) {
  ivec2 m = clamp(ivec2(floor(p)), ivec2(0), microSize() - 1);
  return topHeight(cornersAt(m), clamp(p - vec2(m), 0.0, 1.0));
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float lo = 1e9;
  float hi = -1e9;
  for (int i = 0; i < 4; i++) {
    ivec2 mc = c - CORNER_OFF[i];
    if (!inSlice(mc)) continue;
    float v = float(cornersAt(mc)[i]);
    lo = min(lo, v);
    hi = max(hi, v);
  }
  const vec2 DIRS[8] = vec2[8](vec2(1, 0), vec2(-1, 0), vec2(0, 1), vec2(0, -1),
    vec2(0.70710678, 0.70710678), vec2(-0.70710678, 0.70710678),
    vec2(0.70710678, -0.70710678), vec2(-0.70710678, -0.70710678));
  const float DIST[5] = float[5](1.0, 2.0, 4.0, 8.0, 12.0);  // micro-cells
  vec2 size = vec2(microSize());
  float sumLo = 0.0;
  float sumHi = 0.0;
  for (int i = 0; i < 8; i++) {
    float bestLo = 0.0;
    float bestHi = 0.0;
    for (int s = 0; s < 5; s++) {
      vec2 q = vec2(c) + DIRS[i] * DIST[s];
      if (q.x < 0.0 || q.y < 0.0 || q.x > size.x || q.y > size.y) continue;
      float hs = heightAt(q);
      // rise over run: both in micro units, so steps/cells cancel except the step scale
      bestLo = max(bestLo, (hs - lo) * uStepWorld / DIST[s]);
      bestHi = max(bestHi, (hs - hi) * uStepWorld / DIST[s]);
    }
    sumLo += bestLo / sqrt(1.0 + bestLo * bestLo);
    sumHi += bestHi / sqrt(1.0 + bestHi * bestHi);
  }
  o = vec4(1.0 - sumLo / 8.0, 1.0 - sumHi / 8.0, 0.0, 1.0);
}
`;

/**
 * G-buffer fragment shader for micro-terrain fields: the same as GBUFFER_FS,
 * plus the field textures, so roads and paths can be drawn at their real
 * widths across neighbouring cells (D-050).
 */
export const FIELD_GBUFFER_FS = GBUFFER_FS.replace(
  "precision highp sampler2D;\n",
  "precision highp sampler2D;\n#define FIELD_WAYS 1\n" + FIELD_COMMON,
);
