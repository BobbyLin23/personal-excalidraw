import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    miniflare: {
      // The test pool's bundled workerd currently supports dates through August.
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DRAWINGS'],
      r2Buckets: ['FILES'],
      bindings: {
        MIGRATIONS: await readD1Migrations('./migrations'),
        BETTER_AUTH_SECRET: 'test-only-secret-at-least-thirty-two-characters',
        BETTER_AUTH_URL: 'https://drawings.example.com',
        AUTH_EMAIL: 'owner@example.com',
        RESEND_API_KEY: 'test-only-key',
        EMAIL_FROM: 'Drawings <login@example.com>',
      },
    },
  })],
  test: { include: ['tests/**/*.test.ts'] },
}));
