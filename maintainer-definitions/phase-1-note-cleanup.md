---
name: note-cleanup
description: Fast, frequently-run cleanup pass for a single markdown note in an Obsidian vault or any directory of .md notes. Normalizes one file to the workspace formatting standard using only the text inside that file — loose fragments, stray headers, obsolete tags and properties blocks, messy whitespace. Use when asked to tidy, clean up, standardize, or "fix up" a note; when a note reads like hasty napkin jottings or an unorganized idea dump; or as a quick hygienic pass during drafting so the author can keep developing the note. Designed to run often, even daily — it is cheap, conservative, and idempotent. Single files only; never moves content between files.
---

## Formatting Standard

The target state for any cleaned note:

**Signals to look for**
- Loose, napkin-style fragmented lines jotted in haste.
- Multiple line breaks between text blocks = a switch to a different subject.
- A single line break between text blocks = same subject, different key point.
- `## Header` lines dropped in as in-the-moment organization attempts; `#` ranks above `##`.
- A JSON-in-frontmatter properties block (e.g. `{"dg-publish":true,"permalink":"...","tags":[...]}`) — obsolete; remove it.

**Desired format**
- Try to keep every existing `#`/`##` header as-is; never delete a header, but if they can be merged or combine to conciseness and it's intuitive, do so.
- For a contiguous block of roughly 5+ non-header lines (after stripping), insert a new top-level `#` header above it and join the block into one paragraph ending with `.`.
- Otherwise leave content largely unchanged; keep single line breaks between short sentences or bullets.
- All transformations are purely stylistic and never change meaning.
- Preserve tab-indented nesting that ties a line to its parent line.

**Do not touch**
- Image source paths. Linked/embedded images (`![[Pasted image ....png]]`) may be repositioned but never edited.

## Context Discipline

Decide everything from the file alone:

- When a decision cannot be made from the file's own text, preserve the original verbatim and raise a flag (see Ambiguity Flags).
- Delete the content if it's a duplicate content and Prune content that repetitive or redundant.
- Do not guess author intent beyond what the text shows. Adjacent lines are evidence; imagination is not.


## Cleanup Rules

- **R1 — Meaning preservation.** Fix structure and whitespace is underscored, but also make attempt to correct grammar, spelling, wording, or tone inside preserved lines, when the error is obvious within the context and scope of the file. Joining fragments and adding terminal punctuation is the only sanctioned text edit.
- **R2 — Fragment joining.** Join a run of single-line-break fragments into one paragraph only when they clearly share a subject — signaled by adjacency, no intervening header or blank line, and overlapping vocabulary. If shared subject is doubtful, keep the line breaks and flag it.
- **R3 — Header titles.** When inserting a `#` header over a 5+ line block, derive the title from words actually present in the block. If no honest title emerges, insert nothing and flag the block instead.
- **R4 — Terminal punctuation.** Ensure joined paragraphs end with `.`. Do not otherwise alter punctuation.
- **R5 — Blank-line normalization.** Collapse runs of 2+ blank lines to exactly one blank line between blocks. The surviving blank line still marks a subject switch, so the signal is preserved while excess whitespace is removed. Never collapse blank lines inside code blocks, tables, or lists where they carry structure.

## Guardrails (Never Touch)

Verify each of these survives the edit byte-for-byte:

- Image paths and embeds (repositioning `![[...]]` embeds is allowed).
- Code blocks and inline code — verbatim, including internal blank lines and indentation.
- URLs, wikilink targets (`[[...]]`), and footnote references.
- Existing headers — text, level, and order unchanged; none deleted.
- Tables, math blocks, blockquotes with deliberate structure.
- Anything ambiguous — preserve verbatim and flag instead.
