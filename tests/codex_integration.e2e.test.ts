import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI = new URL("../src/cli.ts", import.meta.url).pathname
const temporaryRoots: string[] = []

async function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

/** integrate refuses non-executable paths, so tests install a real stub binary. */
async function fakeDictumBinary(root: string): Promise<string> {
  const path = join(root, "bin", "dictum")
  await mkdir(join(root, "bin"), { recursive: true })
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  return path
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe("host integration CLI", () => {
  test("prompt-hook and its codex-hook alias gate only Dictum-prefixed prompts", async () => {
    const matching = await runCli(["prompt-hook"], {
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "dictum spec: add CSV export",
      }),
    })
    expect(matching.code).toBe(0)
    const output = JSON.parse(matching.stdout)
    expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    expect(output.hookSpecificOutput.additionalContext).toContain("Sanitized Dictum mode: spec")

    const alias = await runCli(["codex-hook"], {
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "dictum: alias still works",
      }),
    })
    expect(alias.code).toBe(0)
    expect(JSON.parse(alias.stdout).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")

    const ordinary = await runCli(["codex-hook"], {
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "fix the failing test",
      }),
    })
    expect(ordinary.code).toBe(0)
    expect(ordinary.stdout).toBe("")
  })

  test("integrate codex installs both surfaces; codex setup remains an idempotent alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "dictum-codex-e2e-"))
    temporaryRoots.push(root)
    const bin = await fakeDictumBinary(root)
    const env = { HOME: root, CODEX_HOME: join(root, ".codex") }

    const first = await runCli(["integrate", "codex", "--binary", bin], { env })
    expect(first.code).toBe(0)
    expect(first.stdout).toContain("Codex hook: installed")
    expect(first.stdout).toContain("Codex skill: installed")

    const hooks = JSON.parse(await readFile(join(root, ".codex", "hooks.json"), "utf8"))
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(1)
    expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command).toBe(`'${bin}' prompt-hook`)
    const skill = await readFile(join(root, ".agents", "skills", "dictum", "SKILL.md"), "utf8")
    expect(skill).toContain("name: dictum")

    const second = await runCli(["codex", "setup", "--binary", bin], { env })
    expect(second.code).toBe(0)
    expect(second.stdout).toContain("Codex hook: unchanged")
    expect(second.stdout).toContain("Codex skill: unchanged")
  })

  test("integrate claude merges the shared hook and prints MCP registration advice", async () => {
    const root = await mkdtemp(join(tmpdir(), "dictum-claude-e2e-"))
    temporaryRoots.push(root)
    const bin = await fakeDictumBinary(root)
    const env = { HOME: root }

    const first = await runCli(["integrate", "claude", "--binary", bin], { env })
    expect(first.code).toBe(0)
    expect(first.stdout).toContain("Claude hook: installed")
    expect(first.stdout).toContain(`claude mcp add --scope user dictum -- '${bin}' mcp`)
    const settings = JSON.parse(await readFile(join(root, ".claude", "settings.json"), "utf8"))
    const handler = settings.hooks.UserPromptSubmit[0].hooks[0]
    expect(handler.command).toBe(`'${bin}' prompt-hook`)
    expect(handler.statusMessage).toBeUndefined()

    const second = await runCli(["integrate", "claude", "--binary", bin], { env })
    expect(second.code).toBe(0)
    expect(second.stdout).toContain("Claude hook: unchanged")
  })

  test("integrate claude never claims a user's own hook that merely ends in prompt-hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "dictum-claude-foreign-"))
    temporaryRoots.push(root)
    const bin = await fakeDictumBinary(root)
    const settingsPath = join(root, ".claude", "settings.json")
    await mkdir(join(root, ".claude"), { recursive: true })
    const foreign = {
      type: "command",
      command: "/usr/local/bin/my-linter prompt-hook",
      timeout: 30,
    }
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [foreign] }] } }),
    )

    const result = await runCli(["integrate", "claude", "--binary", bin], { env: { HOME: root } })
    expect(result.code).toBe(0)
    const settings = JSON.parse(await readFile(settingsPath, "utf8"))
    const commands = settings.hooks.UserPromptSubmit.flatMap((group: { hooks: unknown[] }) =>
      group.hooks.map((handler) => (handler as { command: string }).command),
    )
    expect(commands).toContain("/usr/local/bin/my-linter prompt-hook") // foreign hook intact
    expect(commands).toContain(`'${bin}' prompt-hook`) // managed hook added alongside
  })

  test("integrate refuses a non-executable binary path and writes nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "dictum-nonexec-"))
    temporaryRoots.push(root)
    const nonExec = join(root, "not-a-binary")
    await writeFile(nonExec, "plain data\n") // mode 644 — not executable

    const result = await runCli(["integrate", "claude", "--binary", nonExec], {
      env: { HOME: root },
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("not an executable file")
    expect(await Bun.file(join(root, ".claude", "settings.json")).exists()).toBe(false)
  })

  test("integrate without a host prints usage instead of Unknown command", async () => {
    const result = await runCli(["integrate"], {})
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("Usage: dictum integrate <claude|codex|cursor|devin>")
  })

  test("integrate cursor installs MCP and an idempotent project rule", async () => {
    const root = await mkdtemp(join(tmpdir(), "dictum-cursor-e2e-"))
    temporaryRoots.push(root)
    const bin = await fakeDictumBinary(root)
    const args = ["integrate", "cursor", "--binary", bin, "--project"]

    const first = await runCli(args, { cwd: root, env: { HOME: root } })
    expect(first.code).toBe(0)
    expect(first.stdout).toContain("Cursor MCP: installed")
    expect(first.stdout).toContain("Cursor rule: installed")
    const mcp = JSON.parse(await readFile(join(root, ".cursor", "mcp.json"), "utf8"))
    expect(mcp.mcpServers.dictum).toEqual({ command: bin, args: ["mcp"] })
    const rule = await readFile(join(root, ".cursor", "rules", "dictum.mdc"), "utf8")
    expect(rule).toContain("alwaysApply: true")

    const second = await runCli(args, { cwd: root, env: { HOME: root } })
    expect(second.code).toBe(0)
    expect(second.stdout).toContain("Cursor MCP: unchanged")
    expect(second.stdout).toContain("Cursor rule: unchanged")
  })

  test("integrate cursor without --project prints the plain User Rule", async () => {
    const root = await mkdtemp(join(tmpdir(), "dictum-cursor-user-rule-e2e-"))
    temporaryRoots.push(root)
    const bin = await fakeDictumBinary(root)
    const result = await runCli(["integrate", "cursor", "--binary", bin], {
      cwd: root,
      env: { HOME: root },
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Cursor User Rule (paste into Settings > Rules)")
    expect(result.stdout).toContain("Before inspecting the project")
    expect(await Bun.file(join(root, ".cursor", "rules", "dictum.mdc")).exists()).toBe(false)
  })

  test("integrate devin writes both MCP config paths and an always-on rule idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "dictum-devin-e2e-"))
    temporaryRoots.push(root)
    const bin = await fakeDictumBinary(root)
    const args = ["integrate", "devin", "--binary", bin, "--project"]

    const first = await runCli(args, { cwd: root, env: { HOME: root } })
    expect(first.code).toBe(0)
    expect(first.stdout).toContain("Devin MCP: installed")
    expect(first.stdout).toContain("Devin rule: installed")
    // Docs disagree mid-migration, so both the new and the legacy Windsurf
    // config paths must carry the server.
    for (const configPath of [
      join(root, ".codeium", "mcp_config.json"),
      join(root, ".codeium", "windsurf", "mcp_config.json"),
    ]) {
      const mcp = JSON.parse(await readFile(configPath, "utf8"))
      expect(mcp.mcpServers.dictum).toEqual({ command: bin, args: ["mcp"] })
    }
    const rule = await readFile(join(root, ".devin", "rules", "dictum.md"), "utf8")
    expect(rule).toContain("trigger: always_on")

    const second = await runCli(args, { cwd: root, env: { HOME: root } })
    expect(second.code).toBe(0)
    expect(second.stdout).toContain("Devin MCP: unchanged")
    expect(second.stdout).toContain("Devin rule: unchanged")
  })

  test("a foreign $dictum skill fails preflight before hooks are changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "dictum-codex-collision-"))
    temporaryRoots.push(root)
    const bin = await fakeDictumBinary(root)
    const skillDir = join(root, ".agents", "skills", "dictum")
    const hooksPath = join(root, ".codex", "hooks.json")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: dictum\n---\nuser owned\n")

    const result = await runCli(["integrate", "codex", "--binary", bin], {
      env: { HOME: root, CODEX_HOME: join(root, ".codex") },
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Refusing to overwrite")
    expect(await Bun.file(hooksPath).exists()).toBe(false)
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toContain("user owned")
  })
})
