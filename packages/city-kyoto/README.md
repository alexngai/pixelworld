# @pixelworlds/city-kyoto

Kyoto's city pack for [pixelworld](https://www.npmjs.com/package/pixelworld): the generators its `kyoto` style pack names. They draw the machiya, narrow and deep under a gabled roof of grey tile, with its lattice front, the pent roof over the ground floor and the slit windows (mushiko-mado) of its low upper storey, and the wooden town houses after it (`machiya`); the white storehouses with their namako skirts (`kura`); concrete utility poles (`utilityPole`); the modest modern blocks of the wide streets, flats with balconies or offices and shops with flush signs, some with a rim of tile (`midrise`); temple and shrine halls on stone platforms under hip-and-gable roofs with deep eaves, and Kiyomizu-dera's main hall on its stage (`templeHall`); two-storey gates, a shrine's vermilion rōmon and a temple's sanmon (`towerGate`); pagodas of three or five storeys with their finials (`pagoda`); vermilion torii with stone lanterns (`torii`); a gilded three-storey pavilion by its pond, Kinkaku-ji's type (`goldenPavilion`); and a slender observation tower on its building, Kyoto Tower's type (`candleTower`).

Not published yet (D-090). In this repository the viewer, the example game and the model preview load it.

```ts
import { cityPlugin as kyoto } from "@pixelworlds/city-kyoto";

const view = await createWorldView({ canvas, worldUrl: "/worlds/kyoto-walk/", style, plugins: [kyoto] });
```

Without a view (tests, tools), `register()` registers the generators on the current thread. How plugins work: [docs/plugins.md](https://github.com/alexngai/pixelworld/blob/main/docs/plugins.md) §9. The look: [docs/style-guide.md](https://github.com/alexngai/pixelworld/blob/main/docs/style-guide.md) §21.

## Licence

MIT OR Apache-2.0.
