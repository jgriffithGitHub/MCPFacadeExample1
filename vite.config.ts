// Builds each browser page into one self-contained HTML file in dist/.
// Run once per page with INPUT set (see the build:* scripts in package.json):
//   host/index.html    -> dist/host/index.html     (the two-pane host page)
//   host/sandbox.html  -> dist/host/sandbox.html   (outer iframe proxy)
//   view/monitor.html  -> dist/view/monitor.html   (the MCP App view the facade serves)
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const INPUT = process.env.INPUT;
if (!INPUT) {
  throw new Error("INPUT environment variable is not set");
}

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    sourcemap: "inline",
    minify: false,
    rollupOptions: { input: INPUT },
    outDir: "dist",
    emptyOutDir: false,
  },
});
