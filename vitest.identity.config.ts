import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.toml" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "test",
          AUTH_ORIGIN: "https://identity.example.test",
          AUTH_SECRET: "identity-tests-only-not-a-production-secret-32-bytes",
          ACCESS_OWNER_EMAIL: "owner@example.test",
          INTERNAL_AUTH_SECRET: "test-only-internal-secret",
          CHAT_MODEL: "test-chat",
          BACKGROUND_MODEL: "test-background",
          BATCH_MODEL: "test-batch",
        },
      },
    }),
  ],
  test: {
    include: ["tests/identity/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
