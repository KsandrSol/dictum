import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { availableTemplateNames, resolveTemplate } from "../src/polisher/templates.ts"

function withUserDir(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dictum-tpl-"))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("resolveTemplate", () => {
  test("resolves a built-in when no user dir", async () => {
    const t = await resolveTemplate("agent-prompt")
    expect(t.name).toBe("agent-prompt")
    expect(t.instruction.length).toBeGreaterThan(0)
  })

  test("built-ins commit and note exist", async () => {
    expect((await resolveTemplate("commit")).name).toBe("commit")
    expect((await resolveTemplate("note")).name).toBe("note")
  })

  test("user override takes precedence over a built-in", async () => {
    const { dir, cleanup } = withUserDir({
      "agent-prompt.md": "---\ndescription: mine\nlanguage: en\n---\nMy custom instruction.",
    })
    try {
      const t = await resolveTemplate("agent-prompt", dir)
      expect(t.description).toBe("mine")
      expect(t.instruction).toBe("My custom instruction.")
    } finally {
      cleanup()
    }
  })

  test("user-only template resolves", async () => {
    const { dir, cleanup } = withUserDir({ "haiku.md": "Write a haiku." })
    try {
      const t = await resolveTemplate("haiku", dir)
      expect(t.name).toBe("haiku")
      expect(t.instruction).toBe("Write a haiku.")
    } finally {
      cleanup()
    }
  })

  test("unknown template throws with the available list (incl. user templates)", async () => {
    const { dir, cleanup } = withUserDir({ "custom.md": "x" })
    try {
      await expect(resolveTemplate("nope", dir)).rejects.toThrow(
        /Unknown template 'nope'\. Available:.*agent-prompt.*commit.*custom.*note/,
      )
    } finally {
      cleanup()
    }
  })

  test("missing user dir is ignored, falls back to built-in", async () => {
    const t = await resolveTemplate("commit", "/no/such/dir/xyz")
    expect(t.name).toBe("commit")
  })
})

describe("availableTemplateNames", () => {
  test("lists built-ins sorted", async () => {
    expect(await availableTemplateNames()).toEqual([
      "agent-prompt",
      "commit",
      "decompose",
      "note",
      "spec",
    ])
  })

  test("merges user templates", async () => {
    const { dir, cleanup } = withUserDir({ "zeta.md": "z", "alpha.md": "a", "ignore.txt": "x" })
    try {
      const names = await availableTemplateNames(dir)
      expect(names).toContain("zeta")
      expect(names).toContain("alpha")
      expect(names).not.toContain("ignore")
      expect(names).toContain("agent-prompt")
    } finally {
      cleanup()
    }
  })
})
