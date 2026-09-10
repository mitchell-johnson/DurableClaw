import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL(
        "./tests/support/cloudflare-workers.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["tests/workers/**", "tests/identity/**"],
    environment: "node",
  },
});
