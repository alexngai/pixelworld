import "@pixelworlds/game/src/game.css";
import { quickRoom } from "../../index";
import { startRts } from "./client";
import { RTS_WORLD } from "./rules";

/**
 * Fogfront's page (D-121). `?room=` (a code to share; without one, quick play
 * finds a room waiting for a second side, or opens one, and puts its code in
 * the address), `&name=`, and `&vs=bot` to play the bot at once rather than
 * wait for someone.
 */
async function main() {
  const params = new URLSearchParams(location.search);
  if (!params.get("room")) {
    params.set("room", await quickRoom().catch(() => "presidio")); // no lobby (an old server): a room by name
    history.replaceState(null, "", `?${params}`);
  }
  await startRts({
    canvas: document.getElementById("view") as HTMLCanvasElement,
    worldUrl: RTS_WORLD,
    room: params.get("room")!,
    name: params.get("name"),
    vs: params.get("vs") === "bot" ? "bot" : "any",
  });
}

main().catch((e: unknown) => {
  console.error(e);
  const ui = document.getElementById("ui");
  if (ui) ui.textContent = `error: ${String(e)}`;
});
