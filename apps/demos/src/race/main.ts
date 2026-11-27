import "@pixelworlds/game/src/game.css";
import { Game } from "@pixelworlds/game/src/game";
import { stylePack } from "@pixelworlds/game/src/styles";
import { quickRoom } from "@pixelworlds/multiplayer";
import { startRace } from "./client";
import { COURSE, RACE_LOBBY, RACE_WORLD } from "./rules";

/**
 * The race demo's page (D-119): the example game's car on the Southwest's
 * driving level, at the Strip, driven through the server (client.ts). No
 * traffic: the race closes the streets. `?room=` (a code to share; without
 * one, quick play finds a room and puts its code in the address), `&name=`,
 * and `&watch=1` to watch rather than drive. Keys: the game's car's, and R
 * back to the last checkpoint (the game's own reset and pause are the race's
 * to decide, so they don't reach it).
 */
async function main() {
  const params = new URLSearchParams(location.search);
  if (!params.get("room")) {
    params.set("room", await quickRoom(undefined, RACE_LOBBY).catch(() => "strip")); // no lobby (an old server): a room by name
    history.replaceState(null, "", `?${params}`);
  }
  const game = await Game.create({
    canvas: document.getElementById("view") as HTMLCanvasElement,
    worldUrl: RACE_WORLD,
    start: COURSE[0],
    style: stylePack,
    hud: document.getElementById("ui"),
    traffic: { enabled: false },
    zoom: 2, // close enough to see the cars bump (1–6 change it)
  });
  window.addEventListener("keydown", (e) => {
    if (!["r", "p"].includes(e.key.toLowerCase())) game.keyDown(e);
  });
  window.addEventListener("keyup", (e) => game.keyUp(e));
  window.addEventListener("blur", () => game.blur());
  await startRace(game, { room: params.get("room")!, name: params.get("name"), watch: params.get("watch") === "1" });
}

main().catch((e: unknown) => {
  console.error(e);
  const ui = document.getElementById("ui");
  if (ui) ui.textContent = `error: ${String(e)}`;
});
