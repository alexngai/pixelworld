import { BAKE_VERSION } from "@pixelworld/bake";
import {
  ChunkStore,
  hashString,
  loadManifest,
  loadObjects,
  tileKey,
  type HeroPaint,
  type InitMessage,
  type TileRequest,
} from "@pixelworld/runtime";
import { buildPalette, materialTables, validateStyle, type Palette, type StylePack } from "@pixelworld/style";
import { GeoGrid, decodePng, type ObjectsFile, type WorldManifest } from "@pixelworld/world-format";
import { pluginsKey } from "./plugins";
import type { PluginDescriptor, StyleSource, WorldInfo, WorldViewOptions } from "./types";

/**
 * Loading a world package for a view: its manifest, geo grid and objects, the
 * style pack and palette, and the bake worker's init message.
 */

const TILE_SIZE = 32; // default bake tile edge (cells); manifest render.tileSize overrides
const MARGIN = 16; // context around a tile, in render units (cells at scale 1)
const MICRO_MARGIN = 8; // micro-terrain: shadows and AO reach a few cells; 16× the cells cost more

export interface LoadedWorld {
  url: string;
  /** The package's base URL, for files it names. */
  base: URL;
  manifest: WorldManifest;
  store: ChunkStore;
  geo: GeoGrid | null;
  objects: ObjectsFile | null;
  /** The style pack as given (its hash keys the tile cache) and validated. */
  styleJson: object;
  style: StylePack;
  palette: Palette;
  renderScale: number;
  tileSize: number;
  /** Context cells around a tile. */
  margin: number;
  heightRange: [number, number];
  /** Height (steps) of the world-edge skirts: the lowest corner less two. */
  floor: number;
  /** Whether a different render scale than the package's was asked for (it then keys the cache). */
  scaleOverridden: boolean;
}

async function resolveStyle(source: StyleSource, id: string): Promise<object> {
  return typeof source === "function" ? await source(id) : source;
}

export async function loadWorld(opts: WorldViewOptions): Promise<LoadedWorld> {
  const url = opts.worldUrl;
  const manifest = await loadManifest(url);
  const store = new ChunkStore(manifest, url);
  const base = new URL(url, location.href);
  // Lon/lat of cell corners: places between scale levels (D-046), fog areas, queries.
  const geo = await GeoGrid.load(manifest, base).catch((e: unknown) => {
    console.warn("geo grid:", e);
    return null;
  });
  // Render scale: fine worlds draw each cell smaller (render units = cells × RS).
  const packageScale = manifest.render?.scale ?? 1;
  const renderScale = opts.renderScale ?? packageScale;
  const tileSize = manifest.render?.tileSize ?? TILE_SIZE;
  const margin = manifest.micro ? MICRO_MARGIN : Math.ceil(MARGIN / renderScale);
  const objects = opts.objects === false ? null : await loadObjects(url, manifest);

  const styleJson = await resolveStyle(opts.style, manifest.style);
  const baseStyle = validateStyle(styleJson as StylePack);
  const style =
    objects && baseStyle.objects?.surfaces
      ? validateStyle({ ...baseStyle, surfaces: { ...baseStyle.surfaces, ...baseStyle.objects.surfaces } })
      : baseStyle;
  const palette = buildPalette(style);

  if (!manifest.heightRange) await store.ensureRect(0, 0, manifest.cellsX, manifest.cellsY);
  const heightRange: [number, number] =
    manifest.heightRange ?? store.slice(0, 0, manifest.cellsX, manifest.cellsY).grid.heightRange();
  return {
    url,
    base,
    manifest,
    store,
    geo,
    objects,
    styleJson,
    style,
    palette,
    renderScale,
    tileSize,
    margin,
    heightRange,
    floor: heightRange[0] - 2,
    scaleOverridden: renderScale !== packageScale,
  };
}

export function worldInfo(w: LoadedWorld): WorldInfo {
  return {
    url: w.url,
    manifest: w.manifest,
    style: w.style,
    palette: w.palette,
    renderScale: w.renderScale,
    cellsX: w.manifest.cellsX,
    cellsY: w.manifest.cellsY,
    heightRange: w.heightRange,
    floor: w.floor,
    hasGeo: w.geo !== null,
    objectCount: w.objects?.instances.length ?? 0,
    level: w.manifest.level ?? null,
  };
}

/** Painted-over hero landmarks (M3, D-053), stamped into every tile bake. */
export async function loadHeroes(w: LoadedWorld): Promise<HeroPaint[]> {
  const heroes: HeroPaint[] = [];
  if (!w.manifest.heroes?.length) return heroes;
  const png = async (path: string) => decodePng(await (await fetch(new URL(path, w.base))).arrayBuffer());
  for (const h of w.manifest.heroes) {
    const [bake, paint] = await Promise.all([png(h.bake), png(h.paint)]);
    heroes.push({ ...h, bake: bake.data, paint: paint.data });
  }
  return heroes;
}

/** The bake worker's init message for a world. */
export function bakeInit(w: LoadedWorld, heroes: HeroPaint[], scatter: boolean): InitMessage {
  const { manifest, style, palette, objects } = w;
  const RS = w.renderScale;
  const { metersPerStep, elevationDatumMeters } = manifest.scale;
  // Strata are compared with render-unit heights in the shader.
  const tables = materialTables(style, palette, manifest, (m) => ((m - elevationDatumMeters) / metersPerStep) * RS, RS);
  // Micro-terrain: tops steeper than the style's rock slope are bare strata (D-036).
  const steepRock = () => {
    const slope = style.terrain?.steepRockSlope;
    const ids = new Map(Object.entries(manifest.surfaces).map(([id, name]) => [name, Number(id)]));
    if (!manifest.micro || !slope || !ids.has("rock")) return undefined;
    // rise over run in micro-steps per micro-cell = slope × metres per cell / metres per step
    const drop = Math.max(1, Math.round((slope * manifest.scale.metersPerCell) / manifest.scale.metersPerStep));
    return { drop, rockSurface: ids.get("rock")!, waterSurface: ids.get("water") ?? -1, snowSurface: ids.get("snow") ?? -1 };
  };
  return {
    type: "init",
    style: {
      tables,
      aoStrength: style.ao.strength,
      outlineThreshold: style.outline.depthThreshold,
      renderScale: RS,
      steepRock: steepRock(),
    },
    tileSize: w.tileSize,
    margin: w.margin,
    floor: w.floor,
    worldWidth: manifest.cellsX,
    worldHeight: manifest.cellsY,
    renderScale: RS,
    heroes,
    objects:
      objects && style.assets
        ? {
            instances: objects.instances,
            catalog: style.assets,
            rampIds: [...palette.rampIds],
            metersPerCell: manifest.scale.metersPerCell,
            // a scale level may draw objects with other proportions (D-047)
            heightStretch: manifest.depiction?.heightStretch ?? style.objects?.heightStretch ?? 1,
            variants: style.objects?.variants ?? 6,
            // decorative vegetation and rocks by surface, where the level asks (M3)
            scatter:
              manifest.depiction?.scatter && scatter
                ? {
                    density: manifest.depiction.scatter,
                    bySurface: Object.fromEntries(
                      Object.entries(manifest.surfaces).map(([id, name]) => [Number(id), style.scatter?.[name] ?? []]),
                    ),
                  }
                : undefined,
          }
        : undefined,
  };
}

/** The tile cache key: the package, style, baker and plugins, so a change to any makes old tiles unreachable. */
export function tileCacheKey(w: LoadedWorld, plugins: PluginDescriptor[] = []): (t: TileRequest) => string {
  // Atmosphere layers (fog) are drawn over the tiles, never into them, so they stay out of the key.
  const styleHash = hashString(JSON.stringify({ ...w.styleJson, atmosphere: undefined }));
  const parts = [
    w.manifest.id,
    w.manifest.packageHash ?? "nohash",
    styleHash,
    BAKE_VERSION,
    w.objects ? "objects" : "terrain",
    ...(w.scaleOverridden ? [`rs${w.renderScale}`] : []),
    ...pluginsKey(plugins),
  ];
  return (t) => [...parts, tileKey(t.rotation, t.tx, t.ty)].join("|");
}
