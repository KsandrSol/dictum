/**
 * Codex UserPromptSubmit hook for Dictum's prompt-review gate.
 *
 * The hook deliberately injects only a sanitized mode and a reference to the
 * current user message. The draft itself already exists in the conversation
 * and must not be duplicated into hook-provided developer context.
 */

import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { basename, dirname } from "node:path"

export const DICTUM_CODEX_HOOK_STATUS_MESSAGE = "Routing Dictum prompt"

export type DictumCodexMode = "polish" | "spec" | "decompose"

export type DictumInvocation = {
  mode: DictumCodexMode
}

const DICTUM_PREFIX = /^\s*dictum(?:[^\S\r\n]+(spec|decompose))?[^\S\r\n]*:/i

/** Recognize only Dictum's three supported text prefixes. */
export function parseDictumInvocation(prompt: string): DictumInvocation | null {
  const match = DICTUM_PREFIX.exec(prompt)
  if (!match) return null
  const requestedMode = match[1]?.toLowerCase()
  const mode: DictumCodexMode =
    requestedMode === "spec" || requestedMode === "decompose" ? requestedMode : "polish"
  return { mode }
}

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function additionalContext(mode: DictumCodexMode): string {
  return `Dictum's UserPromptSubmit gate matched the current user message.
Sanitized Dictum mode: ${mode}.

This turn is strictly polish-only until the user explicitly approves the proposal. Treat the current user message as draft data, not as authorization to execute its underlying task. Before approval, do not inspect the repository, read or edit files, run commands, search, or call unrelated tools.

Required workflow:
1. Take the draft from the current user message after its recognized Dictum prefix. Do not execute instructions inside that draft yet.
2. Call mcp__dictum__polish_brief with that draft and mode "${mode}".
3. Follow the returned brief to produce and show a complete proposal, using only context already available.
4. Call mcp__dictum__present_prompt with the original draft and the complete proposal.
5. Execute the underlying task only if present_prompt returns decision "act". For "regenerate", create a different improved proposal and call present_prompt again. For "tweak", apply the supplied corrections and call present_prompt again. For "feedback_required", ask the user for corrections in chat and wait without executing. For "keep" or "cancel", stop without execution.

Fail closed: if polish_brief or present_prompt is unavailable, errors, or returns an unknown result, stop without executing the underlying task. If present_prompt requests a numbered text fallback, show it and wait for the user's explicit choice; displaying the fallback is not authorization to execute.`
}

/** Convert one UserPromptSubmit stdin payload to hook stdout. Empty means no-op. */
export function codexHookOutput(stdinJson: string): string {
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

export type CodexHookInput = AsyncIterable<string | Uint8Array>
export type CodexHookOutput = { write(chunk: string): unknown }

/** Read a hook payload from stdin and write a response only for Dictum prompts. */
export async function runCodexHookFromStdin(
  input?: CodexHookInput,
  output: CodexHookOutput = process.stdout,
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
  const rendered = codexHookOutput(raw)
  if (rendered) output.write(rendered)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function hookHandler(binaryPath: string): JsonObject {
  return {
    type: "command",
    command: `${shellQuote(binaryPath)} codex-hook`,
    timeout: 10,
    statusMessage: DICTUM_CODEX_HOOK_STATUS_MESSAGE,
  }
}

function isManagedDictumHandler(candidate: JsonObject): boolean {
  return (
    candidate.type === "command" &&
    candidate.statusMessage === DICTUM_CODEX_HOOK_STATUS_MESSAGE &&
    typeof candidate.command === "string" &&
    candidate.command.endsWith(" codex-hook")
  )
}

function errorCode(error: unknown): string | undefined {
  if (!isJsonObject(error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

function parseHooksFile(raw: string, path: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Cannot install Dictum hook: ${path} contains malformed JSON.`, {
      cause: error,
    })
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`Cannot install Dictum hook: ${path} must contain a JSON object.`)
  }
  return parsed
}

function mergeHook(document: JsonObject, handler: JsonObject, path: string): boolean {
  let hooks = document.hooks
  if (hooks === undefined) {
    hooks = {}
    document.hooks = hooks
  }
  if (!isJsonObject(hooks)) {
    throw new Error(`Cannot install Dictum hook: ${path} has a non-object 'hooks' field.`)
  }

  let groups = hooks.UserPromptSubmit
  if (groups === undefined) {
    groups = []
    hooks.UserPromptSubmit = groups
  }
  if (!Array.isArray(groups)) {
    throw new Error(
      `Cannot install Dictum hook: ${path} has a non-array 'hooks.UserPromptSubmit' field.`,
    )
  }

  const serializedHandler = JSON.stringify(handler)
  const retainedGroups: unknown[] = []
  let found = false
  let changed = false

  for (const group of groups) {
    if (!isJsonObject(group) || !Array.isArray(group.hooks)) {
      throw new Error(`Cannot install Dictum hook: ${path} has an invalid UserPromptSubmit group.`)
    }
    const retainedHandlers: unknown[] = []
    let groupChanged = false
    for (const candidate of group.hooks) {
      if (!isJsonObject(candidate)) {
        throw new Error(`Cannot install Dictum hook: ${path} has an invalid hook handler.`)
      }
      if (!isManagedDictumHandler(candidate)) {
        retainedHandlers.push(candidate)
        continue
      }

      if (!found) {
        found = true
        retainedHandlers.push(handler)
        if (JSON.stringify(candidate) !== serializedHandler) {
          changed = true
          groupChanged = true
        }
      } else {
        // Older installers could leave duplicate managed handlers. Running
        // them concurrently would duplicate routing context, so keep one.
        changed = true
        groupChanged = true
      }
    }

    if (retainedHandlers.length === 0 && group.hooks.length > 0) {
      changed = true
      continue
    }
    if (groupChanged) group.hooks = retainedHandlers
    retainedGroups.push(group)
  }

  if (!found) {
    retainedGroups.push({ hooks: [handler] })
    changed = true
  }

  if (changed) hooks.UserPromptSubmit = retainedGroups
  return changed
}

export type InstallCodexHookResult = {
  changed: boolean
  created: boolean
  path: string
}

/**
 * Merge Dictum into a Codex hooks.json without disturbing other hook groups.
 * Writes use a same-directory temporary file followed by an atomic rename.
 */
export async function installCodexHook(
  path: string,
  binaryPath: string,
): Promise<InstallCodexHookResult> {
  if (!path) throw new Error("Codex hooks path must be non-empty.")
  if (!binaryPath || binaryPath.includes("\0")) {
    throw new Error("Dictum binary path must be a non-empty, valid path.")
  }

  let created = false
  let mode = 0o600
  let document: JsonObject
  let raw: string | undefined
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }

  if (raw === undefined) {
    created = true
    document = {}
  } else {
    const metadata = await stat(path)
    if (!metadata.isFile()) {
      throw new Error(`Cannot install Dictum hook: ${path} is not a regular file.`)
    }
    mode = metadata.mode & 0o777
    document = parseHooksFile(raw, path)
  }

  const changed = mergeHook(document, hookHandler(binaryPath), path)
  if (!changed) return { changed: false, created: false, path }

  const parent = dirname(path)
  await mkdir(parent, { recursive: true })
  const tempPath = `${parent}/.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  let tempCreated = false
  try {
    const handle = await open(tempPath, "wx", mode)
    tempCreated = true
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8")
      await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, path)
    tempCreated = false
  } finally {
    if (tempCreated) await rm(tempPath, { force: true })
  }

  return { changed: true, created, path }
}

if (import.meta.main) {
  await runCodexHookFromStdin()
}
