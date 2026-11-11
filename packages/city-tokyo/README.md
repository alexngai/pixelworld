# @pixelworlds/city-tokyo

Tokyo's city pack for [pixelworld](https://www.npmjs.com/package/pixelworld): the generators its `tokyo` style pack names. They draw the narrow mixed-use mid-rises of the entertainment districts under their stacked signs (`zakkyo`), apartment slabs with balconies across their fronts (`mansion`), small detached houses behind block walls (`kodate`), the landmark shapes `twinTowerHall`, `cylinderTower` and `myojinTorii`, and utility poles with the wires strung between them (`utilityPoles`, `wireSpan`). The `tokyo` pack names San Francisco's pack too, `@pixelworlds/city-sf`, for its blocks and towers, so load both. The pipeline half (PLATEAU's building facts and GSI's elevation tiles) is the Python distribution `pixelworld-city-jp`.

Not published yet (D-092). In this repository the viewer, the example game and the model preview load it.

```ts
import { cityPlugin as sanFrancisco } from "@pixelworlds/city-sf";
import { cityPlugin as tokyo } from "@pixelworlds/city-tokyo";

const view = await createWorldView({ canvas, worldUrl: "/worlds/tokyo-walk/", style, plugins: [sanFrancisco, tokyo] });
```

Without a view (tests, tools), `register()` registers the generators on the current thread. How plugins work: [docs/plugins.md](https://github.com/alexngai/pixelworld/blob/main/docs/plugins.md) §9. The look: [docs/style-guide.md](https://github.com/alexngai/pixelworld/blob/main/docs/style-guide.md) §21.

## Licence

MIT OR Apache-2.0.
