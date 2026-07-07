import { describe, expect, test } from "bun:test"
import { type StopMode, stopHint } from "../src/ui/keys.ts"

describe("stopHint", () => {
  test("each mode has a distinct, actionable hint", () => {
    expect(stopHint("enter")).toMatch(/Enter/)
    expect(stopHint("vad")).toMatch(/silence/i)
    expect(stopHint("ptt")).toMatch(/Space/)
  })

  test("covers every stop mode", () => {
    const modes: StopMode[] = ["enter", "vad", "ptt"]
    for (const m of modes) expect(stopHint(m).length).toBeGreaterThan(0)
  })
})
