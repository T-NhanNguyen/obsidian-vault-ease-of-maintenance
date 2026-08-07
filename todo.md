# Plugin Review Triage — Todo (merged plan)

## Post-review feature (2026-08-05)

- [x] Chat sources are now clickable (`chat-review.ts`): click/keyboard opens the file in the main window (`workspace.openLinkText`) and jumps to the section (`MarkdownView.setEphemeralState({ line })` — `line_start` is 0-based, matches the editor). Row gets `.nm-source-clickable` hover/focus/underline styling. Not unit-tested (UI wiring; suite 55/55 still green)
- [x] Citation ↔ source linkage: agent emits `[[n]]` (prompt says `[n]`) — renderer now escapes/handles BOTH forms and stamps clean `[n]` chips with `data-citation-index` (`render-markdown.ts`); sources get numbered badges `data-source-index`; clicking a chip scrolls to + flashes the matching source (`wireCitationNavigation`); sources still open in main window. Prompt tightened: number sources in context order. Pure escape logic pinned by `tests/unit/render_markdown.test.ts` (6 tests)
- [x] **cite_source tool** (replaces prompt-contract citation): the agent calls `cite_source(source_id=N)` instead of self-managing numbers — the tool assigns a stable ordinal (increments on first cite, reuses on repeat), tracks the mapping, and returns `[N]` for the agent to insert in its answer. Fixes the all-`[1]` drift deterministically. New: `src/agent/tools.ts` (CITE_SOURCE_TOOL + tracker), `src/agent/chat_context.ts` (reconstructAnswer — joins fragmented assistant content across tool-call turns), `src/agent/llm.ts` (preserve partial text alongside tool_calls instead of nulling it). UI wired: source badges show the tool-assigned citation number; chip→source jump translates through the citation map. Pinned by 12 new tests in `tests/unit/chat_context.test.ts` (context, reconstruction, tracker, map)
- [x] Right-sidebar pane opens as a tab (not a bottom-half split): `getRightLeaf(false)` + `wrench` icon

Source: Obsidian automated review (obsidian-vault-ease-of-maintenance). Errors + releases block; warnings don't.

## Decision: minAppVersion bump (2026-08-05)

Chose **bump 1.5.0 → 1.7.2** over swapping `revealLeaf` → `setActiveLeaf`. Accepted tradeoff: locks out users on Obsidian < 1.7.2 (small minority — auto-updates are on by default; the genuinely stuck cohort is people on OSes too old to run current Obsidian). Benefit: `revealLeaf` (@since 1.7.2) stays legal, no code change at the call site, and the door stays closed on `getSettingDefinitions` (1.13.0+).

## A. Blocks review

- [x] `manifest.json`: `minAppVersion` 1.5.0 → 1.7.2; `versions.json` created (`{"1.0.0": "1.7.2"}`)
- [x] `.github/workflows/release.yml` added — tag-triggered build + asset attach (main.js, manifest.json, styles.css)
- [ ] **BLOCKED (no GitHub credentials on this machine):** attach `main.js`/`manifest.json`/`styles.css` to the existing release `1.0.0` and rename it to include the version. Commands: `gh release upload 1.0.0 main.js manifest.json styles.css` + `gh release edit 1.0.0 --title "1.0.0"`
- [x] `main.ts:75` — settings header: `createEl("h2", …)` → `new Setting(…).setName(…).setHeading()`

## B. Real correctness/value

- [x] `src/indexer/db.ts` — hardcoded `.obsidian` + PLUGIN_ID landmine fixed: `settings.configDir` + `settings.pluginDir` (from `app.vault.configDir` + `this.manifest.dir`, set in main.ts onload) replace the `.obsidian/plugins/obsidian-vault-ease-of-maintenance` literal; PLUGIN_ID constant deleted. Landmine killed: release/BRAT installs (folder = manifest id `ease-of-maintenance`) now resolve better-sqlite3 correctly
- [x] `fetch` → `requestUrl` seam: new `src/http.ts` (`postJson`, `setHttpTransport`); plugin switches to `requestUrl` at onload; vitest stays on fetch via `tests/fixtures/obsidian_stub.ts` alias; `main.ts` vault path now via typed `FileSystemAdapter.getBasePath()` (any-cast removed)
- [x] `setTimeout` → `window.setTimeout` (llm_client)
- [x] New coverage: `tests/unit/http.test.ts` (fetch branch: 2xx body, non-2xx status, non-JSON null body, transport switching)

## C. Mechanical lint sweep

- [x] `prefer-create-el`: all 7 sites (sort-review ×5, container-sidebar:189, render-markdown:55) → global `createDiv`/`createSpan` (detached, no auto-append). Review line numbers were stale (chat-review:100, render-markdown:50 no longer contain createElement)
- [x] console.log trim: llm.ts all removed; runtime.ts progress logs removed, error-path kept as `console.warn`; db.ts migration diagnostics kept (2 lines, exceptional)
- [x] Unused imports/vars removed: ChatResponse (llm), os (runtime, tools), Snapshot (runtime), CommunitySeed (runtime), TRIAGE_SKILL_FILENAME (runtime), snippet (runtime), INDEX_DB_SUFFIX (tools), _frontmatter (chunker), seeds (indexer), PendingEntry (diff_page), origEscaped/cleanedEscaped (diff_page)
- [x] `this: void` on 6 EligibilityFilter statics; `\-` → `[*-]` (runtime:930); this-alias in container-sidebar kept with eslint-disable + justification (getter closure requires it)

## D. Defer consciously

- [ ] `no-unsafe-*` / `any` flood (~150+ sites) — accepted debt; typing refactor if ever pursued (db.ts row maps would kill ~80)
- [ ] `require()` style — intentional (lazy native load, Obsidian loader quirk) — eslint-disable comments with justification added at all sites (main.ts ×4, db.ts ×2); never static import
- [ ] `getSettingDefinitions()` (1.13.0+) — still deferred; additive-only (inert below 1.13.0), no minAppVersion change needed

## Verification

- [x] `npx tsc --noEmit` clean; `npm test` 55/55 pass (7 files); `npm run build` succeeds; `main.js` rebuilt
- [x] **Regression found + fixed in Obsidian testing**: `pluginDir` (from `this.manifest.dir`) was empty in the runtime → zero fallback candidates → bare-require error. `collectCandidatePaths()` now scans `configDir/plugins/*` (any install folder name) + keeps exact/__dirname paths + logs settings on failure; pinned by `tests/unit/db_resolution.test.ts`
- [x] **Second regression found + fixed in Obsidian testing**: chat hit "Failed to resolve module specifier 'obsidian'" — esbuild kept the native `import("obsidian")` in the CJS bundle (the http.ts requestUrl branch); Obsidian's renderer can't resolve dynamic module specifiers. Fix: static `import { requestUrl } from "obsidian"` (external → `require("obsidian")`, same as renderers; vitest resolves it via the obsidian_stub alias). Bundle check: 0 native `import("obsidian")` remaining
