import { defineConfig } from "@playwright/test";

/**
 * Ports: every server a run starts comes from PW_PORT, so two checkouts run
 * side by side on different PW_PORTs without sharing a server:
 *   the viewer (apps/web, also the model preview)  PW_PORT (default 5199)
 *   the editor (apps/editor, e2e/editor.spec.ts)   PW_PORT − 1, or PW_EDITOR_PORT
 *   the game (apps/game, e2e/game.spec.ts)         PW_PORT − 2, or PW_GAME_PORT
 */
const PORT = Number(process.env.PW_PORT ?? 5199);
export const EDITOR_PORT = Number(process.env.PW_EDITOR_PORT ?? PORT - 1);
export const GAME_PORT = Number(process.env.PW_GAME_PORT ?? PORT - 2);

/**
 * The servers, each started by tools/e2e-server.mjs, which marks its responses
 * with the checkout it serves; e2e/global-setup.ts checks every one is this
 * checkout's. A server already on a port is an error, unless PW_REUSE=1 (then
 * it is reused if it is this checkout's, for example one left running with
 * `node tools/e2e-server.mjs web 5199`).
 */
export const SERVERS = [
  { app: "web", port: PORT },
  { app: "editor", port: EDITOR_PORT }, // its /api is mocked per test
  { app: "game", port: GAME_PORT },
] as const;

/**
 * Golden-image and behaviour tests for the baked renderer. Rendering uses
 * SwiftShader (software WebGL2) so results are reproducible without a GPU.
 * Tests are independent, so CI shards them (`--shard`, .github/workflows/ci.yml);
 * one worker by default, since software rendering takes every core it gets.
 * `@smoke` tags a quick subset over every app: `pnpm test:e2e:smoke`.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 240_000,
  fullyParallel: true,
  workers: Number(process.env.PW_WORKERS ?? 1),
  // CI writes a blob report per shard, merged into one HTML report afterwards
  reporter: process.env.CI ? [["list"], ["blob"]] : [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  snapshotPathTemplate: "e2e/__screenshots__/{testFileName}/{arg}{ext}",
  expect: {
    timeout: 120_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled" },
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
    deviceScaleFactor: 1,
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: SERVERS.map(({ app, port }) => ({
    command: `node tools/e2e-server.mjs ${app} ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: process.env.PW_REUSE === "1",
    timeout: 60_000,
  })),
});
