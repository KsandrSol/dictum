import { describe, expect, test } from "bun:test"
import { buildJsonEnvelope, parseCliArgs, scoreLine } from "../src/cli.ts"

describe("parseCliArgs", () => {
  test("defaults to the run command", () => {
    const o = parseCliArgs([])
    expect(o.command).toBe("run")
    expect(o.error).toBeUndefined()
    expect(o.stdout).toBe(false)
    expect(o.raw).toBe(false)
    expect(o.input).toBeUndefined()
    expect(o.mode).toBeUndefined()
  })

  test("--version short and long", () => {
    expect(parseCliArgs(["--version"]).command).toBe("version")
    expect(parseCliArgs(["-v"]).command).toBe("version")
  })

  test("--help short and long", () => {
    expect(parseCliArgs(["--help"]).command).toBe("help")
    expect(parseCliArgs(["-h"]).command).toBe("help")
  })

  test("doctor subcommand", () => {
    const o = parseCliArgs(["doctor"])
    expect(o.command).toBe("doctor")
    expect(o.error).toBeUndefined()
  })

  test("--input with -i alias", () => {
    expect(parseCliArgs(["--input", "a.wav"]).input).toBe("a.wav")
    expect(parseCliArgs(["-i", "b.wav"]).input).toBe("b.wav")
  })

  test("--stdout and --raw flags", () => {
    const o = parseCliArgs(["--stdout", "--raw"])
    expect(o.stdout).toBe(true)
    expect(o.raw).toBe(true)
  })

  test("--text with -t alias carries the text input", () => {
    expect(parseCliArgs(["--text", "fix the bug"]).text).toBe("fix the bug")
    expect(parseCliArgs(["-t", "draft"]).text).toBe("draft")
  })

  test("text defaults to undefined and auto to false", () => {
    const o = parseCliArgs([])
    expect(o.text).toBeUndefined()
    expect(o.auto).toBe(false)
  })

  test("--auto flag", () => {
    expect(parseCliArgs(["--auto"]).auto).toBe(true)
  })

  test("--input and --text together is an error", () => {
    const o = parseCliArgs(["--input", "a.wav", "--text", "hi"])
    expect(o.error).toBeDefined()
    expect(o.error).toContain("either --input or --text")
  })

  test("-m / --mode / --template select the template", () => {
    expect(parseCliArgs(["-m", "commit"]).mode).toBe("commit")
    expect(parseCliArgs(["--mode", "note"]).mode).toBe("note")
    expect(parseCliArgs(["--template", "agent-prompt"]).mode).toBe("agent-prompt")
  })

  test("--mode wins over --template when both are given", () => {
    const o = parseCliArgs(["--mode", "commit", "--template", "note"])
    expect(o.mode).toBe("commit")
  })

  test("unknown command yields an error", () => {
    const o = parseCliArgs(["frobnicate"])
    expect(o.error).toBeDefined()
    expect(o.error).toContain("Unknown command")
  })

  test("unknown flag yields an error", () => {
    const o = parseCliArgs(["--definitely-not-a-flag"])
    expect(o.error).toBeDefined()
  })

  test("--format defaults to text and accepts json", () => {
    expect(parseCliArgs([]).format).toBe("text")
    expect(parseCliArgs(["--format", "text"]).format).toBe("text")
    expect(parseCliArgs(["--format", "json"]).format).toBe("json")
  })

  test("--format rejects unknown values with a helpful message", () => {
    const o = parseCliArgs(["--format", "yaml"])
    expect(o.error).toContain("Unknown format 'yaml'")
    expect(o.error).toContain("text, json")
  })
})

const MESSY = "эм ну вот короче надо это самое поправить там багу как бы"
const CLEAN = [
  "Fix the flaky VAD test in tests/vad.test.ts: it fails when silenceTimeout is 2.0.",
  "- Reproduce with bun test vad",
  "Done when bun test passes.",
].join("\n")

describe("buildJsonEnvelope", () => {
  test("carries the v1 contract fields", () => {
    const e = buildJsonEnvelope(MESSY, CLEAN, "agent-prompt")
    expect(e.v).toBe(1)
    expect(e.original).toBe(MESSY)
    expect(e.polished).toBe(CLEAN)
    expect(e.template).toBe("agent-prompt")
    expect(Object.keys(e.score.dimensions)).toHaveLength(5)
    expect(e.rationale.length).toBeGreaterThan(0)
  })

  test("score.after exceeds score.before when polishing improved the draft", () => {
    const e = buildJsonEnvelope(MESSY, CLEAN, "agent-prompt")
    expect(e.score.after).toBeGreaterThan(e.score.before)
  })

  test("identical texts yield identical before/after scores", () => {
    const e = buildJsonEnvelope(CLEAN, CLEAN, "agent-prompt")
    expect(e.score.after).toBe(e.score.before)
  })
})

describe("scoreLine", () => {
  test("shows the total delta and the most-improved dimensions", () => {
    const line = scoreLine(MESSY, CLEAN)
    expect(line).toMatch(/^score \d+ → \d+ · /)
    expect(line).toMatch(/\+\d/)
  })

  test("no gains — just the scores, no dimension tail", () => {
    const line = scoreLine(CLEAN, CLEAN)
    expect(line).toMatch(/^score \d+ → \d+$/)
  })
})
