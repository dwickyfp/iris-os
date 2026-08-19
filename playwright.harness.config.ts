import { defineConfig, devices } from "@playwright/test";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const baseURL = required("NEXT_PUBLIC_BASE_URL");
const reportDir = required("HARNESS_REPORT_DIR");
const port = new URL(baseURL).port;

export default defineConfig({
  testDir: "./tests/harness",
  outputDir: `${reportDir}/artifacts`,
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: `${reportDir}/html`, open: "never" }],
    ["json", { outputFile: `${reportDir}/results.json` }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "desktop-chromium",
      dependencies: ["setup"],
      testMatch: /harness\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "pixel-chromium",
      dependencies: ["setup"],
      testMatch: /harness\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    command: `pnpm exec next start --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
