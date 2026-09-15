import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  base: mode === "demo" ? "/zongpu/" : "/",
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3000" } },
  build: { chunkSizeWarningLimit: 850 },
}));
