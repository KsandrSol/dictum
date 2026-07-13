import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI = new URL("../src/cli.ts", import.meta.url).pathname
const temporaryRoots: string[] = []

async function runCli(
  args: string[],
  options: { env?: Record<string, string>; stdin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
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

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe("Codex integration CLI", () => {
  test("codex-hook emits developer context only for a Dictum-prefixed prompt", async () => {
    const matching = await runCli(["codex-hook"], {
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "dictum spec: add CSV export",
      }),
    })
    expect(matching.code).toBe(0)
    const output = JSON.parse(matching.stdout)
    expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    expect(output.hookSpecificOutput.additionalContext).toContain("Sanitized Dictum mode: spec")

    const ordinary = await runCli(["codex-hook"], {
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "fix the failing test",
      }),
    })
    expect(ordinary.code).toBe(0)
    expect(ordinary.stdout).toBe("")
  })

  test("codex setup installs both surfaces and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "dictum-codex-e2e-"))
    temporaryRoots.push(root)
    const env = { HOME: root, CODEX_HOME: join(root, ".codex") }

    const first = await runCli(["codex", "setup", "--binary", "/opt/dictum"], { env })
    expect(first.code).toBe(0)
    expect(first.stdout).toContain("Codex hook: installed")
    expect(first.stdout).toContain("Codex skill: installed")

    const hooks = JSON.parse(await readFile(join(root, ".codex", "hooks.json"), "utf8"))
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(1)
    const skill = await readFile(join(root, ".agents", "skills", "dictum", "SKILL.md"), "utf8")
    expect(skill).toContain("name: dictum")

    const second = await runCli(["codex", "setup", "--binary", "/opt/dictum"], { env })
    expect(second.code).toBe(0)
    expect(second.stdout).toContain("Codex hook: unchanged")
    expect(second.stdout).toContain("Codex skill: unchanged")
  })

  test("a foreign $dictum skill fails preflight before hooks are changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "dictum-codex-collision-"))
    temporaryRoots.push(root)
    const skillDir = join(root, ".agents", "skills", "dictum")
    const hooksPath = join(root, ".codex", "hooks.json")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: dictum\n---\nuser owned\n")

    const result = await runCli(["codex", "setup", "--binary", "/opt/dictum"], {
      env: { HOME: root, CODEX_HOME: join(root, ".codex") },
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Refusing to overwrite")
    expect(await Bun.file(hooksPath).exists()).toBe(false)
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toContain("user owned")
  })
})
