/**
 * polisher/templates.ts — resolve polishing templates by name.
 *
 * Built-in templates are embedded as text (so they survive `bun build
 * --compile`). User overrides in ~/.config/dictum/templates/<name>.md take
 * precedence and are loaded at runtime (added in step 1.4). Frontmatter:
 *
 *   ---
 *   description: ...
 *   language: en|ru|auto
 *   ---
 *   <instruction body>
 */

import { readdir } from "node:fs/promises"
import { resolve, sep } from "node:path"
import type { Template } from "../core/types.ts"
import agentPromptRaw from "./templates/agent-prompt.md" with { type: "text" }
import commitRaw from "./templates/commit.md" with { type: "text" }
import decomposeRaw from "./templates/decompose.md" with { type: "text" }
import noteRaw from "./templates/note.md" with { type: "text" }
import specRaw from "./templates/spec.md" with { type: "text" }

// Null prototype: a lookup like BUILTINS["constructor"] must miss instead of
// returning an inherited Object.prototype member.
const BUILTINS: Record<string, string> = Object.assign(Object.create(null), {
  "agent-prompt": agentPromptRaw,
  commit: commitRaw,
  decompose: decomposeRaw,
  note: noteRaw,
  spec: specRaw,
})

/** Parse a markdown template (frontmatter + body) into a Template. */
export function parseTemplate(name: string, raw: string): Template {
  let description = ""
  let language = "auto"
  let body = raw

  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (fm?.[1] !== undefined) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
      if (!m) continue
      const key = m[1]!.toLowerCase()
      const value = m[2]!.trim().replace(/^["']|["']$/g, "")
      if (key === "description") description = value
      else if (key === "language") language = value
    }
    body = raw.slice(fm[0].length)
  }

  return { name, description, language, instruction: body.trim() }
}

/** Names of the built-in templates. */
export function builtinTemplateNames(): string[] {
  return Object.keys(BUILTINS)
}

/** Resolve a built-in template by name; throws with a helpful list if unknown. */
export function resolveBuiltinTemplate(name: string): Template {
  const raw = BUILTINS[name]
  if (raw === undefined) {
    throw new Error(`Unknown template '${name}'. Available: ${builtinTemplateNames().join(", ")}`)
  }
  return parseTemplate(name, raw)
}

/**
 * All template names available: built-ins plus user overrides in `userDir`.
 * Only valid slugs are advertised — the listing and the resolver share one
 * validator, so every advertised name is guaranteed to resolve.
 */
export async function availableTemplateNames(userDir?: string): Promise<string[]> {
  const names = new Set(builtinTemplateNames())
  if (userDir) {
    try {
      for (const entry of await readdir(userDir, { withFileTypes: true })) {
        // Regular files only: a directory named `x.md` must not be advertised
        // (it can never resolve). Symlinked templates resolve but are not
        // listed — advertised ⊆ resolvable is the invariant.
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue
        const stem = entry.name.slice(0, -3)
        if (isValidTemplateName(stem)) names.add(stem)
      }
    } catch {
      // user template directory may not exist — ignore
    }
  }
  return [...names].sort()
}

/**
 * A template name (the file stem, i.e. the `mode`) is a portable ASCII slug:
 * starts with a letter/digit/underscore, then word characters, dots or dashes
 * — no path separators, no `..`, no NULs, no spaces or non-ASCII. Template
 * titles, descriptions and bodies stay full Unicode; only the technical file
 * ID is restricted so behavior is identical across Linux/macOS/Windows and a
 * name can never escape the template directory (`mode` reaches this from the
 * CLI and from MCP callers). Shared by the resolver and the listing.
 */
const SAFE_NAME_RE = /^[A-Za-z0-9_][\w.-]*$/

/** Windows reserves these device names (bare or with any extension). */
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

/** True when `name` is a portable template slug the resolver will accept. */
export function isValidTemplateName(name: string): boolean {
  return SAFE_NAME_RE.test(name) && !name.includes("..") && !WINDOWS_RESERVED_RE.test(name)
}

function assertSafeTemplateName(name: string): void {
  if (!name || !isValidTemplateName(name)) {
    throw new Error(
      `Invalid template name '${name}': names must be plain file stems without path separators`,
    )
  }
}

/**
 * Resolve a template by name. A user override at `<userDir>/<name>.md` takes
 * precedence over the built-in. Throws with the available list if not found,
 * and rejects names that could traverse outside the template directory.
 *
 * Trust model: the user template directory is the user's own config dir and
 * is treated as trusted — containment is lexical (resolve + prefix), and
 * symlinks inside it are followed. This blocks caller-controlled traversal
 * via `mode`; it does not defend against a hostile local filesystem.
 */
export async function resolveTemplate(name: string, userDir?: string): Promise<Template> {
  assertSafeTemplateName(name)
  if (userDir) {
    const root = resolve(userDir)
    const path = resolve(root, `${name}.md`)
    // Second belt after the name check: the resolved path must stay inside.
    if (!path.startsWith(root + sep)) {
      throw new Error(`Invalid template name '${name}': escapes the template directory`)
    }
    const file = Bun.file(path)
    if (await file.exists()) {
      return parseTemplate(name, await file.text())
    }
  }
  const raw = BUILTINS[name]
  if (raw !== undefined) {
    return parseTemplate(name, raw)
  }
  const available = await availableTemplateNames(userDir)
  throw new Error(`Unknown template '${name}'. Available: ${available.join(", ")}`)
}
