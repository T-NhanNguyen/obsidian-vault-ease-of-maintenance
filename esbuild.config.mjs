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

// Embeds the sql.js wasm into the main bundle as base64 (zkdavis
// obsidian-smart-vault pattern). esbuild's native `.wasm` binary loader
// can't be used here: the `sql.js` entry in `external` cascades to its
// subpaths, so `sql.js/dist/sql-wasm.wasm` would stay external (a runtime
// require — the 1.3.0 store failure again: the store ships only
// main.js / manifest.json / styles.css). This plugin resolves the import
// BEFORE the external check and inlines the bytes directly, so store
// installs are fully self-sufficient. See src/indexer/embedded_wasm.ts.
const embeddedWasmPlugin = {
  name: "embedded-wasm",
  setup(build) {
    build.onResolve({ filter: /^sql\.js\/dist\/sql-wasm\.wasm$/ }, () => ({
      path: "sql.js/dist/sql-wasm.wasm",
      namespace: "embedded-wasm",
    }));
    build.onLoad({ filter: /.*/, namespace: "embedded-wasm" }, async () => {
      const base64 = fs
        .readFileSync("node_modules/sql.js/dist/sql-wasm.wasm")
        .toString("base64");
      return { contents: `export default ${JSON.stringify(base64)};`, loader: "js" };
    });
  },
};

// Copies the sql.js wasm asset next to main.js for dev / zip / manual
// installs and for the GitHub release asset set (build-plugin.sh and
// release.yml copy it). The RUNTIME no longer needs it — the main bundle
// embeds the wasm as base64 (embeddedWasmPlugin above) so store installs
// work — but keeping the file preserves the existing four-file install
// contract.
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
  // The sql.js wasm is EMBEDDED in the main bundle (base64) — the Obsidian
  // community store installer fetches only main.js / manifest.json /
  // styles.css, so a disk-based wasm asset can never reach store installs.
  // See embeddedWasmPlugin above + src/indexer/embedded_wasm.ts. The WORKER
  // bundle (workerBundlePlugin, separate esbuild pass) deliberately has NO
  // wasm handling: it receives the bytes over postMessage and must not
  // double-encode them through the Blob string.
  loader: { ".md": "text" },
  plugins: [workerBundlePlugin, embeddedWasmPlugin, copyWasmPlugin],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
