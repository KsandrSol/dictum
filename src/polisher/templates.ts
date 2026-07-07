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
import { join } from "node:path"
import type { Template } from "../core/types.ts"
import agentPromptRaw from "./templates/agent-prompt.md" with { type: "text" }
import commitRaw from "./templates/commit.md" with { type: "text" }
import decomposeRaw from "./templates/decompose.md" with { type: "text" }
import noteRaw from "./templates/note.md" with { type: "text" }
import specRaw from "./templates/spec.md" with { type: "text" }

const BUILTINS: Record<string, string> = {
  "agent-prompt": agentPromptRaw,
  commit: commitRaw,
  decompose: decomposeRaw,
  note: noteRaw,
  spec: specRaw,
}

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

/** All template names available: built-ins plus user overrides in `userDir`. */
export async function availableTemplateNames(userDir?: string): Promise<string[]> {
  const names = new Set(builtinTemplateNames())
  if (userDir) {
    try {
      for (const entry of await readdir(userDir)) {
        if (entry.endsWith(".md")) names.add(entry.slice(0, -3))
      }
    } catch {
      // user template directory may not exist — ignore
    }
  }
  return [...names].sort()
}

/**
 * Resolve a template by name. A user override at `<userDir>/<name>.md` takes
 * precedence over the built-in. Throws with the available list if not found.
 */
export async function resolveTemplate(name: string, userDir?: string): Promise<Template> {
  if (userDir) {
    const file = Bun.file(join(userDir, `${name}.md`))
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
