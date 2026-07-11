/**
 * config.ts — load, merge and validate Dictum configuration.
 *
 * Resolution order (lowest → highest priority):
 *   1. built-in defaults (DEFAULT_CONFIG)
 *   2. ~/.config/dictum/config.toml (or $DICTUM_CONFIG)
 *   3. environment variable overrides
 *
 * Depends only on Node/Bun built-ins and `smol-toml`. No project imports.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { parse as parseToml } from "smol-toml"

export type SttProviderName = "local_http" | "openai_compat"
export type PolisherName = "claude_cli" | "anthropic" | "openai_compat"
export type PolisherMode = "llm" | "rules" | "layered"
export type SinkName = "clipboard" | "stdout"
// Live capture is sox (`rec`); the file recorder is chosen automatically by
// --input. There is deliberately no `backend` config field: cli.ts never read
// it, so it only promised a choice that did not exist. Reintroduce together
// with a recorder factory that actually honors it.
export type StopMode = "enter" | "vad" | "ptt"

export type Config = {
  recorder: {
    /** How recording stops: Enter key, silence auto-stop (VAD), or push-to-talk. */
    stopMode: StopMode
    /** Stop recording after this many seconds of trailing silence (VAD). */
    silenceTimeout: number
    /** Voicing threshold for VAD as normalized RMS in [0, 1]. */
    energyThreshold: number
    /** Hard safety cap on a single recording, in seconds. */
    maxDuration: number
  }
  stt: {
    /** Provider order; the factory tries each in turn, falling back on failure. */
    providers: SttProviderName[]
    local_http: {
      /** Base URL of the local GigaAM-compatible HTTP server. */
      baseUrl: string
    }
    openai_compat: {
      /** Base URL, e.g. https://api.openai.com or a Groq/whisper endpoint. */
      baseUrl: string
      /** API key (often supplied via env). */
      apiKey: string
      /** Model id, e.g. "whisper-1". */
      model: string
      /** Language hint, e.g. "ru". Empty string lets the server auto-detect. */
      language: string
    }
  }
  polisher: {
    /** Active polisher. */
    provider: PolisherName
    /**
     * Polishing mode: "llm" (provider only, default), "rules" (offline
     * deterministic cleanup, no LLM), "layered" (rule-based gate — the LLM
     * runs only when the draft scores below scoreThreshold).
     */
    mode: PolisherMode
    /** Layered mode: skip the LLM when the draft scores ≥ this (0–100). */
    scoreThreshold: number
    /** Default template name when none is given on the CLI. */
    template: string
    claude_cli: {
      /** Path/name of the claude binary. */
      bin: string
      /** Optional model override passed to claude (empty = CLI default). */
      model: string
      /** Timeout in seconds. */
      timeout: number
    }
    anthropic: {
      apiKey: string
      model: string
      baseUrl: string
    }
    openai_compat: {
      apiKey: string
      model: string
      baseUrl: string
    }
  }
  sink: {
    /** Where the final text goes. */
    target: SinkName
  }
}

export const DEFAULT_CONFIG: Config = {
  recorder: {
    stopMode: "enter",
    silenceTimeout: 2.0,
    energyThreshold: 0.015,
    maxDuration: 120,
  },
  stt: {
    providers: ["local_http", "openai_compat"],
    local_http: {
      baseUrl: "http://127.0.0.1:5500",
    },
    openai_compat: {
      baseUrl: "https://api.openai.com",
      apiKey: "",
      model: "whisper-1",
      language: "",
    },
  },
  polisher: {
    provider: "claude_cli",
    mode: "llm",
    scoreThreshold: 80,
    template: "agent-prompt",
    claude_cli: {
      bin: "claude",
      model: "",
      timeout: 60,
    },
    anthropic: {
      apiKey: "",
      model: "claude-opus-4-8",
      baseUrl: "https://api.anthropic.com",
    },
    openai_compat: {
      apiKey: "",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com",
    },
  },
  sink: {
    target: "clipboard",
  },
}

/** Absolute path to the config file, honoring $DICTUM_CONFIG. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DICTUM_CONFIG && env.DICTUM_CONFIG.length > 0) return env.DICTUM_CONFIG
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config")
  return join(base, "dictum", "config.toml")
}

/** Directory holding user template overrides. */
export function templatesDir(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config")
  return join(base, "dictum", "templates")
}

type PlainObject = Record<string, unknown>

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Recursively merge `source` onto a shallow clone of `target`. Only keys already
 * present in `target` are considered, so unknown TOML keys are ignored and the
 * result keeps the exact shape of the defaults. Arrays are replaced wholesale.
 * `target` is always a plain object here (arrays are leaf values, never recursed).
 */
function deepMerge<T extends PlainObject>(target: T, source: unknown): T {
  if (!isPlainObject(source)) return target
  const out: PlainObject = { ...target }
  for (const key of Object.keys(target)) {
    const tVal = target[key]
    const sVal = source[key]
    if (sVal === undefined) continue
    if (isPlainObject(tVal)) {
      out[key] = deepMerge(tVal, sVal)
    } else if (Array.isArray(tVal)) {
      out[key] = Array.isArray(sVal) ? sVal : tVal
    } else {
      // primitive: take the override as-is
      out[key] = sVal
    }
  }
  return out as T
}

/** Apply environment-variable overrides in place and return the config. */
export function applyEnvOverrides(config: Config, env: NodeJS.ProcessEnv = process.env): Config {
  const c = config

  // Polisher: Anthropic
  if (env.ANTHROPIC_API_KEY) c.polisher.anthropic.apiKey = env.ANTHROPIC_API_KEY
  if (env.DICTUM_ANTHROPIC_MODEL) c.polisher.anthropic.model = env.DICTUM_ANTHROPIC_MODEL

  // OpenAI key is shared between STT and polisher unless overridden explicitly.
  if (env.OPENAI_API_KEY) {
    c.stt.openai_compat.apiKey = env.OPENAI_API_KEY
    c.polisher.openai_compat.apiKey = env.OPENAI_API_KEY
  }
  if (env.DICTUM_STT_OPENAI_API_KEY) c.stt.openai_compat.apiKey = env.DICTUM_STT_OPENAI_API_KEY
  if (env.DICTUM_POLISHER_OPENAI_API_KEY)
    c.polisher.openai_compat.apiKey = env.DICTUM_POLISHER_OPENAI_API_KEY

  // STT endpoints / models
  if (env.DICTUM_STT_LOCAL_URL) c.stt.local_http.baseUrl = env.DICTUM_STT_LOCAL_URL
  if (env.DICTUM_STT_OPENAI_URL) c.stt.openai_compat.baseUrl = env.DICTUM_STT_OPENAI_URL
  if (env.DICTUM_STT_OPENAI_MODEL) c.stt.openai_compat.model = env.DICTUM_STT_OPENAI_MODEL
  if (env.DICTUM_STT_LANGUAGE) c.stt.openai_compat.language = env.DICTUM_STT_LANGUAGE

  // Polisher selection / mode / template
  if (env.DICTUM_POLISHER) c.polisher.provider = env.DICTUM_POLISHER as PolisherName
  if (env.DICTUM_POLISHER_MODE) c.polisher.mode = env.DICTUM_POLISHER_MODE as PolisherMode
  if (env.DICTUM_SCORE_THRESHOLD) {
    const n = Number(env.DICTUM_SCORE_THRESHOLD)
    if (Number.isFinite(n) && n >= 0 && n <= 100) c.polisher.scoreThreshold = n
  }
  if (env.DICTUM_TEMPLATE) c.polisher.template = env.DICTUM_TEMPLATE
  if (env.DICTUM_CLAUDE_BIN) c.polisher.claude_cli.bin = env.DICTUM_CLAUDE_BIN

  // Recorder
  if (env.DICTUM_STOP_MODE) c.recorder.stopMode = env.DICTUM_STOP_MODE as StopMode

  // Sink
  if (env.DICTUM_SINK) c.sink.target = env.DICTUM_SINK as SinkName

  return c
}

/**
 * Load configuration from disk (if present), merge over defaults, then apply
 * environment overrides. Never throws on a missing file; throws with a clear
 * message on malformed TOML.
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const path = configPath(env)
  let parsed: unknown = {}
  const file = Bun.file(path)
  if (await file.exists()) {
    const text = await file.text()
    try {
      parsed = parseToml(text)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to parse config at ${path}: ${reason}`)
    }
  }
  const merged = deepMerge(structuredClone(DEFAULT_CONFIG), parsed)
  return applyEnvOverrides(merged, env)
}
