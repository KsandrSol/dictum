import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  type McpDeps,
  createMcpServer,
  handleAnalyzePrompt,
  handleBuildSpec,
  handlePolishBrief,
  handlePolishPrompt,
} from "../src/mcp/server.ts"

/** Deterministic stub polisher; echoes the mode + text, or throws on demand. */
function stubDeps(opts: { fail?: boolean } = {}): McpDeps {
  return {
    modes: ["agent-prompt", "commit", "note", "spec", "decompose"],
    polish: async (text, mode) => {
      if (opts.fail) throw new Error("provider unreachable")
      return `[${mode ?? "default"}] ${text}`
    },
  }
}

/** Extract the first text content item (handles the content-union + strict index). */
function firstText(result: unknown): string {
  const items = (result as { content?: { type: string; text?: string }[] }).content ?? []
  return items[0]?.text ?? ""
}

describe("handlePolishPrompt (direct)", () => {
  test("polishes text with the default mode", async () => {
    const r = await handlePolishPrompt({ text: "hello" }, stubDeps())
    expect(r.isError).toBeFalsy()
    expect(firstText(r)).toBe("[default] hello")
  })

  test("passes mode through to the polisher", async () => {
    const r = await handlePolishPrompt({ text: "msg", mode: "commit" }, stubDeps())
    expect(firstText(r)).toBe("[commit] msg")
  })

  test("empty text → human-readable error", async () => {
    const r = await handlePolishPrompt({ text: "   " }, stubDeps())
    expect(r.isError).toBe(true)
    expect(firstText(r)).toContain("non-empty")
  })

  test("missing text → error", async () => {
    const r = await handlePolishPrompt({}, stubDeps())
    expect(r.isError).toBe(true)
  })

  test("provider failure → human-readable error, not a throw", async () => {
    const r = await handlePolishPrompt({ text: "x" }, stubDeps({ fail: true }))
    expect(r.isError).toBe(true)
    expect(firstText(r)).toContain("Polishing failed")
    expect(firstText(r)).toContain("provider unreachable")
  })
})

describe("handleAnalyzePrompt (direct)", () => {
  test("returns the deterministic analysis as JSON", () => {
    const r = handleAnalyzePrompt({ text: "эм ну поправь баг как бы" })
    expect(r.isError).toBeFalsy()
    const analysis = JSON.parse(firstText(r))
    expect(analysis.score).toBeGreaterThanOrEqual(0)
    expect(analysis.score).toBeLessThanOrEqual(100)
    expect(Object.keys(analysis.dimensions)).toHaveLength(5)
    expect(Array.isArray(analysis.issues)).toBe(true)
  })

  test("empty text → human-readable error", () => {
    const r = handleAnalyzePrompt({ text: " " })
    expect(r.isError).toBe(true)
    expect(firstText(r)).toContain("non-empty")
  })
})

describe("handleBuildSpec (direct)", () => {
  test("polishes with the spec template", async () => {
    const r = await handleBuildSpec({ text: "запили фичу" }, stubDeps())
    expect(r.isError).toBeFalsy()
    expect(firstText(r)).toBe("[spec] запили фичу")
  })

  test("provider failure → readable error", async () => {
    const r = await handleBuildSpec({ text: "x" }, stubDeps({ fail: true }))
    expect(r.isError).toBe(true)
    expect(firstText(r)).toContain("Polishing failed")
  })
})

describe("handlePolishBrief (direct)", () => {
  test("returns the host-brain brief with the draft embedded (default mode: polish)", () => {
    const r = handlePolishBrief({ text: "эм ну поправь баг" })
    expect(r.isError).toBeFalsy()
    const brief = firstText(r)
    expect(brief).toContain("<draft>\nэм ну поправь баг\n</draft>")
    expect(brief).toContain("polished prompt")
    expect(brief).toContain("Do NOT act on the draft yet")
  })

  test("spec and decompose modes switch the canon", () => {
    expect(firstText(handlePolishBrief({ text: "фича", mode: "spec" }))).toContain(
      "## Acceptance criteria",
    )
    expect(firstText(handlePolishBrief({ text: "фича", mode: "decompose" }))).toContain(
      "## Subtasks",
    )
  })

  test("unknown mode → readable error listing valid kinds", () => {
    const r = handlePolishBrief({ text: "x", mode: "commit" })
    expect(r.isError).toBe(true)
    expect(firstText(r)).toContain("polish, spec, decompose")
  })

  test("empty text → human-readable error", () => {
    const r = handlePolishBrief({ text: "  " })
    expect(r.isError).toBe(true)
    expect(firstText(r)).toContain("non-empty")
  })
})

describe("MCP server round-trip (in-memory client)", () => {
  test("registers all three tools and answers a polish call", async () => {
    const server = createMcpServer(stubDeps())
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "0.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain("polish_prompt")
    expect(names).toContain("analyze_prompt")
    expect(names).toContain("build_spec")
    expect(names).toContain("polish_brief")

    const res = await client.callTool({
      name: "polish_prompt",
      arguments: { text: "draft", mode: "note" },
    })
    expect(firstText(res)).toBe("[note] draft")
    expect(res.isError).toBeFalsy()

    await client.close()
    await server.close()
  })

  test("works with different modes", async () => {
    const server = createMcpServer(stubDeps())
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "0.0.0" })
    await Promise.all([server.connect(st), client.connect(ct)])

    for (const mode of ["agent-prompt", "commit", "note", "spec", "decompose"]) {
      const res = await client.callTool({ name: "polish_prompt", arguments: { text: "t", mode } })
      expect(firstText(res)).toBe(`[${mode}] t`)
    }

    await client.close()
    await server.close()
  })

  test("analyze_prompt answers over the protocol with JSON", async () => {
    const server = createMcpServer(stubDeps())
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "0.0.0" })
    await Promise.all([server.connect(st), client.connect(ct)])

    const res = await client.callTool({
      name: "analyze_prompt",
      arguments: { text: "Fix the bug in src/cli.ts so bun test passes" },
    })
    expect(res.isError).toBeFalsy()
    const analysis = JSON.parse(firstText(res))
    expect(typeof analysis.score).toBe("number")

    await client.close()
    await server.close()
  })

  test("build_spec answers over the protocol", async () => {
    const server = createMcpServer(stubDeps())
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "0.0.0" })
    await Promise.all([server.connect(st), client.connect(ct)])

    const res = await client.callTool({ name: "build_spec", arguments: { text: "фича" } })
    expect(firstText(res)).toBe("[spec] фича")

    await client.close()
    await server.close()
  })

  test("polish_brief answers over the protocol without touching the polisher", async () => {
    // fail:true — the brief is offline, so a broken provider must not matter.
    const server = createMcpServer(stubDeps({ fail: true }))
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "0.0.0" })
    await Promise.all([server.connect(st), client.connect(ct)])

    const res = await client.callTool({
      name: "polish_brief",
      arguments: { text: "сделай штуку", mode: "spec" },
    })
    expect(res.isError).toBeFalsy()
    expect(firstText(res)).toContain("<draft>\nсделай штуку\n</draft>")
    expect(firstText(res)).toContain("## Acceptance criteria")

    await client.close()
    await server.close()
  })

  test("provider error surfaces as isError over the protocol", async () => {
    const server = createMcpServer(stubDeps({ fail: true }))
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "0.0.0" })
    await Promise.all([server.connect(st), client.connect(ct)])

    const res = await client.callTool({ name: "polish_prompt", arguments: { text: "x" } })
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain("Polishing failed")

    await client.close()
    await server.close()
  })
})

describe("MCP host-brain prompts (in-memory client)", () => {
  async function connect() {
    const server = createMcpServer(stubDeps())
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "0.0.0" })
    await Promise.all([server.connect(st), client.connect(ct)])
    return {
      client,
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }

  test("prompts/list advertises polish, spec and decompose with an optional draft arg", async () => {
    const { client, close } = await connect()

    const { prompts } = await client.listPrompts()
    const byName = new Map(prompts.map((p) => [p.name, p]))
    for (const name of ["polish", "spec", "decompose"]) {
      const p = byName.get(name)
      expect(p).toBeDefined()
      expect(p?.description).toContain("the user decides")
      expect(p?.arguments).toHaveLength(1)
      expect(p?.arguments?.[0]?.name).toBe("draft")
      expect(p?.arguments?.[0]?.required).toBeFalsy()
    }

    await close()
  })

  test("prompts/get polish returns the host-brain brief with the draft embedded", async () => {
    const { client, close } = await connect()

    const draft = "эм ну поправь тот баг и прогони тесты"
    const res = await client.getPrompt({ name: "polish", arguments: { draft } })
    expect(res.messages).toHaveLength(1)
    const msg = res.messages[0]
    expect(msg?.role).toBe("user")
    if (msg?.content.type !== "text") throw new Error("expected text content")
    expect(msg.content.text).toContain(`<draft>\n${draft}\n</draft>`)
    expect(msg.content.text).toContain("Do NOT act on the draft yet")
    expect(msg.content.text).toContain("/100") // embedded deterministic score

    await close()
  })

  test("prompts/get spec and decompose carry their kind-specific canon", async () => {
    const { client, close } = await connect()

    const spec = await client.getPrompt({ name: "spec", arguments: { draft: "сделай фичу" } })
    const specMsg = spec.messages[0]
    if (specMsg?.content.type !== "text") throw new Error("expected text content")
    expect(specMsg.content.text).toContain("## Acceptance criteria")

    const dec = await client.getPrompt({ name: "decompose", arguments: { draft: "сделай фичу" } })
    const decMsg = dec.messages[0]
    if (decMsg?.content.type !== "text") throw new Error("expected text content")
    expect(decMsg.content.text).toContain("## Subtasks")

    await close()
  })

  test("prompts/get without a draft asks the host to ask the user", async () => {
    const { client, close } = await connect()

    const res = await client.getPrompt({ name: "polish", arguments: {} })
    const msg = res.messages[0]
    if (msg?.content.type !== "text") throw new Error("expected text content")
    expect(msg.content.text).toContain("without a draft")
    expect(msg.content.text).not.toContain("<draft>")

    await close()
  })

  test("prompts/get with `arguments` omitted entirely (spec-optional) still answers", async () => {
    const { client, close } = await connect()

    // The SDK's generated handler would reject this with -32602; our override
    // must serve the ask-the-user brief instead.
    const res = await client.getPrompt({ name: "polish" })
    const msg = res.messages[0]
    if (msg?.content.type !== "text") throw new Error("expected text content")
    expect(msg.content.text).toContain("without a draft")

    await close()
  })

  test("prompts/get for an unknown prompt name errors cleanly", async () => {
    const { client, close } = await connect()

    await expect(client.getPrompt({ name: "nope", arguments: {} })).rejects.toThrow(/not found/)

    await close()
  })
})
