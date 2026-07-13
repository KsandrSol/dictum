/** Install Dictum's explicit `$dictum` Codex skill without clobbering user work. */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import skillSource from "./skills/dictum/SKILL.md" with { type: "text" }
import skillMetadata from "./skills/dictum/agents/openai.yaml" with { type: "text" }

export const DICTUM_SKILL_MARKER = "<!-- Managed by the Dictum CLI. -->"
export const DICTUM_SKILL_SOURCE = skillSource
export const DICTUM_SKILL_METADATA = skillMetadata

export type SkillInstallResult = "installed" | "updated" | "unchanged"

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (err) {
    if (errorCode(err) === "ENOENT") return undefined
    throw err
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  let mode = 0o644
  try {
    mode = (await stat(path)).mode & 0o777
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err
  }

  const temporary = join(
    dirname(path),
    `.${path.split("/").at(-1) ?? "dictum"}.${process.pid}.${Date.now()}.tmp`,
  )
  await writeFile(temporary, contents, { mode })
  await rename(temporary, path)
}

function assertManagedOrAbsent(existingSkill: string | undefined, skillPath: string): void {
  if (existingSkill !== undefined && !existingSkill.includes(DICTUM_SKILL_MARKER)) {
    throw new Error(
      `Refusing to overwrite an unmanaged Codex skill at ${skillPath}. Move it or install Dictum under a different user account.`,
    )
  }
}

/** Validate the target before setup mutates the independent hooks file. */
export async function assertCodexSkillInstallable(skillDir: string): Promise<void> {
  const skillPath = join(skillDir, "SKILL.md")
  assertManagedOrAbsent(await readOptional(skillPath), skillPath)
}

/**
 * Install or update the managed user skill at `skillDir`.
 *
 * An unrelated skill with the same name is never overwritten. Updates are
 * allowed only when the existing SKILL.md carries Dictum's management marker.
 */
export async function installCodexSkill(skillDir: string): Promise<SkillInstallResult> {
  const skillPath = join(skillDir, "SKILL.md")
  const metadataPath = join(skillDir, "agents", "openai.yaml")
  const existingSkill = await readOptional(skillPath)
  const existingMetadata = await readOptional(metadataPath)

  assertManagedOrAbsent(existingSkill, skillPath)

  if (existingSkill === DICTUM_SKILL_SOURCE && existingMetadata === DICTUM_SKILL_METADATA) {
    return "unchanged"
  }

  await atomicWrite(skillPath, DICTUM_SKILL_SOURCE)
  await atomicWrite(metadataPath, DICTUM_SKILL_METADATA)
  return existingSkill === undefined ? "installed" : "updated"
}

export const LEGACY_GUIDANCE_BEGIN = "# >>> dictum-codex >>>"
export const LEGACY_GUIDANCE_END = "# <<< dictum-codex <<<"

/**
 * Remove the v0.1.x installer's marker-guarded guidance block from Codex's
 * AGENTS.md. Its plain-text 1/2/3 instructions conflict with the four-choice
 * native review panel; the rest of the file is preserved. Returns true when
 * a block was found and removed.
 */
export async function removeLegacyCodexGuidance(path: string): Promise<boolean> {
  const existing = await readOptional(path)
  if (existing === undefined) return false
  const lines = existing.split("\n")
  const beginIdx = lines.findIndex((l) => l.trim() === LEGACY_GUIDANCE_BEGIN)
  const endIdx = lines.findIndex((l) => l.trim() === LEGACY_GUIDANCE_END)
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return false
  // Also drop the single blank separator the old installer wrote above the block.
  const from = beginIdx > 0 && lines[beginIdx - 1]?.trim() === "" ? beginIdx - 1 : beginIdx
  const cleaned = [...lines.slice(0, from), ...lines.slice(endIdx + 1)].join("\n")
  await atomicWrite(path, cleaned)
  return true
}
