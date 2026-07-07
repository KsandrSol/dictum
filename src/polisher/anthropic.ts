/**
 * polisher/anthropic.ts — Polisher backed by the Claude Messages API.
 *
 * Raw HTTP (fetch) to keep dependencies minimal, mirroring stt/openai_compat.ts.
 *   POST {base}/v1/messages
 *   headers: x-api-key, anthropic-version: 2023-06-01, content-type
 *   body: { model, max_tokens, system, messages: [{role:"user", content}] }
 *   response: { content: [{type:"text", text}], stop_reason, ... }
 */

import type { Polisher, Template } from "../core/types.ts"

const ANTHROPIC_VERSION = "2023-06-01"

export type AnthropicOptions = {
  apiKey: string
  model: string
  baseUrl: string
  /** Max output tokens; polished prompts are short. */
  maxTokens?: number
  /** Request timeout in milliseconds. */
  timeoutMs?: number
}

type AnthropicResponse = {
  content?: Array<{ type?: string; text?: string }>
  stop_reason?: string
  error?: { message?: string }
}

export class AnthropicPolisher implements Polisher {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly maxTokens: number
  private readonly timeoutMs: number

  constructor(opts: AnthropicOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
    this.maxTokens = opts.maxTokens ?? 2048
    this.timeoutMs = opts.timeoutMs ?? 60000
  }

  async polish(text: string, template: Template): Promise<string> {
    if (!this.apiKey) {
      throw new Error("Anthropic polisher needs an API key — set ANTHROPIC_API_KEY")
    }

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          system: template.instruction,
          messages: [{ role: "user", content: text }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`Anthropic request failed: ${reason}`)
    }

    const body = (await res.json().catch(() => ({}))) as AnthropicResponse
    if (!res.ok) {
      const detail = body.error?.message ?? (await res.text().catch(() => "")).trim()
      throw new Error(`Anthropic API returned ${res.status}${detail ? `: ${detail}` : ""}`)
    }
    if (body.stop_reason === "refusal") {
      throw new Error("Anthropic declined to polish this transcript (safety refusal)")
    }

    const out = (body.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("")
      .trim()
    if (!out) throw new Error("Anthropic returned an empty response")
    return out
  }
}
