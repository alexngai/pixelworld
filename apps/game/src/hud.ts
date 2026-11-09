import type { RouteNetwork } from "@pixelworlds/sim";

/**
 * The game's HUD: speed, level and place (top left), a hint line (bottom),
 * a banner for events, a minimap of the world's roads (top right) and the
 * key help (H). Plain DOM over the canvas.
 */

export interface HudInfo {
  mode: "car" | "plane";
  level: string;
  world: string;
  /** Gauge speed (km/h) and cells per second. */
  kmh: number;
  cellsPerSecond: number;
  place: string | null;
  lonLat: [number, number] | null;
  /** The plane's height over the ground and above sea level (m). */
  aglMeters?: number | null;
  altitudeMeters?: number | null;
  throttle?: number;
  road?: string | null;
  assist?: boolean;
  fps: number;
  hint: string;
}

const HELP = `<h2>Keys</h2>
<table>
<tr><th colspan="2">Car</th></tr>
<tr><td>W / ↑</td><td>throttle</td></tr>
<tr><td>S / ↓</td><td>brake, then reverse</td></tr>
<tr><td>A D / ← →</td><td>steer</td></tr>
<tr><td>G</td><td>road assist on/off (keeps to the road while the wheel is straight)</td></tr>
<tr><td>T</td><td>take off: fast on a long straight road</td></tr>
<tr><th colspan="2">Plane</th></tr>
<tr><td>W / ↑ · S / ↓</td><td>climb · descend</td></tr>
<tr><td>A D / ← →</td><td>bank and turn</td></tr>
<tr><td>Shift or + · Z or −</td><td>throttle up · down</td></tr>
<tr><td>L</td><td>land: low and slow over a road (it lands by itself too)</td></tr>
<tr><th colspan="2">Both</th></tr>
<tr><td>Q / E</td><td>rotate the view</td></tr>
<tr><td>1–6</td><td>zoom</td></tr>
<tr><td>R</td><td>back onto the nearest road (car) · level out higher up (plane)</td></tr>
<tr><td>V</td><td>traffic on/off</td></tr>
<tr><td>M</td><td>minimap</td></tr>
<tr><td>H</td><td>this help</td></tr>
</table>
<p>URL: <code>?world=/sf/</code> · <code>?start=lon,lat</code> · <code>?traffic=0</code> · <code>?run=1</code> drives Las Vegas → Hoover Dam → the Grand Canyon and flies the canyon by itself, then shows its frame times.</p>`;

const CLASS_COLOUR: Record<string, string> = {
  motorway: "#f2c35b",
  trunk: "#e0a35a",
  primary: "#c9b48a",
  secondary: "#8f8a7a",
};

export class Hud {
  private readonly panel: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly help: HTMLElement;
  private readonly map: HTMLCanvasElement;
  private base: HTMLCanvasElement | null = null;
  private world = { cellsX: 1, cellsY: 1 };
  private bannerUntil = 0;

  constructor(root: HTMLElement) {
    const el = (id: string, tag = "div") => {
      const e = document.createElement(tag);
      e.id = id;
      root.append(e);
      return e;
    };
    this.panel = el("hud");
    this.hint = el("hint");
    this.banner = el("banner");
    this.help = el("help");
    this.help.innerHTML = HELP;
    this.help.classList.add("hidden");
    this.map = el("minimap", "canvas") as HTMLCanvasElement;
  }

  toggleHelp(): void {
    this.help.classList.toggle("hidden");
  }

  toggleMap(): void {
    this.map.classList.toggle("hidden");
  }

  hide(): void {
    for (const e of [this.panel, this.hint, this.banner, this.help, this.map]) e.classList.add("hidden");
  }

  /** A message across the top for a few seconds. */
  say(text: string, seconds = 3): void {
    this.banner.textContent = text;
    this.banner.classList.remove("hidden");
    this.bannerUntil = performance.now() + seconds * 1000;
  }

  update(info: HudInfo): void {
    const lines = [
      `${info.mode === "car" ? "CAR" : "PLANE"} · ${info.level}`,
      `${Math.round(info.kmh)} km/h  (${info.cellsPerSecond.toFixed(1)} cells/s)`,
    ];
    if (info.mode === "plane") {
      lines.push(
        `alt ${info.altitudeMeters == null ? "–" : Math.round(info.altitudeMeters)} m · ${info.aglMeters == null ? "–" : Math.round(info.aglMeters)} m over ground`,
        `throttle ${Math.round((info.throttle ?? 0) * 100)}%`,
      );
    } else lines.push(`${info.road ? `on the ${info.road}` : "off-road"}${info.assist ? "" : " · assist off"}`);
    lines.push(info.place ? `near ${info.place}` : info.lonLat ? `${info.lonLat[1].toFixed(4)}°, ${info.lonLat[0].toFixed(4)}°` : "");
    if (info.place && info.lonLat) lines.push(`${info.lonLat[1].toFixed(4)}°, ${info.lonLat[0].toFixed(4)}°`);
    lines.push(`${info.fps.toFixed(0)} fps · H for keys`);
    this.panel.textContent = lines.join("\n");
    this.hint.textContent = info.hint;
    this.hint.classList.toggle("hidden", !info.hint);
    if (this.bannerUntil && performance.now() > this.bannerUntil) {
      this.banner.classList.add("hidden");
      this.bannerUntil = 0;
    }
  }

  /** Draw the world's roads and landmarks once, for the minimap. */
  setWorld(cellsX: number, cellsY: number, routes: RouteNetwork | null, landmarks: readonly { x: number; y: number }[]): void {
    this.world = { cellsX, cellsY };
    const w = 180;
    const h = Math.max(60, Math.min(200, Math.round((w * cellsY) / cellsX)));
    this.map.width = w;
    this.map.height = h;
    const base = document.createElement("canvas");
    base.width = w;
    base.height = h;
    const ctx = base.getContext("2d")!;
    ctx.fillStyle = "#1e1c2b";
    ctx.fillRect(0, 0, w, h);
    const sx = w / cellsX;
    const sy = h / cellsY;
    for (const cls of ["secondary", "primary", "trunk", "motorway", ""]) {
      ctx.strokeStyle = CLASS_COLOUR[cls] ?? "#6d6a60";
      ctx.lineWidth = cls === "motorway" || cls === "trunk" ? 1.2 : 0.7;
      ctx.beginPath();
      for (const r of routes?.routes ?? []) {
        if (r.net !== "road") continue;
        const known = r.cls in CLASS_COLOUR;
        if ((cls && r.cls !== cls) || (!cls && known)) continue;
        for (let i = 0; i < r.pts.length; i += 3) {
          const x = r.pts[i]! * sx;
          const y = r.pts[i + 1]! * sy;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    ctx.fillStyle = "#7fd0c8";
    for (const l of landmarks) ctx.fillRect(l.x * sx - 1.5, l.y * sy - 1.5, 3, 3);
    this.base = base;
  }

  /** The minimap with the player on it (cells, heading). */
  drawMap(x: number, y: number, heading: number, colour: string): void {
    if (!this.base || this.map.classList.contains("hidden")) return;
    const ctx = this.map.getContext("2d")!;
    ctx.drawImage(this.base, 0, 0);
    const px = (x / this.world.cellsX) * this.map.width;
    const py = (y / this.world.cellsY) * this.map.height;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(heading);
    ctx.fillStyle = colour;
    ctx.strokeStyle = "#141320";
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-4, 4);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-4, -4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
