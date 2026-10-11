import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_PORT = Number(process.env.CE_API_PORT ?? "3001");
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: API_ORIGIN } } },
  preview: { proxy: { "/api": { target: API_ORIGIN } } },
});
