import { defineConfig } from "@playwright/test";

const PORT = 5199;

/**
 * Golden-image and behaviour tests for the baked renderer. Rendering uses
 * SwiftShader (software WebGL2) so results are reproducible without a GPU.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
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
  webServer: {
    command: `pnpm --filter @pixelworld/web exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
