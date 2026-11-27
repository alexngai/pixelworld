import "@pixelworlds/game/src/game.css";
import { quickRoom } from "@pixelworlds/multiplayer";
import { startRts } from "./client";
import { DEFAULT_MAP, MAPS, mapOf } from "./maps";
import { RTS_LOBBY, TEAMS, WATCHES } from "./rules";

/**
 * Fogfront's page (D-121). `?map=` (D-128: `presidio`, `midtown`,
 * `higashiyama`, `kowloon`, `strip`; the Presidio without), `?room=` (a code
 * to share; without one, quick play finds a room on that map waiting for a
 * second side, or opens one, and puts its code in the address), `&name=`, and
 * `&vs=bot` to play the bot at once rather than wait for someone. A room on
 * another map than the address says loads the page again on the room's. Two
 * to a side (D-127): `&size=2` from the room's first page (four pages, two a
 * side), `&side=kiln|tide` to pick one. Watching: `&watch=kiln|tide|all`.
 */
async function main() {
  const params = new URLSearchParams(location.search);
  const map = mapOf(params.get("map")) ?? MAPS[DEFAULT_MAP]!;
  if (!params.get("room")) {
    params.set("room", await quickRoom({ map: map.id }, RTS_LOBBY).catch(() => "presidio")); // no lobby (an old server): a room by name
    params.set("map", map.id);
    history.replaceState(null, "", `?${params}`);
  }
  await startRts({
    canvas: document.getElementById("view") as HTMLCanvasElement,
    map,
    room: params.get("room")!,
    name: params.get("name"),
    vs: params.get("vs") === "bot" ? "bot" : "any",
    size: params.get("size") === "2" ? 2 : 1,
    side: TEAMS.find((t) => t === params.get("side")),
    watch: WATCHES.find((w) => w === params.get("watch")),
    onMap: (id) => {
      if (!mapOf(id)) return; // a map this page doesn't know: it stays
      params.set("map", id);
      location.replace(`?${params}`);
    },
  });
}

main().catch((e: unknown) => {
  console.error(e);
  const ui = document.getElementById("ui");
  if (ui) ui.textContent = `error: ${String(e)}`;
});
