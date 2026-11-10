import { defineConfig } from "vite";

// The editor talks to the local pipeline server (`uv run pixelworld serve <region.yaml>`).
const API = process.env.PIXELWORLD_API ?? "http://127.0.0.1:8765";

export default defineConfig({
  server: { port: 5180, strictPort: true, proxy: { "/api": API } },
});
