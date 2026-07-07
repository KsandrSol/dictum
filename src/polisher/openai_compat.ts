/**
 * polisher/openai_compat.ts — Polisher backed by an OpenAI-compatible
 * Chat Completions API (OpenAI, Groq, local LLM servers, OpenRouter, …).
 *
 *   POST {base}/v1/chat/completions
 *   headers: authorization: Bearer <key>, content-type
 *   body: { model, messages: [{role:"system", instruction}, {role:"user", text}] }
 *   response: { choices: [{message: {content}}] }
 */

import type { Polisher, Template } from "../core/types.ts"

export type OpenAiCompatPolisherOptions = {
  apiKey: string
  model: string
  baseUrl: string
  /** Request timeout in milliseconds. */
  timeoutMs?: number
}

type ChatResponse = {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string }
}

export class OpenAiCompatPolisher implements Polisher {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(opts: OpenAiCompatPolisherOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
    this.timeoutMs = opts.timeoutMs ?? 60000
  }

  async polish(text: string, template: Template): Promise<string> {
    if (!this.apiKey) {
      throw new Error("OpenAI-compatible polisher needs an API key — set OPENAI_API_KEY")
    }

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: template.instruction },
            { role: "user", content: text },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`OpenAI-compatible request failed: ${reason}`)
    }

    const body = (await res.json().catch(() => ({}))) as ChatResponse
    if (!res.ok) {
      const detail = body.error?.message ?? ""
      throw new Error(`OpenAI-compatible API returned ${res.status}${detail ? `: ${detail}` : ""}`)
    }

    const out = body.choices?.[0]?.message?.content?.trim() ?? ""
    if (!out) throw new Error("OpenAI-compatible API returned an empty response")
    return out
  }
}
