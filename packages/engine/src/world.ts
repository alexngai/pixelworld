import { BAKE_CODE } from "@pixelworlds/bake";
import { footprintBounds, resolveAsset, type ObjectInstance } from "@pixelworlds/generators";
import {
  ChunkStore,
  INCOMPLETE_PACKAGE,
  chunkFetcher,
  TileCache,
  hashString,
  loadCoarse,
  loadManifest,
  loadObjectLandmarks,
  loadObjects,
  objectInSlice,
  tileKey,
  type CoarseHeights,
  type HeroPaint,
  type InitMessage,
  type TerrainSlice,
  type TileRequest,
} from "@pixelworlds/runtime";
import {
  StyleError,
  buildPalette,
  materialTables,
  resolveStyleExtends,
  styleIssues,
  styleIssuesError,
  validateStyle,
  type Palette,
  type StylePack,
} from "@pixelworlds/style";
import {
  GeoGrid,
  decodePng,
  fetchWorldFile,
  parseWorldFile,
  type DroppableLayer,
  type ObjectsFile,
  type WorldFetch,
  type WorldManifest,
} from "@pixelworlds/world-format";
import { EditLog } from "./edits";
import { ChunkedObjects, landmarkPlan, ObjectIndex } from "./objects";
import { createQuery, type PickView } from "./queries";
import type { OpenWorldOptions, OpenedWorld, StyleSource, TileStore, WorldInfo, WorldQuery, WorldStats, WorldViewOptions } from "./types";

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
  /** The placed objects; with `chunkedObjects`, only the landmarks (the rest come with their chunks). */
  objects: ObjectsFile | null;
  chunkedObjects: boolean;
  /** The coarse heights (`headless`, where the package has them). */
  coarse: CoarseHeights | null;
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

/**
 * The world's style pack (D-075): the one given, or the resolver's for the id
 * the manifest names, with its `extends` merged in (parents from the resolver)
 * and checked. Errors name the pack; a resolver that answers with another pack
 * is warned about.
 */
export async function resolveStyle(source: StyleSource, id: string): Promise<object> {
  const load = async (want: string): Promise<unknown> => {
    if (typeof source !== "function")
      throw new StyleError(
        `createWorldView's style is a pack, not a resolver, so it can't load "${want}": ` +
          "pass a resolver, or the pack with its parents merged in (resolveStyleExtends)",
      );
    try {
      return await source(want);
    } catch (e) {
      if (e instanceof StyleError) throw e; // it says where it is
      // a resolver that fetches the pack: say what an HTML answer means (D-072)
      const msg = e instanceof Error ? (e.name !== "Error" ? `${e.name}: ${e.message}` : e.message) : String(e);
      const html = /Unexpected token '?<'?|<!doctype/i.test(msg) ? " (it got an HTML page, not JSON: is the pack's URL right?)" : "";
      throw new StyleError(`style pack "${want}" (from your style resolver): ${msg}${html}`, {
        pack: want,
        cause: e,
      });
    }
  };
  const given = typeof source === "function" ? await load(id) : source;
  if (given === null || given === undefined)
    throw new StyleError(`style pack "${id}": your style resolver has no pack for it (it returned ${String(given)})`, { pack: id });
  const pack = (await resolveStyleExtends(given, load)) as Record<string, unknown>;
  const issues = styleIssues(pack);
  if (issues.length) throw styleIssuesError(typeof pack.id === "string" ? pack.id : id, issues);
  if (typeof source === "function" && pack.id !== id)
    console.warn(`the world names the style pack "${id}", but the style resolver gave "${String(pack.id)}": drawing it with that one`);
  return pack;
}

export async function loadWorld(
  opts: Pick<WorldViewOptions, "worldUrl" | "style" | "renderScale" | "objects" | "chunkBudgetMB"> & {
    dropLayers?: readonly DroppableLayer[];
    /**
     * `openWorld`'s (D-123): objects by chunk where the package has them (the
     * landmarks whole, the rest with their terrain), and its coarse heights.
     * A view's bake needs the objects whole.
     */
    headless?: boolean;
    /** How the package's files are fetched (D-123; default `fetch`). */
    fetch?: WorldFetch;
  },
): Promise<LoadedWorld> {
  const url = opts.worldUrl;
  const manifest = await loadManifest(url, opts.fetch);
  const store = new ChunkStore(manifest, url, opts.fetch ? chunkFetcher(opts.fetch) : undefined);
  store.worldFetch = opts.fetch;
  if (opts.chunkBudgetMB !== undefined) store.maxBytes = opts.chunkBudgetMB * 2 ** 20;
  if (opts.dropLayers) store.dropLayers = new Set(opts.dropLayers);
  const base = new URL(url, globalThis.location?.href); // openWorld outside a browser passes an absolute URL
  // Lon/lat of cell corners: places between scale levels (D-046), fog areas, queries.
  const geo = await GeoGrid.load(manifest, base, opts.fetch).catch((e: unknown) => {
    console.warn("geo grid:", e);
    return null;
  });
  // Render scale: fine worlds draw each cell smaller (render units = cells × RS).
  const packageScale = manifest.render?.scale ?? 1;
  const renderScale = opts.renderScale ?? packageScale;
  const tileSize = manifest.render?.tileSize ?? TILE_SIZE;
  const margin = manifest.micro ? MICRO_MARGIN : Math.ceil(MARGIN / renderScale);
  const chunkedObjects = opts.objects !== false && !!opts.headless && !!manifest.objectChunks;
  const coarse = opts.headless ? await loadCoarse(url, manifest, opts.fetch) : null;
  store.objectChunks = chunkedObjects;
  const objects = opts.objects === false ? null : chunkedObjects ? await loadObjectLandmarks(url, manifest, opts.fetch) : await loadObjects(url, manifest, opts.fetch);

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
    chunkedObjects,
    coarse,
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
    objectCount: w.chunkedObjects ? (w.manifest.objects?.count ?? 0) : (w.objects?.instances.length ?? 0),
    level: w.manifest.level ?? null,
  };
}

/** A loaded world's queries: a view's (`view` places its picks) or `openWorld`'s (none: `pick` throws); `edits` takes objects out (D-124). */
export function worldQuery(w: LoadedWorld, view: (() => PickView) | null, edits: EditLog | null = null): WorldQuery {
  const { manifest } = w;
  const heightStretch = manifest.depiction?.heightStretch ?? w.style.objects?.heightStretch ?? 1;
  // placed objects for occupancy queries: the ones the style draws, as the bake does
  const assets = w.style.assets;
  // objects named by their place in the objects file (D-124); a chunk's file doesn't say it (D-123), so those can't be edited yet
  const index = (instances: readonly ObjectInstance[], named = false) =>
    new ObjectIndex(
      instances,
      { cellsX: manifest.cellsX, cellsY: manifest.cellsY, metersPerCell: manifest.scale.metersPerCell, heightStretch },
      (group) => resolveAsset(assets!, group) !== null,
      (x, y) => query.heightAt(x, y),
      (inst) =>
        landmarkPlan(inst, {
          catalog: assets!,
          rampIds: w.palette.rampIds,
          renderScale: w.renderScale,
          metersPerCell: manifest.scale.metersPerCell,
          heightStretch,
        }),
      named ? edits : null,
      named,
    );
  const objects = !w.objects || !assets ? null : w.chunkedObjects ? new ChunkedObjects(index(w.objects.instances), (x, y) => w.store.objectsIn(x, y), index) : index(w.objects.instances, true);
  const noView = (): PickView => {
    throw new Error("pick needs a world view: openWorld's queries have no screen");
  };
  const query = createQuery(w.store, w, w.geo, view ?? noView, objects, w.coarse);
  return query;
}

/**
 * A world package's queries without a view, canvas or GPU (D-111): what a
 * game server, a bot or a worker reads to agree with the players' views on
 * heights, surfaces, roads and occupancy. Nothing streams by itself: `ensure`
 * the area first, as a controller does. `chunkBudgetMB` caps what it keeps
 * (D-120): a server on a world too big to hold loads around its players.
 */
export async function openWorld(opts: OpenWorldOptions): Promise<OpenedWorld> {
  let worldUrl: string;
  try {
    worldUrl = new URL(opts.worldUrl, opts.base ?? globalThis.location?.href).href;
  } catch {
    throw new Error(`openWorld: "${opts.worldUrl}" is relative, and there is no page to resolve it against: give an absolute URL or \`base\``);
  }
  const w = await loadWorld({ ...opts, worldUrl, headless: true });
  const edits = new EditLog(w.chunkedObjects ? (w.manifest.objects?.count ?? 0) : (w.objects?.instances.length ?? 0));
  return { world: worldInfo(w), query: worldQuery(w, null, edits), edits, stats: () => chunkStats(w.store) };
}

/** What a store holds now (`OpenedWorld.stats`, and a view's). */
export function chunkStats(store: ChunkStore): WorldStats {
  return { chunksLoaded: store.loadedCount, chunksTotal: store.manifest.chunks.length, chunksMB: store.loadedBytes / 2 ** 20, chunksEvicted: store.evicted };
}

/** Painted-over hero landmarks (M3, D-053), stamped into every tile bake. */
export async function loadHeroes(w: LoadedWorld): Promise<HeroPaint[]> {
  const heroes: HeroPaint[] = [];
  if (!w.manifest.heroes?.length) return heroes;
  // errors name the URL (D-072)
  const png = async (path: string) => {
    const url = new URL(path, w.base);
    const info = { label: "hero landmark", expected: "a PNG the manifest names", hint: INCOMPLETE_PACKAGE };
    const bytes = await fetchWorldFile(url, info);
    return parseWorldFile(url, "hero landmark", () => decodePng(bytes));
  };
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
    shores: manifest.micro?.shores === true,
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

/** The cells [x0, x1) × [y0, y1) a tile's bake reads: its own and a context margin, clipped to the world. */
function sliceRect(w: LoadedWorld, tx: number, ty: number): [number, number, number, number] {
  const ts = w.tileSize;
  return [
    Math.max(0, tx * ts - w.margin),
    Math.max(0, ty * ts - w.margin),
    Math.min(w.manifest.cellsX, (tx + 1) * ts + w.margin),
    Math.min(w.manifest.cellsY, (ty + 1) * ts + w.margin),
  ];
}

/** A tile's cells plus its context margin, clipped to the world, for its bake (loads the chunks it needs). */
export async function tileSlice(w: LoadedWorld, t: TileRequest): Promise<TerrainSlice> {
  const { store } = w;
  const [x0, y0, x1, y1] = sliceRect(w, t.tx, t.ty);
  await store.ensureRect(x0, y0, x1, y1);
  const s = store.slice(x0, y0, x1, y1);
  return { x0: s.x0, y0: s.y0, width: s.grid.width, height: s.grid.height, layers: s.grid.layers(), micro: s.grid.micro };
}

/**
 * The tiles whose bake builds a placed object (`objectInSlice`), as [tx, ty]:
 * those its pixels, shadows and ambient occlusion fall in. An edit to it bakes
 * them again (D-124).
 */
export function objectTiles(w: LoadedWorld, object: number): [number, number][] {
  const o = w.objects?.instances[object];
  if (!o) return [];
  const ts = w.tileSize;
  // the anchor as well as the footprint: a small footprint's tiles are its anchor's, which may lie outside it
  const [fx0, fy0, fx1, fy1] = o.fp?.length ? footprintBounds(o.fp) : [o.x, o.y, o.x, o.y];
  const [bx0, by0, bx1, by1] = [Math.min(fx0, o.x), Math.min(fy0, o.y), Math.max(fx1, o.x), Math.max(fy1, o.y)];
  const out: [number, number][] = [];
  const last = (cells: number) => Math.ceil(cells / ts) - 1;
  for (let ty = Math.max(0, Math.floor((by0 - w.margin) / ts)); ty <= Math.min(last(w.manifest.cellsY), Math.floor((by1 + w.margin) / ts)); ty++)
    for (let tx = Math.max(0, Math.floor((bx0 - w.margin) / ts)); tx <= Math.min(last(w.manifest.cellsX), Math.floor((bx1 + w.margin) / ts)); tx++)
      if (objectInSlice(o, ...sliceRect(w, tx, ty))) out.push([tx, ty]);
  return out;
}

/**
 * The persistent tile cache a view's `cache` option asks for. IndexedDB only
 * where the bake code's identity is known (BAKE_CODE, D-072): without it a
 * code change couldn't make old tiles unreachable, so none are kept.
 */
export async function openTileCache(option: WorldViewOptions["cache"], code = BAKE_CODE): Promise<TileStore | null> {
  if (option === false) return null;
  if (option !== true && option !== undefined) return option; // the app's own store
  if (code === null) {
    console.info(
      "pixelworld: no tiles are kept in IndexedDB: this build of the engine has no bake code identity " +
        "(build it with packages/pixelworld/build.mjs, or serve it with tools/bake-code.mjs's Vite plugin; D-072)",
    );
    return null;
  }
  return TileCache.open();
}

/**
 * The tile cache key: the package, the style, the bake code's identity
 * (D-072), the objects flag, a render scale other than the package's, and the
 * plugins (`pluginsKey`: their names, versions and code). A change to any of
 * them makes old tiles unreachable. A tile whose bake leaves out removed
 * objects (D-124) is kept under them as well (the list itself, not a hash:
 * one tile's is short, and two lists must never share a key).
 */
export function tileCacheKey(w: LoadedWorld, plugins: string[] = [], code = BAKE_CODE): (t: TileRequest, removed?: readonly number[]) => string {
  // Atmosphere layers (fog) are drawn over the tiles, never into them, so they stay out of the key.
  const styleHash = hashString(JSON.stringify({ ...w.styleJson, atmosphere: undefined }));
  const parts = [
    w.manifest.id,
    w.manifest.packageHash ?? "nohash",
    styleHash,
    `bake:${code ?? "unknown"}`,
    w.objects ? "objects" : "terrain",
    ...(w.scaleOverridden ? [`rs${w.renderScale}`] : []),
    ...plugins,
  ];
  return (t, removed) => [...parts, tileKey(t.rotation, t.tx, t.ty, t.bare), ...(removed?.length ? [`edits:${removed.join(",")}`] : [])].join("|");
}
