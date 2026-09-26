import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against @bombadil/hermetic's source, never a stale build of it.
    alias: [
      { find: /^@bombadil\/hermetic$/, replacement: fileURLToPath(new URL("./packages/hermetic/src/index.ts", import.meta.url)) },
      { find: /^@bombadil\/hermetic\/inject$/, replacement: fileURLToPath(new URL("./packages/hermetic/src/inject.ts", import.meta.url)) },
      { find: /^@bombadil\/hermetic\/doctest$/, replacement: fileURLToPath(new URL("./packages/hermetic/src/doctest.ts", import.meta.url)) },
      { find: /^@bombadil\/hermetic\/record$/, replacement: fileURLToPath(new URL("./packages/hermetic/src/record.ts", import.meta.url)) },
    ],
  },
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    // Each test file runs in a process of its own. Keep it that way:
    // confine.test.ts calls lockdown(), which freezes the built-ins for the rest of its process.
    isolate: true,
    setupFiles: ["packages/eslint-plugin-hermetic/tests/setup.ts"],
  },
});
