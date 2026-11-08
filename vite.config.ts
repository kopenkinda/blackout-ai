import { defineConfig } from "vite";

export default defineConfig({
  base: "/slop-blackout/",
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
