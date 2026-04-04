import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
  test: {
    globals: true,
    environment: "node",
    server: {
      deps: {
        inline: ["@ohcnetwork/leaderboard-api"],
      },
    },
  },
});
