// Real Chromium for PRIVATE-APP BROWSER ACCESS from an owner-selected frontend (work/private-browser-access-interface.txt).
// Separate from playwright.config.mjs: no relay, no anvil, no global setup. Each spec starts its own local world:
// the ACTUAL supervisor.js (test/helpers/private-app-supervisor.mjs) behind a local TLS front, and an owner frontend
// origin. Names resolve to 127.0.0.1 only through Chromium's host-resolver rules; every other request is aborted and
// recorded by the spec.
//   npx playwright test -c private-access.config.mjs        (from e2e/, through the shared test queue)
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./private-access",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: "list",
  use: { browserName: "chromium", reducedMotion: "reduce", trace: "retain-on-failure" },
});
