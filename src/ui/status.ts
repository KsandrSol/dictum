/**
 * ui/status.ts — render a live status line from pipeline stage events.
 *
 * Stages map to glyphs: ● recording / ◌ transcribing / ✦ polishing, finishing
 * with ✓ <done> <timing>. Output goes to a stream (stderr by default) so stdout
 * stays clean for pipes. On a TTY the line is updated in place; otherwise only
 * completed stages are printed (no spinner spam in logs/pipes).
 *
 * Driven by the StageEvent stream already emitted by core/pipeline.ts.
 */

import type { PipelineStage, StageEvent } from "../core/types.ts"

const ACTIVE: Partial<Record<PipelineStage, { glyph: string; label: string }>> = {
  recording: { glyph: "●", label: "recording" },
  transcribing: { glyph: "◌", label: "transcribing" },
  polishing: { glyph: "✦", label: "polishing" },
  emitting: { glyph: "✦", label: "emitting" },
}

const DONE_LABEL: Partial<Record<PipelineStage, string>> = {
  recording: "recorded",
  transcribing: "transcribed",
  polishing: "polished",
}

const DEFAULT_EMIT_LABEL = "copied"
const CHECK = "✓"
const CLEAR_LINE = "\r\x1b[2K"

/** Format a millisecond duration as a short human string ("340ms" / "1.2s"). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Render a single status line for an event, or null when there's nothing to
 * show. `emitLabel` names the completed emit stage (e.g. "copied" for the
 * clipboard, "written" for stdout).
 */
export function renderStageLine(
  event: StageEvent,
  emitLabel: string = DEFAULT_EMIT_LABEL,
): string | null {
  if (event.stage === "done") return null
  if (event.durationMs === undefined) {
    const active = ACTIVE[event.stage]
    return active ? `${active.glyph} ${active.label}…` : null
  }
  const label = event.stage === "emitting" ? emitLabel : DONE_LABEL[event.stage]
  if (!label) return null
  const timing = formatDuration(event.durationMs)
  return timing ? `${CHECK} ${label} ${timing}` : `${CHECK} ${label}`
}

export type StatusStream = { write(s: string): unknown; isTTY?: boolean }

/** Consumes pipeline StageEvents and renders a status line. */
export class StatusReporter {
  private readonly stream: StatusStream
  private readonly tty: boolean
  private readonly emitLabel: string

  constructor(
    stream: StatusStream = process.stderr,
    opts: { tty?: boolean; emitLabel?: string } = {},
  ) {
    this.stream = stream
    this.tty = opts.tty ?? Boolean(stream.isTTY)
    this.emitLabel = opts.emitLabel ?? DEFAULT_EMIT_LABEL
  }

  /** Bound so it can be passed directly as the pipeline's `onStage` callback. */
  readonly onStage = (event: StageEvent): void => {
    if (event.stage === "done") {
      if (this.tty) this.stream.write("\n")
      return
    }
    const line = renderStageLine(event, this.emitLabel)
    if (!line) return
    const active = event.durationMs === undefined
    if (this.tty) {
      this.stream.write(`${CLEAR_LINE}${line}${active ? "" : "\n"}`)
    } else if (!active) {
      // Non-TTY: only print completed stages, one per line.
      this.stream.write(`${line}\n`)
    }
  }
}
