import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Template } from "../src/core/types.ts"
import { OpenAiCompatPolisher } from "../src/polisher/openai_compat.ts"

const TEMPLATE: Template = {
  name: "commit",
  description: "t",
  language: "auto",
  instruction: "Write a commit message.",
}

type MockState = {
  status: number
  lastAuth: string | null
  lastBody: Record<string, unknown> | null
}

let server: ReturnType<typeof Bun.serve>
let state: MockState
let baseUrl: string

beforeAll(() => {
  state = { status: 200, lastAuth: null, lastBody: null }
  server = Bun.serve({
    port: 7416,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        state.lastAuth = req.headers.get("authorization")
        state.lastBody = (await req.json()) as Record<string, unknown>
        if (state.status !== 200) {
          return Response.json({ error: { message: "no quota" } }, { status: state.status })
        }
        return Response.json({
          choices: [{ message: { role: "assistant", content: "feat: add thing" } }],
        })
      }
      return new Response("nf", { status: 404 })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => server.stop(true))

const make = (over: Partial<{ apiKey: string }> = {}) =>
  new OpenAiCompatPolisher({ apiKey: "sk-oa", model: "gpt-4o-mini", baseUrl, ...over })

describe("OpenAiCompatPolisher", () => {
  test("sends system+user messages with auth, returns content", async () => {
    state.status = 200
    const out = await make().polish("I added a thing", TEMPLATE)
    expect(out).toBe("feat: add thing")
    expect(state.lastAuth).toBe("Bearer sk-oa")
    expect(state.lastBody?.model).toBe("gpt-4o-mini")
    expect(state.lastBody?.messages).toEqual([
      { role: "system", content: "Write a commit message." },
      { role: "user", content: "I added a thing" },
    ])
  })

  test("requires an API key", async () => {
    await expect(make({ apiKey: "" }).polish("x", TEMPLATE)).rejects.toThrow(/OPENAI_API_KEY/)
  })

  test("surfaces API errors", async () => {
    state.status = 429
    await expect(make().polish("x", TEMPLATE)).rejects.toThrow(/returned 429: no quota/)
    state.status = 200
  })
})
