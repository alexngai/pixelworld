import { NO_WATER, project, type Rotation } from "@pixelworld/grid";
import { roverBoxes } from "@pixelworld/generators";
import {
  BakeService,
  Camera,
  Compositor,
  cellsScreenRect,
  loadWorld,
  tileKey,
  worldDepthRange,
  type GpuImage,
  type TileKey,
} from "@pixelworld/runtime";
import { buildPalette, materialTables, validateStyle, type StylePack } from "@pixelworld/style";
import styleJson from "../../../worlds/_styles/desert-southwest/style.json";

const TILE_SIZE = 32;
const MARGIN = 16;
const PAN_SPEED = 220; // internal px / s
const DRIVE_SPEED = 3; // cells / s
const MAX_CLIMB = 1.05; // steps the rover can climb between samples

/** Test/debug hooks (used by the Playwright suite in e2e/). */
interface PixelworldDebug {
  ready: () => Promise<void>;
  stats: () => Record<string, unknown>;
  pan: (dx: number, dy: number) => void;
  setRover: (x: number, y: number) => void;
}
declare global {
  interface Window {
    __pixelworld?: PixelworldDebug;
  }
}

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => {
  const v = params.get(key);
  return v === null || v === "" || Number.isNaN(Number(v)) ? fallback : Number(v);
};

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const hud = document.getElementById("hud")!;
  const help = document.getElementById("help")!;
  const attribution = document.getElementById("attribution")!;
  const fixedSize = params.has("w") && params.has("h");
  if (params.get("hud") === "0") {
    hud.classList.add("hidden");
    help.classList.add("hidden");
    attribution.classList.add("hidden");
  }

  const world = await loadWorld(params.get("world") ?? "/grand-canyon-m0/");
  const { manifest, terrain } = world;
  attribution.textContent = manifest.attribution.map((a) => a.name).join(" · ");

  const style = validateStyle(styleJson as StylePack);
  const palette = buildPalette(style);
  const tables = materialTables(style, palette, manifest.surfaces, manifest.scale);
  const [minH, maxH] = terrain.heightRange();
  const floor = minH - 2;

  const compositor = new Compositor(canvas);
  compositor.setPalette(palette.rgba);

  const service = await BakeService.create({
    type: "init",
    cellsX: terrain.width,
    cellsY: terrain.height,
    base: terrain.base.slice(),
    slope: terrain.slope.slice(),
    surface: terrain.surface.slice(),
    water: terrain.water.slice(),
    style: {
      tables,
      aoStrength: style.ao.strength,
      outlineThreshold: style.outline.depthThreshold,
    },
    tileSize: TILE_SIZE,
    margin: MARGIN,
    floor,
  });

  // Tiles and their height ranges (for screen-rect estimates before baking).
  const tilesX = Math.ceil(terrain.width / TILE_SIZE);
  const tilesY = Math.ceil(terrain.height / TILE_SIZE);
  const tileHeights: [number, number][] = [];
  for (let ty = 0; ty < tilesY; ty++)
    for (let tx = 0; tx < tilesX; tx++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let y = ty * TILE_SIZE; y < Math.min(terrain.height, (ty + 1) * TILE_SIZE); y++)
        for (let x = tx * TILE_SIZE; x < Math.min(terrain.width, (tx + 1) * TILE_SIZE); x++) {
          const b = terrain.base[terrain.index(x, y)]!;
          lo = Math.min(lo, b);
          hi = Math.max(hi, b + 1);
        }
      // edge tiles include skirts down to the floor
      const edge = tx === 0 || ty === 0 || tx === tilesX - 1 || ty === tilesY - 1;
      tileHeights.push([edge ? floor : lo, hi]);
    }

  const tiles = new Map<TileKey, GpuImage | null>();
  service.onTile = (res) => {
    tiles.set(res.key, res.image ? compositor.upload(res.image) : null);
    dirty = true;
  };
  service.onError = (m) => {
    console.error(m);
    hud.textContent = `bake error: ${m}`;
  };

  const sprites = new Map<Rotation, GpuImage | null>();
  const roverRamp = palette.rampIds.get("marker")!;
  const cabRamp = palette.rampIds.get("coconino")!;
  const requestSprite = (r: Rotation) => {
    if (sprites.has(r)) return;
    sprites.set(r, null);
    void service.bakeSprite(r, roverBoxes(roverRamp, cabRamp)).then((img) => {
      if (img) sprites.set(r, compositor.upload(img));
      dirty = true;
    });
  };

  // Rover starts on dry land next to the river nearest the centre, unless given.
  const rover = { x: terrain.width / 2, y: terrain.height / 2, h: 0 };
  const roverParam = params.get("rover");
  if (roverParam) {
    const [rx, ry] = roverParam.split(",").map(Number);
    rover.x = rx ?? rover.x;
    rover.y = ry ?? rover.y;
  } else {
    let best = Infinity;
    for (let y = 1; y < terrain.height - 1; y++)
      for (let x = 1; x < terrain.width - 1; x++) {
        if (terrain.water[terrain.index(x, y)] === NO_WATER) continue;
        const below = terrain.index(x, y + 1);
        if (terrain.water[below] !== NO_WATER) continue;
        const d = Math.hypot(x - terrain.width / 2, y - terrain.height / 2);
        if (d < best) {
          best = d;
          rover.x = x + 0.5;
          rover.y = y + 1.5;
        }
      }
  }
  rover.h = terrain.surfaceHeightAt(rover.x, rover.y);

  const camera = new Camera(1, 1);
  camera.rotation = (num("rot", 0) & 3) as Rotation;
  let follow = !(params.has("fx") || params.has("fy"));
  camera.fx = num("fx", rover.x);
  camera.fy = num("fy", rover.y);
  camera.fh = follow ? rover.h : terrain.surfaceHeightAt(camera.fx, camera.fy);
  let noclip = false;
  let zoomFromParams = params.has("zoom");

  function resize() {
    const dpr = fixedSize ? 1 : window.devicePixelRatio || 1;
    const w = fixedSize ? num("w", 640) : Math.round(window.innerWidth * dpr);
    const h = fixedSize ? num("h", 360) : Math.round(window.innerHeight * dpr);
    canvas.width = w;
    canvas.height = h;
    if (fixedSize) {
      canvas.classList.add("fixed");
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    camera.canvasWidth = w;
    camera.canvasHeight = h;
    if (zoomFromParams) camera.zoom = Math.max(1, Math.round(num("zoom", 3)));
    else camera.zoom = Math.max(1, Math.round(w / 640));
    dirty = true;
  }
  let dirty = true;
  resize();
  window.addEventListener("resize", resize);

  const depthRange = worldDepthRange(terrain.width, terrain.height, floor, maxH);

  // ---- input ----
  const keys = new Set<string>();
  window.addEventListener("keydown", (e) => {
    keys.add(e.key.toLowerCase());
    const k = e.key.toLowerCase();
    if (k === "q") camera.rotate(-1);
    else if (k === "e") camera.rotate(1);
    else if (k === "f") follow = !follow;
    else if (k === "n") noclip = !noclip;
    else if (k === "h") [hud, help].forEach((el) => el.classList.toggle("hidden"));
    else if (k >= "1" && k <= "6") {
      camera.zoom = Number(k);
      zoomFromParams = true;
    }
    if (k.startsWith("arrow")) e.preventDefault();
    dirty = true;
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => keys.clear());
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const scale = (fixedSize ? 1 : window.devicePixelRatio || 1) / camera.zoom;
    camera.panPixels(-(e.clientX - drag.x) * scale, -(e.clientY - drag.y) * scale);
    drag = { x: e.clientX, y: e.clientY };
    follow = false;
    dirty = true;
  });
  canvas.addEventListener("pointerup", () => (drag = null));

  function update(dt: number) {
    let px = 0;
    let py = 0;
    if (keys.has("a")) px -= 1;
    if (keys.has("d")) px += 1;
    if (keys.has("w")) py -= 1;
    if (keys.has("s")) py += 1;
    if (px || py) {
      const len = Math.hypot(px, py);
      camera.panPixels((px / len) * PAN_SPEED * dt, (py / len) * PAN_SPEED * dt);
      follow = false;
      dirty = true;
    }
    let mx = 0;
    let my = 0;
    if (keys.has("arrowleft")) mx -= 2;
    if (keys.has("arrowright")) mx += 2;
    if (keys.has("arrowup")) my -= 1;
    if (keys.has("arrowdown")) my += 1;
    if (mx || my) {
      const [gx, gy] = camera.screenDirToGrid(mx, my);
      const step = DRIVE_SPEED * dt;
      const tryMove = (nx: number, ny: number) => {
        if (nx < 0.3 || ny < 0.3 || nx > terrain.width - 0.3 || ny > terrain.height - 0.3) return false;
        const cell = terrain.index(Math.floor(nx), Math.floor(ny));
        const nh = terrain.surfaceHeightAt(nx, ny);
        if (!noclip && (terrain.water[cell] !== NO_WATER || Math.abs(nh - rover.h) > MAX_CLIMB))
          return false;
        rover.x = nx;
        rover.y = ny;
        rover.h = nh;
        return true;
      };
      // slide along obstacles by trying each axis separately
      if (!tryMove(rover.x + gx * step, rover.y + gy * step)) {
        if (!tryMove(rover.x + gx * step, rover.y)) tryMove(rover.x, rover.y + gy * step);
      }
      if (!follow && !keys.has("w") && !keys.has("a") && !keys.has("s") && !keys.has("d")) follow = true;
      dirty = true;
    }
    if (follow) {
      camera.fx = rover.x;
      camera.fy = rover.y;
      camera.fh = rover.h;
    }
  }

  // ---- frame ----
  let frames = 0;
  let fps = 0;
  let fpsT = performance.now();
  let lastT = performance.now();
  let renderedComplete = false;
  const readyResolvers: (() => void)[] = [];

  function visibleTiles(snap: ReturnType<Camera["snapped"]>) {
    const r = camera.rotation;
    const viewL = snap.left - 64;
    const viewT = snap.top - 64;
    const viewR = snap.left + camera.internalWidth + 64;
    const viewB = snap.top + camera.internalHeight + 64;
    const cx = (viewL + viewR) / 2;
    const cy = (viewT + viewB) / 2;
    const list: { rotation: Rotation; tx: number; ty: number; visible: boolean; dist: number }[] = [];
    for (let ty = 0; ty < tilesY; ty++)
      for (let tx = 0; tx < tilesX; tx++) {
        const [lo, hi] = tileHeights[ty * tilesX + tx]!;
        const rect = cellsScreenRect(
          tx * TILE_SIZE,
          ty * TILE_SIZE,
          Math.min(terrain.width, (tx + 1) * TILE_SIZE),
          Math.min(terrain.height, (ty + 1) * TILE_SIZE),
          lo,
          hi,
          r,
        );
        const visible = rect.right >= viewL && rect.left <= viewR && rect.bottom >= viewT && rect.top <= viewB;
        const dist = Math.hypot((rect.left + rect.right) / 2 - cx, (rect.top + rect.bottom) / 2 - cy);
        list.push({ rotation: r, tx, ty, visible, dist });
      }
    list.sort((a, b) => Number(b.visible) - Number(a.visible) || a.dist - b.dist);
    return list;
  }

  function frame(now: number) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    update(dt);
    requestSprite(camera.rotation);

    const snap = camera.snapped();
    const order = visibleTiles(snap);
    service.want(order);

    const r = camera.rotation;
    const drawTiles: GpuImage[] = [];
    let complete = true;
    for (const t of order) {
      const img = tiles.get(tileKey(r, t.tx, t.ty));
      if (img) drawTiles.push(img);
      else if (img === undefined && t.visible) complete = false;
    }
    const sprite = sprites.get(r);
    if (!sprite) complete = false;

    if (dirty) {
      const p = project(rover.x, rover.y, rover.h, r);
      compositor.render(
        {
          left: snap.left,
          top: snap.top,
          fracX: snap.fracX,
          fracY: snap.fracY,
          zoom: camera.zoom,
          internalWidth: camera.internalWidth,
          internalHeight: camera.internalHeight,
          depthRange,
        },
        drawTiles,
        sprite ? [{ sprite, sx: Math.round(p.sx), sy: Math.round(p.sy), depth: p.depth, silhouette: true }] : [],
      );
      dirty = !complete; // keep redrawing while tiles stream in
      renderedComplete = complete;
      if (complete) readyResolvers.splice(0).forEach((f) => f());
    }

    frames++;
    if (now - fpsT > 500) {
      fps = (frames * 1000) / (now - fpsT);
      frames = 0;
      fpsT = now;
      updateHud();
    }
    requestAnimationFrame(frame);
  }

  function stats() {
    const t = service.totals;
    return {
      renderer: service.renderer,
      bakeMode: service.mode,
      tilesBaked: t.tiles,
      tilesPerRotation: tilesX * tilesY,
      avgMeshMs: t.tiles ? t.meshMs / t.tiles : 0,
      avgBakeMs: t.tiles ? t.bakeMs / t.tiles : 0,
      maxTileMs: t.maxTileMs,
      fps,
      rotation: camera.rotation,
      rover: { x: rover.x, y: rover.y, h: rover.h },
    };
  }

  function updateHud() {
    const s = stats();
    const meters = Math.round(rover.h * manifest.scale.metersPerStep + manifest.scale.elevationDatumMeters);
    hud.textContent = [
      `${manifest.name}`,
      `view  rot ${camera.rotation} · zoom ${camera.zoom}× · ${camera.internalWidth}×${camera.internalHeight} internal`,
      `rover cell ${Math.floor(rover.x)},${Math.floor(rover.y)} · ${rover.h.toFixed(1)} steps (${meters} m)${noclip ? " · no-clip" : ""}${follow ? " · follow" : ""}`,
      `bake  ${s.tilesBaked} tiles · mesh ${s.avgMeshMs.toFixed(0)} ms + bake ${s.avgBakeMs.toFixed(0)} ms avg · max ${s.maxTileMs.toFixed(0)} ms`,
      `      ${s.bakeMode} · ${s.renderer}`,
      `fps   ${fps.toFixed(0)}`,
    ].join("\n");
  }

  window.__pixelworld = {
    ready: () =>
      renderedComplete && service.idle
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            dirty = true;
            readyResolvers.push(resolve);
          }),
    stats,
    pan: (dx, dy) => {
      camera.panPixels(dx, dy);
      follow = false;
      renderedComplete = false;
      dirty = true;
    },
    setRover: (x, y) => {
      rover.x = x;
      rover.y = y;
      rover.h = terrain.surfaceHeightAt(x, y);
      renderedComplete = false;
      dirty = true;
    },
  };

  requestAnimationFrame(frame);
}

main().catch((e: unknown) => {
  console.error(e);
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `error: ${String(e)}`;
});
