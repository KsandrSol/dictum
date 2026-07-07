import { describe, expect, test } from "bun:test"
import { SilenceDetector, detectEndpoint, rmsEnergy } from "../src/recorder/vad.ts"

const RATE = 16000

/** Silence: N ms of zeros. */
function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((RATE * ms) / 1000))
}

/** Voiced: N ms of a square wave at the given amplitude (alternating sign). */
function tone(ms: number, amplitude = 8000): Int16Array {
  const buf = new Int16Array(Math.round((RATE * ms) / 1000))
  for (let i = 0; i < buf.length; i++) buf[i] = i % 2 === 0 ? amplitude : -amplitude
  return buf
}

function concat(...parts: Int16Array[]): Int16Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Int16Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

describe("rmsEnergy", () => {
  test("silence is zero energy", () => {
    expect(rmsEnergy(silence(20))).toBe(0)
    expect(rmsEnergy(new Int16Array(0))).toBe(0)
  })

  test("square wave RMS ~= amplitude/full-scale", () => {
    expect(rmsEnergy(tone(20, 8000))).toBeCloseTo(8000 / 32768, 3)
    expect(rmsEnergy(tone(20, 16384))).toBeCloseTo(0.5, 2)
  })
})

describe("SilenceDetector", () => {
  test("never endpoints on pure silence (speech never starts)", () => {
    const det = new SilenceDetector({ sampleRate: RATE, silenceTimeoutSec: 0.5 })
    let fired = false
    for (let i = 0; i < 200; i++) fired ||= det.push(silence(20))
    expect(fired).toBe(false)
    expect(det.hasStarted).toBe(false)
  })

  test("endpoints after trailing silence once speech started", () => {
    const det = new SilenceDetector({ sampleRate: RATE, silenceTimeoutSec: 0.5, minSpeechMs: 40 })
    // 200ms speech → started, no endpoint yet
    for (let t = 0; t < 200; t += 20) expect(det.push(tone(20))).toBe(false)
    expect(det.hasStarted).toBe(true)
    // 0.5s of silence (25 frames of 20ms): fires exactly when the timeout is hit
    let firedAt = -1
    for (let f = 0; f < 40; f++) {
      if (det.push(silence(20))) {
        firedAt = (f + 1) * 20
        break
      }
    }
    expect(firedAt).toBe(500)
  })

  test("brief blip under minSpeechMs does not arm the detector", () => {
    const det = new SilenceDetector({ sampleRate: RATE, silenceTimeoutSec: 0.2, minSpeechMs: 100 })
    det.push(tone(40)) // 40ms < 100ms → not started
    let fired = false
    for (let i = 0; i < 50; i++) fired ||= det.push(silence(20))
    expect(fired).toBe(false)
    expect(det.hasStarted).toBe(false)
  })

  test("reset clears state", () => {
    const det = new SilenceDetector({ sampleRate: RATE, minSpeechMs: 20 })
    det.push(tone(40))
    expect(det.hasStarted).toBe(true)
    det.reset()
    expect(det.hasStarted).toBe(false)
  })
})

describe("detectEndpoint (batch)", () => {
  test("fires near tone-end + silenceTimeout", () => {
    const buf = concat(tone(500), silence(3000))
    const idx = detectEndpoint(buf, { sampleRate: RATE, silenceTimeoutSec: 2.0, minSpeechMs: 100 })
    expect(idx).not.toBeNull()
    // ~ 500ms speech + 2000ms silence = 2500ms → 40000 samples (allow a frame of slack)
    const expected = Math.round((RATE * 2500) / 1000)
    expect(Math.abs((idx as number) - expected)).toBeLessThanOrEqual(RATE * 0.02 + 1)
  })

  test("returns null on pure silence and on pure speech", () => {
    expect(detectEndpoint(silence(3000), { sampleRate: RATE, silenceTimeoutSec: 1 })).toBeNull()
    expect(detectEndpoint(tone(3000), { sampleRate: RATE, silenceTimeoutSec: 1 })).toBeNull()
  })
})
