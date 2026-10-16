import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { reactFlowTimingPlugin } from "./benchmark-react-flow-timing";
export default defineConfig({ plugins: [react(), ...(process.env.NODAL_BENCH_PROFILE === "1" ? [reactFlowTimingPlugin()] : [])], resolve: { alias: process.env.NODAL_BENCH_PROFILE === "1" ? { "react-dom/client": "react-dom/profiling" } : {} }, define: { "import.meta.env.NODAL_BENCH_PROFILE": JSON.stringify(process.env.NODAL_BENCH_PROFILE === "1") }, build: { outDir: process.env.NODAL_BENCH_OUT ?? "dist/benchmark", emptyOutDir: true, rolldownOptions: { input: "diagram-benchmark.html" } }, preview: { host: "127.0.0.1", port: 1421, strictPort: true } });
