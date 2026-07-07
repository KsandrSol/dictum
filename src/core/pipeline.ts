/**
 * core/pipeline.ts — orchestrates the four stages over the abstract contracts
 * declared in core/types.ts: record → transcribe → polish → emit.
 *
 * This module knows nothing about concrete recorders/providers/sinks; cli.ts
 * constructs those and injects them. Imports only core/types.ts.
 */

import type {
  Chooser,
  PipelineStage,
  Polisher,
  Recorder,
  STTProvider,
  Sink,
  StageEvent,
  Template,
} from "./types.ts"

// Re-exported for back-compat; the canonical definitions live in core/types.ts.
export type { PipelineStage, StageEvent } from "./types.ts"

export type PipelineDeps = {
  /** Audio source. Omit when `text` is supplied (text input bypasses capture). */
  recorder?: Recorder | undefined
  /** STT backend. Omit when `text` is supplied. */
  stt?: STTProvider | undefined
  /**
   * Pre-supplied transcript (text input from --text or piped stdin). When set,
   * the record + transcribe stages are skipped and this text is polished/emitted.
   */
  text?: string | undefined
  polisher: Polisher
  sink: Sink
  template: Template
  /** Skip polishing and emit the raw transcript. */
  raw: boolean
  signal: AbortSignal
  /** Optional progress callback (UX layer in step 1.6). */
  onStage?: ((event: StageEvent) => void) | undefined
  /**
   * Optional interactive selection between the original and the polished text.
   * When omitted, the polished text is emitted directly (auto mode).
   */
  choose?: Chooser | undefined
}

export type PipelineResult = {
  transcript: string
  output: string
}

/**
 * Run the pipeline. Two input paths converge on a single transcript:
 *   - audio: record → transcribe (recorder + stt)
 *   - text:  use the supplied `text` directly (skips record + transcribe)
 * then: polish (unless --raw) → optional choice → emit.
 */
export async function runPipeline(deps: PipelineDeps): Promise<PipelineResult> {
  const { recorder, stt, text, polisher, sink, template, raw, signal, onStage, choose } = deps

  const notify = (stage: PipelineStage, startedAt: number) =>
    onStage?.({ stage, durationMs: performance.now() - startedAt })

  let t = performance.now()

  // 1 + 2. obtain transcript — text input bypasses recording and STT.
  let transcript: string
  if (text !== undefined) {
    transcript = text
  } else {
    if (!recorder || !stt) {
      throw new Error("Pipeline requires either text input or a recorder + STT provider")
    }
    // 1. record
    onStage?.({ stage: "recording" })
    const audio = await recorder.record(signal)
    notify("recording", t)

    // 2. transcribe
    t = performance.now()
    onStage?.({ stage: "transcribing" })
    transcript = await stt.transcribe(audio)
    notify("transcribing", t)
  }
  if (!transcript.trim()) {
    throw new Error(
      text !== undefined ? "No input text provided" : "No speech detected in the audio",
    )
  }

  // 3. polish (unless --raw)
  let output = transcript
  if (!raw) {
    t = performance.now()
    onStage?.({ stage: "polishing" })
    const polished = await polisher.polish(transcript, template)
    notify("polishing", t)

    // 3b. choose — show the polished candidate and let the user pick (or accept
    // the polished default). Without a chooser the polished text wins (auto mode).
    output = choose
      ? await choose({
          original: transcript,
          polished,
          regenerate: () => polisher.polish(transcript, template),
          signal,
        })
      : polished
  }

  // 4. emit
  t = performance.now()
  onStage?.({ stage: "emitting" })
  await sink.emit(output)
  notify("emitting", t)

  onStage?.({ stage: "done" })
  return { transcript, output }
}
