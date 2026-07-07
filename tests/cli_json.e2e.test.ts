import { describe, expect, test } from "bun:test"

/**
 * End-to-end contract tests for `--format json` — spawn the real CLI in the
 * offline rules mode (no LLM, no network, no mic) and parse its stdout.
 * This is the exact integration surface consumers (scripts, Hail) rely on.
 */

const CLI = new URL("../src/cli.ts", import.meta.url).pathname

async function runCli(
  args: string[],
  env: Record<string, string> = {},
  stdin: string | undefined = undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...process.env,
      // isolate from the developer's real config; force the offline mode
      DICTUM_CONFIG: "/nonexistent/dictum-e2e-config.toml",
      DICTUM_POLISHER_MODE: "rules",
      ...env,
    },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
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

describe("dictum --format json (e2e, offline rules mode)", () => {
  test("emits the stable v1 envelope on stdout", async () => {
    const { code, stdout } = await runCli([
      "--text",
      "эм ну сделай тест для src/cli.ts",
      "--auto",
      "--stdout",
      "--format",
      "json",
    ])
    expect(code).toBe(0)
    const envelope = JSON.parse(stdout)
    expect(envelope.v).toBe(1)
    expect(envelope.original).toBe("эм ну сделай тест для src/cli.ts")
    expect(envelope.polished).toBe("Ну сделай тест для src/cli.ts") // rules: filler stripped
    expect(envelope.template).toBe("agent-prompt")
    expect(typeof envelope.score.before).toBe("number")
    expect(typeof envelope.score.after).toBe("number")
    expect(Object.keys(envelope.score.dimensions)).toEqual([
      "clarity",
      "specificity",
      "structure",
      "actionability",
      "context",
    ])
    expect(Array.isArray(envelope.rationale)).toBe(true)
  })

  test("--raw keeps the original as the polished field", async () => {
    const { code, stdout } = await runCli([
      "--text",
      "verbatim draft",
      "--auto",
      "--stdout",
      "--raw",
      "--format",
      "json",
    ])
    expect(code).toBe(0)
    const envelope = JSON.parse(stdout)
    expect(envelope.polished).toBe("verbatim draft")
    expect(envelope.score.after).toBe(envelope.score.before)
  })

  test("plain text mode still emits bare text (no envelope)", async () => {
    const { code, stdout } = await runCli(["--text", "эм, fix the bug", "--auto", "--stdout"])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe("Fix the bug")
  })

  test("invalid --format fails fast with a helpful error", async () => {
    const { code, stderr } = await runCli(["--text", "x", "--format", "yaml"])
    expect(code).toBe(2)
    expect(stderr).toContain("Unknown format 'yaml'")
  })

  test("piped stdin + --format json — the exact /dictum slash-command path", async () => {
    // The Claude Code slash command pipes the draft via a quoted heredoc:
    //   cat <<'DICTUM_EOF' | dictum --auto --stdout --format json
    const draft = 'сделай кнопку "Сохранить" в src/App.tsx\nи не трогай стили'
    const { code, stdout } = await runCli(["--auto", "--stdout", "--format", "json"], {}, draft)
    expect(code).toBe(0)
    const envelope = JSON.parse(stdout)
    expect(envelope.v).toBe(1)
    expect(envelope.original).toBe(draft)
    expect(envelope.polished).toContain("src/App.tsx") // details survive
  })

  test("-m selects the template recorded in the envelope", async () => {
    const { code, stdout } = await runCli([
      "--text",
      "запусти тесты и почини красное",
      "--auto",
      "--stdout",
      "--format",
      "json",
      "-m",
      "spec",
    ])
    expect(code).toBe(0)
    expect(JSON.parse(stdout).template).toBe("spec")
  })
})
