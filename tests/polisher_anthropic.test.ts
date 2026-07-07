import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Template } from "../src/core/types.ts"
import { AnthropicPolisher } from "../src/polisher/anthropic.ts"

const TEMPLATE: Template = {
  name: "agent-prompt",
  description: "t",
  language: "auto",
  instruction: "Rewrite the transcript.",
}

type MockState = {
  status: number
  stopReason: string
  lastBody: Record<string, unknown> | null
  lastHeaders: Headers | null
}

let server: ReturnType<typeof Bun.serve>
let state: MockState
let baseUrl: string

beforeAll(() => {
  state = { status: 200, stopReason: "end_turn", lastBody: null, lastHeaders: null }
  server = Bun.serve({
    port: 7415,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/messages" && req.method === "POST") {
        state.lastHeaders = req.headers
        state.lastBody = (await req.json()) as Record<string, unknown>
        if (state.status !== 200) {
          return Response.json({ error: { message: "bad model" } }, { status: state.status })
        }
        if (state.stopReason === "refusal") {
          return Response.json({ stop_reason: "refusal", content: [] })
        }
        return Response.json({
          stop_reason: "end_turn",
          content: [
            { type: "thinking", text: "" },
            { type: "text", text: "  polished output  " },
          ],
        })
      }
      return new Response("nf", { status: 404 })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => server.stop(true))

const make = (over: Partial<{ apiKey: string }> = {}) =>
  new AnthropicPolisher({ apiKey: "sk-ant", model: "claude-opus-4-8", baseUrl, ...over })

describe("AnthropicPolisher", () => {
  test("sends correct headers and body, returns trimmed text", async () => {
    state.status = 200
    state.stopReason = "end_turn"
    const out = await make().polish("hello transcript", TEMPLATE)
    expect(out).toBe("polished output")
    expect(state.lastHeaders?.get("x-api-key")).toBe("sk-ant")
    expect(state.lastHeaders?.get("anthropic-version")).toBe("2023-06-01")
    expect(state.lastBody?.model).toBe("claude-opus-4-8")
    expect(state.lastBody?.system).toBe("Rewrite the transcript.")
    expect(state.lastBody?.messages).toEqual([{ role: "user", content: "hello transcript" }])
    expect(typeof state.lastBody?.max_tokens).toBe("number")
  })

  test("throws a clear error without an API key (no request made)", async () => {
    await expect(make({ apiKey: "" }).polish("x", TEMPLATE)).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })

  test("surfaces a safety refusal", async () => {
    state.stopReason = "refusal"
    await expect(make().polish("x", TEMPLATE)).rejects.toThrow(/refusal/i)
    state.stopReason = "end_turn"
  })

  test("surfaces API errors with the message", async () => {
    state.status = 400
    await expect(make().polish("x", TEMPLATE)).rejects.toThrow(/returned 400: bad model/)
    state.status = 200
  })
})
