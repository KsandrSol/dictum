import { describe, expect, test } from "bun:test"
import { ClipboardSink } from "../src/sink/clipboard.ts"
import { VALID_SINKS, createSink } from "../src/sink/factory.ts"
import { StdoutSink } from "../src/sink/stdout.ts"

describe("createSink", () => {
  test("builds the clipboard sink", () => {
    expect(createSink("clipboard")).toBeInstanceOf(ClipboardSink)
  })

  test("builds the stdout sink", () => {
    expect(createSink("stdout")).toBeInstanceOf(StdoutSink)
  })

  test("rejects an unknown sink with a helpful message", () => {
    expect(() => createSink("printer")).toThrow(/Unknown sink 'printer'\. Valid: clipboard, stdout/)
  })

  test("VALID_SINKS is the source of truth", () => {
    expect([...VALID_SINKS]).toEqual(["clipboard", "stdout"])
  })
})
