import { defineConfig } from "vite";
import { modernFonts } from "./scripts/font-assets.mjs";

export default defineConfig({
  plugins: [modernFonts()],
  optimizeDeps: { entries: ['index.html'] },
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/.tmp/**'] } },
  build: { target: "es2022", rollupOptions: { input: { main: "index.html", settings: "settings.html" } } },
});
