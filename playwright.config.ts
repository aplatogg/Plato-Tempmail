import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./tests/e2e/.results",
  fullyParallel: true,
  workers: 2,
  timeout: 20000,
  expect: { timeout: 5000 },
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:8788", trace: "retain-on-failure" },
  projects: [
    {
      name: "desktopchromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    { name: "mobilechromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node tests/static-server.mjs",
    url: "http://127.0.0.1:8788/__ready",
    reuseExistingServer: false,
    timeout: 15000,
  },
});
