/**
 * recorder/wav.ts — minimal RIFF/WAVE parsing and canonicalization helpers.
 *
 * Part of the recorder module. Depends only on Node/Bun built-ins (and ffmpeg
 * at runtime for transcoding non-canonical inputs). The canonical format used
 * across Dictum is PCM16, 16 kHz, mono — see core/types.ts AudioData.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type WavFormat = {
  audioFormat: number // 1 = PCM
  channels: number
  sampleRate: number
  bitsPerSample: number
}

const CANONICAL_RATE = 16000
const CANONICAL_CHANNELS = 1
const CANONICAL_BITS = 16

function readFourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  )
}

/**
 * Parse the `fmt ` chunk of a WAV file. Tolerates extra chunks (LIST, fact, …)
 * appearing before `data`. Throws on a non-RIFF/WAVE input.
 */
export function parseWavFormat(bytes: Uint8Array): WavFormat {
  if (bytes.length < 12 || readFourCC(bytes, 0) !== "RIFF" || readFourCC(bytes, 8) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = readFourCC(bytes, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === "fmt ") {
      return {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      }
    }
    // chunks are word-aligned (pad to even length)
    offset = body + size + (size % 2)
  }
  throw new Error("WAV is missing a 'fmt ' chunk")
}

function writeAscii(buf: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) buf[offset + i] = text.charCodeAt(i)
}

/**
 * Wrap raw PCM16 little-endian bytes in a canonical WAV container (44-byte
 * header). Defaults to 16 kHz mono — the format Dictum captures.
 */
export function pcmToWav(
  pcm: Uint8Array,
  opts: { sampleRate?: number; channels?: number } = {},
): Uint8Array {
  const sampleRate = opts.sampleRate ?? CANONICAL_RATE
  const channels = opts.channels ?? CANONICAL_CHANNELS
  const bitsPerSample = CANONICAL_BITS
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length

  const buf = new Uint8Array(44 + dataSize)
  const view = new DataView(buf.buffer)
  writeAscii(buf, 0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(buf, 8, "WAVE")
  writeAscii(buf, 12, "fmt ")
  view.setUint32(16, 16, true) // fmt chunk size (PCM)
  view.setUint16(20, 1, true) // audioFormat = PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeAscii(buf, 36, "data")
  view.setUint32(40, dataSize, true)
  buf.set(pcm, 44)
  return buf
}

/** True when the WAV is already PCM16 / 16 kHz / mono. */
export function isCanonical(fmt: WavFormat): boolean {
  return (
    fmt.audioFormat === 1 &&
    fmt.channels === CANONICAL_CHANNELS &&
    fmt.sampleRate === CANONICAL_RATE &&
    fmt.bitsPerSample === CANONICAL_BITS
  )
}

/**
 * Transcode arbitrary WAV bytes into canonical PCM16/16k/mono using ffmpeg.
 * Used only when the input is not already canonical.
 */
export async function transcodeToCanonical(bytes: Uint8Array): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "dictum-wav-"))
  const inPath = join(dir, "in.wav")
  const outPath = join(dir, "out.wav")
  try {
    await writeFile(inPath, bytes)
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inPath,
        "-ar",
        String(CANONICAL_RATE),
        "-ac",
        String(CANONICAL_CHANNELS),
        "-sample_fmt",
        "s16",
        "-f",
        "wav",
        outPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const code = await proc.exited
    if (code !== 0) {
      const err = await new Response(proc.stderr).text()
      throw new Error(`ffmpeg transcode failed (exit ${code}): ${err.trim() || "unknown error"}`)
    }
    const out = await readFile(outPath)
    return new Uint8Array(out)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
