/** Shared, conservative file-update primitives for host integrations. */

import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import { basename, dirname } from "node:path"

export type JsonObject = Record<string, unknown>

export type FileUpdateResult = {
  changed: boolean
  created: boolean
  path: string
}

export type ManagedFileState = "installed" | "updated" | "unchanged"

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function errorCode(error: unknown): string | undefined {
  if (!isJsonObject(error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
}

/** Write through a same-directory temporary file and preserve existing permissions. */
export async function atomicWrite(
  path: string,
  contents: string,
  defaultMode = 0o644,
): Promise<void> {
  // Write through the symlink target, not over the link: dotfile-managed
  // configs (stow/chezmoi) must keep their link, or the next `apply` would
  // silently revert the integration with a stale copy.
  let target = path
  try {
    target = await realpath(path)
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }

  let mode = defaultMode
  try {
    const metadata = await stat(target)
    if (!metadata.isFile()) throw new Error(`Refusing to replace non-regular file: ${target}`)
    mode = metadata.mode & 0o777
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }

  const parent = dirname(target)
  await mkdir(parent, { recursive: true })
  const temporary = `${parent}/.${basename(target)}.${process.pid}.${randomUUID()}.tmp`
  let temporaryExists = false
  try {
    const handle = await open(temporary, "wx", mode)
    temporaryExists = true
    try {
      await handle.writeFile(contents, "utf8")
      await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
    temporaryExists = false
  } finally {
    if (temporaryExists) await rm(temporary, { force: true })
  }
}

/** Parse, merge, and atomically rewrite one JSON object while preserving unknown keys. */
export async function updateJsonObjectFile(
  path: string,
  label: string,
  merge: (document: JsonObject) => boolean,
): Promise<FileUpdateResult> {
  const raw = await readOptional(path)
  const created = raw === undefined
  let document: JsonObject
  if (raw === undefined) {
    document = {}
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`Cannot install Dictum ${label}: ${path} contains malformed JSON.`, {
        cause: error,
      })
    }
    if (!isJsonObject(parsed)) {
      throw new Error(`Cannot install Dictum ${label}: ${path} must contain a JSON object.`)
    }
    document = parsed
  }

  const changed = merge(document)
  if (!changed) return { changed: false, created: false, path }
  await atomicWrite(path, `${JSON.stringify(document, null, 2)}\n`, 0o600)
  return { changed: true, created, path }
}

export function validateBinaryPath(binaryPath: string): void {
  if (!binaryPath || binaryPath.includes("\0")) {
    throw new Error("Dictum binary path must be a non-empty, valid path.")
  }
}

/** Merge the Dictum stdio server into an MCP JSON config. */
export async function installMcpServer(
  path: string,
  binaryPath: string,
  label: string,
): Promise<FileUpdateResult> {
  if (!path) throw new Error(`${label} path must be non-empty.`)
  validateBinaryPath(binaryPath)
  return updateJsonObjectFile(path, label, (document) => {
    let servers = document.mcpServers
    if (servers === undefined) {
      servers = {}
      document.mcpServers = servers
    }
    if (!isJsonObject(servers)) {
      throw new Error(
        `Cannot install Dictum ${label}: ${path} has a non-object 'mcpServers' field.`,
      )
    }

    const current = servers.dictum
    if (current !== undefined && !isJsonObject(current)) {
      throw new Error(
        `Cannot install Dictum ${label}: ${path} has a non-object 'mcpServers.dictum' field.`,
      )
    }
    const desired: JsonObject = {
      ...(current ?? {}),
      command: binaryPath,
      args: ["mcp"],
    }
    if (current !== undefined && JSON.stringify(current) === JSON.stringify(desired)) return false
    servers.dictum = desired
    return true
  })
}

export type HookHandlerMatcher = (handler: JsonObject) => boolean

/** Merge one managed UserPromptSubmit handler without disturbing foreign groups or fields. */
export function mergeUserPromptSubmitHook(
  document: JsonObject,
  handler: JsonObject,
  isManaged: HookHandlerMatcher,
  path: string,
  label: string,
): boolean {
  let hooks = document.hooks
  if (hooks === undefined) {
    hooks = {}
    document.hooks = hooks
  }
  if (!isJsonObject(hooks)) {
    throw new Error(`Cannot install Dictum ${label}: ${path} has a non-object 'hooks' field.`)
  }

  let groups = hooks.UserPromptSubmit
  if (groups === undefined) {
    groups = []
    hooks.UserPromptSubmit = groups
  }
  if (!Array.isArray(groups)) {
    throw new Error(
      `Cannot install Dictum ${label}: ${path} has a non-array 'hooks.UserPromptSubmit' field.`,
    )
  }

  const serializedHandler = JSON.stringify(handler)
  const retainedGroups: unknown[] = []
  let found = false
  let changed = false

  for (const group of groups) {
    if (!isJsonObject(group) || !Array.isArray(group.hooks)) {
      throw new Error(
        `Cannot install Dictum ${label}: ${path} has an invalid UserPromptSubmit group.`,
      )
    }
    const retainedHandlers: unknown[] = []
    let groupChanged = false
    for (const candidate of group.hooks) {
      if (!isJsonObject(candidate)) {
        throw new Error(`Cannot install Dictum ${label}: ${path} has an invalid hook handler.`)
      }
      if (!isManaged(candidate)) {
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

export async function assertManagedFileInstallable(
  path: string,
  marker: string,
  label: string,
): Promise<void> {
  const existing = await readOptional(path)
  if (existing !== undefined && !existing.includes(marker)) {
    throw new Error(`Refusing to overwrite an unmanaged ${label} at ${path}.`)
  }
}

/** Install a marker-owned text file, refusing to overwrite a user-owned collision. */
export async function installManagedFile(
  path: string,
  contents: string,
  marker: string,
  label: string,
): Promise<ManagedFileState> {
  const existing = await readOptional(path)
  if (existing !== undefined && !existing.includes(marker)) {
    throw new Error(`Refusing to overwrite an unmanaged ${label} at ${path}.`)
  }
  if (existing === contents) return "unchanged"
  await atomicWrite(path, contents)
  return existing === undefined ? "installed" : "updated"
}

/** Remove one complete marker-delimited block while preserving surrounding text. */
export async function removeMarkedBlock(
  path: string,
  beginMarker: string,
  endMarker: string,
): Promise<boolean> {
  const existing = await readOptional(path)
  if (existing === undefined) return false
  const lines = existing.split("\n")
  const begin = lines.findIndex((line) => line.trim() === beginMarker)
  const end = lines.findIndex((line) => line.trim() === endMarker)
  if (begin === -1 || end === -1 || end < begin) return false
  const from = begin > 0 && lines[begin - 1]?.trim() === "" ? begin - 1 : begin
  const cleaned = [...lines.slice(0, from), ...lines.slice(end + 1)].join("\n")
  await atomicWrite(path, cleaned)
  return true
}
