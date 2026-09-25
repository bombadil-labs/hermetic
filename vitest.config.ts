import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against @bombadil/hermetic's source, never a stale build of it.
    alias: [{ find: /^@bombadil\/hermetic$/, replacement: fileURLToPath(new URL("./packages/hermetic/src/index.ts", import.meta.url)) }],
  },
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    setupFiles: ["packages/eslint-plugin-hermetic/tests/setup.ts"],
  },
});
