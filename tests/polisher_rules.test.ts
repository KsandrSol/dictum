import { describe, expect, test } from "bun:test"
import { analyzePrompt, normalizeText } from "../src/polisher/rules.ts"

/** A messy dictated draft: fillers, false starts, vague references, no structure. */
const MESSY_RU =
  "эм ну вот короче надо это самое поправить там багу ну в общем чтобы работало как бы нормально ну ты понял"

/** A clean, structured prompt: imperative lead, concrete details, acceptance criteria. */
const CLEAN_EN = [
  "Fix the flaky VAD test in tests/vad.test.ts: it fails when silenceTimeout is 2.0.",
  "- Reproduce with bun test vad",
  "- Keep the energyThreshold default",
  "Done when bun test passes.",
].join("\n")

describe("analyzePrompt", () => {
  test("is deterministic", () => {
    expect(analyzePrompt(MESSY_RU)).toEqual(analyzePrompt(MESSY_RU))
  })

  test("score is 0–100 and dimensions are 0–10", () => {
    for (const text of [MESSY_RU, CLEAN_EN, "fix it", "a"]) {
      const a = analyzePrompt(text)
      expect(a.score).toBeGreaterThanOrEqual(0)
      expect(a.score).toBeLessThanOrEqual(100)
      for (const v of Object.values(a.dimensions)) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(10)
      }
    }
  })

  test("a messy dictated draft scores clearly below a clean structured prompt", () => {
    const messy = analyzePrompt(MESSY_RU)
    const clean = analyzePrompt(CLEAN_EN)
    expect(messy.score).toBeLessThanOrEqual(45)
    expect(clean.score).toBeGreaterThanOrEqual(70)
    expect(messy.score).toBeLessThan(clean.score)
  })

  test("weak dimensions produce ordered human-readable issues", () => {
    const messy = analyzePrompt(MESSY_RU)
    expect(messy.issues.length).toBeGreaterThan(0)
    // worst dimension first
    const scores = messy.issues.map((i) => Number(/(\d+)\/10/.exec(i)?.[1]))
    expect([...scores].sort((a, b) => a - b)).toEqual(scores)
  })

  test("empty text scores zero with an explicit issue", () => {
    const a = analyzePrompt("   ")
    expect(a.score).toBe(0)
    expect(a.issues).toEqual(["empty prompt"])
  })
})

describe("analyzePrompt — analytical task verbs", () => {
  test("an analytical lead counts as task-first structure", () => {
    const withVerb = analyzePrompt("Разбери, как пайплайн обрабатывает черновик")
    const noVerb = analyzePrompt("Пайплайн обрабатывает черновик по шагам")
    expect(withVerb.dimensions.structure).toBeGreaterThan(noVerb.dimensions.structure)
    expect(withVerb.dimensions.actionability).toBeGreaterThan(noVerb.dimensions.actionability)
  })

  test("ru analytical imperatives earn the actionability verb bonus", () => {
    const leads = [
      "Разбери",
      "Покажи",
      "Проанализируй",
      "Опиши",
      "Объясни",
      "Расскажи",
      "Оцени",
      "Сравни",
      "Уточни",
      "Сформулируй",
      "Исследуй",
      "Изучи",
      "Проработай",
    ]
    for (const lead of leads) {
      const a = analyzePrompt(`${lead} пайплайн распознавания`)
      expect(a.dimensions.actionability).toBeGreaterThanOrEqual(4)
    }
  })

  test("en analytical imperatives earn the actionability verb bonus", () => {
    const leads = [
      "Explain",
      "Describe",
      "Analyze",
      "Show",
      "Summarize",
      "Compare",
      "Evaluate",
      "Clarify",
    ]
    for (const lead of leads) {
      const a = analyzePrompt(`${lead} the recorder pipeline`)
      expect(a.dimensions.actionability).toBeGreaterThanOrEqual(4)
    }
  })

  test("noun lookalikes (разбор, показатель, описание) stay unmatched", () => {
    const a = analyzePrompt("Разбор полётов, показатель качества и описание системы")
    expect(a.dimensions.actionability).toBe(0)
  })

  test("regression: the analytical polish from the live run is task-first again", () => {
    // Before this fix «Разбери…» lost the task-lead bonus that «Проверим…» got.
    const a = analyzePrompt("Разбери, как Dictum отработал этот прогон")
    expect(a.dimensions.structure).toBeGreaterThanOrEqual(7)
    expect(a.dimensions.actionability).toBeGreaterThanOrEqual(4)
  })
})

describe("normalizeText", () => {
  test("strips unambiguous filler interjections (ru + en)", () => {
    expect(normalizeText("эм, сделай рефакторинг")).toBe("Сделай рефакторинг")
    expect(normalizeText("um, fix the bug")).toBe("Fix the bug")
    expect(normalizeText("ммм эээ добавь тест")).toBe("Добавь тест")
  })

  test("keeps meaning-bearing words and concrete details", () => {
    // conservative: «ну» can carry meaning, so it survives (capitalized as first word)
    expect(normalizeText("ну сделай тест для src/cli.ts с таймаутом 60")).toBe(
      "Ну сделай тест для src/cli.ts с таймаутом 60",
    )
  })

  test("does not eat filler-lookalikes inside words", () => {
    // "мм" inside "программу", "err" inside "error" must survive
    expect(normalizeText("обнови программу")).toBe("Обнови программу")
    expect(normalizeText("log the error")).toBe("Log the error")
  })

  test("collapses duplicated words and whitespace", () => {
    expect(normalizeText("это это надо   надо сделать")).toBe("Это надо сделать")
  })

  test("preserves newlines but collapses 3+ into a blank line", () => {
    expect(normalizeText("line one\n\n\n\nline two")).toBe("Line one\n\nline two")
  })

  test("capitalizes the first letter and trims", () => {
    expect(normalizeText("  fix the bug  ")).toBe("Fix the bug")
  })

  test("empty input stays empty", () => {
    expect(normalizeText("")).toBe("")
    expect(normalizeText("   ")).toBe("")
  })
})
