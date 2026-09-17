import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const localBackend = env.VITE_LOCAL_BACKEND === "true";
  const localProxy = localBackend
    ? { "/api": { target: "http://127.0.0.1:8000", changeOrigin: false } }
    : undefined;

  return {
    plugins: [react(), tailwindcss()],
    define: { global: "globalThis" },
    server: { host: "127.0.0.1", port: localBackend ? 5174 : undefined, strictPort: localBackend, proxy: localProxy },
    preview: { host: "127.0.0.1", port: localBackend ? 5174 : undefined, strictPort: localBackend, proxy: localProxy },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
