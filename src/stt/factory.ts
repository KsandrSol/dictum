/**
 * stt/factory.ts — build an STTProvider from configuration.
 *
 * Providers are tried in the configured order. transcribe() health-checks each
 * candidate and falls back to the next when one is unhealthy or errors, so a
 * dead primary (e.g. local server down) transparently fails over to a cloud
 * backend. Imports only core/types.ts and sibling stt files (own module).
 */

import type { AudioData, STTProvider } from "../core/types.ts"
import { LocalHttpStt } from "./local_http.ts"
import { OpenAiCompatStt } from "./openai_compat.ts"

export const VALID_STT_PROVIDERS = ["local_http", "openai_compat"] as const
export type SttProviderName = (typeof VALID_STT_PROVIDERS)[number]

/** Structural config the factory needs (mirrors Config["stt"], no import). */
export type SttFactoryConfig = {
  providers: string[]
  local_http: { baseUrl: string }
  openai_compat: { baseUrl: string; apiKey: string; model: string; language: string }
}

export type NamedProvider = { name: SttProviderName; provider: STTProvider }

function isValidName(name: string): name is SttProviderName {
  return (VALID_STT_PROVIDERS as readonly string[]).includes(name)
}

function instantiate(name: SttProviderName, cfg: SttFactoryConfig): STTProvider {
  switch (name) {
    case "local_http":
      return new LocalHttpStt({ baseUrl: cfg.local_http.baseUrl })
    case "openai_compat":
      return new OpenAiCompatStt({
        baseUrl: cfg.openai_compat.baseUrl,
        apiKey: cfg.openai_compat.apiKey,
        model: cfg.openai_compat.model,
        language: cfg.openai_compat.language,
      })
  }
}

/** Build the ordered list of named providers, validating each name. */
export function buildSttProviders(cfg: SttFactoryConfig): NamedProvider[] {
  if (cfg.providers.length === 0) {
    throw new Error("No STT providers configured ([stt].providers is empty)")
  }
  return cfg.providers.map((name) => {
    if (!isValidName(name)) {
      throw new Error(`Unknown STT provider '${name}'. Valid: ${VALID_STT_PROVIDERS.join(", ")}`)
    }
    return { name, provider: instantiate(name, cfg) }
  })
}

/** An STTProvider that fails over across an ordered list of backends. */
export class FallbackStt implements STTProvider {
  constructor(private readonly providers: NamedProvider[]) {}

  async health(): Promise<boolean> {
    for (const p of this.providers) {
      if (await p.provider.health()) return true
    }
    return false
  }

  async transcribe(audio: AudioData): Promise<string> {
    const errors: string[] = []
    for (const p of this.providers) {
      const healthy = await p.provider.health()
      if (!healthy) {
        errors.push(`${p.name}: unhealthy`)
        continue
      }
      try {
        return await p.provider.transcribe(audio)
      } catch (err) {
        errors.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    throw new Error(`All STT providers failed:\n  - ${errors.join("\n  - ")}`)
  }
}

/** Construct the composite STTProvider from config. */
export function createSttProvider(cfg: SttFactoryConfig): STTProvider {
  return new FallbackStt(buildSttProviders(cfg))
}
