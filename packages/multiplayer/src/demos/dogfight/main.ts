import "@pixelworlds/game/src/game.css";
import { Game } from "@pixelworlds/game/src/game";
import { stylePack } from "@pixelworlds/game/src/styles";
import { quickRoom } from "../../index";
import { startDogfight } from "./client";
import { DOGFIGHT_START, DOGFIGHT_WORLD } from "./rules";

/**
 * The dogfight demo's page (D-114): the example game in the air over the
 * Grand Canyon, its plane flown through the server (client.ts). `?room=` (a
 * code to share; without one, quick play finds a room and puts its code in
 * the address), `&name=`, and `&watch=1` to watch rather than fly. Keys: the
 * game's plane's, and Space fires (watching: the next plane).
 */
async function main() {
  const params = new URLSearchParams(location.search);
  if (!params.get("room")) {
    params.set("room", await quickRoom().catch(() => "canyon")); // no lobby (an old server): a room by name
    history.replaceState(null, "", `?${params}`);
  }
  const game = await Game.create({
    canvas: document.getElementById("view") as HTMLCanvasElement,
    worldUrl: DOGFIGHT_WORLD,
    start: DOGFIGHT_START,
    style: stylePack,
    hud: document.getElementById("ui"),
    fly: true,
  });
  window.addEventListener("keydown", (e) => game.keyDown(e));
  window.addEventListener("keyup", (e) => game.keyUp(e));
  window.addEventListener("blur", () => game.blur());
  await startDogfight(game, { room: params.get("room")!, name: params.get("name"), watch: params.get("watch") === "1" });
}

main().catch((e: unknown) => {
  console.error(e);
  const ui = document.getElementById("ui");
  if (ui) ui.textContent = `error: ${String(e)}`;
});
