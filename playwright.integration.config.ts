import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/integration",
  outputDir: "./test-results/integration",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "worker-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "worker-mobile", use: { ...devices["Pixel 7"] } },
  ],
});
