import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Throwaway values per run; never real ones. Siteverify is mocked in the tests.
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          TURNSTILE_SITE_KEY: '1x00000000000000000000AA', // Cloudflare's public testing key
          TURNSTILE_SECRET_KEY: 'turnstile-test-secret',
          ADMIN_TOKEN: 'test-admin-token-0123456789abcdef0123',
        },
      },
    })),
  ],
  test: { setupFiles: ['./test/setup.ts'] },
});
