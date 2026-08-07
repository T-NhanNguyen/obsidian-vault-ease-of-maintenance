// Test stub for the "obsidian" module.
//
// The obsidian npm package ships type definitions only (empty "main"), so
// vitest cannot resolve it. All plugin-only modules that touch the obsidian
// API at runtime (renderers, transport's requestUrl branch) are out of scope
// for the vitest suite — tests exercise the pure-logic graph. The stub makes
// imports resolvable and fails loudly if a test accidentally reaches a
// plugin-only path.

export function requestUrl(): never {
  throw new Error(
    "obsidian module is not available under vitest; the requestUrl branch is plugin-only"
  );
}

// No-op API surface so plugin-only modules (e.g. render-markdown.ts) can be
// imported in tests that exercise their pure helpers without touching DOM.
export class App {}

export class Component {}

export class MarkdownRenderer {
  static render(): Promise<void> {
    return Promise.resolve();
  }
}
