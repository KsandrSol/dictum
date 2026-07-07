import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { AudioData } from "../src/core/types.ts"
import { OpenAiCompatStt } from "../src/stt/openai_compat.ts"

function tinyWav(): AudioData {
  return { wav: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), sampleRate: 16000, channels: 1 }
}

type MockState = {
  modelsStatus: number
  transcribeStatus: number
  lastAuth: string | null
  lastModel: string | null
  lastLanguage: string | null
  lastFileBytes: number
}

let server: ReturnType<typeof Bun.serve>
let state: MockState
let baseUrl: string

beforeAll(() => {
  state = {
    modelsStatus: 200,
    transcribeStatus: 200,
    lastAuth: null,
    lastModel: null,
    lastLanguage: null,
    lastFileBytes: 0,
  }
  server = Bun.serve({
    port: 7413,
    async fetch(req) {
      const url = new URL(req.url)
      state.lastAuth = req.headers.get("authorization")
      if (url.pathname === "/v1/models") {
        return new Response("{}", { status: state.modelsStatus })
      }
      if (url.pathname === "/v1/audio/transcriptions" && req.method === "POST") {
        if (state.transcribeStatus !== 200) {
          return new Response("bad", { status: state.transcribeStatus })
        }
        const form = await req.formData()
        state.lastModel = String(form.get("model") ?? "")
        state.lastLanguage = form.has("language") ? String(form.get("language")) : null
        const file = form.get("file")
        state.lastFileBytes = file instanceof Blob ? file.size : 0
        return Response.json({ text: "hello world" })
      }
      return new Response("not found", { status: 404 })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => server.stop(true))

const opts = () => ({ baseUrl, apiKey: "sk-test", model: "whisper-1", language: "ru" })

describe("OpenAiCompatStt contract", () => {
  test("health true on 200 from /v1/models, sends auth", async () => {
    state.modelsStatus = 200
    const stt = new OpenAiCompatStt(opts())
    expect(await stt.health()).toBe(true)
    expect(state.lastAuth).toBe("Bearer sk-test")
  })

  test("health false on 401", async () => {
    state.modelsStatus = 401
    const stt = new OpenAiCompatStt(opts())
    expect(await stt.health()).toBe(false)
    state.modelsStatus = 200
  })

  test("transcribe posts multipart with model+language+file, returns text", async () => {
    state.transcribeStatus = 200
    const stt = new OpenAiCompatStt(opts())
    const text = await stt.transcribe(tinyWav())
    expect(text).toBe("hello world")
    expect(state.lastModel).toBe("whisper-1")
    expect(state.lastLanguage).toBe("ru")
    expect(state.lastFileBytes).toBe(8)
  })

  test("omits language when empty", async () => {
    const stt = new OpenAiCompatStt({ ...opts(), language: "" })
    await stt.transcribe(tinyWav())
    expect(state.lastLanguage).toBeNull()
  })

  test("throws readable error on non-200 transcribe", async () => {
    state.transcribeStatus = 500
    const stt = new OpenAiCompatStt(opts())
    await expect(stt.transcribe(tinyWav())).rejects.toThrow(/returned 500/)
    state.transcribeStatus = 200
  })

  test("no auth header when apiKey empty", async () => {
    state.lastAuth = "stale"
    const stt = new OpenAiCompatStt({ ...opts(), apiKey: "" })
    await stt.health()
    expect(state.lastAuth).toBeNull()
  })
})
