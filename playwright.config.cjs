const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  // Game phases are real time even at TIMER_SCALE=0.2 (up to ~21s/cycle).
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
  },
  // Reuses an already-running server; otherwise starts one with fast timers.
  webServer: {
    command: "npm run start:test",
    url: "http://localhost:3000/health",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
