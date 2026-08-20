// @ts-check
const { defineConfig } = require("@playwright/test");

const channel = process.env.PLAYWRIGHT_CHANNEL || undefined;

module.exports = defineConfig({
  testDir: __dirname,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://127.0.0.1:${process.env.DSH_PORT || "3099"}`,
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    ...(channel ? { channel } : {}),
  },
});
