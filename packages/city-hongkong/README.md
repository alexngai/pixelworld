# @pixelworlds/city-hongkong

Hong Kong's city pack for [pixelworld](https://www.npmjs.com/package/pixelworld): the generators its `hongkong` style pack names. They draw Kowloon's tenements of the 1950s and 60s in rows, pastel and white mosaic, with balconies of railings, laundry and air conditioners over shops under their signboards (`tongLau`); the slender composite buildings over shops, a dense grid of small windows and air conditioners, and the malls and podiums under their sign bands (`compositeTower`); the slim residential towers of bay windows under a crown (`pencilTower`); the neon signs that hang over the street from both sides, on steel frames drawn in one-pixel lines (`neonSign`); and two landmark shapes of Tsim Sha Tsui's waterfront: a windowless hall under a curved roof, the Hong Kong Cultural Centre's type (`curvedRoofHall`), and a grand hotel with its tower behind, The Peninsula's type (`grandHotel`). The `hongkong` pack names San Francisco's pack too, `@pixelworlds/city-sf`, for its blocks and commercial towers, so load both.

```sh
npm install pixelworld @pixelworlds/city-sf @pixelworlds/city-hongkong
```

`pixelworld` is a peer dependency: the pack uses your app's copy of its generator registry.

```ts
import { cityPlugin as sanFrancisco } from "@pixelworlds/city-sf";
import { cityPlugin as hongKong } from "@pixelworlds/city-hongkong";

const view = await createWorldView({ canvas, worldUrl: "/worlds/hongkong-walk/", style, plugins: [sanFrancisco, hongKong] });
```

Without a view (tests, tools), `register()` registers the generators on the current thread. How plugins work: [docs/plugins.md](https://github.com/alexngai/pixelworld/blob/main/docs/plugins.md) §9. The look: [docs/style-guide.md](https://github.com/alexngai/pixelworld/blob/main/docs/style-guide.md) §23.

## Licence

MIT OR Apache-2.0.
