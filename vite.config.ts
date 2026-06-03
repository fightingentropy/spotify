import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { fileURLToPath, URL } from "node:url";

function offlineAssetsManifest(): Plugin {
  return {
    name: "spotify-offline-assets-manifest",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = Object.values(bundle)
        .map((entry) => entry.fileName)
        .filter((fileName) => fileName.startsWith("assets/") && !fileName.endsWith(".map"))
        .map((fileName) => `/${fileName}`)
        .sort();

      this.emitFile({
        type: "asset",
        fileName: "offline-assets.json",
        source: `${JSON.stringify({ files: Array.from(new Set(files)) }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), cloudflare(), offlineAssetsManifest()],
  legacy: {
    skipWebSocketTokenCheck: true,
  },
  server: {
    port: 5174,
    strictPort: true,
    hmr: {
      protocol: "ws",
      host: "127.0.0.1",
      port: 5175,
      clientPort: 5175,
    },
  },
  preview: {
    port: 5174,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
