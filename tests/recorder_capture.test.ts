import { describe, expect, test } from "bun:test"
import { captureStream } from "../src/recorder/sox.ts"
import { SilenceDetector } from "../src/recorder/vad.ts"
import { isCanonical, parseWavFormat, pcmToWav } from "../src/recorder/wav.ts"

const RATE = 16000

function int16ToBytesLE(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true)
  return out
}

/** A 100ms chunk of silence or square-wave tone, as PCM16 LE bytes. */
function chunk(kind: "silence" | "tone", ms = 100): Uint8Array {
  const n = Math.round((RATE * ms) / 1000)
  const s = new Int16Array(n)
  if (kind === "tone") for (let i = 0; i < n; i++) s[i] = i % 2 === 0 ? 8000 : -8000
  return int16ToBytesLE(s)
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!)
      else controller.close()
    },
  })
}

const CHUNK_BYTES = 100 * (RATE / 1000) * 2 // 3200

describe("pcmToWav", () => {
  test("wraps PCM in a canonical 16k/mono/PCM16 header", () => {
    const pcm = int16ToBytesLE(new Int16Array([1, -1, 100, -100]))
    const wav = pcmToWav(pcm)
    expect(wav.length).toBe(44 + pcm.length)
    const fmt = parseWavFormat(wav)
    expect(isCanonical(fmt)).toBe(true)
    expect(fmt.sampleRate).toBe(16000)
    expect(fmt.channels).toBe(1)
    expect(fmt.bitsPerSample).toBe(16)
    // data payload preserved
    expect([...wav.slice(44)]).toEqual([...pcm])
  })
})

describe("captureStream", () => {
  test("without VAD, consumes the whole stream", async () => {
    const chunks = [chunk("tone"), chunk("tone"), chunk("silence")]
    const out = await captureStream(streamOf(chunks), {
      signal: new AbortController().signal,
      maxBytes: 1e9,
    })
    expect(out.length).toBe(3 * CHUNK_BYTES)
  })

  test("VAD stops early after trailing silence", async () => {
    // 200ms tone then 1s silence; endpoint at ~0.5s silence → ~7 chunks.
    const chunks = [
      chunk("tone"),
      chunk("tone"),
      ...Array.from({ length: 10 }, () => chunk("silence")),
    ]
    const total = chunks.length * CHUNK_BYTES
    const out = await captureStream(streamOf(chunks), {
      signal: new AbortController().signal,
      maxBytes: 1e9,
      vad: new SilenceDetector({ sampleRate: RATE, silenceTimeoutSec: 0.5, minSpeechMs: 100 }),
    })
    expect(out.length).toBeLessThan(total) // stopped before consuming all silence
    expect(out.length).toBeGreaterThan(2 * CHUNK_BYTES) // consumed tone + some silence
    // ~ 200ms speech + 500ms silence = 700ms = 7 chunks
    expect(out.length).toBe(7 * CHUNK_BYTES)
  })

  test("respects the maxBytes cap", async () => {
    const chunks = Array.from({ length: 10 }, () => chunk("tone"))
    const out = await captureStream(streamOf(chunks), {
      signal: new AbortController().signal,
      maxBytes: 2 * CHUNK_BYTES,
    })
    expect(out.length).toBe(2 * CHUNK_BYTES) // stops once the cap is reached
  })

  test("an already-aborted signal yields no audio", async () => {
    const ac = new AbortController()
    ac.abort()
    const out = await captureStream(streamOf([chunk("tone")]), { signal: ac.signal, maxBytes: 1e9 })
    expect(out.length).toBe(0)
  })
})
