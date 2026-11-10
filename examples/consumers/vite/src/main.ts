import { createWorldView, roverController, type PluginDescriptor } from "pixelworld/engine";
import { cityPlugin } from "@pixelworlds/city-sf";

/**
 * pixelworld from npm, in a Vite app: a world with the rover and its free
 * camera. public/ holds the world packages (worlds/<id>/) and the style packs
 * their manifests name (styles/<id>/style.json). The Grand Canyon slice by
 * default; ?world=sf-fly draws San Francisco with its city pack.
 * Arrows drive, WASD or a drag pans, Q/E rotate, 1–6 zoom.
 */

// The city packs this app can load, by name. A world's style pack names the plugins its
// generators come from (bay-area names @pixelworlds/city-sf), and the view loads those;
// the Southwest's pack names none, so the Grand Canyon loads nothing.
const PLUGINS: Record<string, PluginDescriptor> = { [cityPlugin.name]: cityPlugin };

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
  const status = document.querySelector<HTMLElement>("#status")!;
  const world = new URLSearchParams(location.search).get("world") ?? "grand-canyon-m0";

  const view = await createWorldView({
    canvas,
    worldUrl: `/worlds/${world}/`,
    // the manifest names its style pack ("desert-southwest", "bay-area"); fetch it from where you host packs
    style: (id) => fetch(`/styles/${id}/style.json`).then((r) => r.json()),
    plugins: (names) => names.flatMap((name) => PLUGINS[name] ?? []),
    camera: { rotation: 1 },
    controller: roverController({ listen: { keys: window, pointer: canvas } }),
  });

  await view.ready();
  const { bakeMode, tilesBaked } = view.stats();
  status.textContent = `${view.world.manifest.name} · ${tilesBaked} tiles baked (${bakeMode}) · arrows drive, Q/E rotate`;
  // read by the consumer test
  document.body.dataset.tilesBaked = String(tilesBaked);
  document.body.dataset.bakeMode = bakeMode;
  Object.assign(window, { view });
}

main().catch((e: unknown) => {
  document.querySelector("#status")!.textContent = `error: ${String(e)}`;
  document.body.dataset.error = String(e);
});
