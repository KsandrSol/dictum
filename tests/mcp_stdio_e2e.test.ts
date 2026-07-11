/**
 * mcp_stdio_e2e.test.ts — real-subprocess regression for the stdin-EOF race.
 *
 * A client that writes its requests and immediately closes stdin (the CI
 * smoke: `printf … | dictum mcp`) must still get every response. The SDK
 * dispatches a parsed request to its handler on a later microtask, and on
 * Bun 1.2 the stdin 'end' event fires inside that gap — an idle check based
 * only on entered handlers saw zero in flight and exited before answering
 * id 2. Runs on whatever Bun executes the test suite, so the CI matrix
 * exercises it on both the engines minimum and the release toolchain.
 */
import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

const SMOKE = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "polish_brief", arguments: { text: "fix the bug" } },
  },
]

describe("mcp stdio e2e (subprocess)", () => {
  test("requests written right before stdin EOF are all answered", async () => {
    const input = `${SMOKE.map((m) => JSON.stringify(m)).join("\n")}\n`
    const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "mcp"], {
      cwd: repoRoot,
      stdin: new TextEncoder().encode(input), // written in full, then closed — the race
      stdout: "pipe",
      stderr: "ignore",
    })
    const killer = setTimeout(() => proc.kill("SIGKILL"), 15000)
    const code = await proc.exited
    clearTimeout(killer)
    const out = await new Response(proc.stdout).text()

    expect(code).toBe(0) // exited on EOF by itself, not via the kill
    const replies = out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: number })
    expect(replies.some((r) => r.id === 1)).toBe(true)
    const brief = replies.find((r) => r.id === 2)
    expect(brief).toBeDefined()
    const text = JSON.stringify(brief)
    expect(text).toContain("Do NOT act on the draft yet")
    expect(text).not.toContain('"isError":true')
  }, 20000)
})
