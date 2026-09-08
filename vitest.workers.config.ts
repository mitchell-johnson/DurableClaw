import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.toml" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "test",
          AGENT_TOKEN: "test-only-token",
          INTERNAL_AUTH_SECRET: "test-only-internal-secret",
          CHAT_MODEL: "test-chat",
          BACKGROUND_MODEL: "test-background",
          BATCH_MODEL: "test-batch",
        },
      },
    }),
  ],
  test: {
    include: ["tests/workers/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
