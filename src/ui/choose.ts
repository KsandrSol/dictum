/**
 * ui/choose.ts — interactive selection between the user's original words and the
 * polished candidate.
 *
 * Dictum proposes a polished prompt rather than blindly replacing the input: on
 * an interactive terminal it shows both and asks which to emit, with the option
 * to regenerate a fresh polish. Pipes (`dictum | claude`, `echo … | dictum`) and
 * `--auto` skip this entirely and emit the polished text directly — cli.ts
 * decides and only wires a chooser in when appropriate.
 *
 * Imported only by cli.ts (assembly layer). Depends only on core/types.ts.
 */

import { createInterface } from "node:readline/promises"
import type { ChoiceContext, Chooser } from "../core/types.ts"

export type ChoiceAction = "original" | "polished" | "regenerate" | "unknown"

/** Question shown when asking for a choice. */
export const CHOICE_PROMPT = "Keep [p]olished (default), [o]riginal, or [r]egenerate? "

/** Hint repeated after an unrecognized key. */
export const CHOICE_HINT = "Please answer o / p / r (or Enter for polished)."

/** Map a raw keypress / line to a choice action. Pure, for testing. */
export function parseChoiceKey(input: string): ChoiceAction {
  const k = input.trim().toLowerCase()
  if (k === "" || k === "p" || k === "polished") return "polished"
  if (k === "o" || k === "original") return "original"
  if (k === "r" || k === "regenerate") return "regenerate"
  return "unknown"
}

/** Render the side-by-side preview block (original + polished). Pure, for testing. */
export function formatPreview(original: string, polished: string, note?: string): string {
  const lines = ["", "── your words ──", original, "", "── polished ──", polished]
  if (note) lines.push("", note)
  lines.push("")
  return lines.join("\n")
}

/** Injectable I/O so the interactive loop can be unit-tested without a real TTY. */
export type ChooserIo = {
  /** Display a line/block (goes to stderr in production, keeping stdout clean). */
  write: (s: string) => void
  /** Prompt and read one line; resolves to null on EOF (Ctrl-D). */
  readLine: (prompt: string) => Promise<string | null>
}

/**
 * Drive the choose loop over an injectable I/O. Returns the text to emit.
 * EOF (stdin closed) accepts the current polished default.
 */
export async function interactiveChoose(ctx: ChoiceContext, io: ChooserIo): Promise<string> {
  let polished = ctx.polished
  io.write(formatPreview(ctx.original, polished, ctx.annotate?.(polished)))

  while (true) {
    const line = await io.readLine(CHOICE_PROMPT)
    if (line === null) return polished // EOF → accept the polished default
    const action = parseChoiceKey(line)
    if (action === "original") return ctx.original
    if (action === "polished") return polished
    if (action === "regenerate") {
      io.write("\nRegenerating…\n")
      polished = await ctx.regenerate()
      io.write(formatPreview(ctx.original, polished, ctx.annotate?.(polished)))
      continue
    }
    io.write(`${CHOICE_HINT}\n`)
  }
}

/**
 * Build a Chooser bound to the real terminal: reads keys from stdin, renders the
 * prompt on stderr so stdout stays clean for the result.
 */
export function terminalChooser(): Chooser {
  return (ctx) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    const io: ChooserIo = {
      write: (s) => {
        process.stderr.write(s)
      },
      readLine: async (prompt) => {
        try {
          return await rl.question(prompt)
        } catch {
          return null // stream closed / aborted
        }
      },
    }
    return interactiveChoose(ctx, io).finally(() => rl.close())
  }
}
