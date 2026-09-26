import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 開発時は API を ebpflens-server に転送する(EBPFLENS_API で変更可)
const api = process.env.EBPFLENS_API ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../internal/webui/dist",
    emptyOutDir: false, // .gitkeep を残す
  },
  server: {
    proxy: { "/api": api },
  },
});
