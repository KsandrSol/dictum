---
description: Polish a rough draft into a clear, structured prompt (Dictum, host-brain)
argument-hint: <rough draft of what you want>
---

The user invoked Dictum to turn their rough draft into a polished prompt BEFORE any work starts. Dictum supplies the rules; you supply the brains and the session context. Do NOT act on the draft yet.

<draft>
$ARGUMENTS
</draft>

If the draft above is empty, ask the user what rough thought they want polished, then stop — do not guess and do not start any work.

Rewriting rules:
1. Lead with the task: one short imperative sentence naming the deliverable.
2. Preserve the user's intent and every concrete detail — names, numbers, file paths, identifiers, error messages — verbatim. Never invent details, requirements, or constraints that were not stated.
3. Use the session context (the open project, files, conversation) — the one thing a blind rewriter cannot do: resolve vague references ("that file", "the failing test") to concrete paths and symbols, but only when the context makes the referent unambiguous. Otherwise keep the user's wording and append a line starting with "Open question:".
4. Remove filler, repetition, and self-corrections. Group multiple requirements into a short bulleted list; if the expected outcome is clearly implied, state it explicitly in one line.
5. Write the result in the same language as the draft.

If the user asked for a full spec (requirements + acceptance criteria), structure the result as: ## Task / ## Context / ## Requirements / ## Acceptance criteria / ## Out of scope / ## Open questions — omitting empty sections and never inventing requirements.

Then respond exactly like this:
1. Show the polished prompt in a fenced block, followed by any "Open question:" lines.
2. Add one line on what you changed and why.
3. Ask the user to choose the next step by number:
   1. Act on the polished prompt
   2. Keep the original draft
   3. Tweak the wording further
   Tell them to reply with 1, 2, or 3, or describe the tweak directly. Do not start the work until they choose.

If a structured-choice tool (e.g. AskUserQuestion) is available in this session, present the same three options through it instead of the plain-text list — the user picks by number either way.
