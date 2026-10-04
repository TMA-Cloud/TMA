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
    rolldownOptions: {
      output: {
        // Split vendor code for better caching (vendor changes less than app code)
        // Lazy loading handles app code splitting, this handles dependencies
        codeSplitting: {
          groups: [
            // Only core React packages (exact names) to avoid circular chunk:
            // other "react-*" packages must stay in vendor, not react-vendor
            {
              name: 'react-vendor',
              test: /node_modules[/\\](react|react-dom|scheduler)[/\\]/,
              priority: 20,
            },
            { name: 'vendor', test: /node_modules[/\\]/, priority: 10 },
          ],
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
      // Proxy Share routes: use '/s/' so we don't accidentally
      // proxy '/src/*' (which should be handled by Vite itself)
      '/s/': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
