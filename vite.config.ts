import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: { entries: ['index.html'] },
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/.tmp/**'] } },
  build: { target: "es2022" },
});
