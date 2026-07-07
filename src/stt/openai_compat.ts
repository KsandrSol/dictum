/**
 * stt/openai_compat.ts — STTProvider for OpenAI-compatible transcription APIs.
 *
 * Works with OpenAI, Groq, and local whisper-servers exposing
 *   POST {base}/v1/audio/transcriptions   (multipart: file, model, language)
 *   GET  {base}/v1/models                 (used as a liveness/auth probe)
 *
 * Sends the WAV in-memory as multipart form data; no temp file needed.
 */

import type { AudioData, STTProvider } from "../core/types.ts"

export type OpenAiCompatOptions = {
  baseUrl: string
  apiKey: string
  model: string
  /** Optional language hint (ISO code). Empty = let the server auto-detect. */
  language: string
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
}

export class OpenAiCompatStt implements STTProvider {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly model: string
  private readonly language: string
  private readonly timeoutMs: number

  constructor(opts: OpenAiCompatOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.language = opts.language
    this.timeoutMs = opts.timeoutMs ?? 60000
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async transcribe(audio: AudioData): Promise<string> {
    const form = new FormData()
    form.append("file", new Blob([audio.wav], { type: "audio/wav" }), "audio.wav")
    form.append("model", this.model)
    form.append("response_format", "json")
    if (this.language) form.append("language", this.language)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, {
        method: "POST",
        headers: this.authHeaders(),
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`OpenAI-compatible STT request to ${this.baseUrl} failed: ${reason}`)
    }
    if (!res.ok) {
      const detail = (await res.text()).trim()
      throw new Error(`OpenAI-compatible STT returned ${res.status}${detail ? `: ${detail}` : ""}`)
    }
    const body = (await res.json()) as { text?: unknown }
    if (typeof body.text !== "string") {
      throw new Error("OpenAI-compatible STT response missing 'text' field")
    }
    return body.text.trim()
  }
}
