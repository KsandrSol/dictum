import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { installClaudeHook } from "../src/hosts/claude.ts"

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp("/tmp/dictum-claude-")
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("Claude Code integration", () => {
  test("merges, marks by command suffix, preserves foreign data and permissions", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "settings.json")
      const foreign = { type: "command", command: "foreign-hook", future: true }
      await writeFile(
        path,
        JSON.stringify({
          permissions: { allow: ["Read"] },
          futureRoot: 7,
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "stop-hook" }] }],
            UserPromptSubmit: [
              {
                matcher: "preserve",
                hooks: [foreign, { type: "command", command: "'/old/dictum' prompt-hook" }],
              },
            ],
          },
        }),
        { mode: 0o640 },
      )
      await chmod(path, 0o640)

      const result = await installClaudeHook(path, "/new/Dictum's bin")
      const merged = JSON.parse(await readFile(path, "utf8"))
      const handler = merged.hooks.UserPromptSubmit[0].hooks[1]

      expect(result).toEqual({ changed: true, created: false, path })
      expect(merged.permissions).toEqual({ allow: ["Read"] })
      expect(merged.futureRoot).toBe(7)
      expect(merged.hooks.Stop).toHaveLength(1)
      expect(merged.hooks.UserPromptSubmit[0].matcher).toBe("preserve")
      expect(merged.hooks.UserPromptSubmit[0].hooks[0]).toEqual(foreign)
      expect(handler).toEqual({
        type: "command",
        command: `'/new/Dictum'"'"'s bin' prompt-hook`,
        timeout: 10,
      })
      expect(handler.statusMessage).toBeUndefined()
      expect((await stat(path)).mode & 0o777).toBe(0o640)
    })
  })

  test("creates a private file and is byte-for-byte idempotent", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, ".claude", "settings.json")
      expect(await installClaudeHook(path, "/opt/dictum")).toEqual({
        changed: true,
        created: true,
        path,
      })
      const first = await readFile(path, "utf8")
      expect(await installClaudeHook(path, "/opt/dictum")).toEqual({
        changed: false,
        created: false,
        path,
      })
      expect(await readFile(path, "utf8")).toBe(first)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    })
  })

  test("malformed settings fail without mutation", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "settings.json")
      await writeFile(path, "{ broken")
      await expect(installClaudeHook(path, "/opt/dictum")).rejects.toThrow("malformed JSON")
      expect(await readFile(path, "utf8")).toBe("{ broken")
    })
  })
})

describe("symlinked settings", () => {
  test("writes through the symlink target and keeps the link intact", async () => {
    const { lstat, readlink, symlink } = await import("node:fs/promises")
    await withTempDir(async (directory) => {
      const target = join(directory, "dotfiles-settings.json")
      const link = join(directory, "settings.json")
      await writeFile(target, JSON.stringify({ theme: "dark" }))
      await symlink(target, link)

      await installClaudeHook(link, "/opt/dictum")

      expect((await lstat(link)).isSymbolicLink()).toBe(true) // dotfile link survives
      expect(await readlink(link)).toBe(target)
      const merged = JSON.parse(await readFile(target, "utf8"))
      expect(merged.theme).toBe("dark")
      expect(merged.hooks.UserPromptSubmit[0].hooks[0].command).toBe("'/opt/dictum' prompt-hook")
    })
  })
})
