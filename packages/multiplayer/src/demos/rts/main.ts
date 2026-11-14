import "@pixelworlds/game/src/game.css";
import { quickRoom } from "../../index";
import { startRts } from "./client";
import { RTS_WORLD, TEAMS, WATCHES } from "./rules";

/**
 * Fogfront's page (D-121). `?room=` (a code to share; without one, quick play
 * finds a room waiting for a second side, or opens one, and puts its code in
 * the address), `&name=`, and `&vs=bot` to play the bot at once rather than
 * wait for someone. Two to a side (D-127): `&size=2` from the room's first
 * page (four pages, two a side), `&side=kiln|tide` to pick one. Watching:
 * `&watch=kiln|tide|all`.
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
    size: params.get("size") === "2" ? 2 : 1,
    side: TEAMS.find((t) => t === params.get("side")),
    watch: WATCHES.find((w) => w === params.get("watch")),
  });
}

main().catch((e: unknown) => {
  console.error(e);
  const ui = document.getElementById("ui");
  if (ui) ui.textContent = `error: ${String(e)}`;
});
