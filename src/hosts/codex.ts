/** Codex hook and skill integration without clobbering user-owned configuration. */

import { join } from "node:path"
import {
  type FileUpdateResult,
  type JsonObject,
  type ManagedFileState,
  assertManagedFileInstallable,
  atomicWrite,
  mergeUserPromptSubmitHook,
  readOptional,
  removeMarkedBlock,
  shellQuote,
  updateJsonObjectFile,
  validateBinaryPath,
} from "./shared.ts"
import skillSource from "./skills/dictum/SKILL.md" with { type: "text" }
import skillMetadata from "./skills/dictum/agents/openai.yaml" with { type: "text" }

export {
  type CodexHookInput,
  type CodexHookOutput,
  type DictumCodexMode,
  type DictumInvocation,
  codexHookOutput,
  parseDictumInvocation,
  runCodexHookFromStdin,
} from "./prompt-hook.ts"

export const DICTUM_CODEX_HOOK_STATUS_MESSAGE = "Routing Dictum prompt"

function hookHandler(binaryPath: string): JsonObject {
  return {
    type: "command",
    command: `${shellQuote(binaryPath)} prompt-hook`,
    timeout: 10,
    statusMessage: DICTUM_CODEX_HOOK_STATUS_MESSAGE,
  }
}

function isManagedDictumHandler(candidate: JsonObject): boolean {
  return (
    candidate.type === "command" &&
    candidate.statusMessage === DICTUM_CODEX_HOOK_STATUS_MESSAGE &&
    typeof candidate.command === "string" &&
    (candidate.command.endsWith(" prompt-hook") || candidate.command.endsWith(" codex-hook"))
  )
}

/** Merge Dictum into Codex hooks.json without disturbing other hook groups. */
export async function installCodexHook(
  path: string,
  binaryPath: string,
): Promise<FileUpdateResult> {
  if (!path) throw new Error("Codex hooks path must be non-empty.")
  validateBinaryPath(binaryPath)
  const handler = hookHandler(binaryPath)
  return updateJsonObjectFile(path, "Codex hook", (document) =>
    mergeUserPromptSubmitHook(document, handler, isManagedDictumHandler, path, "Codex hook"),
  )
}

export const DICTUM_SKILL_MARKER = "<!-- Managed by the Dictum CLI. -->"
export const DICTUM_SKILL_SOURCE = skillSource
export const DICTUM_SKILL_METADATA = skillMetadata
export type SkillInstallResult = ManagedFileState

/** Validate the target before setup mutates the independent hooks file. */
export async function assertCodexSkillInstallable(skillDir: string): Promise<void> {
  await assertManagedFileInstallable(join(skillDir, "SKILL.md"), DICTUM_SKILL_MARKER, "Codex skill")
}

/** Install or update the managed user skill at `skillDir`. */
export async function installCodexSkill(skillDir: string): Promise<SkillInstallResult> {
  const skillPath = join(skillDir, "SKILL.md")
  const metadataPath = join(skillDir, "agents", "openai.yaml")
  await assertCodexSkillInstallable(skillDir)
  const existingSkill = await readOptional(skillPath)
  const existingMetadata = await readOptional(metadataPath)
  if (existingSkill === DICTUM_SKILL_SOURCE && existingMetadata === DICTUM_SKILL_METADATA) {
    return "unchanged"
  }
  await atomicWrite(skillPath, DICTUM_SKILL_SOURCE)
  await atomicWrite(metadataPath, DICTUM_SKILL_METADATA)
  return existingSkill === undefined ? "installed" : "updated"
}

export const LEGACY_GUIDANCE_BEGIN = "# >>> dictum-codex >>>"
export const LEGACY_GUIDANCE_END = "# <<< dictum-codex <<<"

/** Remove the v0.1.x marker-guarded block from Codex's AGENTS.md. */
export async function removeLegacyCodexGuidance(path: string): Promise<boolean> {
  return removeMarkedBlock(path, LEGACY_GUIDANCE_BEGIN, LEGACY_GUIDANCE_END)
}
