---
name: inbox-triage
description: Periodic cross-file integration pass for an Obsidian vault or any directory of .md notes. Empties the designated inbox folder (configured via the Obsidian plugin settings or config.yaml) by relocating its accumulated loose notes — whole files, text blocks, or single lines — into the best-fit existing files across the other folders, cleaning as it goes, consolidating everything into a single review file for quick delete, and deferring invasive improvements as written suggestions. Use when asked to process, triage, file, or integrate an inbox of notes; to merge or move content between notes; or to answer "does everything make sense where it is" before work is presented, shared with peers, or merged into a collaborative workspace. Designed to run periodically — roughly weekly, at checkpoints — not daily. Thorough, not fast.
---

# Inbox Triage

Answer the question "does everything make sense where it is right now?" before notes are presented or merged into the collaborative workspace. Empty the inbox by relocating its content into the existing structure, clean as you go, and surface — never perform — improvements that are too invasive.

This is a periodic checkpoint pass, run when the author has reviewed their recent work and is ready to integrate it. Take the time to be thorough: read destinations properly, verify everything, and leave a complete review file behind.

## Vault Context (fill by exploring the vault)

Before triaging, read the vault structure and answer these:

*   **What folders exist outside the inbox, and what topic does each cover?**
*   **What is the naming pattern of existing folders?** (e.g., numbered prefixes like 000_, topical names, project-based categories)
*   **Are there any content hubs or index files?** (e.g., MOC - Map of Content, Master Index, README)
*   **What writing style does the vault use?** (e.g., atomic notes, long-form documents, daily journals, reference snippets)
*   **How are files typically organized within folders?** (e.g., by date, by project phase, alphabetically)
*   **Which folders are likely destinations for inbox content?** (e.g., project folders, topical reference, daily notes)

## Scope Rules

- Moves flow one way: **out of the inbox into existing files in other folders.** Never move content into the inbox, and never move content between two non-inbox files — record those as Suggestions instead.  
  The inbox folder is resolved from the plugin's request (`inbox_folder`) or from `config.yaml`'s `inbox_folder` field. When neither is set, the system auto-discovers any folder with "inbox" in its name. You receive the folder's path relative to the vault root — place content relative to that.
- Destinations must already exist. If no existing file is an honest fit, leave the item in the inbox and propose a new file as a Suggestion. Do not create destination files, rename files, or restructure folders.
- Read across the whole vault to judge fit, but edit only the inbox files and their chosen destinations.

## Formatting Standard

Apply this standard to any raw inbox file before placement, and to every destination region you touch. It is the workspace's baseline hygiene:

- Fragmented single-line jottings that clearly share a subject (adjacent, no header or blank line between them, overlapping vocabulary) join into one paragraph ending with `.`. When shared subject is doubtful, keep the line breaks.
- A contiguous block of roughly 5+ non-header lines gets a new top-level `#` header above it, titled from words actually present in the block; the block becomes a single paragraph ending with `.`. If no honest title emerges, insert nothing.
- Existing headers are never deleted or reworded; `#` ranks above `##`.
- Obsolete `#tags` are stripped. If a tag is the only subject signal for a fragment, record it in the review file before removing it.
- Obsolete JSON properties blocks in frontmatter (dg-publish/permalink/gardenEntry style) are removed; all other frontmatter is untouched.
- Line-break semantics: a single line break means same subject, blank line means subject switch. Collapse runs of 2+ blank lines to exactly one, preserving the switch signal.
- Preserve tab-indented nesting that ties a line to its parent line.
- Fix structure and whitespace only — never grammar, spelling, wording, or tone.

## Ambiguity Flags

When a decision cannot be made from the available context, mark it rather than guess. Insert an HTML comment directly above the affected block:

```
<!-- review: short-machine-readable-reason -->
```

Reasons used in this pass: `no-destination-fit`, `multiple-tie-unresolved`, `unclear-subject-boundary`, `untitled-block`, `near-duplicate`. Flags are invisible in Obsidian reading mode and greppable later. Every flag in a kept file must also appear in the review file.

## Workflow

1. **Map the territory.** List folders and files outside the inbox and read candidate destination files enough to understand each one's topic, headers, and scope. This destination map drives every placement decision.
2. **Prepare inbox files.** Process inbox files one at a time. If a file is still raw — fragments, stray tags, obsolete properties — first apply the Formatting Standard to it so what you move is clean.
3. **Decide extraction granularity** per unit of content:
   - **Whole file** — the entire note fits one destination.
   - **Text block** — a headed section or blank-line-separated chunk sharing one subject.
   - **Single line** — a lone fact or idea.
   One inbox file may split into several units bound for different destinations.
4. **Place each unit where it is intuitive to search for.** Choose the most specific fitting file and insert under the destination's matching header or adjacent to its closest-related content. Prefer specific files over general ones; when two destinations tie, pick the more specific and note the alternative in the review file.
5. **Clean as you go.** After each insertion, apply the Formatting Standard to the touched region: join fragments, header hygiene, terminal punctuation, blank-line normalization. Leave the destination cleaner than you found it — but only in regions you touched; do not reformat the rest of the file.
6. **Log every move** in the consolidation file `_triage-review.md` inside the inbox folder (create it if absent): source file, one-line content summary, destination file, insertion section, granularity.
7. **Consolidate emptied sources.** Once an inbox file is fully extracted, append any residual content to the review file and record the emptied file's path under Emptied Sources, so the user reviews one file and quick-deletes it plus the shells. Do not hard-delete originals yourself.
8. **Skip and flag no-fits.** Items with no honest destination stay in the inbox, each listed in the review file with its reason.
9. **Reassess.** Re-read every modified destination file end to end. Fix integration seams: duplicate content revealed by the merge, redundant headers, broken flow around insertion points. Verify the Formatting Standard holds in all touched regions.
10. **Write Suggestions.** For improvements too invasive or drastic for this pass — file renames, folder restructures, splitting an overgrown destination, moves between non-inbox files, broken `[[links]]` needing relinks, tag taxonomy — add an entry to the review file's Suggestions section stating what, why, and the risk. Perform none of them.

## Review File Format

`<inbox>/_triage-review.md` — the single artifact for review and quick delete. Located inside whichever folder is the current inbox:

- `# Inbox Triage Review — <date>`
- `## Moves` — one bullet per moved unit: `source → destination › section (granularity): one-line summary`
- `## Left in Inbox` — unplaced items with reasons.
- `## Emptied Sources` — paths of fully extracted inbox files plus any residual content.
- `## Suggestions` — deferred invasive improvements: what, why, risk.

## Guardrails (Never Touch)

- Image paths and embeds: move `![[...]]` embeds together with their surrounding content; never edit their paths.
- Code blocks and inline code — verbatim, including internal blank lines and indentation.
- `[[wikilinks]]` and `#tags` inside moved content stay exactly as written, even if broken or obsolete — relinking and taxonomy are out of scope; log them as Suggestions instead.
- URLs and footnote references — verbatim.
- Frontmatter other than obsolete properties blocks.
- Existing headers in any file — text, level, and order unchanged; none deleted.
- Tables, math blocks, blockquotes with deliberate structure.
- If moved content duplicates text already in the destination, do not create a duplicate — record the near-duplicate in the review file.
- Never restructure a destination beyond the insertion and its local cleanup; all larger reorganization ideas go to Suggestions.

## Verification Checklist

- [ ] Inbox contains only flagged no-fit items; every extracted unit appears in the Moves log.
- [ ] No content lost: every inbox line is placed, logged as leftover, or logged as a near-duplicate.
- [ ] Every modified destination satisfies the Formatting Standard in touched regions; all other regions untouched.
- [ ] Images, links, code, tables byte-identical everywhere.
- [ ] Review file complete: Moves, Left in Inbox, Emptied Sources, Suggestions.
- [ ] **Idempotent:** re-running this pass immediately would find nothing new to move.

## Report Format

Report briefly and point the user to `<inbox>/_triage-review.md` for review and quick delete:

1. Inbox files processed; units moved, broken down by granularity; destinations touched.
2. Items left behind and why.
3. Number of suggestions raised (headline the top ones).
4. Verification status.

## Edge Cases

- **Empty inbox:** report "nothing to triage" and stop.
- **An inbox file that deserves to become its own standalone note:** leave it, add a new-file Suggestion.
- **A destination swelled by insertions to the point of unwieldiness:** add a split Suggestion; do not split.
- **Non-markdown items in the inbox (images, attachments):** move only if a destination clearly expects them; otherwise leave and flag.
