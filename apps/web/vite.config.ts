import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  /* Ports come from the environment, defaulting to the pair everything else in
     the repo assumes. Hardcoded, a second instance cannot exist: the proxy
     still points at the first instance's API, so a worktree checkout on a free
     web port quietly reads and WRITES the main checkout's task data. Three env
     vars is the difference between "run a branch beside the one you have open"
     and "stop the server you were using". */
  server: {
    host: true,
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.API_PORT ?? 4100}`,
        changeOrigin: true
      }
    }
  },
  resolve: {
    alias: {
      "@": "/src"
    }
  }
});
