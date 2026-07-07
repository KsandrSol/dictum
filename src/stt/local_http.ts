/**
 * stt/local_http.ts — STTProvider for a local GigaAM-compatible HTTP server.
 *
 * Contract:
 *   GET  {base}/health      -> { loaded: boolean, ... }
 *   POST {base}/transcribe  body { path: string } -> { text: string, duration?: number }
 *
 * The server reads audio by filesystem path, so we materialize the WAV to a
 * temp file on this host before posting. Same-host only.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AudioData, STTProvider } from "../core/types.ts"

export type LocalHttpOptions = {
  baseUrl: string
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
}

export class LocalHttpStt implements STTProvider {
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(opts: LocalHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
    this.timeoutMs = opts.timeoutMs ?? 60000
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)),
      })
      if (!res.ok) return false
      const body = (await res.json()) as { loaded?: boolean }
      return body.loaded === true
    } catch {
      return false
    }
  }

  async transcribe(audio: AudioData): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "dictum-stt-"))
    const wavPath = join(dir, "audio.wav")
    try {
      await writeFile(wavPath, audio.wav)
      let res: Response
      try {
        res = await fetch(`${this.baseUrl}/transcribe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: wavPath }),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(`local STT request to ${this.baseUrl} failed: ${reason}`)
      }
      if (!res.ok) {
        const detail = (await res.text()).trim()
        throw new Error(`local STT returned ${res.status}${detail ? `: ${detail}` : ""}`)
      }
      const body = (await res.json()) as { text?: unknown }
      if (typeof body.text !== "string") {
        throw new Error("local STT response missing 'text' field")
      }
      return body.text.trim()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
