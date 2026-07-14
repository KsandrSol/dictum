import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DICTUM_SKILL_MARKER,
  DICTUM_SKILL_METADATA,
  DICTUM_SKILL_SOURCE,
  LEGACY_GUIDANCE_BEGIN,
  LEGACY_GUIDANCE_END,
  assertCodexSkillInstallable,
  installCodexSkill,
  removeLegacyCodexGuidance,
} from "../src/hosts/codex.ts"

const temporaryRoots: string[] = []

async function temporarySkillDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dictum-skill-test-"))
  temporaryRoots.push(root)
  return join(root, ".agents", "skills", "dictum")
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe("Dictum Codex skill", () => {
  test("has valid minimal frontmatter and the explicit MCP approval workflow", () => {
    expect(DICTUM_SKILL_SOURCE).toMatch(/^---\nname: dictum\ndescription: .+\n---\n/)
    expect(DICTUM_SKILL_SOURCE).toContain(DICTUM_SKILL_MARKER)
    expect(DICTUM_SKILL_SOURCE).toContain("mcp__dictum__polish_brief")
    expect(DICTUM_SKILL_SOURCE).toContain("mcp__dictum__present_prompt")
    expect(DICTUM_SKILL_SOURCE).toContain("Only a returned decision of `act`")
    expect(DICTUM_SKILL_SOURCE).toContain("For `regenerate`")
    expect(DICTUM_SKILL_SOURCE).toContain("For `tweak`, apply the")
    expect(DICTUM_SKILL_SOURCE).toContain("For `feedback_required`")
    expect(DICTUM_SKILL_METADATA).toContain('default_prompt: "Use $dictum')
  })

  test("installs and then becomes idempotent", async () => {
    const skillDir = await temporarySkillDir()
    expect(await installCodexSkill(skillDir)).toBe("installed")
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(DICTUM_SKILL_SOURCE)
    expect(await readFile(join(skillDir, "agents", "openai.yaml"), "utf8")).toBe(
      DICTUM_SKILL_METADATA,
    )
    expect(await installCodexSkill(skillDir)).toBe("unchanged")
  })

  test("updates only a skill carrying Dictum's marker", async () => {
    const skillDir = await temporarySkillDir()
    await installCodexSkill(skillDir)
    await writeFile(join(skillDir, "SKILL.md"), `${DICTUM_SKILL_MARKER}\nold managed content\n`)
    expect(await installCodexSkill(skillDir)).toBe("updated")
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(DICTUM_SKILL_SOURCE)
  })

  test("refuses to overwrite an unrelated skill with the same name", async () => {
    const skillDir = await temporarySkillDir()
    await installCodexSkill(skillDir)
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: dictum\n---\ncustom\n")
    await expect(installCodexSkill(skillDir)).rejects.toThrow("Refusing to overwrite")
    await expect(assertCodexSkillInstallable(skillDir)).rejects.toThrow("Refusing to overwrite")
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toContain("custom")
  })
})

describe("legacy guidance cleanup", () => {
  async function temporaryGuidance(contents: string | undefined): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "dictum-guidance-test-"))
    temporaryRoots.push(root)
    const path = join(root, "AGENTS.md")
    if (contents !== undefined) await writeFile(path, contents)
    return path
  }

  const LEGACY_BLOCK = `\n${LEGACY_GUIDANCE_BEGIN}\n## Dictum shorthand\n\nold 1/2/3 instructions\n${LEGACY_GUIDANCE_END}\n`

  test("removes only the marker block and keeps user content", async () => {
    const path = await temporaryGuidance(
      `# My rules\nBe terse.\n${LEGACY_BLOCK}# After\nkeep this\n`,
    )
    expect(await removeLegacyCodexGuidance(path)).toBe(true)
    const cleaned = await readFile(path, "utf8")
    expect(cleaned).toContain("# My rules")
    expect(cleaned).toContain("Be terse.")
    expect(cleaned).toContain("keep this")
    expect(cleaned).not.toContain(LEGACY_GUIDANCE_BEGIN)
    expect(cleaned).not.toContain("old 1/2/3 instructions")
  })

  test("a file without markers is left untouched", async () => {
    const original = "# My rules\nBe terse.\n"
    const path = await temporaryGuidance(original)
    expect(await removeLegacyCodexGuidance(path)).toBe(false)
    expect(await readFile(path, "utf8")).toBe(original)
  })

  test("a missing file is a no-op", async () => {
    const path = await temporaryGuidance(undefined)
    expect(await removeLegacyCodexGuidance(path)).toBe(false)
    expect(await Bun.file(path).exists()).toBe(false)
  })

  test("a file that was only the installer block becomes empty", async () => {
    const path = await temporaryGuidance(LEGACY_BLOCK)
    expect(await removeLegacyCodexGuidance(path)).toBe(true)
    expect((await readFile(path, "utf8")).trim()).toBe("")
  })
})
