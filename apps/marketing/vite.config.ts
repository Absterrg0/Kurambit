import { defineConfig } from "vite-plus";

// GitHub Pages serves the site under /<repo>/, so the base comes from the deploy.
export default defineConfig({
  base: process.env.MARKETING_BASE ?? "/",
  build: { outDir: "dist" },
});
