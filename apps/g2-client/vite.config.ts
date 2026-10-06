import { defineConfig } from 'vite'

export default defineConfig({
  // Keep device and agent settings in the repository-level, gitignored .env.
  envDir: '../../',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
})

