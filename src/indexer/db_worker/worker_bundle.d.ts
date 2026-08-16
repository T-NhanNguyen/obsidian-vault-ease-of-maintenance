// Ambient declaration for the build-time virtual module "@worker-bundle".
// esbuild's worker-bundle plugin resolves it to a JS module exporting the
// worker bundle as a string; vitest aliases it to a stub (see vitest.config.ts).
declare module "@worker-bundle" {
  export const WORKER_BUNDLE: string;
}
