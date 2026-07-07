import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { AudioData } from "../src/core/types.ts"
import { LocalHttpStt } from "../src/stt/local_http.ts"

// Minimal canonical WAV (44-byte header, no samples) — enough for transport.
function tinyWav(): AudioData {
  return { wav: new Uint8Array(44), sampleRate: 16000, channels: 1 }
}

type MockState = { loaded: boolean; lastPath: string | null; transcribeStatus: number }

let server: ReturnType<typeof Bun.serve>
let state: MockState
let baseUrl: string

beforeAll(() => {
  state = { loaded: true, lastPath: null, transcribeStatus: 200 }
  server = Bun.serve({
    port: 7411,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", model: "mock", loaded: state.loaded })
      }
      if (url.pathname === "/transcribe" && req.method === "POST") {
        const body = (await req.json()) as { path?: string }
        state.lastPath = body.path ?? null
        if (state.transcribeStatus !== 200) {
          return new Response("boom", { status: state.transcribeStatus })
        }
        return Response.json({ text: "  привет мир  ", duration: 1.23 })
      }
      return new Response("not found", { status: 404 })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

describe("LocalHttpStt contract", () => {
  test("health true when server reports loaded", async () => {
    state.loaded = true
    const stt = new LocalHttpStt({ baseUrl })
    expect(await stt.health()).toBe(true)
  })

  test("health false when not loaded", async () => {
    state.loaded = false
    const stt = new LocalHttpStt({ baseUrl })
    expect(await stt.health()).toBe(false)
    state.loaded = true
  })

  test("health false when server unreachable", async () => {
    const stt = new LocalHttpStt({ baseUrl: "http://127.0.0.1:7999" })
    expect(await stt.health()).toBe(false)
  })

  test("transcribe posts a path and returns trimmed text", async () => {
    state.transcribeStatus = 200
    const stt = new LocalHttpStt({ baseUrl })
    const text = await stt.transcribe(tinyWav())
    expect(text).toBe("привет мир")
    expect(state.lastPath).toMatch(/dictum-stt-.*audio\.wav$/)
  })

  test("transcribe throws a readable error on non-200", async () => {
    state.transcribeStatus = 500
    const stt = new LocalHttpStt({ baseUrl })
    await expect(stt.transcribe(tinyWav())).rejects.toThrow(/local STT returned 500/)
    state.transcribeStatus = 200
  })

  test("baseUrl trailing slashes are trimmed", async () => {
    const stt = new LocalHttpStt({ baseUrl: `${baseUrl}///` })
    expect(await stt.health()).toBe(true)
  })
})
