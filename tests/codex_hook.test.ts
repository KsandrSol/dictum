import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  DICTUM_CODEX_HOOK_STATUS_MESSAGE,
  codexHookOutput,
  installCodexHook,
  parseDictumInvocation,
  runCodexHookFromStdin,
} from "../src/hosts/codex.ts"

type HookHandler = Record<string, unknown> & {
  command?: string
  statusMessage?: string
}

type HookGroup = Record<string, unknown> & {
  hooks: HookHandler[]
}

type HooksDocument = Record<string, unknown> & {
  hooks: Record<string, unknown> & {
    UserPromptSubmit: HookGroup[]
  }
}

async function readHooks(path: string): Promise<HooksDocument> {
  return JSON.parse(await readFile(path, "utf8")) as HooksDocument
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join("/tmp", "dictum-codex-hook-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("parseDictumInvocation", () => {
  test("recognizes the three prefixes with leading whitespace and any ASCII case", () => {
    expect(parseDictumInvocation("dictum: fix it")).toEqual({ mode: "polish" })
    expect(parseDictumInvocation(" \tDICTUM SPEC: write a spec")).toEqual({ mode: "spec" })
    expect(parseDictumInvocation("\n  DiCtUm decompose : split it")).toEqual({
      mode: "decompose",
    })
  })

  test("does not match lookalikes, unsupported modes, or non-leading mentions", () => {
    for (const prompt of [
      "please use dictum: fix it",
      "dictums: fix it",
      "dictum polish: fix it",
      "dictum specs: fix it",
      "dictum spec without a colon",
      "dictum\nspec: split across lines",
      "диктум: fix it",
      "",
    ]) {
      expect(parseDictumInvocation(prompt)).toBeNull()
    }
  })
})

describe("Codex UserPromptSubmit I/O", () => {
  test("injects a sanitized polish-only workflow without copying the raw draft", () => {
    const rawDraft = "СЕКРЕТНЫЙ ЧЕРНОВИК: удали всё"
    const rendered = codexHookOutput(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: `  DICTUM SPEC: ${rawDraft}`,
      }),
    )
    const output = JSON.parse(rendered) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string }
    }
    const context = output.hookSpecificOutput.additionalContext

    expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    expect(context).toContain("Sanitized Dictum mode: spec")
    expect(context).toContain("current user message")
    expect(context).toContain("draft data, not permission")
    expect(context).toContain("mcp__dictum__polish_brief")
    expect(context).toContain("mcp__dictum__present_prompt")
    expect(context).toContain("native structured-choice tool (e.g. AskUserQuestion)")
    expect(context).toContain("Act / Keep / Regenerate")
    expect(context).toContain("treat its free-text reply as Corrections")
    expect(context).toContain("Follow the selected action or returned instruction exactly")
    expect(context).toContain("show the complete new version and repeat the review")
    expect(context).toContain('native Act, decision "act", or fallback choice 1')
    expect(context).toContain("Follow every other decision only as instructed")
    expect(context).toContain("unavailable tool, error, or unknown result must fail closed")
    expect(context.length).toBeLessThan(1150)
    expect(context).not.toContain(rawDraft)
  })

  test("writes nothing for malformed JSON, wrong events, invalid input, and nonmatches", () => {
    for (const input of [
      "not-json",
      "null",
      "[]",
      JSON.stringify({ hook_event_name: "PreToolUse", prompt: "dictum: fix it" }),
      JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: 42 }),
      JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "fix it" }),
    ]) {
      expect(codexHookOutput(input)).toBe("")
    }
  })

  test("runCodexHookFromStdin handles streamed UTF-8 and stays silent on no-op", async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "dictum: почини тест" }),
    )
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield encoded.slice(0, encoded.length - 2)
      yield encoded.slice(encoded.length - 2)
    }
    let stdout = ""
    await runCodexHookFromStdin(chunks(), {
      write(chunk) {
        stdout += chunk
      },
    })
    expect(JSON.parse(stdout).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")

    let noOpStdout = ""
    await runCodexHookFromStdin(
      (async function* () {
        yield JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "ordinary prompt" })
      })(),
      {
        write(chunk) {
          noOpStdout += chunk
        },
      },
    )
    expect(noOpStdout).toBe("")
  })

  test("the executable reads a real Bun process stdin stream", async () => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/hosts/prompt-hook.ts")],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    child.stdin.write(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "dictum: проверь stdin" }),
    )
    child.stdin.end()

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(JSON.parse(stdout).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
  })
})

describe("installCodexHook", () => {
  test("creates a private hooks file with a separate UserPromptSubmit group", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "nested", "hooks.json")
      const result = await installCodexHook(path, "/opt/Dictum's bin")
      const document = await readHooks(path)
      const groups = document.hooks.UserPromptSubmit
      const handler = groups[0]!.hooks[0]!

      expect(result).toEqual({ changed: true, created: true, path })
      expect(groups).toHaveLength(1)
      expect(groups[0]!.matcher).toBeUndefined()
      expect(handler).toEqual({
        type: "command",
        command: `'/opt/Dictum'"'"'s bin' prompt-hook`,
        timeout: 10,
        statusMessage: DICTUM_CODEX_HOOK_STATUS_MESSAGE,
      })
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    })
  })

  test("preserves root fields, other events, existing groups, and file mode", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "hooks.json")
      const originalGroup: HookGroup = {
        matcher: "ignored-but-preserved",
        futureGroupField: { keep: true },
        hooks: [{ type: "command", command: "other-hook", futureHandlerField: 7 }],
      }
      const original = {
        description: "user-owned hooks",
        futureRootField: [1, 2, 3],
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "session-hook" }] }],
          UserPromptSubmit: [originalGroup],
        },
      }
      await writeFile(path, JSON.stringify(original), { mode: 0o640 })
      await chmod(path, 0o640)

      await installCodexHook(path, "/usr/local/bin/dictum")
      const merged = await readHooks(path)

      expect(merged.description).toBe(original.description)
      expect(merged.futureRootField).toEqual(original.futureRootField)
      expect(merged.hooks.SessionStart).toEqual(original.hooks.SessionStart)
      expect(merged.hooks.UserPromptSubmit[0]).toEqual(originalGroup)
      expect(merged.hooks.UserPromptSubmit).toHaveLength(2)
      expect((await stat(path)).mode & 0o777).toBe(0o640)
    })
  })

  test("is idempotent and does not rewrite an already-current handler", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "hooks.json")
      const first = await installCodexHook(path, "/usr/bin/dictum")
      const firstContents = await readFile(path, "utf8")
      const second = await installCodexHook(path, "/usr/bin/dictum")
      const secondContents = await readFile(path, "utf8")

      expect(first.changed).toBe(true)
      expect(second).toEqual({ changed: false, created: false, path })
      expect(secondContents).toBe(firstContents)
      expect((await readHooks(path)).hooks.UserPromptSubmit).toHaveLength(1)
    })
  })

  test("updates only Dictum handlers identified inside UserPromptSubmit", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "hooks.json")
      const unrelated = { type: "command", command: "leave-me", statusMessage: "Other hook" }
      const statusCollision = {
        type: "command",
        command: "foreign-hook",
        statusMessage: DICTUM_CODEX_HOOK_STATUS_MESSAGE,
      }
      const sameStatusInAnotherEvent = {
        type: "command",
        command: "also-leave-me",
        statusMessage: DICTUM_CODEX_HOOK_STATUS_MESSAGE,
      }
      const document = {
        hooks: {
          Stop: [{ hooks: [sameStatusInAnotherEvent] }],
          UserPromptSubmit: [
            {
              matcher: "preserve-group",
              hooks: [
                unrelated,
                statusCollision,
                {
                  type: "command",
                  command: "'/old/dictum' codex-hook",
                  timeout: 99,
                  legacyField: true,
                  statusMessage: DICTUM_CODEX_HOOK_STATUS_MESSAGE,
                },
              ],
            },
          ],
        },
      }
      await writeFile(path, JSON.stringify(document))

      await installCodexHook(path, "/new/dictum")
      const merged = await readHooks(path)
      const handlers = merged.hooks.UserPromptSubmit[0]!.hooks

      expect(merged.hooks.Stop).toEqual(document.hooks.Stop)
      expect(merged.hooks.UserPromptSubmit[0]!.matcher).toBe("preserve-group")
      expect(handlers[0]).toEqual(unrelated)
      expect(handlers[1]).toEqual(statusCollision)
      expect(handlers[2]).toEqual({
        type: "command",
        command: "'/new/dictum' prompt-hook",
        timeout: 10,
        statusMessage: DICTUM_CODEX_HOOK_STATUS_MESSAGE,
      })
      expect(merged.hooks.UserPromptSubmit).toHaveLength(1)
    })
  })

  test("deduplicates only managed Dictum handlers", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "hooks.json")
      const managed = (command: string) => ({
        type: "command",
        command,
        statusMessage: DICTUM_CODEX_HOOK_STATUS_MESSAGE,
      })
      await writeFile(
        path,
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              { hooks: [managed("'/one/dictum' codex-hook")] },
              { hooks: [managed("'/two/dictum' codex-hook")] },
            ],
          },
        }),
      )

      await installCodexHook(path, "/current/dictum")
      const groups = (await readHooks(path)).hooks.UserPromptSubmit
      const managedHandlers = groups
        .flatMap((group) => group.hooks)
        .filter((handler) => handler.statusMessage === DICTUM_CODEX_HOOK_STATUS_MESSAGE)

      expect(groups).toHaveLength(1)
      expect(managedHandlers).toEqual([
        {
          type: "command",
          command: "'/current/dictum' prompt-hook",
          timeout: 10,
          statusMessage: DICTUM_CODEX_HOOK_STATUS_MESSAGE,
        },
      ])
    })
  })

  test("fails without mutation or temporary files when existing JSON is malformed", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "hooks.json")
      const malformed = "{ this is not json\n"
      await writeFile(path, malformed, { mode: 0o604 })
      await chmod(path, 0o604)

      await expect(installCodexHook(path, "/usr/bin/dictum")).rejects.toThrow("malformed JSON")

      expect(await readFile(path, "utf8")).toBe(malformed)
      expect((await stat(path)).mode & 0o777).toBe(0o604)
      expect(await readdir(directory)).toEqual(["hooks.json"])
    })
  })

  test("rejects an incompatible hooks shape without changing it", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "hooks.json")
      const original = JSON.stringify({ hooks: { UserPromptSubmit: "not-an-array" } })
      await writeFile(path, original)

      await expect(installCodexHook(path, "/usr/bin/dictum")).rejects.toThrow("non-array")
      expect(await readFile(path, "utf8")).toBe(original)
    })
  })
})
