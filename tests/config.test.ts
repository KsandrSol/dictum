import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_CONFIG,
  applyEnvOverrides,
  configPath,
  loadConfig,
  templatesDir,
} from "../src/config.ts"

describe("config defaults", () => {
  test("sane built-in defaults", () => {
    expect(DEFAULT_CONFIG.stt.providers).toEqual(["local_http", "openai_compat"])
    expect(DEFAULT_CONFIG.stt.local_http.baseUrl).toBe("http://127.0.0.1:5500")
    expect(DEFAULT_CONFIG.polisher.provider).toBe("claude_cli")
    expect(DEFAULT_CONFIG.polisher.template).toBe("agent-prompt")
    expect(DEFAULT_CONFIG.polisher.mode).toBe("llm")
    expect(DEFAULT_CONFIG.polisher.scoreThreshold).toBe(80)
    expect(DEFAULT_CONFIG.sink.target).toBe("clipboard")
    expect(DEFAULT_CONFIG.recorder.backend).toBe("sox")
    expect(DEFAULT_CONFIG.recorder.stopMode).toBe("enter")
    expect(DEFAULT_CONFIG.recorder.energyThreshold).toBe(0.015)
    expect(DEFAULT_CONFIG.recorder.silenceTimeout).toBe(2.0)
  })

  test("DICTUM_STOP_MODE overrides the stop mode", () => {
    const c = structuredClone(DEFAULT_CONFIG)
    applyEnvOverrides(c, { DICTUM_STOP_MODE: "vad" } as NodeJS.ProcessEnv)
    expect(c.recorder.stopMode).toBe("vad")
  })
})

describe("configPath", () => {
  test("honors DICTUM_CONFIG", () => {
    expect(configPath({ DICTUM_CONFIG: "/x/y.toml" } as NodeJS.ProcessEnv)).toBe("/x/y.toml")
  })

  test("honors XDG_CONFIG_HOME", () => {
    const p = configPath({ XDG_CONFIG_HOME: "/cfg" } as NodeJS.ProcessEnv)
    expect(p).toBe("/cfg/dictum/config.toml")
  })

  test("templatesDir under XDG_CONFIG_HOME", () => {
    expect(templatesDir({ XDG_CONFIG_HOME: "/cfg" } as NodeJS.ProcessEnv)).toBe(
      "/cfg/dictum/templates",
    )
  })
})

describe("applyEnvOverrides", () => {
  test("ANTHROPIC_API_KEY flows into polisher", () => {
    const c = structuredClone(DEFAULT_CONFIG)
    applyEnvOverrides(c, { ANTHROPIC_API_KEY: "sk-ant" } as NodeJS.ProcessEnv)
    expect(c.polisher.anthropic.apiKey).toBe("sk-ant")
  })

  test("DICTUM_POLISHER_MODE and DICTUM_SCORE_THRESHOLD override the mode gate", () => {
    const c = structuredClone(DEFAULT_CONFIG)
    applyEnvOverrides(c, {
      DICTUM_POLISHER_MODE: "layered",
      DICTUM_SCORE_THRESHOLD: "65",
    } as NodeJS.ProcessEnv)
    expect(c.polisher.mode).toBe("layered")
    expect(c.polisher.scoreThreshold).toBe(65)
  })

  test("a non-numeric DICTUM_SCORE_THRESHOLD is ignored", () => {
    const c = structuredClone(DEFAULT_CONFIG)
    applyEnvOverrides(c, { DICTUM_SCORE_THRESHOLD: "lots" } as NodeJS.ProcessEnv)
    expect(c.polisher.scoreThreshold).toBe(80)
  })

  test("an out-of-range DICTUM_SCORE_THRESHOLD is ignored", () => {
    const c = structuredClone(DEFAULT_CONFIG)
    applyEnvOverrides(c, { DICTUM_SCORE_THRESHOLD: "500" } as NodeJS.ProcessEnv)
    expect(c.polisher.scoreThreshold).toBe(80)
    applyEnvOverrides(c, { DICTUM_SCORE_THRESHOLD: "-5" } as NodeJS.ProcessEnv)
    expect(c.polisher.scoreThreshold).toBe(80)
  })

  test("OPENAI_API_KEY flows into both stt and polisher", () => {
    const c = structuredClone(DEFAULT_CONFIG)
    applyEnvOverrides(c, { OPENAI_API_KEY: "sk-oa" } as NodeJS.ProcessEnv)
    expect(c.stt.openai_compat.apiKey).toBe("sk-oa")
    expect(c.polisher.openai_compat.apiKey).toBe("sk-oa")
  })

  test("DICTUM_* overrides win over shared keys", () => {
    const c = structuredClone(DEFAULT_CONFIG)
    applyEnvOverrides(c, {
      OPENAI_API_KEY: "shared",
      DICTUM_STT_OPENAI_API_KEY: "stt-only",
      DICTUM_STT_LOCAL_URL: "http://127.0.0.1:9999",
      DICTUM_SINK: "stdout",
    } as NodeJS.ProcessEnv)
    expect(c.stt.openai_compat.apiKey).toBe("stt-only")
    expect(c.polisher.openai_compat.apiKey).toBe("shared")
    expect(c.stt.local_http.baseUrl).toBe("http://127.0.0.1:9999")
    expect(c.sink.target).toBe("stdout")
  })
})

describe("loadConfig", () => {
  test("returns defaults when no file present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dictum-cfg-"))
    try {
      const c = await loadConfig({ DICTUM_CONFIG: join(dir, "missing.toml") } as NodeJS.ProcessEnv)
      expect(c.stt.providers).toEqual(["local_http", "openai_compat"])
      expect(c.polisher.provider).toBe("claude_cli")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("merges TOML over defaults, ignoring unknown keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dictum-cfg-"))
    const file = join(dir, "config.toml")
    writeFileSync(
      file,
      [
        "[polisher]",
        'provider = "anthropic"',
        'template = "commit"',
        "",
        "[stt]",
        'providers = ["openai_compat"]',
        "",
        "[stt.local_http]",
        'baseUrl = "http://localhost:1234"',
        "",
        "[unknown_section]",
        "ignored = true",
      ].join("\n"),
    )
    try {
      const c = await loadConfig({ DICTUM_CONFIG: file } as NodeJS.ProcessEnv)
      expect(c.polisher.provider).toBe("anthropic")
      expect(c.polisher.template).toBe("commit")
      expect(c.stt.providers).toEqual(["openai_compat"])
      expect(c.stt.local_http.baseUrl).toBe("http://localhost:1234")
      // untouched defaults remain
      expect(c.sink.target).toBe("clipboard")
      expect("unknown_section" in c).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("throws a clear error on malformed TOML", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dictum-cfg-"))
    const file = join(dir, "config.toml")
    writeFileSync(file, "this is = = not valid toml [[[")
    try {
      await expect(loadConfig({ DICTUM_CONFIG: file } as NodeJS.ProcessEnv)).rejects.toThrow(
        /Failed to parse config/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
