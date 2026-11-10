import type { ObjectHit, PickResult, Rotation, StylePack, WorldQuery, WorldView } from "@pixelworlds/engine";
import { listGenerators, resolveAsset } from "@pixelworlds/generators";
import { unprojectAtHeight } from "@pixelworlds/grid";
import { INDEX_BACKGROUND, INDEX_SILHOUETTE, SHADES, buildPalette, type Palette } from "@pixelworlds/style";

/**
 * What is under a canvas pixel (`__pixelworld.inspect(x, y)`, Alt+click):
 * the palette entry its colour is (ramp and shade), where the style pack uses
 * that ramp, the ground the view ray reaches (cell, surface, road), and the
 * placed object drawn there with its asset group, generator and landmark id.
 *
 * Bakes keep no per-pixel object id, so the object is found from the
 * queries: march the view ray down from above toward the ground, take the
 * placed objects whose footprint and estimated height (`query.objectsAt`) it
 * passes through, nearest first, and keep the first whose asset draws in the
 * pixel's ramp. Decorative scatter, traffic and the rover aren't placed
 * objects, and a part drawn above an object's estimated top is missed.
 */

export interface Inspection {
  /** The point asked about: CSS pixels from the canvas's top-left. */
  x: number;
  y: number;
  /** Its colour on the canvas, "#rrggbb". */
  color: string;
  /** The palette entry with that colour in the palette shown now (day or night), or null. */
  index: number | null;
  /** The entry's ramp ("background" and "silhouette" for those entries) and shade (0 darkest … 5 lightest). */
  ramp: string | null;
  shade: number | null;
  /** Other ramps with an entry of the same colour (rare). */
  alsoRamps: string[];
  /** Where the style pack uses the ramp: `surface:forest`, `strata:canyon/Tonto`, `roads.asphalt`, `asset:tree.conifer/crown`, … */
  usedBy: string[];
  /** Where the view ray meets what is drawn there (cells, steps): the object's side or top, else the ground. */
  cell: { x: number; y: number; h: number } | null;
  /** The ground the ray reaches (behind any object), and what it is. */
  ground: { x: number; y: number; h: number; surface: string; surfaceRamp: string | null; road: string | null } | null;
  lonLat: [number, number] | null;
  /** The placed object drawn at the pixel, if any. */
  object: {
    group: string;
    /** The generator its asset names, and who registered it (`@pixelworlds/generators`, a plugin's name). */
    generator: string | null;
    source: string | null;
    /** The asset's roles drawn in the pixel's ramp (`wall`, `roof`, …). */
    roles: string[];
    /** Its anchor and footprint bounds (cells), base and estimated top (steps). */
    anchor: [number, number];
    bounds: [number, number, number, number];
    base: number | null;
    top: number | null;
  } | null;
  /** The landmark registry id of that object (`hoover-dam`), or null. */
  landmark: string | null;
}

/** Palette entries (day or night) whose colour is `rgb`, with their ramp and shade. */
export function paletteMatches(
  palette: Palette,
  rgb: readonly [number, number, number],
): { index: number; ramp: string; shade: number | null }[] {
  const names = new Map([...palette.rampIds].map(([name, id]) => [id, name]));
  const out: { index: number; ramp: string; shade: number | null }[] = [];
  for (let i = 0; i < 256; i++) {
    const c = palette.rgba.subarray(i * 4, i * 4 + 3);
    if (c[0] !== rgb[0] || c[1] !== rgb[1] || c[2] !== rgb[2]) continue;
    if (i === INDEX_BACKGROUND) out.push({ index: i, ramp: "background", shade: null });
    else if (i === INDEX_SILHOUETTE) out.push({ index: i, ramp: "silhouette", shade: null });
    else {
      const name = names.get(Math.floor((i - 1) / SHADES));
      if (name !== undefined) out.push({ index: i, ramp: name, shade: (i - 1) % SHADES });
    }
  }
  return out;
}

/** Where a style pack uses a ramp: surfaces, strata bands, roads and paths, asset roles, fog. */
export function rampUses(style: StylePack, ramp: string): string[] {
  const out: string[] = [];
  for (const [name, s] of Object.entries(style.surfaces)) if (s.ramp === ramp) out.push(`surface:${name}`);
  for (const [name, s] of Object.entries(style.objects?.surfaces ?? {}))
    if (s.ramp === ramp && style.surfaces[name]?.ramp !== ramp) out.push(`objects.surface:${name}`);
  for (const [set, bands] of Object.entries(style.strataSets))
    for (const b of bands) if (b.ramp === ramp) out.push(`strata:${set}/${b.name}`);
  const roads = style.roads;
  if (roads) {
    for (const key of ["asphalt", "marking", "rail"] as const) if (roads[key] === ramp) out.push(`roads.${key}`);
    if (roads.lanes?.ramp === ramp) out.push("roads.lanes");
    for (const [cls, c] of Object.entries(roads.classes)) if (c.ramp === ramp) out.push(`roads.classes.${cls}`);
  }
  for (const [cls, c] of Object.entries(style.paths?.classes ?? {})) if (c.ramp === ramp) out.push(`paths.classes.${cls}`);
  for (const [group, a] of Object.entries(style.assets ?? {}))
    for (const [role, r] of Object.entries(a.ramps)) if (r === ramp) out.push(`asset:${group}/${role}`);
  if (style.atmosphere?.fog?.ramp === ramp) out.push("atmosphere.fog");
  return out;
}

/** How far the view ray moves (cells) per step of height in a rotation: the ray through a pixel is ground + (h − ground.h) × this. */
export function rayPerStep(rotation: Rotation, renderScale: number): [number, number] {
  const [x0, y0] = unprojectAtHeight(0, 0, 0, rotation);
  const [x1, y1] = unprojectAtHeight(0, 0, renderScale, rotation);
  return [(x1 - x0) / renderScale, (y1 - y0) / renderScale];
}

/** Height resolution of the march (steps), and how far above the ground it starts. */
const STEP = 1 / 8;
const REACH = 400;

/**
 * The placed objects the view ray passes through above the ground point,
 * nearest the viewer first, with the point where it enters each. An object
 * without an estimated top (trees, props) is taken to be 3 voxels-per-step
 * tall at the world's render scale.
 */
export function objectsOnRay(
  query: Pick<WorldQuery, "objectsAt">,
  ground: { x: number; y: number; h: number },
  perStep: [number, number],
  opts: { renderScale: number; top: number },
): { hit: ObjectHit; at: { x: number; y: number; h: number } }[] {
  const seen = new Set<string>();
  const out: { hit: ObjectHit; at: { x: number; y: number; h: number } }[] = [];
  const pointTop = 3 / opts.renderScale;
  for (let h = Math.max(opts.top, ground.h) + REACH; h >= ground.h; h -= STEP) {
    const x = ground.x + (h - ground.h) * perStep[0];
    const y = ground.y + (h - ground.h) * perStep[1];
    for (const o of query.objectsAt(x, y)) {
      if (o.base === null || h < o.base || h > (o.top ?? o.base + pointTop)) continue;
      const key = `${o.group}@${o.x},${o.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ hit: o, at: { x, y, h } });
    }
  }
  return out;
}

/** The asset roles of a group drawn in one of these ramps. */
function rolesIn(style: StylePack, group: string, ramps: string[]): string[] {
  const asset = style.assets ? resolveAsset(style.assets, group) : null;
  return asset ? Object.entries(asset.ramps).filter(([, r]) => ramps.includes(r)).map(([role]) => role) : [];
}

/** An inspector for a view: reads the canvas and the view's queries. */
export function inspector(view: WorldView): (x: number, y: number) => Inspection {
  const reader = document.createElement("canvas");
  reader.width = reader.height = 1;
  const ctx = reader.getContext("2d", { willReadFrequently: true })!;
  let night: Palette | null = null;
  const palette = () => (view.palette === "night" ? (night ??= buildPalette(view.world.style, "night")) : view.world.palette);

  return (x, y) => {
    const { style, renderScale } = view.world;
    const px = Math.floor(x * view.pixelRatio);
    const py = Math.floor(y * view.pixelRatio);
    ctx.clearRect(0, 0, 1, 1);
    ctx.drawImage(view.canvas, px, py, 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const rgb: [number, number, number] = [r!, g!, b!];
    const matches = paletteMatches(palette(), rgb);
    const first = matches[0] ?? null;
    const ramps = matches.map((m) => m.ramp);

    const pick: PickResult | null = view.query.pick(x, y);
    let ground: Inspection["ground"] = null;
    let object: Inspection["object"] = null;
    let cell: Inspection["cell"] = null;
    let landmark: string | null = null;
    if (pick) {
      const surface = view.query.surfaceAt(pick.x, pick.y);
      const surfaceRamp = surface ? (style.surfaces[surface.name]?.ramp ?? null) : null;
      ground = {
        x: pick.x,
        y: pick.y,
        h: pick.h,
        surface: surface?.name ?? "unknown",
        surfaceRamp,
        road: view.query.roadAt(pick.x, pick.y)?.class ?? null,
      };
      cell = { x: pick.x, y: pick.y, h: pick.h };
      const candidates = objectsOnRay(view.query, pick, rayPerStep(view.camera.rotation, renderScale), {
        renderScale,
        top: view.world.heightRange[1],
      });
      const found = candidates.find((c) => rolesIn(style, c.hit.group, ramps).length > 0);
      if (found) {
        const o = found.hit;
        const asset = style.assets ? resolveAsset(style.assets, o.group) : null;
        const generator = asset?.generator ?? null;
        object = {
          group: o.group,
          generator,
          source: listGenerators().find((gen) => gen.name === generator)?.source ?? null,
          roles: rolesIn(style, o.group, ramps),
          anchor: [o.x, o.y],
          bounds: o.bounds,
          base: o.base,
          top: o.top,
        };
        cell = found.at;
        landmark = o.id;
      }
    }
    return {
      x,
      y,
      color: "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join(""),
      index: first?.index ?? null,
      ramp: first?.ramp ?? null,
      shade: first?.shade ?? null,
      alsoRamps: [...new Set(ramps.slice(1))].filter((n) => n !== first?.ramp),
      usedBy: first && first.shade !== null ? rampUses(style, first.ramp) : [],
      cell,
      ground,
      lonLat: cell ? view.query.cellToLonLat(cell.x, cell.y) : null,
      object,
      landmark,
    };
  };
}

/** Alt+click on the canvas logs what is under the pointer to the console. */
export function inspectOnAltClick(canvas: HTMLCanvasElement, inspect: (x: number, y: number) => Inspection): void {
  canvas.addEventListener("click", (e) => {
    if (!e.altKey) return;
    const rect = canvas.getBoundingClientRect();
    console.log("inspect", inspect(e.clientX - rect.left, e.clientY - rect.top));
  });
}
