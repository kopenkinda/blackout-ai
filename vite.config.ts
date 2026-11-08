import { defineConfig } from "vite";

export default defineConfig({
  base: "/blackout-ai/",
  build: {
    rollupOptions: {
      output: {
        advancedChunks: {
          groups: [{ name: "three", test: /[\\/]node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
});
