import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// En développement, les appels /api sont envoyés au serveur local (port 8080).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8080" } },
});
