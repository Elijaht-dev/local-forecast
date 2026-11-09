import { defineConfig } from "vite";

export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "custom_components/local_forecast/frontend",
    emptyOutDir: true,
    target: "es2022",
    lib: { entry: "src/lab.ts", formats: ["es"], fileName: () => "forecast-lab.js" },
    minify: "esbuild",
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
