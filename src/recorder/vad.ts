/**
 * recorder/vad.ts — energy-based voice-activity endpointing.
 *
 * Pure math over PCM16 samples: compute frame energy, and detect the end of an
 * utterance once trailing silence exceeds a configurable timeout. No I/O, no
 * project imports — fully unit-testable on synthetic buffers. The live wiring
 * (feeding frames from the recorder) is done in cli.ts/recorder during step 1.6.
 */

export type VadOptions = {
  /** Sample rate of the PCM data (Hz). */
  sampleRate?: number
  /** Voicing threshold as normalized RMS in [0, 1]. */
  energyThreshold?: number
  /** Stop after this much trailing silence, in seconds. */
  silenceTimeoutSec?: number
  /** Minimum cumulative voiced time before endpointing can trigger (ms). */
  minSpeechMs?: number
}

const PCM16_FULL_SCALE = 32768

/** Root-mean-square energy of a PCM16 frame, normalized to [0, 1]. */
export function rmsEnergy(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]! / PCM16_FULL_SCALE
    sumSq += s * s
  }
  return Math.sqrt(sumSq / samples.length)
}

/**
 * Streaming endpoint detector. Feed PCM16 frames via push(); it returns true the
 * first time end-of-speech is detected (≥ silenceTimeout of trailing silence
 * after at least minSpeechMs of voiced audio).
 */
export class SilenceDetector {
  private readonly sampleRate: number
  private readonly threshold: number
  private readonly silenceTimeoutMs: number
  private readonly minSpeechMs: number
  private speechMs = 0
  private silenceMs = 0
  private started = false

  constructor(opts: VadOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 16000
    this.threshold = opts.energyThreshold ?? 0.015
    this.silenceTimeoutMs = (opts.silenceTimeoutSec ?? 2.0) * 1000
    this.minSpeechMs = opts.minSpeechMs ?? 100
  }

  /** True once trailing silence after speech reaches the timeout. */
  push(frame: Int16Array): boolean {
    if (frame.length === 0) return false
    const frameMs = (frame.length / this.sampleRate) * 1000
    const voiced = rmsEnergy(frame) >= this.threshold
    if (voiced) {
      this.speechMs += frameMs
      this.silenceMs = 0
      if (this.speechMs >= this.minSpeechMs) this.started = true
    } else if (this.started) {
      this.silenceMs += frameMs
      if (this.silenceMs >= this.silenceTimeoutMs) return true
    }
    return false
  }

  /** Whether enough voiced audio has been seen to consider speech started. */
  get hasStarted(): boolean {
    return this.started
  }

  reset(): void {
    this.speechMs = 0
    this.silenceMs = 0
    this.started = false
  }
}

/**
 * Batch helper: run the detector over a whole PCM16 buffer in fixed frames and
 * return the sample index at which endpointing fires, or null if it never does.
 */
export function detectEndpoint(
  samples: Int16Array,
  opts: VadOptions & { frameMs?: number } = {},
): number | null {
  const sampleRate = opts.sampleRate ?? 16000
  const frameMs = opts.frameMs ?? 20
  const frameSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000))
  const detector = new SilenceDetector(opts)
  for (let i = 0; i < samples.length; i += frameSize) {
    const end = Math.min(i + frameSize, samples.length)
    if (detector.push(samples.subarray(i, end))) return end
  }
  return null
}
