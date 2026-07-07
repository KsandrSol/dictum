import { describe, expect, test } from "bun:test"
import {
  builtinTemplateNames,
  parseTemplate,
  resolveBuiltinTemplate,
} from "../src/polisher/templates.ts"

describe("template parsing", () => {
  test("parses frontmatter and body", () => {
    const raw = [
      "---",
      "description: Hello there",
      'language: "ru"',
      "---",
      "Do the thing.",
      "",
    ].join("\n")
    const t = parseTemplate("x", raw)
    expect(t.name).toBe("x")
    expect(t.description).toBe("Hello there")
    expect(t.language).toBe("ru")
    expect(t.instruction).toBe("Do the thing.")
  })

  test("defaults when frontmatter is absent", () => {
    const t = parseTemplate("y", "just a body")
    expect(t.description).toBe("")
    expect(t.language).toBe("auto")
    expect(t.instruction).toBe("just a body")
  })
})

describe("built-in templates", () => {
  test("agent-prompt is available and well-formed", () => {
    expect(builtinTemplateNames()).toContain("agent-prompt")
    const t = resolveBuiltinTemplate("agent-prompt")
    expect(t.description.length).toBeGreaterThan(0)
    expect(t.instruction.length).toBeGreaterThan(50)
    expect(t.instruction.endsWith("Transcript:")).toBe(true)
  })

  test("agent-prompt follows the canon: task lead, structure, explicit output, no guessing", () => {
    const t = resolveBuiltinTemplate("agent-prompt")
    expect(t.instruction).toContain("Lead with the task")
    expect(t.instruction).toContain("bulleted list")
    expect(t.instruction).toContain("Never invent details")
    expect(t.instruction).toContain("Open question:")
    expect(t.instruction).toContain("Output ONLY the rewritten prompt")
  })

  test("spec template expands a thought into a spec with acceptance criteria", () => {
    expect(builtinTemplateNames()).toContain("spec")
    const t = resolveBuiltinTemplate("spec")
    expect(t.description.length).toBeGreaterThan(0)
    expect(t.instruction).toContain("## Task")
    expect(t.instruction).toContain("## Acceptance criteria")
    expect(t.instruction).toContain("## Open questions")
    expect(t.instruction).toContain("never invent requirements")
    expect(t.instruction.endsWith("Transcript:")).toBe(true)
  })

  test("decompose template breaks a task into ordered, dependency-tracked subtasks", () => {
    expect(builtinTemplateNames()).toContain("decompose")
    const t = resolveBuiltinTemplate("decompose")
    expect(t.description.length).toBeGreaterThan(0)
    expect(t.instruction).toContain("## Subtasks")
    expect(t.instruction).toContain("Depends on")
    expect(t.instruction).toContain("## Open questions")
    expect(t.instruction).toContain("never invent subtasks")
    expect(t.instruction.endsWith("Transcript:")).toBe(true)
  })

  test("every built-in ends with the Transcript: input marker", () => {
    for (const name of builtinTemplateNames()) {
      const t = resolveBuiltinTemplate(name)
      expect(t.instruction.endsWith("Transcript:")).toBe(true)
    }
  })

  test("unknown template throws with the available list", () => {
    expect(() => resolveBuiltinTemplate("nope")).toThrow(/Unknown template 'nope'/)
  })
})
