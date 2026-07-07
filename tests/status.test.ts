import { describe, expect, test } from "bun:test"
import type { StageEvent } from "../src/core/pipeline.ts"
import {
  StatusReporter,
  type StatusStream,
  formatDuration,
  renderStageLine,
} from "../src/ui/status.ts"

class Capture implements StatusStream {
  out = ""
  isTTY: boolean
  constructor(isTTY = false) {
    this.isTTY = isTTY
  }
  write(s: string): unknown {
    this.out += s
    return true
  }
}

describe("formatDuration", () => {
  test("sub-second in ms, else seconds", () => {
    expect(formatDuration(340)).toBe("340ms")
    expect(formatDuration(1200)).toBe("1.2s")
    expect(formatDuration(0)).toBe("0ms")
  })

  test("invalid durations render empty", () => {
    expect(formatDuration(-5)).toBe("")
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("")
  })
})

describe("renderStageLine", () => {
  test("active stages show glyph + label + ellipsis", () => {
    expect(renderStageLine({ stage: "recording" })).toBe("● recording…")
    expect(renderStageLine({ stage: "transcribing" })).toBe("◌ transcribing…")
    expect(renderStageLine({ stage: "polishing" })).toBe("✦ polishing…")
  })

  test("completed stages show check + past-tense label + timing", () => {
    expect(renderStageLine({ stage: "transcribing", durationMs: 1300 })).toBe("✓ transcribed 1.3s")
    expect(renderStageLine({ stage: "emitting", durationMs: 12 })).toBe("✓ copied 12ms")
  })

  test("emit label is overridable (e.g. 'emitted' for stdout)", () => {
    expect(renderStageLine({ stage: "emitting", durationMs: 12 }, "emitted")).toBe("✓ emitted 12ms")
    // non-emit stages ignore the override
    expect(renderStageLine({ stage: "polishing", durationMs: 100 }, "emitted")).toBe(
      "✓ polished 100ms",
    )
  })

  test("done stage renders nothing", () => {
    expect(renderStageLine({ stage: "done" })).toBeNull()
  })
})

describe("StatusReporter", () => {
  const sequence: StageEvent[] = [
    { stage: "recording" },
    { stage: "recording", durationMs: 800 },
    { stage: "transcribing" },
    { stage: "transcribing", durationMs: 13000 },
    { stage: "polishing" },
    { stage: "polishing", durationMs: 15000 },
    { stage: "emitting" },
    { stage: "emitting", durationMs: 5 },
    { stage: "done" },
  ]

  test("non-TTY prints only completed stages, one per line", () => {
    const cap = new Capture(false)
    const r = new StatusReporter(cap)
    for (const e of sequence) r.onStage(e)
    expect(cap.out).toBe("✓ recorded 800ms\n✓ transcribed 13.0s\n✓ polished 15.0s\n✓ copied 5ms\n")
  })

  test("TTY updates in place and clears the line for active stages", () => {
    const cap = new Capture(true)
    const r = new StatusReporter(cap)
    r.onStage({ stage: "recording" })
    expect(cap.out).toContain("● recording…")
    expect(cap.out).toContain("\x1b[2K") // line-clear escape
    expect(cap.out.endsWith("\n")).toBe(false) // active line has no newline
  })

  test("explicit tty override wins over stream.isTTY", () => {
    const cap = new Capture(false)
    const r = new StatusReporter(cap, { tty: true })
    r.onStage({ stage: "recording", durationMs: 100 })
    expect(cap.out).toContain("\x1b[2K")
    expect(cap.out.endsWith("\n")).toBe(true) // completed line ends with newline
  })

  test("emitLabel option flows through to the emit line", () => {
    const cap = new Capture(false)
    const r = new StatusReporter(cap, { emitLabel: "emitted" })
    r.onStage({ stage: "emitting", durationMs: 5 })
    expect(cap.out).toBe("✓ emitted 5ms\n")
  })
})
