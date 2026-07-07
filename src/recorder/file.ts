/**
 * recorder/file.ts — a Recorder that reads audio from a WAV file (`--input`).
 *
 * Used for testing and SSH/headless flows where there is no microphone. The
 * input is normalized to canonical PCM16/16k/mono via ffmpeg when needed.
 */

import { readFile } from "node:fs/promises"
import type { AudioData, Recorder } from "../core/types.ts"
import { isCanonical, parseWavFormat, transcodeToCanonical } from "./wav.ts"

export class FileRecorder implements Recorder {
  constructor(private readonly path: string) {}

  async record(_signal: AbortSignal): Promise<AudioData> {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await readFile(this.path))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`Cannot read input file '${this.path}': ${reason}`)
    }

    let fmt: ReturnType<typeof parseWavFormat>
    try {
      fmt = parseWavFormat(bytes)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`'${this.path}' is not a valid WAV file: ${reason}`)
    }

    const wav = isCanonical(fmt) ? bytes : await transcodeToCanonical(bytes)
    return { wav, sampleRate: 16000, channels: 1 }
  }
}
