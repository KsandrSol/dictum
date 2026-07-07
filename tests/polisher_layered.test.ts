import { describe, expect, test } from "bun:test"
import type { Polisher, Template } from "../src/core/types.ts"
import { LayeredPolisher, RulesPolisher } from "../src/polisher/layered.ts"

const template: Template = {
  name: "agent-prompt",
  description: "",
  language: "auto",
  instruction: "Rewrite.",
}

/** Inner polisher that records calls and returns a marker. */
class SpyPolisher implements Polisher {
  calls: string[] = []
  async polish(text: string, _template: Template): Promise<string> {
    this.calls.push(text)
    return "LLM_RESULT"
  }
}

const MESSY = "эм ну вот короче надо это самое поправить там багу как бы"
const CLEAN = [
  "Fix the flaky VAD test in tests/vad.test.ts: it fails when silenceTimeout is 2.0.",
  "- Reproduce with bun test vad",
  "Done when bun test passes.",
].join("\n")

describe("RulesPolisher", () => {
  test("returns the normalized text without any LLM", async () => {
    const p = new RulesPolisher()
    expect(await p.polish("эм, сделай рефакторинг", template)).toBe("Сделай рефакторинг")
  })
})

describe("LayeredPolisher", () => {
  test("high-scoring draft skips the LLM (offline fast path)", async () => {
    const inner = new SpyPolisher()
    const layered = new LayeredPolisher(inner, { scoreThreshold: 50 })
    const out = await layered.polish(CLEAN, template)
    expect(inner.calls).toEqual([])
    expect(out).toContain("tests/vad.test.ts") // normalized original, not LLM output
  })

  test("low-scoring draft goes to the wrapped LLM with the original text", async () => {
    const inner = new SpyPolisher()
    const layered = new LayeredPolisher(inner, { scoreThreshold: 50 })
    const out = await layered.polish(MESSY, template)
    expect(inner.calls).toEqual([MESSY])
    expect(out).toBe("LLM_RESULT")
  })

  test("threshold above any score forces the LLM path even for clean text", async () => {
    const inner = new SpyPolisher()
    const layered = new LayeredPolisher(inner, { scoreThreshold: 101 })
    expect(await layered.polish(CLEAN, template)).toBe("LLM_RESULT")
    expect(inner.calls).toEqual([CLEAN])
  })
})
