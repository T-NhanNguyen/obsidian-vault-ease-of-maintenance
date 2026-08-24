---
name: manifest-populate
description: System and user templates for the Stage 2 manifest population LLM pass (handoff-2). The pass writes folder purposes for the (needs review) markers in _manifest.md, using the comprehension vault summary card as context. Placeholders {card}, {manifest} are substituted by the runtime.
---

## Populate system

Complete each line. The part before ' — ' is a folder path; write the folder's PURPOSE after it, in at most 8 words.
Rules:
- NEVER list file names. NEVER repeat the manifest.
- Use only information present in the vault summary card — no speculation.
- Write a purpose ONLY for folders you can describe from the card. Leave the others out entirely.
- Output ONLY the completed lines, one per folder, in the given order.

## Populate user

Vault summary card:

{card}

Manifest (folders marked '(needs review)' still need a purpose):

{manifest}
