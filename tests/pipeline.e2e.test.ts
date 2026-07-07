import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { runPipeline } from "../src/core/pipeline.ts"
import type { Polisher, Sink, Template } from "../src/core/types.ts"
import { FileRecorder } from "../src/recorder/file.ts"
import { LocalHttpStt } from "../src/stt/local_http.ts"

const FIXTURE = new URL("./fixtures/sample-ru.wav", import.meta.url).pathname
const MOCK_TRANSCRIPT = "сделай функцию которая складывает два числа"

// Stub polisher: deterministic, no external calls.
class StubPolisher implements Polisher {
  async polish(text: string, template: Template): Promise<string> {
    return `[${template.name}] ${text.toUpperCase()}`
  }
}

// Capture sink: records what was emitted.
class CaptureSink implements Sink {
  emitted: string[] = []
  async emit(text: string): Promise<void> {
    this.emitted.push(text)
  }
}

const TEMPLATE: Template = {
  name: "agent-prompt",
  description: "test",
  language: "auto",
  instruction: "Rewrite:",
}

let server: ReturnType<typeof Bun.serve>
let baseUrl: string

beforeAll(() => {
  server = Bun.serve({
    port: 7412,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/health") return Response.json({ loaded: true })
      if (url.pathname === "/transcribe") return Response.json({ text: MOCK_TRANSCRIPT })
      return new Response("not found", { status: 404 })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

describe("pipeline e2e (file recorder + mock STT + stub polisher)", () => {
  test("record → transcribe → polish → emit", async () => {
    const sink = new CaptureSink()
    const result = await runPipeline({
      recorder: new FileRecorder(FIXTURE),
      stt: new LocalHttpStt({ baseUrl }),
      polisher: new StubPolisher(),
      sink,
      template: TEMPLATE,
      raw: false,
      signal: new AbortController().signal,
    })
    expect(result.transcript).toBe(MOCK_TRANSCRIPT)
    expect(result.output).toBe(`[agent-prompt] ${MOCK_TRANSCRIPT.toUpperCase()}`)
    expect(sink.emitted).toEqual([result.output])
  })

  test("--raw skips polishing and emits the transcript", async () => {
    const sink = new CaptureSink()
    const result = await runPipeline({
      recorder: new FileRecorder(FIXTURE),
      stt: new LocalHttpStt({ baseUrl }),
      polisher: new StubPolisher(),
      sink,
      template: TEMPLATE,
      raw: true,
      signal: new AbortController().signal,
    })
    expect(result.output).toBe(MOCK_TRANSCRIPT)
    expect(sink.emitted).toEqual([MOCK_TRANSCRIPT])
  })

  test("emits stage events in order", async () => {
    const stages: string[] = []
    await runPipeline({
      recorder: new FileRecorder(FIXTURE),
      stt: new LocalHttpStt({ baseUrl }),
      polisher: new StubPolisher(),
      sink: new CaptureSink(),
      template: TEMPLATE,
      raw: false,
      signal: new AbortController().signal,
      onStage: (e) => {
        if (e.durationMs === undefined) stages.push(e.stage)
      },
    })
    expect(stages).toEqual(["recording", "transcribing", "polishing", "emitting", "done"])
  })
})

describe("pipeline text path (no recorder/STT)", () => {
  test("polishes supplied text and emits it", async () => {
    const sink = new CaptureSink()
    const result = await runPipeline({
      text: "draft prompt",
      polisher: new StubPolisher(),
      sink,
      template: TEMPLATE,
      raw: false,
      signal: new AbortController().signal,
    })
    expect(result.transcript).toBe("draft prompt")
    expect(result.output).toBe("[agent-prompt] DRAFT PROMPT")
    expect(sink.emitted).toEqual([result.output])
  })

  test("--raw text passes through unpolished", async () => {
    const sink = new CaptureSink()
    const result = await runPipeline({
      text: "verbatim",
      polisher: new StubPolisher(),
      sink,
      template: TEMPLATE,
      raw: true,
      signal: new AbortController().signal,
    })
    expect(result.output).toBe("verbatim")
    expect(sink.emitted).toEqual(["verbatim"])
  })

  test("skips recording/transcribing stages on the text path", async () => {
    const stages: string[] = []
    await runPipeline({
      text: "hi",
      polisher: new StubPolisher(),
      sink: new CaptureSink(),
      template: TEMPLATE,
      raw: false,
      signal: new AbortController().signal,
      onStage: (e) => {
        if (e.durationMs === undefined) stages.push(e.stage)
      },
    })
    expect(stages).toEqual(["polishing", "emitting", "done"])
  })

  test("empty text input is rejected", async () => {
    await expect(
      runPipeline({
        text: "   ",
        polisher: new StubPolisher(),
        sink: new CaptureSink(),
        template: TEMPLATE,
        raw: false,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/No input text/)
  })

  test("throws when neither text nor recorder/STT is provided", async () => {
    await expect(
      runPipeline({
        polisher: new StubPolisher(),
        sink: new CaptureSink(),
        template: TEMPLATE,
        raw: false,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/requires either text input/)
  })
})

describe("pipeline choice step", () => {
  test("chooser picking original emits the transcript, not the polish", async () => {
    const sink = new CaptureSink()
    const result = await runPipeline({
      text: "my own words",
      polisher: new StubPolisher(),
      sink,
      template: TEMPLATE,
      raw: false,
      signal: new AbortController().signal,
      choose: async (c) => c.original,
    })
    expect(result.output).toBe("my own words")
    expect(sink.emitted).toEqual(["my own words"])
  })

  test("chooser picking polished emits the polish", async () => {
    const sink = new CaptureSink()
    await runPipeline({
      text: "x",
      polisher: new StubPolisher(),
      sink,
      template: TEMPLATE,
      raw: false,
      signal: new AbortController().signal,
      choose: async (c) => c.polished,
    })
    expect(sink.emitted).toEqual(["[agent-prompt] X"])
  })

  test("chooser regenerate re-invokes the polisher", async () => {
    let polishCalls = 0
    const polisher: Polisher = {
      async polish(text) {
        polishCalls++
        return `v${polishCalls}:${text}`
      },
    }
    const sink = new CaptureSink()
    await runPipeline({
      text: "x",
      polisher,
      sink,
      template: TEMPLATE,
      raw: false,
      signal: new AbortController().signal,
      choose: async (c) => await c.regenerate(),
    })
    // First polish (v1) then one regeneration (v2); v2 is what we emit.
    expect(polishCalls).toBe(2)
    expect(sink.emitted).toEqual(["v2:x"])
  })

  test("chooser is not consulted in --raw mode", async () => {
    let consulted = false
    const sink = new CaptureSink()
    await runPipeline({
      text: "raw words",
      polisher: new StubPolisher(),
      sink,
      template: TEMPLATE,
      raw: true,
      signal: new AbortController().signal,
      choose: async (c) => {
        consulted = true
        return c.polished
      },
    })
    expect(consulted).toBe(false)
    expect(sink.emitted).toEqual(["raw words"])
  })
})
