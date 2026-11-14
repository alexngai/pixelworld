/**
 * @pixelworlds/engine: a pixel-art world view to build games and other
 * interaction modes on (docs/library.md). One entry point:
 *
 *   const view = await createWorldView({ canvas, worldUrl, style, layers, controller });
 *
 * The view streams a world package, bakes and caches its tiles, and draws
 * them with runtime layers (fog here; traffic in @pixelworlds/sim) and
 * entities in a lazy frame loop. It owns no input handling or UI: a
 * controller turns input into entity and camera movement, using queries.
 *
 * Without a view, `openWorld({ worldUrl, style })` gives the same queries
 * (D-111): for a game server or a bot that must agree with the views.
 */
export { createWorldView } from "./view";
export { openWorld } from "./world";
export { roverController, RoverController, type RoverOptions, type RoverState } from "./rover";
export { fogLayer, FogLayer, type FogLayerOptions } from "./fog";
export { listenTo } from "./controller";
export { headingIndex, turnBoxes, DEFAULT_HEADINGS } from "./entities";
export { AUTO_ZOOM_PX } from "./camera";
export * from "./cells";
export type * from "./types";
