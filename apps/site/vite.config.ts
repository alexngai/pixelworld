import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const page = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// pixelworld.site's own pages (D-142). `pnpm site:build` (build.mjs) puts the
// viewer (/view/), the game (/play/) and the world packages (/<world>/) beside
// them; the dev server has the pages alone, so their links into those 404.
export default defineConfig({
  appType: "mpa",
  publicDir: false,
  server: { port: 5190, strictPort: true },
  preview: { port: 4190, strictPort: true },
  build: {
    rolldownOptions: {
      input: { index: page("index.html"), worlds: page("worlds/index.html"), games: page("games/index.html") },
    },
  },
});
