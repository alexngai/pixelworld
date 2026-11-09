import { createWorldView, roverController } from "@pixelworld/engine";
import { trafficLayer } from "@pixelworld/sim";
// the world names its style pack ("bay-area"); a page brings the packs it uses
import bayArea from "../../../worlds/_styles/bay-area/style.json";
// and the plugins whose generators the pack names: San Francisco's city pack
import { cityPlugin } from "@pixelworlds/city-sf";

/**
 * A minimal client of the engine: San Francisco's driving level, the rover
 * and its free camera, and ambient traffic. Arrows drive, WASD or a drag
 * pans, Q/E rotate, 1–6 zoom, V switches traffic. The status line reads the
 * world under the pointer through the view's queries.
 */
async function main() {
  const canvas = document.getElementById("world") as HTMLCanvasElement;
  const status = document.getElementById("status")!;
  const view = await createWorldView({
    canvas,
    worldUrl: "/sf/",
    style: bayArea,
    plugins: [cityPlugin],
    layers: [trafficLayer()],
    // Russian Hill, where the cable cars climb Hyde Street
    controller: roverController({ start: { lon: -122.4195, lat: 37.8 }, listen: { keys: window, pointer: canvas } }),
  });

  window.addEventListener("keydown", (e) => {
    const traffic = view.layers.get("traffic");
    if (e.key === "v" && traffic) view.layers.enable(traffic.id, !traffic.enabled);
  });

  canvas.addEventListener("pointermove", (e) => {
    const hit = view.query.pick(e.offsetX, e.offsetY);
    if (!hit) return;
    const [lon, lat] = view.query.cellToLonLat(hit.x, hit.y) ?? [0, 0];
    const road = view.query.roadAt(hit.x, hit.y);
    status.textContent =
      `cell ${hit.cellX},${hit.cellY} · ${lat.toFixed(5)}°, ${lon.toFixed(5)}° · ${view.query.surfaceAt(hit.x, hit.y)?.name}` +
      (road ? ` · ${road.class} road, ${road.width.toFixed(1)} cells wide` : "");
  });

  await view.ready();
  status.textContent = "Arrows drive · WASD or drag pan · Q/E rotate · 1–6 zoom · V traffic";
  Object.assign(window, { view }); // for the console
}

main().catch((e: unknown) => {
  document.getElementById("status")!.textContent = `error: ${String(e)}`;
});
