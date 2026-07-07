/**
 * sink/stdout.ts — a Sink that writes the final text to stdout.
 *
 * Suited for shell pipes: `dictum --stdout | claude`. A trailing newline is
 * added unless the text already ends with one.
 */

import type { Sink } from "../core/types.ts"

export class StdoutSink implements Sink {
  async emit(text: string): Promise<void> {
    const out = text.endsWith("\n") ? text : `${text}\n`
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(out, (err) => (err ? reject(err) : resolve()))
    })
  }
}
