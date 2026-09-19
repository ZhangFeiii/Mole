const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.cjs",
  workers: 1,
  timeout: 45000,
  reporter: [["list"]],
  outputDir: "test-results",
});
