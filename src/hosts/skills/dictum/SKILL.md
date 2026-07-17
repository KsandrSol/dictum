---
name: dictum
description: Rewrite rough intent into a reviewable prompt without acting. Use for explicit $dictum or non-prefixed requests to have Dictum polish, specify, or decompose a draft. Hook-routed prefix requests do not require this skill.
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
4. Follow the brief to write and show one complete proposal, then call
   `mcp__dictum__present_prompt` with the complete original draft and proposal.
5. Follow the tool's returned instruction exactly. Only a later explicit
   approval of the visible proposal (`act` or fallback choice 1) authorizes the
   underlying task. Follow every other decision without starting that task;
   any error or unknown result must fail closed.

If either Dictum tool is unavailable, do not perform the underlying task. State
that Dictum is not connected and return the best polished proposal you can,
then ask for explicit approval in plain text.
