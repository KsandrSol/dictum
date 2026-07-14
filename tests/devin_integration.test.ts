import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DEVIN_RULE_SOURCE, installDevinMcp, installDevinRule } from "../src/hosts/devin.ts"
import { DICTUM_RULE_MARKER } from "../src/hosts/rule.ts"

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp("/tmp/dictum-devin-")
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("Devin Desktop integration", () => {
  test("merges MCP config with private defaults and remains idempotent", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, ".codeium", "mcp_config.json")
      expect(await installDevinMcp(path, "/opt/dictum")).toEqual({
        changed: true,
        created: true,
        path,
      })
      const first = await readFile(path, "utf8")
      expect(JSON.parse(first).mcpServers.dictum).toEqual({
        command: "/opt/dictum",
        args: ["mcp"],
      })
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await installDevinMcp(path, "/opt/dictum")).changed).toBe(false)
      expect(await readFile(path, "utf8")).toBe(first)
    })
  })

  test("preserves foreign MCP data while updating Dictum", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "mcp_config.json")
      await writeFile(
        path,
        JSON.stringify({
          futureRoot: 1,
          mcpServers: {
            foreign: { url: "https://example.test/mcp" },
            dictum: { command: "old", args: [], env: { KEEP: "yes" } },
          },
        }),
      )
      await installDevinMcp(path, "/new/dictum")
      const merged = JSON.parse(await readFile(path, "utf8"))
      expect(merged.futureRoot).toBe(1)
      expect(merged.mcpServers.foreign).toEqual({ url: "https://example.test/mcp" })
      expect(merged.mcpServers.dictum.env).toEqual({ KEEP: "yes" })
      expect(merged.mcpServers.dictum.command).toBe("/new/dictum")
      expect(merged.mcpServers.dictum.args).toEqual(["mcp"])
    })
  })

  test("installs, updates, and protects the marker-owned always-on rule", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, ".devin", "rules", "dictum.md")
      expect(await installDevinRule(path)).toBe("installed")
      expect(await readFile(path, "utf8")).toBe(DEVIN_RULE_SOURCE)
      expect(DEVIN_RULE_SOURCE).toContain("trigger: always_on")
      expect(await installDevinRule(path)).toBe("unchanged")
      await writeFile(path, `${DICTUM_RULE_MARKER}\nold managed rule\n`)
      expect(await installDevinRule(path)).toBe("updated")
      await writeFile(path, "user-owned rule\n")
      await expect(installDevinRule(path)).rejects.toThrow("unmanaged Devin rule")
    })
  })
})
