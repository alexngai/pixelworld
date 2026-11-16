import type { RouteNetwork } from "@pixelworlds/sim";
import { Minimap } from "./minimap";

/**
 * The game's HUD: speed, level and place (top left), a hint line (bottom),
 * a banner for events, a minimap of the world's roads (top right), the
 * landmarks' names over them, buttons for the world's levels and a reset
 * (bottom left), and the key help (H). Plain DOM over the canvas.
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
  /** The nose over the horizon and the bank (rad). */
  pitch?: number;
  bank?: number;
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
<tr><td>W / ↑ · S / ↓</td><td>pull · push (hold W to loop)</td></tr>
<tr><td>A D / ← →</td><td>roll (bank to turn; hold to roll right round)</td></tr>
<tr><td>Q / E</td><td>rudder (yaw)</td></tr>
<tr><td>Shift or + · Z or −</td><td>throttle up · down</td></tr>
<tr><td>hands off</td><td>rolls upright and levels out by itself</td></tr>
<tr><td>L</td><td>land: low and slow over a road (it lands by itself too)</td></tr>
<tr><th colspan="2">Both</th></tr>
<tr><td>[ / ]</td><td>rotate the view (Q / E in the car)</td></tr>
<tr><td>1–6</td><td>zoom</td></tr>
<tr><td>Tab</td><td>next map, here: driving → walking → flying (in the same vehicle)</td></tr>
<tr><td>C</td><td>car ⇄ plane, here, on the same map (the buttons bottom left do both)</td></tr>
<tr><td>R</td><td>back to safety: onto the nearest road (car) · level, over everything around (plane)</td></tr>
<tr><td>V</td><td>traffic on/off</td></tr>
<tr><td>P</td><td>pause</td></tr>
<tr><td>M</td><td>minimap</td></tr>
<tr><td>H</td><td>this help</td></tr>
</table>
<p>URL: <code>?world=/sf/</code> · <code>?start=lon,lat</code> · <code>?traffic=0</code> · <code>?run=1</code> drives Las Vegas → Hoover Dam → the Grand Canyon and flies the canyon by itself, then shows its frame times.</p>`;

const deg = (rad = 0) => `${rad >= 0 ? "+" : "−"}${Math.abs(Math.round((rad * 180) / Math.PI))}`;

export class Hud {
  private readonly panel: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly help: HTMLElement;
  private readonly map: Minimap;
  private bannerUntil = 0;
  private readonly root: HTMLElement;
  private readonly labelEls: HTMLElement[] = [];
  private readonly bar: HTMLElement;
  /** A button was clicked: "vehicle:car", "vehicle:plane", "map:drive" (or walk, fly), or "reset". */
  onButton: ((what: string) => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
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
    this.map = new Minimap(el("minimap", "canvas") as HTMLCanvasElement);
    this.bar = el("modes");
    this.bar.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      b.blur(); // keys stay the game's
      this.onButton?.(b.dataset.go!);
    });
  }

  /** The vehicle and map buttons (the current ones marked), and the reset. */
  setButtons(maps: readonly { name: string; label: string }[], map: string, mode: "car" | "plane"): void {
    const short: Record<string, string> = { drive: "Drive", walk: "Walk", fly: "Fly" };
    const button = (go: string, text: string, title: string, on = false) => {
      const e = document.createElement("button");
      e.dataset.go = go;
      e.textContent = text;
      e.title = title;
      e.tabIndex = -1;
      e.classList.toggle("on", on);
      return e;
    };
    const caption = (text: string) => Object.assign(document.createElement("span"), { textContent: text });
    this.bar.replaceChildren(
      button("vehicle:car", "Car", "Drive here (C)", mode === "car"),
      button("vehicle:plane", "Plane", "Fly here (C)", mode === "plane"),
      caption("map"),
      ...maps.map((m) => button(`map:${m.name}`, short[m.name] ?? m.label, `${m.label} map (Tab)`, m.name === map)),
      button("reset", "Reset", "Back to safety (R)"),
    );
  }

  toggleHelp(): void {
    this.help.classList.toggle("hidden");
  }

  toggleMap(): void {
    this.map.canvas.classList.toggle("hidden");
  }

  hide(): void {
    for (const e of [this.panel, this.hint, this.banner, this.help, this.map.canvas, this.bar, ...this.labelEls]) e.classList.add("hidden");
  }

  /** Names over places on the canvas (CSS px from its top-left, as the camera projects them). */
  labels(canvas: HTMLCanvasElement, list: readonly { name: string; x: number; y: number }[]): void {
    const box = canvas.getBoundingClientRect();
    while (this.labelEls.length < list.length) {
      const e = document.createElement("div");
      e.className = "label";
      this.root.append(e);
      this.labelEls.push(e);
    }
    this.labelEls.forEach((e, i) => {
      const l = list[i];
      e.classList.toggle("hidden", !l);
      if (!l) return;
      if (e.textContent !== l.name) e.textContent = l.name;
      e.style.left = `${box.left + l.x}px`;
      e.style.top = `${box.top + l.y}px`;
    });
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
        `pitch ${deg(info.pitch)}° · bank ${deg(info.bank)}°`,
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

  /** The world's roads and landmarks, for the minimap. */
  setWorld(cellsX: number, cellsY: number, routes: RouteNetwork | null, landmarks: readonly { x: number; y: number }[]): void {
    this.map.setWorld(cellsX, cellsY, routes, landmarks);
  }

  /** The minimap with the player on it (cells, heading). */
  drawMap(x: number, y: number, heading: number, colour: string): void {
    this.map.draw(x, y, heading, colour);
  }
}
