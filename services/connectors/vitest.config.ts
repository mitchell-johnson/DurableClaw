import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: fileURLToPath(
          new URL("./wrangler.test.jsonc", import.meta.url),
        ),
      },
      miniflare: {
        bindings: {
          CONNECTOR_AUTH_SECRET:
            "test-only-connector-auth-with-at-least-32-bytes",
          CONNECTOR_CREDENTIALS_SECRET:
            "test-only-encryption-with-at-least-32-bytes",
          GOOGLE_CLIENT_ID: "test-google-client",
          GOOGLE_CLIENT_SECRET: "test-google-secret",
          GOOGLE_REDIRECT_URI:
            "https://app.example/api/connectors/google/callback",
        },
      },
    }),
  ],
  test: {
    include: ["services/connectors/tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
