import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import pkg from "../package.json" with { type: "json" }
import {
  CLAUDE_COMMAND_SOURCE,
  CODEX_SKILL_METADATA_LEGACY_SOURCE,
  CODEX_SKILL_METADATA_SOURCE,
  CODEX_SKILL_SOURCE,
  DICTUM_MANAGED_MARKER,
  classifyManagedContents,
  settleReconcile,
  shortHash,
  userManagedFileTargets,
} from "../src/hosts/managed.ts"

const CLI = new URL("../src/cli.ts", import.meta.url).pathname
const temporaryRoots: string[] = []

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), label))
  temporaryRoots.push(root)
  return root
}

async function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", CLI, ...args], {
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

async function writeManaged(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe("managed-file classification", () => {
  const expected = `${DICTUM_MANAGED_MARKER}\ncurrent\n`

  test("classifies up-to-date, stale, unmanaged, and absent with short hashes", () => {
    const current = classifyManagedContents(expected, expected, DICTUM_MANAGED_MARKER)
    const stale = classifyManagedContents(
      `${DICTUM_MANAGED_MARKER}\nold\n`,
      expected,
      DICTUM_MANAGED_MARKER,
    )
    const unmanaged = classifyManagedContents("user owned\n", expected, DICTUM_MANAGED_MARKER)
    const absent = classifyManagedContents(undefined, expected, DICTUM_MANAGED_MARKER)

    expect(current).toEqual({
      status: "up-to-date",
      hash: shortHash(expected),
      expectedHash: shortHash(expected),
    })
    expect(stale.status).toBe("stale")
    expect(unmanaged.status).toBe("unmanaged")
    expect(absent).toEqual({ status: "absent", hash: null, expectedHash: shortHash(expected) })
    for (const result of [current, stale, unmanaged]) expect(result.hash).toHaveLength(8)
  })

  test("startup targets only the user-scoped surfaces Dictum actually installs", () => {
    expect(userManagedFileTargets("/home/test").map((target) => target.host)).toEqual([
      "claude",
      "codex",
    ])
  })

  test("the hot-path settle guard swallows an unexpected rejected reconcile", async () => {
    await expect(
      settleReconcile(Promise.reject(new Error("discovery failed"))),
    ).resolves.toBeUndefined()
  })
})

describe("managed-file startup self-heal", () => {
  test("hook updates the stale Codex skill and metadata but skips an unmanaged command", async () => {
    const home = await temporaryRoot("dictum-managed-hook-")
    const targets = userManagedFileTargets(home, { CODEX_HOME: join(home, ".codex") })
    const codex = targets.find((target) => target.host === "codex")!
    const claude = targets.find((target) => target.host === "claude")!
    const metadata = codex.companionFiles[0]!
    const unmanaged = "my own Claude command\n"

    await writeManaged(codex.path, `${DICTUM_MANAGED_MARKER}\nstale skill\n`)
    await writeManaged(metadata.path, CODEX_SKILL_METADATA_LEGACY_SOURCE)
    await writeManaged(claude.path, unmanaged)

    const result = await runCli(["prompt-hook"], {
      env: { HOME: home, CODEX_HOME: join(home, ".codex") },
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "dictum: repair without breaking this hook",
      }),
    })

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    expect(await readFile(codex.path, "utf8")).toBe(CODEX_SKILL_SOURCE)
    expect(await readFile(metadata.path, "utf8")).toBe(CODEX_SKILL_METADATA_SOURCE)
    expect(await readFile(claude.path, "utf8")).toBe(unmanaged)
  })

  test("hook heals the stale skill but leaves an edited (non-legacy) metadata file untouched", async () => {
    const home = await temporaryRoot("dictum-managed-edited-meta-")
    const codex = userManagedFileTargets(home, { CODEX_HOME: join(home, ".codex") }).find(
      (target) => target.host === "codex",
    )!
    const metadata = codex.companionFiles[0]!
    const edited = "# hand-edited metadata, neither marker-owned nor a shipped legacy\n"

    await writeManaged(codex.path, `${DICTUM_MANAGED_MARKER}\nstale skill\n`)
    await writeManaged(metadata.path, edited)

    const result = await runCli(["prompt-hook"], {
      env: { HOME: home, CODEX_HOME: join(home, ".codex") },
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "dictum: heal the skill but never my edited metadata",
      }),
    })

    expect(result.code).toBe(0)
    expect(await readFile(codex.path, "utf8")).toBe(CODEX_SKILL_SOURCE)
    expect(await readFile(metadata.path, "utf8")).toBe(edited)
  })

  test("an absent target and a target-discovery FS error cannot break the hook", async () => {
    const home = await temporaryRoot("dictum-managed-hook-error-")
    const codex = userManagedFileTargets(home).find((target) => target.host === "codex")!
    await writeFile(join(home, ".claude"), "not a directory\n")

    const result = await runCli(["prompt-hook"], {
      env: { HOME: home, CODEX_HOME: join(home, ".codex") },
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "dictum: preserve output when repair fails",
      }),
    })

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    expect(await Bun.file(codex.path).exists()).toBe(false)
    expect(await readFile(join(home, ".claude"), "utf8")).toBe("not a directory\n")
  })

  test("MCP startup rewrites an existing stale managed file", async () => {
    const home = await temporaryRoot("dictum-managed-mcp-")
    const claude = userManagedFileTargets(home).find((target) => target.host === "claude")!
    await writeManaged(claude.path, `${DICTUM_MANAGED_MARKER}\nstale command\n`)

    const result = await runCli(["mcp"], {
      env: { HOME: home, CODEX_HOME: join(home, ".codex") },
    })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain("host-brain prompts + tools ready")
    expect(await readFile(claude.path, "utf8")).toBe(CLAUDE_COMMAND_SOURCE)
  })

  test("startup never discovers or rewrites project-scoped rules", async () => {
    const home = await temporaryRoot("dictum-managed-home-")
    const project = await temporaryRoot("dictum-managed-project-")
    const projectRule = join(project, ".cursor", "rules", "dictum.mdc")
    const stale = `${DICTUM_MANAGED_MARKER}\nproject-owned stale canon\n`
    await writeManaged(projectRule, stale)

    const result = await runCli(["codex-hook"], {
      cwd: project,
      env: { HOME: home, CODEX_HOME: join(home, ".codex") },
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "ordinary prompt",
      }),
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toBe("")
    expect(await readFile(projectRule, "utf8")).toBe(stale)
  })
})

describe("status and version commands", () => {
  test("status --json reports every detected host and remains read-only", async () => {
    const home = await temporaryRoot("dictum-managed-status-")
    const targets = userManagedFileTargets(home, { CODEX_HOME: join(home, ".codex") })
    const byHost = Object.fromEntries(targets.map((target) => [target.host, target]))
    const stale = `${DICTUM_MANAGED_MARKER}\nstale skill\n`

    await writeManaged(byHost.claude!.path, CLAUDE_COMMAND_SOURCE)
    await writeManaged(byHost.codex!.path, stale)
    await writeManaged(byHost.codex!.companionFiles[0]!.path, CODEX_SKILL_METADATA_SOURCE)

    const result = await runCli(["status", "--json"], {
      env: { HOME: home, CODEX_HOME: join(home, ".codex") },
    })

    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as {
      version: string
      drift: boolean
      hosts: Array<{ host: string; status: string; hash: string | null; expectedHash: string }>
    }
    expect(report.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(report.drift).toBe(true)
    expect(Object.fromEntries(report.hosts.map((host) => [host.host, host.status]))).toEqual({
      claude: "up-to-date",
      codex: "stale",
    })
    for (const host of report.hosts) {
      expect(host.expectedHash).toHaveLength(8)
      if (host.hash !== null) expect(host.hash).toHaveLength(8)
    }
    expect(await readFile(byHost.codex!.path, "utf8")).toBe(stale)
  })

  test("text status flags canon drift clearly", async () => {
    const home = await temporaryRoot("dictum-managed-status-text-")
    const codex = userManagedFileTargets(home).find((target) => target.host === "codex")!
    await writeManaged(codex.path, `${DICTUM_MANAGED_MARKER}\nstale\n`)

    const result = await runCli(["status"], { env: { HOME: home } })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain("! Codex skill: stale")
    expect(result.stdout).toContain("Canon drift detected")
  })

  test("text status does not imply that an unmanaged file will be updated", async () => {
    const home = await temporaryRoot("dictum-managed-status-unmanaged-")
    const claude = userManagedFileTargets(home).find((target) => target.host === "claude")!
    await writeManaged(claude.path, "my own command\n")

    const result = await runCli(["status"], { env: { HOME: home } })

    expect(result.code).toBe(0)
    const row = result.stdout.split("\n").find((line) => line.includes("Claude command"))
    expect(row).toContain("unmanaged")
    expect(row).not.toContain("→")
  })

  test("version --json emits a structured version object", async () => {
    const result = await runCli(["version", "--json"])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ version: pkg.version })
  })
})
