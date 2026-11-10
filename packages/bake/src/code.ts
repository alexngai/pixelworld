/** Set where the engine is built or served: the npm build's define, or the apps' Vite plugin (tools/bake-code.mjs). */
declare const __PIXELWORLD_BAKE_CODE__: string | undefined;

/**
 * The bake code's identity (D-072): a hash of the source of everything that
 * turns a world package and a style into tile pixels (the baker and its
 * shaders, the built-in generators, the bake host, the world format's
 * decoding, the engine's bake init), computed where the code is built
 * (packages/pixelworld/build.mjs) or served (tools/bake-code.mjs). Persistent
 * tile caches key on it, so any change to that code makes old tiles
 * unreachable; it replaces the hand-bumped `BAKE_VERSION`.
 *
 * Null where neither set it (a bundler without the plugin, tests): the engine
 * then keeps no tiles in IndexedDB, rather than risk drawing stale ones.
 */
export const BAKE_CODE: string | null = typeof __PIXELWORLD_BAKE_CODE__ === "string" ? __PIXELWORLD_BAKE_CODE__ : null;
