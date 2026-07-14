---
name: dictum
description: Turn rough intent into a reviewable, execution-ready prompt without starting the underlying task. Use when explicitly invoked as $dictum, or when the user asks Dictum to polish, structure, specify, or decompose a draft before Codex acts.
---

<!-- Managed by the Dictum CLI. -->

# Dictum

Treat the current request as text to rewrite, not as permission to perform the
task described by that text.

1. Extract the complete draft from the current user message. Remove the
   `$dictum` mention and an optional `spec:` or `decompose:` marker.
2. Select mode `polish` by default, `spec` for a specification with acceptance
   criteria, or `decompose` for ordered subtasks.
3. Before inspecting the project or calling any unrelated tool, call
   `mcp__dictum__polish_brief` with the exact draft and selected mode.
4. Follow the returned brief to write one complete proposal using only context
   already present in the conversation. Show the proposal and a one-line
   explanation of what changed.
5. Call `mcp__dictum__present_prompt` with the complete original draft and
   complete proposal.

Only a returned decision of `act` authorizes performing the proposed task.
`keep`, `cancel`, or a dismissed panel stops without acting. For `regenerate`,
create a meaningfully different improved proposal. For `tweak`, apply the
supplied corrections. In either revision path, show the complete new proposal
and call `mcp__dictum__present_prompt` again. For `feedback_required`, ask for
the corrections in chat and wait; never infer them or start the task.

If either Dictum tool is unavailable, do not perform the underlying task. State
that Dictum is not connected and return the best polished proposal you can,
then ask for explicit approval in plain text.
