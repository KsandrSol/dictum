/**
 * polisher/layered.ts — offline and two-layer polishers over rules.ts.
 *
 * RulesPolisher: deterministic cleanup only — works with no LLM, no network,
 * no API key. The fully-offline mode.
 *
 * LayeredPolisher: the two-layer strategy (borrowed from the wider prompt-
 * optimizer ecosystem): a deterministic analyzer decides whether the LLM is
 * needed at all. Drafts that already score at or above the threshold take the
 * fast offline path (normalize only); everything else goes to the wrapped LLM
 * polisher. Saves latency, tokens and privacy on already-good prompts.
 *
 * Imports only core/types.ts and sibling polisher files.
 */

import type { Polisher, Template } from "../core/types.ts"
import { analyzePrompt, normalizeText } from "./rules.ts"

/** Offline polisher: deterministic normalization, no LLM involved. */
export class RulesPolisher implements Polisher {
  async polish(text: string, _template: Template): Promise<string> {
    return normalizeText(text)
  }
}

export type LayeredOptions = {
  /** Skip the LLM when the draft already scores at or above this (0–100). */
  scoreThreshold: number
}

/** Two-layer polisher: rule-based gate in front of a wrapped LLM polisher. */
export class LayeredPolisher implements Polisher {
  constructor(
    private readonly inner: Polisher,
    private readonly opts: LayeredOptions,
  ) {}

  async polish(text: string, template: Template): Promise<string> {
    const analysis = analyzePrompt(text)
    if (analysis.score >= this.opts.scoreThreshold) return normalizeText(text)
    return this.inner.polish(text, template)
  }
}
