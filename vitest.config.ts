import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "tools/**/*.test.mjs"],
    environment: "node",
    // tests that open a real world (multiplayer's traffic, big world and Fogfront) take 4–6 s on CI's runners
    testTimeout: 20_000,
  },
});
