import { describe, expect, test } from "bun:test"
import { AnthropicPolisher } from "../src/polisher/anthropic.ts"
import { ClaudeCliPolisher } from "../src/polisher/claude_cli.ts"
import {
  type PolisherFactoryConfig,
  VALID_POLISHERS,
  VALID_POLISHER_MODES,
  createPolisher,
} from "../src/polisher/factory.ts"
import { LayeredPolisher, RulesPolisher } from "../src/polisher/layered.ts"
import { OpenAiCompatPolisher } from "../src/polisher/openai_compat.ts"

const base: PolisherFactoryConfig = {
  provider: "claude_cli",
  claude_cli: { bin: "claude", model: "", timeout: 60 },
  anthropic: { apiKey: "k", model: "claude-opus-4-8", baseUrl: "https://api.anthropic.com" },
  openai_compat: { apiKey: "k", model: "gpt-4o-mini", baseUrl: "https://api.openai.com" },
}

describe("createPolisher", () => {
  test("builds the claude_cli polisher", () => {
    expect(createPolisher({ ...base, provider: "claude_cli" })).toBeInstanceOf(ClaudeCliPolisher)
  })

  test("builds the anthropic polisher", () => {
    expect(createPolisher({ ...base, provider: "anthropic" })).toBeInstanceOf(AnthropicPolisher)
  })

  test("builds the openai_compat polisher", () => {
    expect(createPolisher({ ...base, provider: "openai_compat" })).toBeInstanceOf(
      OpenAiCompatPolisher,
    )
  })

  test("rejects an unknown provider with a helpful message", () => {
    expect(() => createPolisher({ ...base, provider: "ollama" })).toThrow(
      /Unknown polisher 'ollama'\. Valid: claude_cli, anthropic, openai_compat/,
    )
  })

  test("VALID_POLISHERS is the source of truth", () => {
    expect([...VALID_POLISHERS]).toEqual(["claude_cli", "anthropic", "openai_compat"])
  })
})

describe("createPolisher modes", () => {
  test("default mode is llm — bare provider, unchanged behavior", () => {
    expect(createPolisher(base)).toBeInstanceOf(ClaudeCliPolisher)
    expect(createPolisher({ ...base, mode: "llm" })).toBeInstanceOf(ClaudeCliPolisher)
  })

  test("mode rules is fully offline and ignores the provider entirely", () => {
    expect(createPolisher({ ...base, mode: "rules", provider: "nonsense" })).toBeInstanceOf(
      RulesPolisher,
    )
  })

  test("mode layered wraps the provider behind the score gate", () => {
    expect(createPolisher({ ...base, mode: "layered" })).toBeInstanceOf(LayeredPolisher)
  })

  test("layered still validates the provider", () => {
    expect(() => createPolisher({ ...base, mode: "layered", provider: "ollama" })).toThrow(
      /Unknown polisher 'ollama'/,
    )
  })

  test("rejects an unknown mode with a helpful message", () => {
    expect(() => createPolisher({ ...base, mode: "turbo" })).toThrow(
      /Unknown polisher mode 'turbo'\. Valid: llm, rules, layered/,
    )
  })

  test("VALID_POLISHER_MODES is the source of truth", () => {
    expect([...VALID_POLISHER_MODES]).toEqual(["llm", "rules", "layered"])
  })
})
