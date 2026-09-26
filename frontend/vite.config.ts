import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In development, proxy the API to ebpflens-server (override with EBPFLENS_API)
const api = process.env.EBPFLENS_API ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../internal/webui/dist",
    emptyOutDir: false, // keep .gitkeep
  },
  server: {
    proxy: { "/api": api },
  },
});
