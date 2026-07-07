/**
 * recorder/sox.ts — capture from the microphone via sox `rec`, streaming raw
 * PCM16 so we can endpoint live (energy VAD) instead of waiting for a file.
 *
 * The recording loop (`captureStream`) is pure over a ReadableStream and is
 * unit-tested with synthetic PCM — no microphone needed. Stops on: the abort
 * signal (Enter / push-to-talk / SIGINT, wired in cli via ui/keys), an energy
 * VAD endpoint, or the max-duration cap. Live mic capture is verified manually.
 */

import type { AudioData, Recorder } from "../core/types.ts"
import { SilenceDetector, type VadOptions } from "./vad.ts"
import { pcmToWav } from "./wav.ts"

const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2
const VAD_FRAME_SAMPLES = 320 // 20 ms @ 16 kHz

export type SoxOptions = {
  /** Binary to invoke; sox ships `rec` as a recording front-end. */
  bin?: string
  /** Hard safety cap in seconds. */
  maxDuration?: number
  /** Enable energy-based silence auto-stop. */
  vad?: boolean
  /** VAD tuning (threshold, silence timeout, …). */
  vadOptions?: VadOptions
}

export type CaptureOptions = {
  signal: AbortSignal
  /** Optional detector; when present, the loop stops at the speech endpoint. */
  vad?: SilenceDetector
  /** Hard byte cap; the loop stops once this many PCM bytes are buffered. */
  maxBytes: number
  frameSamples?: number
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** Decode little-endian PCM16 bytes to Int16 samples for energy analysis. */
function pcm16le(bytes: Uint8Array): Int16Array {
  const n = bytes.length >> 1
  const out = new Int16Array(n)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true)
  return out
}

/**
 * Consume a raw-PCM stream until the signal aborts, the VAD endpoints, or the
 * byte cap is hit. Returns the accumulated PCM16 bytes. Pure and testable.
 */
export async function captureStream(
  stream: ReadableStream<Uint8Array>,
  opts: CaptureOptions,
): Promise<Uint8Array> {
  const frameBytes = (opts.frameSamples ?? VAD_FRAME_SAMPLES) * BYTES_PER_SAMPLE
  const chunks: Uint8Array[] = []
  let total = 0
  let leftover: Uint8Array = new Uint8Array(0)
  const reader = stream.getReader()
  const onAbort = () => {
    reader.cancel().catch(() => {})
  }
  opts.signal.addEventListener("abort", onAbort, { once: true })

  try {
    while (!opts.signal.aborted) {
      const { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value)
      total += value.length
      if (total >= opts.maxBytes) break

      if (opts.vad) {
        // frame leftover+value into fixed VAD windows
        const merged = leftover.length
          ? concatChunks([leftover, value], leftover.length + value.length)
          : value
        let off = 0
        let endpoint = false
        while (merged.length - off >= frameBytes) {
          if (opts.vad.push(pcm16le(merged.subarray(off, off + frameBytes)))) {
            endpoint = true
            break
          }
          off += frameBytes
        }
        leftover = merged.subarray(off)
        if (endpoint) break
      }
    }
  } finally {
    opts.signal.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
  return concatChunks(chunks, total)
}

export class SoxRecorder implements Recorder {
  private readonly bin: string
  private readonly maxDuration: number
  private readonly vadEnabled: boolean
  private readonly vadOptions: VadOptions

  constructor(opts: SoxOptions = {}) {
    this.bin = opts.bin ?? "rec"
    this.maxDuration = opts.maxDuration ?? 120
    this.vadEnabled = opts.vad ?? false
    this.vadOptions = opts.vadOptions ?? {}
  }

  async record(signal: AbortSignal): Promise<AudioData> {
    const proc = Bun.spawn(
      [
        this.bin,
        "-q",
        "-c",
        "1",
        "-r",
        String(SAMPLE_RATE),
        "-b",
        "16",
        "-e",
        "signed-integer",
        "-t",
        "raw",
        "-", // stream raw PCM to stdout
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )

    const vad = this.vadEnabled
      ? new SilenceDetector({ sampleRate: SAMPLE_RATE, ...this.vadOptions })
      : undefined
    const maxBytes = Math.max(1, this.maxDuration * SAMPLE_RATE * BYTES_PER_SAMPLE)

    const captureOpts: CaptureOptions = vad ? { signal, vad, maxBytes } : { signal, maxBytes }

    let pcm: Uint8Array
    try {
      pcm = await captureStream(proc.stdout, captureOpts)
    } finally {
      proc.kill("SIGINT")
      await proc.exited
    }

    if (pcm.length < BYTES_PER_SAMPLE) {
      const err = (await new Response(proc.stderr).text()).trim()
      throw new Error(
        `${this.bin}: no audio captured. ${err || "is sox installed? → apt install sox / brew install sox"}`,
      )
    }
    return { wav: pcmToWav(pcm), sampleRate: 16000, channels: 1 }
  }
}
