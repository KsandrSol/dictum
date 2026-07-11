import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

describe("resolveTemplate — traversal guard", () => {
  const ATTACKS = [
    "../../README",
    "..",
    "../x",
    "..\\..\\README",
    "/etc/passwd",
    "a/b",
    "a\\b",
    "",
    ".hidden",
  ]

  test("path-like and traversal names are rejected with a clear error", async () => {
    for (const name of ATTACKS) {
      await expect(resolveTemplate(name, "tests/fixtures")).rejects.toThrow(/Invalid template name/)
    }
  })

  test("traversal is rejected even without a user dir", async () => {
    await expect(resolveTemplate("../../README")).rejects.toThrow(/Invalid template name/)
  })

  test("legitimate names still resolve: built-ins and user overrides", async () => {
    expect((await resolveTemplate("commit")).name).toBe("commit")
    const { dir, cleanup } = withUserDir({ "my-mode.v2.md": "Custom body." })
    try {
      expect((await resolveTemplate("my-mode.v2", dir)).instruction).toBe("Custom body.")
    } finally {
      cleanup()
    }
  })
})

describe("availableTemplateNames ↔ resolveTemplate consistency", () => {
  test("invalid stems (unicode, spaces, dots) are not advertised", async () => {
    const { dir, cleanup } = withUserDir({
      "русский.md": "b",
      "my template.md": "b",
      "..sneaky.md": "b",
      ".hidden.md": "b",
      "good-slug.v2.md": "b",
    })
    try {
      const names = await availableTemplateNames(dir)
      expect(names).toContain("good-slug.v2")
      for (const bad of ["русский", "my template", "..sneaky", ".hidden"]) {
        expect(names).not.toContain(bad)
      }
    } finally {
      cleanup()
    }
  })

  test("every advertised name resolves (listing and resolver share the validator)", async () => {
    const { dir, cleanup } = withUserDir({
      "custom.md": "Custom.",
      "не-слаг.md": "b",
    })
    try {
      for (const name of await availableTemplateNames(dir)) {
        const t = await resolveTemplate(name, dir)
        expect(t.name).toBe(name)
      }
    } finally {
      cleanup()
    }
  })
})

describe("resolver hardening: prototype names, directories, reserved names", () => {
  test("Object.prototype member names miss cleanly (no TypeError)", async () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      await expect(resolveTemplate(name)).rejects.toThrow(/Unknown template/)
    }
  })

  test("a directory named *.md is not advertised as a template", async () => {
    const { dir, cleanup } = withUserDir({})
    try {
      mkdirSync(join(dir, "folder.md"))
      const names = await availableTemplateNames(dir)
      expect(names).not.toContain("folder")
    } finally {
      cleanup()
    }
  })

  test("Windows reserved device names are rejected and never advertised", async () => {
    const { dir, cleanup } = withUserDir({ "CON.md": "b", "nul.md": "b", "com1.md": "b" })
    try {
      for (const name of ["CON", "nul", "com1", "LPT9", "aux.backup"]) {
        await expect(resolveTemplate(name, dir)).rejects.toThrow(/Invalid template name/)
      }
      const names = await availableTemplateNames(dir)
      for (const bad of ["CON", "nul", "com1"]) expect(names).not.toContain(bad)
    } finally {
      cleanup()
    }
  })
})
