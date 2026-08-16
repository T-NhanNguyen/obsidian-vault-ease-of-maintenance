import esbuild from "esbuild";
import fs from "fs";
import process from "process";

const prod = process.argv[2] === "production";

// ---------------------------------------------------------------------------
// Worker bundle plugin — builds src/indexer/db_worker/worker.ts as a
// self-contained IIFE (sql.js inlined) and exposes it to the main bundle as
// the virtual module "@worker-bundle" (a string). At runtime the browser
// channel spawns `new Worker(URL.createObjectURL(new Blob([WORKER_BUNDLE])))`
// — no extra shipped asset, no path resolution for the worker code.
// ---------------------------------------------------------------------------

const workerBundlePlugin = {
  name: "worker-bundle",
  setup(build) {
    build.onResolve({ filter: /^@worker-bundle$/ }, () => ({
      path: "worker-bundle",
      namespace: "worker-bundle",
    }));
    build.onLoad({ filter: /.*/, namespace: "worker-bundle" }, async () => {
      const result = await esbuild.build({
        entryPoints: ["src/indexer/db_worker/worker.ts"],
        bundle: true,
        write: false,
        format: "iife",
        target: "es2020",
        minify: prod,
        logLevel: "silent",
      });
      const code = result.outputFiles[0].text;
      return {
        contents: `export const WORKER_BUNDLE = ${JSON.stringify(code)};`,
        loader: "js",
      };
    });
  },
};

// Copies the sql.js wasm asset next to main.js. The browser channel reads it
// from the plugin dir through the vault adapter at runtime.
const copyWasmPlugin = {
  name: "copy-sql-wasm",
  setup(build) {
    build.onEnd(() => {
      fs.copyFileSync("node_modules/sql.js/dist/sql-wasm.wasm", "sql-wasm.wasm");
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "fs",
    "path",
    "crypto",
    "os",
    "util",
    "stream",
    "buffer",
    "events",
    // sql.js runs only inside the worker bundle (inlined there) or in Node
    // (in-process channel, tests). The main bundle never executes it, so it
    // stays external to keep main.js small.
    "sql.js",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  loader: { ".md": "text" },
  plugins: [workerBundlePlugin, copyWasmPlugin],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
