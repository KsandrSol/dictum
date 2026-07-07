import { describe, expect, test } from "bun:test"
import type { AudioData, STTProvider } from "../src/core/types.ts"
import {
  FallbackStt,
  type SttFactoryConfig,
  VALID_STT_PROVIDERS,
  buildSttProviders,
  createSttProvider,
} from "../src/stt/factory.ts"

const cfg: SttFactoryConfig = {
  providers: ["local_http", "openai_compat"],
  local_http: { baseUrl: "http://127.0.0.1:5500" },
  openai_compat: {
    baseUrl: "https://api.openai.com",
    apiKey: "",
    model: "whisper-1",
    language: "",
  },
}

// Controllable stub provider.
class StubStt implements STTProvider {
  calls = 0
  constructor(
    private readonly healthy: boolean,
    private readonly result: string | Error,
  ) {}
  async health(): Promise<boolean> {
    return this.healthy
  }
  async transcribe(_a: AudioData): Promise<string> {
    this.calls++
    if (this.result instanceof Error) throw this.result
    return this.result
  }
}

const audio: AudioData = { wav: new Uint8Array(0), sampleRate: 16000, channels: 1 }

describe("buildSttProviders", () => {
  test("builds providers in configured order", () => {
    const named = buildSttProviders(cfg)
    expect(named.map((n) => n.name)).toEqual(["local_http", "openai_compat"])
  })

  test("rejects unknown provider names with a helpful message", () => {
    expect(() => buildSttProviders({ ...cfg, providers: ["local_http", "bogus"] })).toThrow(
      /Unknown STT provider 'bogus'\. Valid: local_http, openai_compat/,
    )
  })

  test("rejects empty provider list", () => {
    expect(() => buildSttProviders({ ...cfg, providers: [] })).toThrow(/No STT providers/)
  })

  test("createSttProvider returns a FallbackStt", () => {
    expect(createSttProvider(cfg)).toBeInstanceOf(FallbackStt)
  })

  test("VALID_STT_PROVIDERS is the source of truth", () => {
    expect([...VALID_STT_PROVIDERS]).toEqual(["local_http", "openai_compat"])
  })
})

describe("FallbackStt failover", () => {
  test("uses the first healthy provider", async () => {
    const primary = new StubStt(true, "from-primary")
    const secondary = new StubStt(true, "from-secondary")
    const fb = new FallbackStt([
      { name: "local_http", provider: primary },
      { name: "openai_compat", provider: secondary },
    ])
    expect(await fb.transcribe(audio)).toBe("from-primary")
    expect(secondary.calls).toBe(0)
  })

  test("skips an unhealthy primary and uses the secondary", async () => {
    const primary = new StubStt(false, "from-primary")
    const secondary = new StubStt(true, "from-secondary")
    const fb = new FallbackStt([
      { name: "local_http", provider: primary },
      { name: "openai_compat", provider: secondary },
    ])
    expect(await fb.transcribe(audio)).toBe("from-secondary")
    expect(primary.calls).toBe(0)
  })

  test("falls over when a healthy primary throws", async () => {
    const primary = new StubStt(true, new Error("primary boom"))
    const secondary = new StubStt(true, "from-secondary")
    const fb = new FallbackStt([
      { name: "local_http", provider: primary },
      { name: "openai_compat", provider: secondary },
    ])
    expect(await fb.transcribe(audio)).toBe("from-secondary")
    expect(primary.calls).toBe(1)
  })

  test("aggregates errors when all providers fail", async () => {
    const fb = new FallbackStt([
      { name: "local_http", provider: new StubStt(false, "x") },
      { name: "openai_compat", provider: new StubStt(true, new Error("auth")) },
    ])
    await expect(fb.transcribe(audio)).rejects.toThrow(
      /All STT providers failed[\s\S]*local_http: unhealthy[\s\S]*openai_compat: auth/,
    )
  })

  test("health true if any provider is healthy", async () => {
    const fb = new FallbackStt([
      { name: "local_http", provider: new StubStt(false, "x") },
      { name: "openai_compat", provider: new StubStt(true, "y") },
    ])
    expect(await fb.health()).toBe(true)
  })

  test("health false if none healthy", async () => {
    const fb = new FallbackStt([{ name: "local_http", provider: new StubStt(false, "x") }])
    expect(await fb.health()).toBe(false)
  })
})
