
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/rialo-rpc": {
        target: "https://devnet.rialo.io:4101",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/rialo-rpc/, ""),
      },
    },
  },
});
