import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Architectural guard: the pluggable modules (recorder/stt/polisher/sink) must
 * import ONLY from `core/types.ts`, their own directory (`./...`), Node/Bun
 * built-ins, or third-party packages. They must never import a sibling module,
 * `config.ts`, or `core/pipeline.ts`. Assembly happens only in cli.ts/pipeline.
 */

const SRC = new URL("../src/", import.meta.url).pathname
const MODULE_DIRS = ["recorder", "stt", "polisher", "sink"]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith(".ts")) out.push(full)
  }
  return out
}

function importSources(code: string): string[] {
  const sources: string[] = []
  const re = /(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/g
  for (const m of code.matchAll(re)) if (m[1]) sources.push(m[1])
  // also bare side-effect imports: import "x"
  const re2 = /(?:^|\n)\s*import\s*["']([^"']+)["']/g
  for (const m of code.matchAll(re2)) if (m[1]) sources.push(m[1])
  return sources
}

function isAllowed(source: string): boolean {
  if (source.startsWith("node:")) return true
  if (!source.startsWith(".")) return true // bare package (e.g. smol-toml)
  if (source.startsWith("./")) return true // same module dir or subdir
  if (source === "../core/types.ts") return true
  return false
}

describe("module orthogonality", () => {
  for (const mod of MODULE_DIRS) {
    test(`${mod}/* imports only core/types, own files, builtins, packages`, () => {
      const files = walk(join(SRC, mod))
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        const code = readFileSync(file, "utf8")
        for (const source of importSources(code)) {
          if (!isAllowed(source)) {
            throw new Error(`Illegal cross-module import in ${file}: "${source}"`)
          }
        }
      }
    })
  }
})
