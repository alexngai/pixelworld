import { createWorldView, roverController } from "pixelworld/engine";
import { cityPlugin } from "@pixelworlds/city-sf";

/**
 * pixelworld from npm, bundled by webpack 5: a world with the rover and its
 * free camera. public/ holds the page, the world packages (worlds/<id>/) and
 * the style packs their manifests name (styles/<id>/style.json); webpack
 * writes main.js to dist/, and the city pack's worker module beside it. The
 * Grand Canyon slice by default; ?world=sf-fly draws San Francisco with its
 * city pack.
 */

// The city packs this app can load, by name: the view loads those the world's style pack names.
const PLUGINS = { [cityPlugin.name]: cityPlugin };

async function main() {
  const canvas = document.querySelector("#world");
  const status = document.querySelector("#status");
  const world = new URLSearchParams(location.search).get("world") ?? "grand-canyon-m0";

  const view = await createWorldView({
    canvas,
    worldUrl: `/worlds/${world}/`,
    style: (id) => fetch(`/styles/${id}/style.json`).then((r) => r.json()),
    plugins: (names) => names.flatMap((name) => PLUGINS[name] ?? []),
    camera: { rotation: 1 },
    controller: roverController({ listen: { keys: window, pointer: canvas } }),
  });

  await view.ready();
  const { bakeMode, tilesBaked } = view.stats();
  status.textContent = `${view.world.manifest.name} · ${tilesBaked} tiles baked (${bakeMode}) · webpack 5`;
  // read by the consumer test
  document.body.dataset.tilesBaked = String(tilesBaked);
  document.body.dataset.bakeMode = bakeMode;
  Object.assign(window, { view });
}

main().catch((e) => {
  document.querySelector("#status").textContent = `error: ${String(e)}`;
  document.body.dataset.error = String(e);
});
