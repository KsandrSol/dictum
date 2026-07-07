/**
 * sink/factory.ts — build a Sink from a target name.
 *
 * Validates the name (human-readable error on a bad config/env value) and
 * constructs the matching sink. Imports only core/types.ts and sibling sink
 * files (own module).
 */

import type { Sink } from "../core/types.ts"
import { ClipboardSink } from "./clipboard.ts"
import { StdoutSink } from "./stdout.ts"

export const VALID_SINKS = ["clipboard", "stdout"] as const
export type SinkName = (typeof VALID_SINKS)[number]

function isValidName(name: string): name is SinkName {
  return (VALID_SINKS as readonly string[]).includes(name)
}

/** Construct the named Sink; throws on an unknown target. */
export function createSink(name: string): Sink {
  if (!isValidName(name)) {
    throw new Error(`Unknown sink '${name}'. Valid: ${VALID_SINKS.join(", ")}`)
  }
  switch (name) {
    case "clipboard":
      return new ClipboardSink()
    case "stdout":
      return new StdoutSink()
  }
}
