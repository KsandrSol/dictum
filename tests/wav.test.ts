import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { isCanonical, parseWavFormat } from "../src/recorder/wav.ts"

const FIXTURE = new URL("./fixtures/sample-ru.wav", import.meta.url).pathname

describe("wav parsing", () => {
  test("parses the canonical fixture header", () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE))
    const fmt = parseWavFormat(bytes)
    expect(fmt.audioFormat).toBe(1)
    expect(fmt.channels).toBe(1)
    expect(fmt.sampleRate).toBe(16000)
    expect(fmt.bitsPerSample).toBe(16)
    expect(isCanonical(fmt)).toBe(true)
  })

  test("rejects non-RIFF input", () => {
    expect(() => parseWavFormat(new Uint8Array([1, 2, 3, 4]))).toThrow(/Not a RIFF/)
  })

  test("isCanonical false for 44.1k stereo", () => {
    expect(isCanonical({ audioFormat: 1, channels: 2, sampleRate: 44100, bitsPerSample: 16 })).toBe(
      false,
    )
  })
})
