import { createWorldView, roverController } from "pixelworld/engine";

/**
 * pixelworld from npm, in a Vite app: the Grand Canyon slice, the rover and
 * its free camera. public/ holds the world package (worlds/grand-canyon-m0/)
 * and the style pack its manifest names (styles/desert-southwest/style.json).
 * Arrows drive, WASD or a drag pans, Q/E rotate, 1–6 zoom.
 */
async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
  const status = document.querySelector<HTMLElement>("#status")!;

  const view = await createWorldView({
    canvas,
    worldUrl: "/worlds/grand-canyon-m0/",
    // the manifest names its style pack ("desert-southwest"); fetch it from where you host packs
    style: (id) => fetch(`/styles/${id}/style.json`).then((r) => r.json()),
    camera: { rotation: 1 },
    controller: roverController({ listen: { keys: window, pointer: canvas } }),
  });

  await view.ready();
  const { bakeMode, tilesBaked } = view.stats();
  status.textContent = `${view.world.manifest.name} · ${tilesBaked} tiles baked (${bakeMode}) · arrows drive, Q/E rotate`;
  document.body.dataset.bakeMode = bakeMode; // read by the consumer test
  Object.assign(window, { view });
}

main().catch((e: unknown) => {
  document.querySelector("#status")!.textContent = `error: ${String(e)}`;
  document.body.dataset.error = String(e);
});
