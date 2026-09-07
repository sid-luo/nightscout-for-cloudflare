import { createRequire } from "node:module";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const TEST_API_SECRET = "nscf-test-secret-20260717";

// Seed the disposable local authorization value for the test runtime.
(process.env as Record<string, string | undefined>).API_SECRET ??= TEST_API_SECRET;

export default defineConfig({
  // Match PostCSS require() resolution: the Workers test runner otherwise
  // selects nanoid's ESM export and source-map-js's empty browser export.
  resolve: {
    alias: {
      "nanoid/non-secure": createRequire(import.meta.url).resolve("nanoid/non-secure"),
      "source-map-js": createRequire(import.meta.url).resolve("source-map-js"),
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          API_SECRET: TEST_API_SECRET,
          AUTH_DEFAULT_ROLES: "readable",
          AUTH_FAIL_DELAY: "1",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // The API3 contract files intentionally exercise many Durable Object
    // transactions. Under full-suite worker contention they can exceed
    // Vitest's five-second default despite passing quickly in isolation.
    testTimeout: 15_000,
  },
});
