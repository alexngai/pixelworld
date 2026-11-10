# @pixelworlds/city-sf

San Francisco's city pack for [pixelworld](https://www.npmjs.com/package/pixelworld): the generators its `bay-area` style pack names. They draw the Victorian, Edwardian and stucco rows (`rowhouse`), apartment blocks, Chinatown and the piers (`block`), the towers by era (`decoTower`, `sfTower`), and Chinatown's gate and lanterns. Without it, a San Francisco world bakes no tiles that hold those buildings.

## Install

```sh
npm install pixelworld @pixelworlds/city-sf
```

`pixelworld` is a peer dependency: the pack uses your app's copy of its generator registry.

## Use

```ts
import { createWorldView } from "pixelworld/engine";
import { cityPlugin } from "@pixelworlds/city-sf";

const view = await createWorldView({
  canvas,
  worldUrl: "/worlds/sf/",
  style: (id) => fetch(`/styles/${id}/style.json`).then((r) => r.json()), // bay-area
  plugins: [cityPlugin],
});
```

- **`cityPlugin`** is a descriptor, `{ name, url, version }`. Its `url` is `new URL("./worker.js", import.meta.url)`: the pack's worker module, which the bake worker imports before its first bake. Vite and webpack 5 copy it into your build with no configuration.
- **Without a bundler** (an import map, or a CDN that rewrites bare imports), map `pixelworld/generators` too: the entry imports it.
- **Without a view** (tests, tools), register the generators on the current thread with `register()`.
- **Several packs, chosen by the world:** pass a function. It gets the plugins the world's style pack names: `plugins: (names) => names.flatMap((n) => (n === cityPlugin.name ? [cityPlugin] : []))`.

How plugins work, and how to make a city pack of your own: [docs/plugins.md](https://github.com/alexngai/pixelworld/blob/main/docs/plugins.md) §9.

## Licence

MIT OR Apache-2.0. The `bay-area` style pack is CC BY 4.0, and San Francisco's world packages are ODbL 1.0; both are in the [repository](https://github.com/alexngai/pixelworld).
