import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "fs";
import { join } from "path";

// Read package.json to get version
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "package.json"), "utf-8"),
);
const frontendVersion = packageJson.version || "unknown";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __FRONTEND_VERSION__: JSON.stringify(frontendVersion),
  },
  optimizeDeps: {
    exclude: ["lucide-react"],
  },
  server: {
    proxy: {
      // Proxy API requests to the backend
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        secure: false,
      },
      // Proxy Share routes (from your git diff: app.use('/s', shareRoutes))
      "/s": {
        target: "http://localhost:3000",
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
