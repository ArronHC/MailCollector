import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: frontendDirectory,
  plugins: [react()],
  build: {
    outDir: path.resolve(frontendDirectory, "../public"),
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000"
    }
  }
});
