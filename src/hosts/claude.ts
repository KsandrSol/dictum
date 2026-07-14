/** Claude Code UserPromptSubmit hook integration. */

import {
  type FileUpdateResult,
  type JsonObject,
  mergeUserPromptSubmitHook,
  shellQuote,
  updateJsonObjectFile,
  validateBinaryPath,
} from "./shared.ts"

function hookHandler(binaryPath: string): JsonObject {
  return {
    type: "command",
    command: `${shellQuote(binaryPath)} prompt-hook`,
    timeout: 10,
  }
}

function isManagedDictumHandler(candidate: JsonObject): boolean {
  // Claude settings have no spare field for a marker, so match only the exact
  // quoted shape this installer writes ("'<path>' prompt-hook") — a bare
  // "… prompt-hook" suffix could be a user's own unrelated hook, which must
  // never be claimed or replaced.
  return (
    candidate.type === "command" &&
    typeof candidate.command === "string" &&
    candidate.command.endsWith("' prompt-hook")
  )
}

/** Merge Dictum into Claude settings.json without disturbing other settings or hooks. */
export async function installClaudeHook(
  path: string,
  binaryPath: string,
): Promise<FileUpdateResult> {
  if (!path) throw new Error("Claude settings path must be non-empty.")
  validateBinaryPath(binaryPath)
  const handler = hookHandler(binaryPath)
  return updateJsonObjectFile(path, "Claude hook", (document) =>
    mergeUserPromptSubmitHook(document, handler, isManagedDictumHandler, path, "Claude hook"),
  )
}
