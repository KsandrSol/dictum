import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CURSOR_RULE_SOURCE, installCursorMcp, installCursorRule } from "../src/hosts/cursor.ts"
import { DICTUM_RULE_MARKER } from "../src/hosts/rule.ts"

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp("/tmp/dictum-cursor-")
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("Cursor integration", () => {
  test("merges MCP config, preserves foreign keys and permissions, and is idempotent", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "mcp.json")
      await writeFile(
        path,
        JSON.stringify({
          futureRoot: true,
          mcpServers: {
            foreign: { command: "foreign" },
            dictum: { command: "old", args: ["old"], env: { KEEP: "yes" }, disabled: false },
          },
        }),
        { mode: 0o640 },
      )
      await chmod(path, 0o640)

      expect((await installCursorMcp(path, "/opt/dictum")).changed).toBe(true)
      const first = await readFile(path, "utf8")
      const merged = JSON.parse(first)
      expect(merged.futureRoot).toBe(true)
      expect(merged.mcpServers.foreign).toEqual({ command: "foreign" })
      expect(merged.mcpServers.dictum).toEqual({
        command: "/opt/dictum",
        args: ["mcp"],
        env: { KEEP: "yes" },
        disabled: false,
      })
      expect((await stat(path)).mode & 0o777).toBe(0o640)
      expect((await installCursorMcp(path, "/opt/dictum")).changed).toBe(false)
      expect(await readFile(path, "utf8")).toBe(first)
    })
  })

  test("installs, updates, and protects the marker-owned project rule", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, ".cursor", "rules", "dictum.mdc")
      expect(await installCursorRule(path)).toBe("installed")
      expect(await readFile(path, "utf8")).toBe(CURSOR_RULE_SOURCE)
      expect(await installCursorRule(path)).toBe("unchanged")
      await writeFile(path, `${DICTUM_RULE_MARKER}\nold managed rule\n`)
      expect(await installCursorRule(path)).toBe("updated")
      await writeFile(path, "user-owned rule\n")
      await expect(installCursorRule(path)).rejects.toThrow("unmanaged Cursor rule")
      expect(await readFile(path, "utf8")).toBe("user-owned rule\n")
    })
  })

  test("rejects an incompatible MCP shape without mutation", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "mcp.json")
      const original = JSON.stringify({ mcpServers: [] })
      await writeFile(path, original)
      await expect(installCursorMcp(path, "/opt/dictum")).rejects.toThrow("non-object")
      expect(await readFile(path, "utf8")).toBe(original)
    })
  })
})
