# @pixelworlds/tactics

What a turn-based tactics game on pixelworld's real cities draws and reads, beside the engine's edits (D-124, D-147) and boards (D-148), in D-149:

- **`BoardOverlay`**: a board's marks, grid and arrows, as a runtime layer.
- **Models**: units (`pumper`, `crane`, `wrecker`, `drone`, `crawler`, `brute`, `flyer`) and effects (`fire`, `smoke`, `rubble`, `jet`, `blast`) as entity boxes, coloured from any city's palette (`rampsFor`, `entityModel`).
- **`objectInfo`**: a building's storeys, floor area, use, material, occupants, flammability and strength.

```ts
import { Boards, CELL_WALL, toWorld } from "@pixelworlds/engine";
import { BoardOverlay, entityModel, objectInfo, rampsFor } from "@pixelworlds/tactics";

const boards = new Boards(view);
const board = await boards.add({ x0, y0, w: 16, h: 16, cell: 1 });
const overlay = new BoardOverlay(board);
await view.layers.add(overlay);
boards.onChange((b) => b === board && overlay.changed());
overlay.setMarks([{ i: 3, j: 4, kind: "move" }]);

const ramps = rampsFor(view.world.palette.rampIds);
const k = 4 * board.w + 3;
const { x, y } = toWorld(board, { x: 3.5, y: 4.5 });
view.entities.add({ model: entityModel("pumper", ramps, { scale: board.cell }), x, y, h: board.flags[k]! & CELL_WALL ? board.top[k]! : board.height[k]! });

const hit = view.query.pickObject(px, py);
const info = hit ? objectInfo(view.query.object(hit.index)!, { metersPerCell: 10 }) : null;
if (hit) view.edits.remove([hit.index]); // every board over it follows
view.edits.cells([{ x: 40, y: 12, surface: "rock" }]); // scorched
```

The sandbox: `pnpm --filter @pixelworlds/tactics demo`, then http://localhost:5290 (`?world=kyoto-walk`, `sf-walk`, `paris-walk`, `tokyo-walk`, `hongkong-walk`).
