import { createWorldView, roverController } from "pixelworld/engine";

/**
 * pixelworld from npm, bundled by webpack 5: the Grand Canyon slice, the
 * rover and its free camera. public/ holds the page, the world package
 * (worlds/grand-canyon-m0/) and the style pack its manifest names
 * (styles/desert-southwest/style.json); webpack writes main.js to dist/.
 */
async function main() {
  const canvas = document.querySelector("#world");
  const status = document.querySelector("#status");

  const view = await createWorldView({
    canvas,
    worldUrl: "/worlds/grand-canyon-m0/",
    style: (id) => fetch(`/styles/${id}/style.json`).then((r) => r.json()),
    camera: { rotation: 1 },
    controller: roverController({ listen: { keys: window, pointer: canvas } }),
  });

  await view.ready();
  const { bakeMode, tilesBaked } = view.stats();
  status.textContent = `${view.world.manifest.name} · ${tilesBaked} tiles baked (${bakeMode}) · webpack 5`;
  document.body.dataset.bakeMode = bakeMode; // read by the consumer test
  Object.assign(window, { view });
}

main().catch((e) => {
  document.querySelector("#status").textContent = `error: ${String(e)}`;
  document.body.dataset.error = String(e);
});
