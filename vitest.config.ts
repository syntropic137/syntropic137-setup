import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Points CODEX_HOME away from this machine's Codex login (#92).
    setupFiles: ["./vitest.setup.ts"],
  },
});
