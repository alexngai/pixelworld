# @pixelworlds/city-paris

Paris's city pack for [pixelworld](https://www.npmjs.com/package/pixelworld): the generators its `paris` style pack names. They draw Haussmann blocks with continuous iron balconies on the second and fifth storeys under zinc mansards with dormers (`haussmann`), the faubourg's narrow plastered houses under steep roofs (`faubourg`), the brick social-housing blocks of the 1920s and 30s (`hbm`), and five landmark shapes on the proportions of Paris's landmarks: a Gothic cathedral (`cathedral`), a triumphal arch (`triumphalArch`), a lattice tower on four arched piers (`latticeArchTower`), an opera house (`operaHouse`) and a steel arch bridge with gilt-crowned pylons (`steelArchBridge`). The `paris` pack names San Francisco's pack too, `@pixelworlds/city-sf`, for its post-war blocks and towers, so load both.

Not published yet (D-085). In this repository the viewer, the example game and the model preview load it.

```ts
import { cityPlugin as sanFrancisco } from "@pixelworlds/city-sf";
import { cityPlugin as paris } from "@pixelworlds/city-paris";

const view = await createWorldView({ canvas, worldUrl: "/worlds/paris-walk/", style, plugins: [sanFrancisco, paris] });
```

Without a view (tests, tools), `register()` registers the generators on the current thread. How plugins work: [docs/plugins.md](https://github.com/alexngai/pixelworld/blob/main/docs/plugins.md) §9. The look: [docs/style-guide.md](https://github.com/alexngai/pixelworld/blob/main/docs/style-guide.md) §20.

## Licence

MIT OR Apache-2.0.
