import { OVERRUN, PRESSURE, choosing, type Front } from "@pixelworlds/tactics";
import type { CityMap } from "./cityMap";
import type { Campaign } from "./coop";
import type { Block } from "./sites";

/**
 * The overworld between fights (D-179): the city from above with the front
 * on it (each district's boards tinted by its pressure, its name, the wave's
 * threats numbered) and a panel beside it: the wave, the city's trust, what
 * the last wave's end did, the threats with who's on each, and the squads
 * defending the city.
 */

/** Calm, threatened, under attack, overrun. */
const TINT = ["#8fb996", "#ffd166", "#ff9f43", "#ff5a4e"];
const GOLD = "#ffd166";
const SIZE = 8;
/** How far round each of its boards a district is drawn (world cells). */
const REACH = 26;
let LAYER: HTMLCanvasElement | null = null;
const middle = (b: Block) => [b.x0 + (SIZE * b.cell) / 2, b.y0 + (SIZE * b.cell) / 2] as const;

/** The front over the city map (`CityMap.decorate`). */
export function drawFront(g: CanvasRenderingContext2D, at: (x: number, y: number) => [number, number], k: number, c: Campaign, pool: readonly Block[]): void {
  const f = c.front;
  if (!f) return;
  // each district an area around its boards, tinted by its pressure: drawn whole on a layer, then laid over at once, so overlaps don't darken
  const layer = (LAYER ??= document.createElement("canvas"));
  [layer.width, layer.height] = [g.canvas.width, g.canvas.height];
  const lg = layer.getContext("2d")!;
  lg.setTransform(g.getTransform());
  for (let p = 0; p <= OVERRUN; p++) {
    lg.clearRect(0, 0, layer.width, layer.height);
    lg.fillStyle = TINT[p]!;
    lg.beginPath();
    f.districts.forEach((d, j) => {
      if (f.pressure[j] !== p) return;
      for (const i of d.sites) {
        const [x, y] = at(...middle(pool[i]!));
        lg.moveTo(x + REACH * k, y);
        lg.arc(x, y, REACH * k, 0, 2 * Math.PI);
      }
    });
    lg.fill();
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = [0.14, 0.3, 0.38, 0.5][p]!;
    g.drawImage(layer, 0, 0);
    g.restore();
  }
  g.globalAlpha = 1;
  g.textAlign = "center";
  g.textBaseline = "middle";
  f.districts.forEach((d, j) => {
    const p = f.pressure[j]!;
    const [x, y] = at(d.x, d.y);
    const text = `${d.name} · ${PRESSURE[p]}`;
    g.font = "bold 11px ui-monospace, Menlo, monospace";
    const w = g.measureText(text).width + 10;
    g.fillStyle = "rgba(14,13,22,0.75)";
    g.fillRect(x - w / 2, y - 22, w, 16);
    g.fillStyle = p ? TINT[p]! : "#a99f86";
    g.fillText(text, x, y - 14);
  });
  f.threats.forEach((t, n) => {
    const [x, y] = at(...middle(pool[t.site]!));
    g.beginPath();
    g.arc(x, y, 11, 0, 2 * Math.PI);
    g.fillStyle = t.result ? "#3a3650" : TINT[f.pressure[t.district]!]!;
    g.fill();
    g.lineWidth = t.by === c.me ? 3 : 1.5;
    g.strokeStyle = t.by === c.me ? GOLD : "#0e0d16";
    g.stroke();
    g.fillStyle = t.result ? "#e8dcbc" : "#0e0d16";
    g.font = "bold 12px ui-monospace, Menlo, monospace";
    g.fillText(t.result ? (t.result.held ? "✓" : "✗") : String(n + 1), x, y + 1);
    const who = t.by && t.by !== c.me ? c.crews[t.by]?.name : null;
    if (who) {
      g.textAlign = "left";
      g.fillStyle = "#e8dcbc";
      g.fillText(who, x + 15, y + 1);
      g.textAlign = "center";
    }
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function panel(f: Front, c: Campaign, pool: readonly Block[], city: string): string {
  const mine = f.threats.find((t) => t.by === c.me);
  const crewOf = (id: string) => c.crews[id] ?? { name: "A squad that left", squad: "" };
  const ids = Object.keys(c.crews);
  const sat = f.passed.includes(c.me);
  // who the wave waits on: squads fighting, and squads still choosing (D-182)
  const awaited = [
    ...f.threats.flatMap((t) => (t.by && t.by !== c.me && !t.result ? [`${crewOf(t.by).name} (fighting)`] : [])),
    ...choosing(f, ids).flatMap((id) => (id !== c.me ? [`${crewOf(id).name} (choosing)`] : [])),
  ];
  const status = (t: Front["threats"][number]) =>
    t.result
      ? `<em class="${t.result.held ? "good" : "bad"}">${t.result.held ? "held" : `fought: ${Math.round(t.result.lost)} lost`}${t.by && t.by !== c.me ? ` by ${crewOf(t.by).name}` : ""}</em>`
      : t.by === c.me
        ? `<em>your squad</em>`
        : t.by
          ? `<em>${crewOf(t.by).name}'s ${crewOf(t.by).squad}</em>`
          : mine || sat
            ? ""
            : `<button data-claim="${t.id}">Defend</button>`;
  const link = c.room ? `${location.origin}${location.pathname}?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(location.search)), room: c.room })}` : "";
  return `
    <h2>${city} · wave ${f.wave} of ${f.waves}</h2>
    <p class="trust" title="The city's trust: lost when a block fought isn't held and when a district is overrun; at none, the operation is lost">Trust <b>${"●".repeat(f.trust)}</b> ${f.trust}</p>
    ${f.news.length ? `<ul class="news">${f.news.map((n) => `<li>${n}</li>`).join("")}</ul>` : `<p class="dim">Invaders are landing at the city's edge. Each wave, every squad takes one block to hold; the districts nobody defends are pressed harder, and one overrun spreads.</p>`}
    <h3>${c.lost ? "The room is gone" : mine?.result || sat ? `${sat ? "Your squad sits this wave out. " : ""}Waiting for ${awaited.join(", ") || "the other squads"}` : mine ? "Your squad is on its way" : "Choose a block to defend"}</h3>
    ${c.room && !c.lost && !mine && !sat ? `<p class="choose">${c.chooseBy ? `<b data-left></b> to choose, or your squad sits this wave out. ` : ""}<button data-pass>Sit this wave out</button></p>` : ""}
    ${c.lost ? `<p>${c.lost}</p><button data-leave>Back to the title</button>` : ""}
    <ol class="threats">${f.threats
      .map(
        (t, n) => `<li data-at="${t.site}" class="${t.by === c.me ? "mine" : ""}">
          <span class="pin" style="background:${t.result ? "#3a3650" : TINT[f.pressure[t.district]!]}">${n + 1}</span>
          <div><b>${pool[t.site]!.name}</b><small>${f.districts[t.district]!.name} · ${PRESSURE[f.pressure[t.district]!]}</small></div>
          ${status(t)}
        </li>`,
      )
      .join("")}</ol>
    ${
      c.room
        ? `<h3>${plural(ids.length, "squad")} defending</h3>
           <ul class="crews">${ids.map((id) => `<li>${id === c.me ? "<b>You</b>" : crewOf(id).name} · ${crewOf(id).squad}</li>`).join("")}</ul>
           <p class="dim">Room <b>${c.room}</b>. Another squad joins with this link: <input readonly value="${link}" onclick="this.select()"></p>`
        : ""
    }`;
}

/**
 * The overworld until this page's squad has a block to fight: the map opened
 * over the city, the panel beside it; resolves with the threat taken once the
 * front says it's this squad's, or null when the operation is over.
 */
export function chooseThreat(ui: HTMLElement, map: CityMap, c: Campaign, pool: readonly Block[], city: string): Promise<number | null> {
  const el = document.createElement("div");
  el.className = "front-panel";
  ui.append(el);
  // the whole city in view, beside the panel
  const ms = pool.map(middle);
  const [x0, x1] = [Math.min(...ms.map((m) => m[0])) - REACH, Math.max(...ms.map((m) => m[0])) + REACH];
  const [y0, y1] = [Math.min(...ms.map((m) => m[1])) - REACH, Math.max(...ms.map((m) => m[1])) + REACH];
  map.show((x0 + x1) / 2, (y0 + y1) / 2);
  const room = Math.max(200, map.el.clientWidth - 380);
  const k = Math.min(4, room / (x1 - x0), map.el.clientHeight / (y1 - y0));
  map.show((x0 + x1) / 2 + 190 / k, (y0 + y1) / 2, k);
  return new Promise((done) => {
    let finished = false;
    const finish = (v: number | null) => {
      if (finished) return;
      finished = true;
      off();
      clearInterval(tick);
      el.remove();
      done(v);
    };
    const render = () => {
      const f = c.front;
      const mine = f.threats.find((t) => t.by === c.me && !t.result);
      if (f.over) return finish(null);
      if (mine) return finish(mine.id);
      el.innerHTML = panel(f, c, pool, city);
      map.redraw();
    };
    const off = c.listen(render);
    // the choosing clock, counted down in place (D-182)
    const tick = setInterval(() => {
      const left = el.querySelector<HTMLElement>("[data-left]");
      if (!left || !c.chooseBy) return;
      const s = Math.max(0, Math.ceil((c.chooseBy - Date.now()) / 1000));
      left.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 250);
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const claim = t.closest<HTMLElement>("[data-claim]")?.dataset.claim;
      if (claim) return c.send({ k: "claim", threat: Number(claim) });
      if (t.closest("[data-pass]")) return c.send({ k: "pass" });
      if (t.closest("[data-leave]")) return void (location.search = "");
      const at = t.closest<HTMLElement>("[data-at]")?.dataset.at;
      if (at) map.show(...middle(pool[Number(at)]!));
    });
    render();
  });
}
