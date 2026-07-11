import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Config, DEFAULT_CONFIG } from "../src/config.ts"
import {
  type CheckResult,
  claudeCliVersion,
  doctorExitCode,
  ffmpegCheck,
  formatDoctorTable,
  micCheck,
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

/** Fake claude binary printing the given --version output. */
function fakeClaude(stdout: string, exitCode = 0): { bin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dictum-doc-claude-"))
  const bin = join(dir, "fakeclaude")
  writeFileSync(bin, `#!/bin/sh\necho "${stdout}"\nexit ${exitCode}\n`)
  chmodSync(bin, 0o755)
  return { bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
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

  test("polisher ok when claude_cli bin exists and reports a good version", async () => {
    const { bin, cleanup } = fakeClaude("9.9.9 (Claude Code)")
    try {
      const cfg = configWith((c) => {
        c.polisher.provider = "claude_cli"
        c.polisher.claude_cli.bin = bin
        c.stt.local_http.baseUrl = sttUrl
      })
      const results = await runDoctorChecks(cfg, { SSH_CONNECTION: "x" } as NodeJS.ProcessEnv)
      expect(row(results, "polisher (claude_cli)").status).toBe("ok")
    } finally {
      cleanup()
    }
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
    const { bin, cleanup } = fakeClaude("9.9.9 (Claude Code)")
    try {
      const cfg = configWith((c) => {
        c.polisher.mode = "layered"
        c.polisher.scoreThreshold = 80
        c.polisher.claude_cli.bin = bin
      })
      const results = await runDoctorChecks(cfg, {} as NodeJS.ProcessEnv)
      expect(row(results, "polisher (claude_cli, layered ≥80)").status).toBe("ok")
    } finally {
      cleanup()
    }
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

  test("clipboard under SSH with a TTY → OSC52 ok", async () => {
    const cfg = configWith((c) => {
      c.stt.local_http.baseUrl = sttUrl
    })
    const results = await runDoctorChecks(
      cfg,
      { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 5000" } as NodeJS.ProcessEnv,
      true,
    )
    const clip = row(results, "clipboard")
    expect(clip.status).toBe("ok")
    expect(clip.detail).toMatch(/OSC52/)
  })

  test("clipboard under SSH without a TTY → warn, not a false ok", async () => {
    // 'ssh host dictum' (no TTY) would die at copy time — doctor must say so.
    const cfg = configWith((c) => {
      c.stt.local_http.baseUrl = sttUrl
    })
    const results = await runDoctorChecks(
      cfg,
      { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 5000" } as NodeJS.ProcessEnv,
      false,
    )
    const clip = row(results, "clipboard")
    expect(clip.status).toBe("warn")
    expect(clip.detail).toMatch(/interactive terminal/)
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

describe("micCheck", () => {
  test("rec present → ok with its path", () => {
    const r = micCheck("/usr/bin/rec", "/usr/bin/sox")
    expect(r.status).toBe("ok")
    expect(r.detail).toBe("/usr/bin/rec")
  })

  test("sox without rec → warn, not ok (the recorder runs 'rec')", () => {
    const r = micCheck(null, "/usr/bin/sox")
    expect(r.status).toBe("warn")
    expect(r.detail).toContain("'rec' front-end is missing")
  })

  test("neither → warn with install hint", () => {
    const r = micCheck(null, null)
    expect(r.status).toBe("warn")
    expect(r.hint).toContain("file --input works without it")
  })
})

describe("ffmpegCheck", () => {
  test("present → ok", () => {
    expect(ffmpegCheck("/usr/bin/ffmpeg").status).toBe("ok")
  })

  test("absent → warn naming the non-canonical WAV requirement", () => {
    const r = ffmpegCheck(null)
    expect(r.status).toBe("warn")
    expect(r.hint).toContain("non-canonical WAV")
  })
})

describe("claude_cli version gate", () => {
  test("an outdated CLI fails doctor with an update hint", async () => {
    const { bin, cleanup } = fakeClaude("2.0.14 (Claude Code)")
    try {
      const cfg = configWith((c) => {
        c.stt.local_http.baseUrl = sttUrl
        c.polisher.claude_cli.bin = bin
      })
      const results = await runDoctorChecks(cfg, {} as NodeJS.ProcessEnv, false)
      const pol = results.find((r) => r.name.startsWith("polisher"))
      expect(pol?.status).toBe("fail")
      expect(pol?.hint).toContain("2.1.169")
    } finally {
      cleanup()
    }
  })

  test("a recent CLI passes and reports its version", async () => {
    const { bin, cleanup } = fakeClaude("2.1.206 (Claude Code)")
    try {
      const cfg = configWith((c) => {
        c.stt.local_http.baseUrl = sttUrl
        c.polisher.claude_cli.bin = bin
      })
      const results = await runDoctorChecks(cfg, {} as NodeJS.ProcessEnv, false)
      const pol = results.find((r) => r.name.startsWith("polisher"))
      expect(pol?.status).toBe("ok")
      expect(pol?.detail).toContain("2.1.206")
    } finally {
      cleanup()
    }
  })
})

describe("claude_cli version gate — fail closed", () => {
  test("a binary with no version output (/bin/true-like) fails, not ok", async () => {
    const { bin, cleanup } = fakeClaude("") // prints nothing useful, exit 0
    try {
      const cfg = configWith((c) => {
        c.stt.local_http.baseUrl = sttUrl
        c.polisher.claude_cli.bin = bin
      })
      const results = await runDoctorChecks(cfg, {} as NodeJS.ProcessEnv, false)
      const pol = results.find((r) => r.name.startsWith("polisher"))
      expect(pol?.status).toBe("fail")
      expect(pol?.detail).toContain("could not determine")
    } finally {
      cleanup()
    }
  })

  test("a binary whose --version exits non-zero fails even if it prints a version", async () => {
    const { bin, cleanup } = fakeClaude("2.1.206 (Claude Code)", 3)
    try {
      const cfg = configWith((c) => {
        c.stt.local_http.baseUrl = sttUrl
        c.polisher.claude_cli.bin = bin
      })
      const results = await runDoctorChecks(cfg, {} as NodeJS.ProcessEnv, false)
      expect(results.find((r) => r.name.startsWith("polisher"))?.status).toBe("fail")
    } finally {
      cleanup()
    }
  })
})

describe("claude_cli version gate — impostors and stuck binaries", () => {
  test("a tool printing a dotted version without the Claude Code marker fails (bash impostor)", async () => {
    const { bin, cleanup } = fakeClaude("GNU bash, version 5.3.9(1)-release (x86_64-pc-linux-gnu)")
    try {
      const cfg = configWith((c) => {
        c.stt.local_http.baseUrl = sttUrl
        c.polisher.claude_cli.bin = bin
      })
      const results = await runDoctorChecks(cfg, {} as NodeJS.ProcessEnv, false)
      const pol = results.find((r) => r.name.startsWith("polisher"))
      expect(pol?.status).toBe("fail")
      expect(pol?.detail).toContain("could not determine")
    } finally {
      cleanup()
    }
  })

  test("a SIGTERM-immune binary is killed and fails after the deadline", async () => {
    // Ignores SIGTERM and would print a valid version after 30s — the
    // deadline must escalate to SIGKILL and fail unconditionally.
    const dir = mkdtempSync(join(tmpdir(), "dictum-doc-claude-"))
    const bin = join(dir, "stubborn")
    writeFileSync(bin, '#!/bin/sh\ntrap "" TERM\nsleep 30\necho "2.1.206 (Claude Code)"\n')
    chmodSync(bin, 0o755)
    try {
      const t0 = performance.now()
      const version = await claudeCliVersion(bin, 300)
      const elapsed = performance.now() - t0
      expect(version).toBeNull()
      expect(elapsed).toBeLessThan(5000) // SIGKILL grace = deadline + 1s, not 30s
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("claude_cli version gate — adjacency and monotonic deadline", () => {
  test("a foreign version near a detached marker does not pass (frankenstein output)", async () => {
    const { bin, cleanup } = fakeClaude("runtime 9.9.9; Claude Code 2.0.0")
    try {
      expect(await claudeCliVersion(bin)).toBeNull()
    } finally {
      cleanup()
    }
  })

  test("the version adjacent to the marker wins, and an old one fails the gate", async () => {
    // 9.9.9 floats earlier in the line; the CLI's own version is 2.0.14.
    const { bin, cleanup } = fakeClaude("bundled runtime 9.9.9 — 2.0.14 (Claude Code)")
    try {
      expect(await claudeCliVersion(bin)).toBe("2.0.14")
      const cfg = configWith((c) => {
        c.stt.local_http.baseUrl = sttUrl
        c.polisher.claude_cli.bin = bin
      })
      const pol = (await runDoctorChecks(cfg, {} as NodeJS.ProcessEnv, false)).find((r) =>
        r.name.startsWith("polisher"),
      )
      expect(pol?.status).toBe("fail")
      expect(pol?.hint).toContain("2.1.169")
    } finally {
      cleanup()
    }
  })

  test("a blocked event loop cannot smuggle a late exit past the deadline", async () => {
    // The child exits at ~500ms wall time, past the 300ms deadline, while the
    // loop is blocked so no timer fires until 1s. Monotonic check must reject
    // regardless of timer/I-O phase ordering after the unblock.
    const dir = mkdtempSync(join(tmpdir(), "dictum-doc-claude-"))
    const bin = join(dir, "slow")
    writeFileSync(bin, '#!/bin/sh\nsleep 0.5\necho "2.1.206 (Claude Code)"\n')
    chmodSync(bin, 0o755)
    try {
      const pending = claudeCliVersion(bin, 300)
      Bun.sleepSync(1000)
      expect(await pending).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
