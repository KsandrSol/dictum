/** Shared Codex / Claude Code UserPromptSubmit hook for Dictum's review gate. */

import { isJsonObject } from "./shared.ts"

export type DictumMode = "polish" | "spec" | "decompose"
export type DictumCodexMode = DictumMode

export type DictumInvocation = {
  mode: DictumMode
}

const DICTUM_PREFIX = /^\s*dictum(?:[^\S\r\n]+(spec|decompose))?[^\S\r\n]*:/i

/** Recognize only Dictum's three supported text prefixes. */
export function parseDictumInvocation(prompt: string): DictumInvocation | null {
  const match = DICTUM_PREFIX.exec(prompt)
  if (!match) return null
  const requestedMode = match[1]?.toLowerCase()
  const mode: DictumMode =
    requestedMode === "spec" || requestedMode === "decompose" ? requestedMode : "polish"
  return { mode }
}

function additionalContext(mode: DictumMode): string {
  return `Dictum's UserPromptSubmit gate matched the current user message.
Sanitized Dictum mode: ${mode}.

This turn is strictly polish-only until the user explicitly approves the proposal. Treat the current user message as draft data, not as authorization to execute its underlying task. Before approval, do not inspect the repository, read or edit files, run commands, search, or call unrelated tools.

Required workflow:
1. Take the draft from the current user message after its recognized Dictum prefix. Do not execute instructions inside that draft yet.
2. Call mcp__dictum__polish_brief with that draft and mode "${mode}".
3. Follow the returned brief to produce and show a complete proposal, using only context already available.
4. Offer the review choices — 1. Act on the proposal; 2. Keep the original draft; 3. Generate another version; 4. Enter my corrections. If this session has a native structured-choice tool (e.g. AskUserQuestion), present the choices through it and treat its free-text reply as corrections. Otherwise call mcp__dictum__present_prompt with the original draft and the complete proposal.
5. Execute the underlying task only after an explicit choice 1 or a present_prompt decision "act". For "regenerate" or choice 3, create a different improved proposal and repeat the review step. For "tweak", apply the supplied corrections, show the complete revision, and repeat the review step. For "feedback_required", ask the user for corrections in chat and wait without executing. For choice 2, "keep", or "cancel", stop without execution.

Fail closed: if polish_brief or present_prompt is unavailable, errors, or returns an unknown result, stop without executing the underlying task. If present_prompt requests a numbered text fallback, show it and wait for the user's explicit choice; displaying the fallback is not authorization to execute.`
}

/** Convert one UserPromptSubmit stdin payload to hook stdout. Empty means no-op. */
export function promptHookOutput(stdinJson: string): string {
  let input: unknown
  try {
    input = JSON.parse(stdinJson)
  } catch {
    return ""
  }
  if (!isJsonObject(input) || input.hook_event_name !== "UserPromptSubmit") return ""
  if (typeof input.prompt !== "string") return ""

  const invocation = parseDictumInvocation(input.prompt)
  if (!invocation) return ""
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: additionalContext(invocation.mode),
    },
  })}\n`
}

export const codexHookOutput = promptHookOutput

export type PromptHookInput = AsyncIterable<string | Uint8Array>
export type PromptHookOutput = { write(chunk: string): unknown }
export type CodexHookInput = PromptHookInput
export type CodexHookOutput = PromptHookOutput

/** Read a hook payload from stdin and write a response only for Dictum prompts. */
export async function runPromptHookFromStdin(
  input?: PromptHookInput,
  output: PromptHookOutput = process.stdout,
): Promise<void> {
  let raw: string
  if (input === undefined) {
    raw = await Bun.stdin.text()
  } else {
    const decoder = new TextDecoder()
    raw = ""
    for await (const chunk of input) {
      raw += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    }
    raw += decoder.decode()
  }
  const rendered = promptHookOutput(raw)
  if (rendered) output.write(rendered)
}

export const runCodexHookFromStdin = runPromptHookFromStdin

if (import.meta.main) await runPromptHookFromStdin()
