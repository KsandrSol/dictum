import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type Config, DEFAULT_CONFIG } from "../src/config.ts"
import {
  type CheckResult,
  doctorExitCode,
  formatDoctorTable,
  runDoctorChecks,
} from "../src/doctor.ts"

let server: ReturnType<typeof Bun.serve>
let sttUrl: string

beforeAll(() => {
  server = Bun.serve({
    port: 7414,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/health") return Response.json({ loaded: true })
      return new Response("nf", { status: 404 })
    },
  })
  sttUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => server.stop(true))

function configWith(over: (c: Config) => void): Config {
  const c = structuredClone(DEFAULT_CONFIG)
  over(c)
  return c
}

function row(results: CheckResult[], name: string): CheckResult {
  const r = results.find((x) => x.name === name)
  if (!r) throw new Error(`no check named '${name}' in ${results.map((x) => x.name).join(", ")}`)
  return r
}

describe("doctor checks", () => {
  test("STT ok when a configured backend is healthy", async () => {
    const cfg = configWith((c) => {
      c.stt.providers = ["local_http"]
      c.stt.local_http.baseUrl = sttUrl
    })
    const results = await runDoctorChecks(cfg, { SSH_CONNECTION: "x" } as NodeJS.ProcessEnv)
    expect(row(results, "speech-to-text").status).toBe("ok")
  })

  test("STT fails on an invalid provider name", async () => {
    const cfg = configWith((c) => {
      // deliberately invalid to exercise factory validation
      c.stt.providers = ["nope"] as unknown as Config["stt"]["providers"]
    })
    const results = await runDoctorChecks(cfg, {} as NodeJS.ProcessEnv)
    const stt = row(results, "speech-to-text")
    expect(stt.status).toBe("fail")
    expect(stt.detail).toMatch(/Unknown STT provider/)
  })

  test("polisher ok when claude_cli bin exists", async () => {
    const cfg = configWith((c) => {
      c.polisher.provider = "claude_cli"
      c.polisher.claude_cli.bin = "sh"
      c.stt.local_http.baseUrl = sttUrl
    })
    const results = await runDoctorChecks(cfg, { SSH_CONNECTION: "x" } as NodeJS.ProcessEnv)
    expect(row(results, "polisher (claude_cli)").status).toBe("ok")
  })

  test("polisher fails when bin is missing", async () => {
    const cfg = configWith((c) => {
      c.polisher.claude_cli.bin = "definitely-not-a-real-binary-xyz123"
      c.stt.local_http.baseUrl = sttUrl
    })
    const results = await runDoctorChecks(cfg, { SSH_CONNECTION: "x" } as NodeJS.ProcessEnv)
    const p = row(results, "polisher (claude_cli)")
    expect(p.status).toBe("fail")
    expect(p.hint).toBeDefined()
  })

  test("rules mode is always ok — offline, no LLM required", async () => {
    const cfg = configWith((c) => {
      c.polisher.mode = "rules"
      // even a broken provider must not matter in the offline mode
      c.polisher.claude_cli.bin = "definitely-not-a-real-binary-xyz123"
    })
    const results = await runDoctorChecks(cfg, {} as NodeJS.ProcessEnv)
    const p = row(results, "polisher (rules)")
    expect(p.status).toBe("ok")
    expect(p.detail).toContain("offline")
  })

  test("layered mode shows the score gate and still checks the provider", async () => {
    const cfg = configWith((c) => {
      c.polisher.mode = "layered"
      c.polisher.scoreThreshold = 80
      c.polisher.claude_cli.bin = "sh"
    })
    const results = await runDoctorChecks(cfg, {} as NodeJS.ProcessEnv)
    expect(row(results, "polisher (claude_cli, layered ≥80)").status).toBe("ok")
  })

  test("anthropic polisher needs an API key", async () => {
    const cfg = configWith((c) => {
      c.polisher.provider = "anthropic"
      c.polisher.anthropic.apiKey = ""
      c.stt.local_http.baseUrl = sttUrl
    })
    const results = await runDoctorChecks(cfg, { SSH_CONNECTION: "x" } as NodeJS.ProcessEnv)
    expect(row(results, "polisher (anthropic)").status).toBe("fail")
  })

  test("clipboard uses OSC52 under SSH", async () => {
    const cfg = configWith((c) => {
      c.stt.local_http.baseUrl = sttUrl
    })
    const results = await runDoctorChecks(cfg, {
      SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 5000",
    } as NodeJS.ProcessEnv)
    const clip = row(results, "clipboard")
    expect(clip.status).toBe("ok")
    expect(clip.detail).toMatch(/OSC52/)
  })
})

describe("doctor formatting", () => {
  const results: CheckResult[] = [
    { name: "a", status: "ok", detail: "fine" },
    { name: "bee", status: "fail", detail: "broken", hint: "do x" },
    { name: "c", status: "warn", detail: "meh", hint: "maybe y" },
  ]

  test("table renders icons, hints, and a summary", () => {
    const out = formatDoctorTable(results)
    expect(out).toContain("✓")
    expect(out).toContain("✗")
    expect(out).toContain("→ do x")
    expect(out).toContain("1 check(s) failed.")
  })

  test("exit code is 1 when any check fails", () => {
    expect(doctorExitCode(results)).toBe(1)
    expect(doctorExitCode([{ name: "a", status: "ok", detail: "" }])).toBe(0)
    expect(doctorExitCode([{ name: "a", status: "warn", detail: "" }])).toBe(0)
  })
})
