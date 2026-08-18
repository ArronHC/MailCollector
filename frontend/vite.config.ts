import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.resolve(frontendDirectory, "../package.json"), "utf8")) as { version: string };

export default defineConfig({
  root: frontendDirectory,
  plugins: [react()],
  define: {
    __MAIL_COLLECTOR_VERSION__: JSON.stringify(packageJson.version)
  },
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
