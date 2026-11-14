// Builds the publishable `@pixelworlds/multiplayer` into dist/ (D-112): the room
// client for pages (`pixelworld` stays an external peer; it uses only its types)
// and the relay for Node (`ws` stays a dependency).
// Run: pnpm --filter @pixelworlds/multiplayer build (`pnpm pack` runs it too, as prepack).
import { copyFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const common = { format: ["esm"], target: "es2022", outDir: here("./dist/"), clean: false, sourcemap: true, splitting: false };

await rm(here("./dist/"), { recursive: true, force: true });
await Promise.all(["LICENSE-MIT", "LICENSE-APACHE"].map((f) => copyFile(here("../../" + f), here(f))));
await build({ ...common, platform: "browser", entry: { index: here("src/index.ts") }, external: [/^pixelworld(\/|$)/], dts: true });
await build({ ...common, platform: "node", entry: { server: here("src/server.ts") }, external: ["ws"], dts: true });
await build({ ...common, platform: "neutral", entry: { testing: here("src/testing.ts") }, dts: true });

const files = await readdir(here("./dist/"));
for (const f of ["index.js", "index.d.ts", "server.js", "server.d.ts", "testing.js", "testing.d.ts"]) if (!files.includes(f)) throw new Error(`dist/${f} is missing`);
