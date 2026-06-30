import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite builds a static SPA. The desktop shell loads the result via
// QWebEngineView using a `file://` URL, so we must keep asset paths
// relative.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
  },
});
