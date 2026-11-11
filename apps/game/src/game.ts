import {
  createWorldView,
  fogLayer,
  type Controller,
  type PluginDescriptor,
  type StyleSource,
  type WorldManifest,
  type WorldView,
} from "@pixelworlds/engine";
import { loadRoutes, trafficLayer, type RouteNetwork, type TrafficLayer } from "@pixelworlds/sim";
import { CarController, type Place } from "./carController";
import { Hud } from "./hud";
import { levelLabel, levelUrl, poseToGeo, startFor, type GeoPose } from "./levels";
import { landmarkName, landmarkPlaces, nearestPlace, GAZETTEER, type NamedPlace } from "./places";
import { PlaneController } from "./planeController";
import { ViewTransitions } from "./transition";
import { DRIVE_PACE, FLY_PACE, GAUGE_KMH, PLANE } from "./tuning";

/**
 * The game: one canvas, one world view at a time, and the player's car or
 * plane as the view's controller. Taking off and landing load the other
 * scale level at the same lon/lat into a new view that replaces the old one
 * on the same canvas when its first frame is complete (the engine's
 * `replace`), so the page never reloads and never flashes; the old frame
 * then zooms away into the new one (transition.ts), as do zooms and turns
 * of the view.
 */

/** How long the view's changes take (ms), and how long a turn of the view waits for its tiles. */
const FX = { level: 800, zoom: 240, turn: 280, turnWait: 500 };

export interface GameOptions {
  canvas: HTMLCanvasElement;
  /** A world package (a directory with `manifest.json`). */
  worldUrl: string;
  /** Start here instead of the world's default start (lon/lat). */
  start?: { lon: number; lat: number } | null;
  /** The style pack, or a resolver for the id the world names (and the ids it `extends`). */
  style: StyleSource;
  /** Generator plugins (city packs, D-071), or a choice from the names the world's style pack asks for. */
  plugins?: PluginDescriptor[] | ((names: string[]) => PluginDescriptor[]);
  traffic?: { enabled?: boolean; seed?: number; paused?: boolean; density?: number };
  fog?: boolean;
  cache?: boolean;
  /** A fixed canvas size (device px); default: follow the page. */
  size?: { width: number; height: number };
  zoom?: number | "auto";
  rotation?: number;
  /** HUD root element; null for none. */
  hud?: HTMLElement | null;
  /** Start in the air (any level). */
  fly?: boolean;
}

export type Mode = "car" | "plane";

/** What the HUD shows and tests read (`Game.info`). Cells, steps, radians, cells per second. */
export interface GameState {
  mode: Mode;
  /** The level's label ("Driving", "Flying") and the package's id. */
  level: string;
  world: string;
  x: number;
  y: number;
  h: number;
  heading: number;
  speed: number;
  /** The gauge speed (tuning.ts GAUGE_KMH). */
  kmh: number;
  cellsPerSecond: number;
  lonLat: [number, number] | null;
  /** The nearest named place, with its distance when over a kilometre. */
  place: string | null;
  /** The drawn ground under the vehicle (steps). */
  ground: number | null;
  // the car's
  road?: string | null;
  assist?: boolean;
  canTakeOff?: boolean;
  blocked?: string | null;
  bump?: { reason: string; what: string | null; t: number } | null;
  // the plane's
  agl?: number | null;
  aglMeters?: number | null;
  altitudeMeters?: number | null;
  throttle?: number;
  pitch?: number;
  bank?: number;
  shadow?: { x: number; y: number; h: number };
  canLand?: boolean;
  crashes?: number;
}

/** Frame intervals seen, for the HUD and the run's report. */
export class FrameStats {
  private readonly times: number[] = [];
  private last = 0;

  tick(now: number): void {
    if (this.last) this.times.push(now - this.last);
    if (this.times.length > 20000) this.times.splice(0, 10000);
    this.last = now;
  }

  reset(): void {
    this.times.length = 0;
    this.last = 0;
  }

  summary(): { frames: number; mean: number; p50: number; p95: number; p99: number; max: number; over20: number } {
    const t = [...this.times].sort((a, b) => a - b);
    const q = (p: number) => (t.length ? t[Math.min(t.length - 1, Math.floor(p * t.length))]! : 0);
    const mean = t.length ? t.reduce((s, v) => s + v, 0) / t.length : 0;
    return { frames: t.length, mean, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: t[t.length - 1] ?? 0, over20: t.filter((v) => v > 20).length };
  }
}

async function fetchManifest(worldUrl: string): Promise<WorldManifest> {
  const base = worldUrl.endsWith("/") ? worldUrl : worldUrl + "/";
  const res = await fetch(base + "manifest.json");
  if (!res.ok) throw new Error(`${base}manifest.json: HTTP ${res.status}`);
  return (await res.json()) as WorldManifest;
}

export class Game {
  view!: WorldView;
  mode: Mode = "car";
  car: CarController | null = null;
  plane: PlaneController | null = null;
  worldUrl = "";
  manifest!: WorldManifest;
  routes: RouteNetwork | null = null;
  traffic: TrafficLayer | null = null;
  places: NamedPlace[] = [...GAZETTEER];
  /** The world's landmarks, named, for the labels over them. */
  private marks: { id: string; name: string; x: number; y: number; top?: number }[] = [];
  /** A level change in progress. */
  transition: "takeoff" | "landing" | "switch" | null = null;
  /** Scripts step the controllers (`paused` on every controller, now and after level changes). */
  paused = false;
  readonly frames = new FrameStats();
  readonly hud: Hud | null;
  /** Level changes so far: where from and to, and how long the new level took to show (ms). */
  readonly changes: { from: string; to: string; ms: number }[] = [];
  private hudT = 0;
  private offFrame: (() => void) | null = null;
  private readonly fx: ViewTransitions;
  /** While another level loads: keep a copy of each frame of this one, and where its vehicle is, for the change. */
  private holding = false;
  private changeFrom: ReturnType<Game["anchor"]> | null = null;

  private constructor(private readonly opts: GameOptions) {
    this.hud = opts.hud ? new Hud(opts.hud) : null;
    if (this.hud)
      this.hud.onButton = (what) => {
        const [kind, name] = what.split(":");
        if (kind === "reset") this.reset();
        else if (kind === "vehicle") void this.switchVehicle(name as Mode);
        else if (kind === "map" && name) void this.switchMap(name);
      };
    this.fx = new ViewTransitions(opts.canvas);
  }

  static async create(opts: GameOptions): Promise<Game> {
    const game = new Game(opts);
    const manifest = await fetchManifest(opts.worldUrl);
    const start = opts.start ?? startFor(manifest);
    const place: Place | undefined = start ? { lon: start.lon, lat: start.lat } : undefined;
    const toward = start && "toward" in start ? (start as { toward: { lon: number; lat: number } }).toward : undefined;
    await game.load(opts.worldUrl, manifest, (routes) =>
      manifest.level === "fly" || opts.fly
        ? // in the air over a finer level: from the top, over its towers
          new PlaneController({ start: place, agl: manifest.level === "fly" ? undefined : Infinity })
        : new CarController({ start: place, toward, routes, traffic: () => game.trafficOn() }),
    );
    return game;
  }

  /** The traffic layer while it is on (for collisions). */
  private trafficOn(): TrafficLayer | null {
    return this.traffic && this.traffic.enabled ? this.traffic : null;
  }

  get controller(): CarController | PlaneController {
    return (this.mode === "car" ? this.car : this.plane)!;
  }

  /** Open a world in a new view (replacing the current one without a flash) with a controller. */
  private async load(worldUrl: string, manifest: WorldManifest, make: (routes: RouteNetwork | null) => Controller): Promise<void> {
    const t0 = performance.now();
    const opts = this.opts;
    const old = this.view as WorldView | undefined;
    // the same world (flying over a walking level): the view stays, only its controller changes
    const same = old !== undefined && worldUrl === this.worldUrl;
    const routes = same ? this.routes : await loadRoutes(worldUrl, manifest).catch(() => null);
    const controller = make(routes);
    const t = opts.traffic ?? {};
    const traffic =
      !same && routes && t.enabled !== false
        ? trafficLayer({ routes, seed: t.seed ?? 1, paused: t.paused ?? false, density: t.density ?? 1, enabled: this.traffic?.enabled ?? true })
        : null;
    if (controller instanceof CarController || controller instanceof PlaneController) {
      controller.paused = this.paused;
      if (old) controller.frozen = true; // until the new view shows
    }
    const view = same ? old : await createWorldView({
      canvas: opts.canvas,
      worldUrl,
      style: opts.style,
      size: opts.size,
      cache: opts.cache ?? true,
      camera: old
        ? { rotation: old.camera.rotation, zoom: old.camera.autoZoom ? "auto" : old.camera.zoom }
        : { rotation: opts.rotation ?? 0, zoom: opts.zoom ?? "auto" },
      layers: [...(traffic ? [traffic] : []), fogLayer({ enabled: opts.fog ?? true })],
      controller,
      plugins: opts.plugins,
      replace: old,
    });
    if (same) await view.controllers.use(controller);
    else if (old?.paused) view.paused = true; // still paused on the other level
    // the old view keeps the canvas (and its controller runs) until the new one has a whole frame
    await view.ready();
    this.offFrame?.();
    this.view = view;
    this.worldUrl = worldUrl;
    this.manifest = manifest;
    this.routes = routes;
    if (!same) this.traffic = traffic && view.layers.get(traffic.id) ? traffic : null;
    if (controller instanceof CarController) {
      this.mode = "car";
      this.car = controller;
      this.plane = null;
    } else if (controller instanceof PlaneController) {
      this.mode = "plane";
      this.plane = controller;
      this.car = null;
      controller.onLand = () => void this.land();
    }
    if (controller instanceof CarController || controller instanceof PlaneController) controller.frozen = false;
    this.marks = view.query.landmarks().map((l) => ({ id: l.id, name: landmarkName(l.id), x: l.x, y: l.y }));
    this.places = [...landmarkPlaces(view.query.landmarks(), view.query.cellToLonLat), ...GAZETTEER];
    this.hud?.setWorld(view.world.cellsX, view.world.cellsY, routes, view.query.landmarks());
    this.hud?.setButtons(this.levels, this.map, this.mode);
    this.offFrame = view.onFrame((e) => this.onFrame(e.now, e.dt));
    if (old && !same) this.changes.push({ from: old.world.level ?? "", to: view.world.level ?? "", ms: performance.now() - t0 });
    this.transition = null;
    this.refreshHud();
  }

  private onFrame(now: number, dt: number): void {
    this.frames.tick(now);
    // the old vehicle rises from the road while the flying level loads
    if (this.transition === "takeoff" && this.car) this.car.coast(dt, 2.5);
    if (this.holding) {
      this.fx.refresh();
      this.changeFrom = this.anchor(); // the old vehicle coasts on while the new level loads
    }
    this.labelLandmarks();
    if (now - this.hudT < 100) return;
    this.hudT = now;
    this.refreshHud();
  }

  /** The landmarks' names over their tops, where they are drawn on the canvas. */
  private labelLandmarks(): void {
    if (!this.hud) return;
    const view = this.view;
    const shown: { name: string; x: number; y: number }[] = [];
    for (const m of this.marks) {
      if (!view.isDrawn(m.x, m.y)) continue;
      // its drawn top, once the terrain under it is loaded; the ground until then
      m.top ??= view.query.objectsAt(m.x, m.y).find((o) => o.id === m.id)?.top ?? undefined;
      const p = m.top !== undefined ? view.camera.project(m.x, m.y, m.top) : view.camera.project(m.x, m.y);
      if (p?.onScreen) shown.push({ name: m.name, x: p.x, y: p.y });
    }
    this.hud.labels(view.canvas, shown);
  }

  /** Bring the HUD up to date (it follows the frames ten times a second). */
  refreshHud(): void {
    if (!this.hud) return;
    const s = this.info();
    const hint =
      this.transition === "takeoff"
        ? "taking off…"
        : this.transition === "landing"
          ? "landing…"
          : this.transition === "switch"
            ? "on the way…"
          : this.mode === "car" && this.car?.canTakeOff
            ? "T: take off"
            : this.mode === "plane" && this.plane?.canLand
              ? "L: land (or hold it low and slow)"
              : "";
    this.hud.update({ ...s, fps: this.view.stats().fps, hint });
    this.hud.drawMap(s.x, s.y, s.heading, this.mode === "car" ? "#ffe36e" : "#ffffff");
  }

  /** What the HUD and tests read. */
  info(): GameState {
    const view = this.view;
    const m = view.world.manifest;
    const c = this.controller;
    const s = c.state;
    const lonLat = view.query.cellToLonLat(s.x, s.y);
    const near = lonLat ? nearestPlace(lonLat[0], lonLat[1], this.places) : null;
    const k = c.params.pace;
    const base = {
      mode: this.mode,
      level: levelLabel(m),
      world: m.id,
      x: s.x,
      y: s.y,
      h: s.h,
      heading: s.heading,
      speed: s.speed,
      kmh: (Math.abs(s.speed) / k) * GAUGE_KMH * (this.mode === "plane" ? 3 : 1),
      cellsPerSecond: Math.abs(s.speed),
      lonLat,
      place: near ? (near.km < 1 ? near.name : `${near.name} (${near.km.toFixed(0)} km)`) : null,
      ground: view.query.heightAt(s.x, s.y),
    };
    if (this.mode === "plane" && this.plane) {
      const p = this.plane;
      const agl = p.agl;
      // real metres, undoing the level's vertical caricature (D-041)
      const altitude = view.query.elevationAt(s.x, s.y, s.h);
      const under = agl === null ? null : view.query.elevationAt(s.x, s.y, s.h - agl);
      return {
        ...base,
        agl,
        aglMeters: altitude === null || under === null ? null : altitude - under,
        altitudeMeters: altitude,
        throttle: p.state.throttle,
        pitch: p.state.pitch,
        bank: p.state.bank,
        shadow: p.shadowPose ?? undefined,
        canLand: p.canLand,
        crashes: p.crashes,
      };
    }
    const car = this.car!;
    return {
      ...base,
      road: car.drive.roadClassAt(s.x, s.y, s.h),
      assist: car.assist,
      canTakeOff: car.canTakeOff,
      blocked: car.last.blocked,
      bump: car.bump,
    };
  }

  /** Take off: fast on a straight road, into the flying level at the same place. */
  async takeOff(force = false): Promise<boolean> {
    const car = this.car;
    if (this.mode !== "car" || !car || this.transition) return false;
    if (!force && !car.canTakeOff) return false;
    // a walking level's detail is its charm: fly over it rather than switch to the flying level
    const here = this.manifest.level === "walk";
    const url = here ? this.worldUrl : levelUrl(this.worldUrl, this.manifest, "fly", location.href);
    if (!url) {
      this.hud?.say("This world has no flying level.");
      return false;
    }
    const s = car.state;
    const pose = poseToGeo(this.view.query, s.x, s.y, s.heading);
    if (!pose) return false;
    this.transition = "takeoff";
    car.frozen = true;
    this.hud?.say("Taking off…", 2);
    const gen = this.beginChange(here);
    try {
      const manifest = here ? this.manifest : await fetchManifest(url);
      // on the same map the plane keeps the car's speed (another level's speeds differ)
      await this.load(url, manifest, () => new PlaneController({ pose, agl: PLANE.startAgl, speed: here ? s.speed : undefined }));
    } catch (e) {
      this.endChange(null);
      this.transition = null;
      car.frozen = false;
      car.lift = 0;
      throw e;
    }
    this.endChange(gen);
    this.hud?.say(here ? "Airborne" : `Airborne · ${levelLabel(this.manifest)} level`, 2.5);
    return true;
  }

  /** Land: low and slow over a road, onto the driving level's road at the same place. */
  async land(force = false): Promise<boolean> {
    const plane = this.plane;
    if (this.mode !== "plane" || !plane || this.transition) return false;
    if (!force && !plane.canLand) return false;
    const here = this.manifest.level === "walk"; // flying over a walking level: land on it
    const url = here ? this.worldUrl : levelUrl(this.worldUrl, this.manifest, "drive", location.href);
    if (!url) {
      this.hud?.say("This world has no driving level.");
      return false;
    }
    const s = plane.state;
    const pose: GeoPose | null = poseToGeo(this.view.query, s.x, s.y, s.heading);
    if (!pose) return false;
    this.transition = "landing";
    plane.frozen = true;
    this.hud?.say("Landing…", 2);
    const gen = this.beginChange(here);
    try {
      const manifest = here ? this.manifest : await fetchManifest(url);
      // touch down rolling: half the road's speed at the driving level's pace
      const dk = Math.max(DRIVE_PACE.floor, Math.min(1, Math.pow(manifest.scale.metersPerCell / DRIVE_PACE.ref, 0.3)));
      await this.load(url, manifest, (routes) => new CarController({ pose, snap: 8, speed: 3 * dk, routes, traffic: () => this.trafficOn() }));
    } catch (e) {
      this.endChange(null);
      this.transition = null;
      plane.frozen = false;
      throw e;
    }
    this.endChange(gen);
    const car = this.car;
    this.hud?.say(car?.outside ? "That place is outside the driving map: starting at its start." : here ? "Landed" : `Landed · ${levelLabel(this.manifest)} level`, 2.5);
    return true;
  }

  /** Where the ground under the vehicle is on the canvas (CSS px; the two levels' ground meets), and the view's pixels per metre. */
  private anchor(): { x: number; y: number; pxPerMetre: number } {
    const s = this.controller.state;
    const p = this.view.camera.project(s.x, s.y) ?? this.view.camera.project(s.x, s.y, s.h);
    return { x: p.x, y: p.y, pxPerMetre: (this.view.camera.zoom * this.view.world.renderScale) / this.manifest.scale.metersPerCell };
  }

  /**
   * A level change begins: hold the frame. On the same view (flying over a
   * walking level) the vehicles swap under a still frame; another level
   * loads while this one runs on, so its frames are copied as they come.
   */
  private beginChange(same: boolean): number {
    const gen = this.fx.hold(same);
    this.holding = !same;
    this.changeFrom = this.anchor();
    return gen;
  }

  /** …and ends (null: it failed): the held frame zooms into the new level's, at the vehicle. */
  private endChange(gen: number | null): void {
    this.holding = false;
    const from = this.changeFrom;
    this.changeFrom = null;
    if (gen === null || !from) return this.fx.stop();
    const to = this.anchor();
    void this.fx.release(gen, { ms: FX.level, scale: to.pxPerMetre / from.pxPerMetre, from, to });
  }

  /** Turn the view a quarter, the old frame turning away as the new one comes in. */
  private turnView(d: 1 | -1): void {
    const view = this.view;
    if (this.transition) return view.camera.rotate(d); // a level change holds the frame already
    const gen = this.fx.hold();
    view.camera.rotate(d);
    // its tiles first (they may not be baked in this rotation yet), but not for long
    void Promise.race([view.ready(), new Promise((r) => setTimeout(r, FX.turnWait))]).then(() => this.fx.release(gen, { ms: FX.turn, turn: d * 12 }));
  }

  /** Zoom the view, the old frame zooming into the new one. */
  private zoomView(z: number): void {
    const camera = this.view.camera;
    const z0 = camera.zoom;
    if (z === z0) return;
    if (this.transition) {
      camera.zoom = z; // a level change holds the frame already
      return;
    }
    const gen = this.fx.hold();
    camera.zoom = z;
    void this.fx.release(gen, { ms: FX.zoom, scale: camera.zoom / z0 });
  }

  /** The world's levels, in the order Tab goes through them: driving, walking, flying (those it has). */
  get levels(): { name: string; label: string }[] {
    const all = this.manifest.levels ?? [];
    return ["drive", "walk", "fly"].flatMap((name) => all.filter((l) => l.name === name).map((l) => ({ name, label: l.label ?? name })));
  }

  /** The map (level) the game is on: "drive", "walk" or "fly". */
  get map(): string {
    return this.manifest.level ?? "drive";
  }

  /**
   * Any vehicle on any map, at the same place: the map of a level ("drive",
   * "walk", "fly") and the car (on the nearest road there) or the plane (in
   * the air, clear of what stands there). The same map: only the vehicle
   * changes, under a still frame.
   */
  async goTo(name: string, mode: Mode): Promise<boolean> {
    const vehicle = this.controller;
    if (this.transition || !vehicle) return false;
    const fly = mode === "plane";
    const same = name === this.map;
    if (same && mode === this.mode) return false; // there already
    const url = same ? this.worldUrl : levelUrl(this.worldUrl, this.manifest, name, location.href);
    if (!url) {
      this.hud?.say(`This world has no ${name === "drive" ? "driving" : name === "walk" ? "walking" : "flying"} level.`);
      return false;
    }
    const s = vehicle.state;
    const pose = poseToGeo(this.view.query, s.x, s.y, s.heading);
    if (!pose) return false;
    this.transition = "switch";
    vehicle.frozen = true;
    const gen = this.beginChange(same);
    try {
      const manifest = same ? this.manifest : await fetchManifest(url);
      await this.load(url, manifest, (routes) =>
        fly ? new PlaneController({ pose, agl: PLANE.switchAgl }) : new CarController({ pose, snap: 8, routes, traffic: () => this.trafficOn() }),
      );
    } catch (e) {
      this.endChange(null);
      this.transition = null;
      vehicle.frozen = false;
      throw e;
    }
    this.endChange(gen);
    const what = `${fly ? "Plane" : "Car"} · ${levelLabel(this.manifest)}`;
    this.hud?.say(this.car?.outside ? "That place is outside this map: starting at its start." : what, 2.5);
    return true;
  }

  /** Another map here, in the same vehicle (Tab, the map buttons). */
  switchMap(name: string): Promise<boolean> {
    return this.goTo(name, this.mode);
  }

  /** The other vehicle here, on the same map (C, the vehicle buttons). */
  switchVehicle(mode: Mode = this.mode === "car" ? "plane" : "car"): Promise<boolean> {
    return this.goTo(this.map, mode);
  }

  /** The next map along (Tab): driving → walking → flying → driving, in the same vehicle. */
  nextMap(): Promise<boolean> {
    const names = this.levels.map((l) => l.name);
    const next = names[(names.indexOf(this.map) + 1) % names.length];
    return next && next !== this.map ? this.switchMap(next) : Promise.resolve(false);
  }

  /** Back to safety (R): the car onto the nearest road; the plane level, over everything around it. */
  reset(): void {
    if (this.transition) return;
    if (this.mode === "car") {
      this.hud?.say(this.car?.toRoad() ? "Back on the road" : "No road within reach", 1.5);
    } else if (this.plane) {
      this.plane.flyRoute(null);
      this.plane.safeReset();
      this.hud?.say("Back in clear air", 1.5);
    }
  }

  /** A landing approach: fly low and slow to a place (cells) and circle it; over a road, the plane lands. */
  approach(x: number, y: number): boolean {
    const plane = this.plane;
    if (this.mode !== "plane" || !plane) return false;
    plane.flyRoute([{ x, y, agl: 0.8, speed: 3.2 * plane.params.pace }]);
    return true;
  }

  /** Every controller from now on steps only when a script says (`pause(true)`), or in real time. */
  pause(on: boolean): void {
    this.paused = on;
    if (this.car) this.car.paused = on;
    if (this.plane) this.plane.paused = on;
  }

  keyDown(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    const view = this.view;
    if (!view) return;
    if (k === "h" || k === "?") this.hud?.toggleHelp();
    else if (k === "m") this.hud?.toggleMap();
    // Q/E turn the view in the car; in the plane they are the rudder ([ and ] turn the view in both)
    else if (k === "[" || (k === "q" && this.mode === "car")) this.turnView(-1);
    else if (k === "]" || (k === "e" && this.mode === "car")) this.turnView(1);
    else if (k >= "1" && k <= "6" && k.length === 1) this.zoomView(Number(k));
    else if (k === "v" && this.traffic) view.layers.enable(this.traffic.id, !this.traffic.enabled);
    else if (k === "p") {
      // the view's game time: the vehicle, traffic and fog hold still together
      view.paused = !view.paused;
      this.hud?.say(view.paused ? "Paused · P to go on" : "Go", view.paused ? 3600 : 1);
    }
    else if (k === "t" && this.mode === "car") {
      if (!this.car?.canTakeOff) this.hud?.say("To take off: over 7 cells/s on a long straight road.", 2);
      else void this.takeOff();
    } else if (k === "l" && this.mode === "plane") {
      if (!this.plane?.canLand) this.hud?.say("To land: low and slow over a road.", 2);
      else void this.land();
    } else if (k === "r") this.reset();
    else if (k === "tab") {
      e.preventDefault();
      void this.nextMap();
    } else if (k === "c") void this.switchVehicle();
    else this.controller?.keyDown?.(e);
  }

  keyUp(e: KeyboardEvent): void {
    this.controller?.keyUp?.(e);
  }

  blur(): void {
    this.controller?.blur?.();
  }

  /** The flying level's pace (for scripts planning a flight). */
  get flyPace(): number {
    return this.plane?.params.pace ?? FLY_PACE.floor;
  }
}
