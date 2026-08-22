---
name: folder-purpose-question
description: Clarify-dialog question and context templates for the manifest folder-purpose pass. Placeholders {folder}, {files} are substituted by the runtime.
---

## Question

What is the purpose of the folder "{folder}"? Answer in a few words — this becomes the manifest purpose line.

## Context

The manifest (_manifest.md) lists each vault folder with a one-line purpose: `## folder/ <!-- purpose -->`.{files}
