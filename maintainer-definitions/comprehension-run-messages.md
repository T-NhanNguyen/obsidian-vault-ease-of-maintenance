---
name: comprehension-run-messages
description: Per-turn instruction templates for the vault-comprehension loop (nudges, clarification injections, the final synthesis request, the default question). Placeholders {status}, {reason}, {detail}, {lines}, {question}, {answer}, {ledger} are substituted by the runtime.
---

## Nudge

Status is "{status}" — {reason} Continue the protocol (skim/verify/score). Do not write the final synthesis yet.

## Optional clarification hint

Optional clarification available ({reason}): {detail} You may call clarify, or continue.

## Mandatory clarification answered

[Mandatory clarification] {question}
User answer: {answer}
Convert the answer into ledger changes (ledger_add / ledger_score) and continue.

## Mandatory clarification no answer

[Mandatory clarification] {question}
No answer received. Continue with the current evidence and stop with a flagged summary.

## Clarify question conflicted

Two leading hypotheses contradict each other: {lines}. Which is right, or how should I reconcile them?

## Clarify question insufficient evidence

I have insufficient evidence to understand this vault. Give me a keyword, folder, or starting note to focus on.

## Clarify question budget exhausted

My tool-call budget is nearly exhausted and the run is not confirmed. What should I prioritize with the remaining calls?

## Final synthesis request

Write the final one-page vault summary synthesis (2-4 sentences, **bold** key terms) from the ledger:
{ledger}

## Default question

Understand this vault.
