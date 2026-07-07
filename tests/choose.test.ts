import { describe, expect, test } from "bun:test"
import type { ChoiceContext } from "../src/core/types.ts"
import {
  type ChooserIo,
  formatPreview,
  interactiveChoose,
  parseChoiceKey,
} from "../src/ui/choose.ts"

describe("parseChoiceKey", () => {
  test("empty line (Enter) defaults to polished", () => {
    expect(parseChoiceKey("")).toBe("polished")
    expect(parseChoiceKey("   ")).toBe("polished")
  })

  test("o / original → original", () => {
    expect(parseChoiceKey("o")).toBe("original")
    expect(parseChoiceKey("O")).toBe("original")
    expect(parseChoiceKey("original")).toBe("original")
  })

  test("p / polished → polished", () => {
    expect(parseChoiceKey("p")).toBe("polished")
    expect(parseChoiceKey(" P ")).toBe("polished")
  })

  test("r / regenerate → regenerate", () => {
    expect(parseChoiceKey("r")).toBe("regenerate")
    expect(parseChoiceKey("Regenerate")).toBe("regenerate")
  })

  test("anything else → unknown", () => {
    expect(parseChoiceKey("x")).toBe("unknown")
    expect(parseChoiceKey("yes")).toBe("unknown")
  })
})

describe("formatPreview", () => {
  test("includes both labels and texts", () => {
    const out = formatPreview("hello", "Hello, world.")
    expect(out).toContain("your words")
    expect(out).toContain("polished")
    expect(out).toContain("hello")
    expect(out).toContain("Hello, world.")
  })

  test("renders the optional note under the polished block", () => {
    const out = formatPreview("a", "b", "score 30 → 74")
    expect(out).toContain("score 30 → 74")
    expect(out.indexOf("score 30 → 74")).toBeGreaterThan(out.indexOf("b"))
  })

  test("no note — no extra line", () => {
    expect(formatPreview("a", "b")).toBe(formatPreview("a", "b", undefined))
  })
})

/** Scripted I/O: serves queued lines, records everything written. */
function scriptedIo(lines: (string | null)[]): ChooserIo & { written: string[] } {
  const queue = [...lines]
  const written: string[] = []
  return {
    written,
    write: (s) => {
      written.push(s)
    },
    readLine: async () => (queue.length > 0 ? queue.shift()! : null),
  }
}

function ctx(overrides: Partial<ChoiceContext> = {}): ChoiceContext {
  return {
    original: "ORIG",
    polished: "POLISHED",
    regenerate: async () => "REGEN",
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe("interactiveChoose", () => {
  test("Enter accepts the polished default", async () => {
    const io = scriptedIo([""])
    expect(await interactiveChoose(ctx(), io)).toBe("POLISHED")
  })

  test("'o' returns the original", async () => {
    const io = scriptedIo(["o"])
    expect(await interactiveChoose(ctx(), io)).toBe("ORIG")
  })

  test("'p' returns the polished text", async () => {
    const io = scriptedIo(["p"])
    expect(await interactiveChoose(ctx(), io)).toBe("POLISHED")
  })

  test("EOF (null) accepts the polished default", async () => {
    const io = scriptedIo([null])
    expect(await interactiveChoose(ctx(), io)).toBe("POLISHED")
  })

  test("unknown key re-prompts, then accepts a valid choice", async () => {
    const io = scriptedIo(["huh?", "o"])
    expect(await interactiveChoose(ctx(), io)).toBe("ORIG")
    expect(io.written.some((s) => s.includes("o / p / r"))).toBe(true)
  })

  test("'r' regenerates, then the fresh polish can be accepted", async () => {
    let calls = 0
    const regenerate = async () => {
      calls++
      return "REGEN-1"
    }
    const io = scriptedIo(["r", "p"])
    const result = await interactiveChoose(ctx({ regenerate }), io)
    expect(result).toBe("REGEN-1")
    expect(calls).toBe(1)
  })

  test("'r' then 'o' keeps the original even after regenerating", async () => {
    const io = scriptedIo(["r", "o"])
    expect(await interactiveChoose(ctx(), io)).toBe("ORIG")
  })

  test("annotation is rendered and recomputed for each candidate", async () => {
    const io = scriptedIo(["r", "p"])
    const annotate = (p: string) => `note:${p}`
    await interactiveChoose(ctx({ annotate }), io)
    const all = io.written.join("")
    expect(all).toContain("note:POLISHED") // first candidate
    expect(all).toContain("note:REGEN") // fresh candidate after regenerate
  })
})
