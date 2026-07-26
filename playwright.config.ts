import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = 3107;
const baseURL = `http://127.0.0.1:${port}`;

/**
 * Browser-test-only credentials. The app secret only has to agree with the signature the launch
 * spec computes, and the token file is deliberately outside the working copy so a run cannot
 * write over a developer's own local ikas tokens.
 */
export const E2E_CLIENT_SECRET = "playwright-app-secret-not-a-real-credential";
export const E2E_TOKEN_STORE_FILE = path.join(tmpdir(), "playwright-ikas-tokens.json");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `./node_modules/.bin/next dev --webpack --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      SECRET_COOKIE_PASSWORD: Array.from({ length: 2 }, () => "playwright-local-only").join("-"),
      NEXT_PUBLIC_DEPLOY_URL: baseURL,
      IKAS_TOKEN_STORE_DRIVER: "file",
      IKAS_TOKEN_STORE_FILE: E2E_TOKEN_STORE_FILE,
      NEXT_PUBLIC_CLIENT_ID: "playwright-client-id",
      CLIENT_SECRET: E2E_CLIENT_SECRET,
    },
  },
});
