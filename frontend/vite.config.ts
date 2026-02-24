import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json to get version
const packageJson = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
const frontendVersion = packageJson.version || 'unknown';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __FRONTEND_VERSION__: JSON.stringify(frontendVersion),
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  build: {
    rollupOptions: {
      output: {
        // Split vendor code for better caching (vendor changes less than app code)
        // Lazy loading handles app code splitting, this handles dependencies
        manualChunks(id) {
          if (!id.includes('node_modules')) return;

          // Only core React packages (exact names) to avoid circular chunk:
          // e.g. "react-file-icon" must stay in vendor, not react-vendor
          if (
            /node_modules[/\\]react[/\\]/.test(id) ||
            /node_modules[/\\]react-dom[/\\]/.test(id) ||
            /node_modules[/\\]scheduler[/\\]/.test(id)
          ) {
            return 'react-vendor';
          }

          return 'vendor';
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
  server: {
    proxy: {
      // Proxy API requests to the backend
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
      // Proxy Share routes (from your git diff: app.use('/s', shareRoutes))
      '/s': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
