import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Template } from "../src/core/types.ts"
import { ClaudeCliPolisher } from "../src/polisher/claude_cli.ts"

const TEMPLATE: Template = {
  name: "agent-prompt",
  description: "t",
  language: "auto",
  instruction: "Rewrite.",
}

function scriptBin(body: string): { bin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dictum-claude-"))
  const bin = join(dir, "fakeclaude")
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return { bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("ClaudeCliPolisher", () => {
  test("returns trimmed stdout on success", async () => {
    const { bin, cleanup } = scriptBin('printf "  polished  "')
    try {
      const out = await new ClaudeCliPolisher({ bin }).polish("x", TEMPLATE)
      expect(out).toBe("polished")
    } finally {
      cleanup()
    }
  })

  test("times out fast even when a child holds the pipes open", async () => {
    // A backgrounded sleep inherits stdout and keeps the pipe open after the
    // script exits — the regression the defensive timeout guards against.
    const { bin, cleanup } = scriptBin("sleep 30 & echo started")
    try {
      const p = new ClaudeCliPolisher({ bin, timeoutMs: 400 })
      const t0 = performance.now()
      // The script exits immediately (code 0) but the held pipe must not hang us.
      const result = await p.polish("x", TEMPLATE).catch((e) => e)
      const elapsed = performance.now() - t0
      // Must not block on the orphaned sleep's 30s pipe.
      expect(elapsed).toBeLessThan(6000)
      // Either the trimmed "started" output or a clean error — never a 30s hang.
      expect(result === "started" || result instanceof Error).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("reports a clean timeout when the process itself hangs", async () => {
    const { bin, cleanup } = scriptBin("sleep 30")
    try {
      const p = new ClaudeCliPolisher({ bin, timeoutMs: 400 })
      const t0 = performance.now()
      await expect(p.polish("x", TEMPLATE)).rejects.toThrow(/timed out after 0\.4s/)
      expect(performance.now() - t0).toBeLessThan(6000)
    } finally {
      cleanup()
    }
  })

  test("surfaces a launch error for a missing binary", async () => {
    const p = new ClaudeCliPolisher({ bin: "definitely-not-a-real-binary-xyz123" })
    await expect(p.polish("x", TEMPLATE)).rejects.toThrow(/Cannot launch/)
  })
})
