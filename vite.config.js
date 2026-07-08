import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: "public",
    emptyOutDir: false,
    assetsDir: "assets",
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replaceAll("\\", "/");
          if (!normalized.includes("/node_modules/")) return undefined;
          if (normalized.includes("lucide-react")) return "vendor-icons";
          if (
            normalized.includes("react-markdown") ||
            normalized.includes("remark-") ||
            normalized.includes("rehype-") ||
            normalized.includes("micromark") ||
            normalized.includes("unified") ||
            normalized.includes("mdast") ||
            normalized.includes("hast") ||
            normalized.includes("unist")
          ) {
            return "vendor-markdown";
          }
          if (normalized.includes("katex") || normalized.includes("highlight.js")) return "vendor-rich-text";
          if (
            normalized.includes("/node_modules/react/") ||
            normalized.includes("/node_modules/react-dom/") ||
            normalized.includes("/node_modules/scheduler/")
          ) {
            return "vendor-react";
          }
          return undefined;
        }
      }
    }
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787"
    }
  }
});
