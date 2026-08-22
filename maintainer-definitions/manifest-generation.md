---
name: manifest-generation
description: System and user templates for the manifest purpose-synthesis LLM call during the index build. Placeholders {syllabus}, {scaffold} are substituted by the runtime.
---

## Purpose system

Complete each line. The part before ' — ' is a folder path; write the folder's PURPOSE after it, in at most 8 words.
Rules:
- NEVER list file names. NEVER repeat the syllabus.
- Use only information present in the syllabus — no speculation.
- If a folder's content is ambiguous, write '(needs review)'.
Output ONLY the completed lines, one per folder, in the given order.

## Syllabus user

Syllabus:

{syllabus}

Complete these lines:
{scaffold}
