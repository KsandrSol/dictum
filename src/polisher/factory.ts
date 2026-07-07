/**
 * polisher/factory.ts — build a Polisher from configuration.
 *
 * Validates the provider name (human-readable error on a bad config/env value)
 * and constructs the matching backend. Imports only core/types.ts and sibling
 * polisher files (own module).
 */

import type { Polisher } from "../core/types.ts"
import { AnthropicPolisher } from "./anthropic.ts"
import { ClaudeCliPolisher } from "./claude_cli.ts"
import { LayeredPolisher, RulesPolisher } from "./layered.ts"
import { OpenAiCompatPolisher } from "./openai_compat.ts"

export const VALID_POLISHERS = ["claude_cli", "anthropic", "openai_compat"] as const
export type PolisherName = (typeof VALID_POLISHERS)[number]

export const VALID_POLISHER_MODES = ["llm", "rules", "layered"] as const
export type PolisherMode = (typeof VALID_POLISHER_MODES)[number]

/** Layered mode: skip the LLM when the draft scores ≥ this (0–100). */
const DEFAULT_SCORE_THRESHOLD = 80

/** Structural config the factory needs (mirrors Config["polisher"], no import). */
export type PolisherFactoryConfig = {
  provider: string
  /** Polishing mode; optional for back-compat, defaults to "llm". */
  mode?: string
  /** Layered-mode gate (0–100); defaults to 80. */
  scoreThreshold?: number
  claude_cli: { bin: string; model: string; timeout: number }
  anthropic: { apiKey: string; model: string; baseUrl: string }
  openai_compat: { apiKey: string; model: string; baseUrl: string }
}

function isValidName(name: string): name is PolisherName {
  return (VALID_POLISHERS as readonly string[]).includes(name)
}

function isValidMode(mode: string): mode is PolisherMode {
  return (VALID_POLISHER_MODES as readonly string[]).includes(mode)
}

/**
 * Construct the configured Polisher; throws on an unknown provider or mode.
 * Mode "rules" is fully offline and needs no provider at all; "layered" wraps
 * the configured provider behind the rule-based score gate.
 */
export function createPolisher(cfg: PolisherFactoryConfig): Polisher {
  const mode = cfg.mode ?? "llm"
  if (!isValidMode(mode)) {
    throw new Error(`Unknown polisher mode '${mode}'. Valid: ${VALID_POLISHER_MODES.join(", ")}`)
  }
  if (mode === "rules") return new RulesPolisher()

  if (!isValidName(cfg.provider)) {
    throw new Error(`Unknown polisher '${cfg.provider}'. Valid: ${VALID_POLISHERS.join(", ")}`)
  }
  const base = createProvider(cfg, cfg.provider)
  if (mode === "layered") {
    return new LayeredPolisher(base, {
      scoreThreshold: cfg.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
    })
  }
  return base
}

function createProvider(cfg: PolisherFactoryConfig, provider: PolisherName): Polisher {
  switch (provider) {
    case "claude_cli":
      return new ClaudeCliPolisher({
        bin: cfg.claude_cli.bin,
        model: cfg.claude_cli.model,
        timeoutMs: cfg.claude_cli.timeout * 1000,
      })
    case "anthropic":
      return new AnthropicPolisher({
        apiKey: cfg.anthropic.apiKey,
        model: cfg.anthropic.model,
        baseUrl: cfg.anthropic.baseUrl,
      })
    case "openai_compat":
      return new OpenAiCompatPolisher({
        apiKey: cfg.openai_compat.apiKey,
        model: cfg.openai_compat.model,
        baseUrl: cfg.openai_compat.baseUrl,
      })
  }
}
