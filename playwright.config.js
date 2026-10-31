import { defineConfig } from '@playwright/test';

export default defineConfig({
 testDir: './e2e',
 timeout: 60000,
 workers: 1,
 retries: 0,
 use: { baseURL: 'http://localhost:8790', trace: 'retain-on-failure' },
 webServer: {
  command: 'npx wrangler d1 migrations apply uat --config wrangler.dev.jsonc --local --persist-to .wrangler-e2e && npx wrangler dev --config wrangler.dev.jsonc --local --persist-to .wrangler-e2e --port 8790',
  url: 'http://localhost:8790/',
  reuseExistingServer: false,
  timeout: 120000
 }
});
