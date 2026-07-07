/**
 * core/types.ts — the single source of truth for Dictum's contracts.
 *
 * This module contains ONLY types and interfaces. No logic, no imports of
 * other project modules. Every pluggable component (recorder, stt, polisher,
 * sink) depends solely on the contracts declared here; assembly happens in
 * core/pipeline.ts and cli.ts.
 */

/** Raw captured audio: PCM16 WAV, 16 kHz, mono. */
export type AudioData = {
  /** Complete WAV file bytes (RIFF header + PCM16 data). */
  wav: Uint8Array
  /** Sample rate in Hz. Fixed at 16 kHz to match the STT backends. */
  sampleRate: 16000
  /** Channel count. Mono only. */
  channels: 1
}

/**
 * A polishing template: instruction text plus metadata. Loaded from built-in
 * markdown files or user overrides in ~/.config/dictum/templates/*.md.
 */
export type Template = {
  /** Stable identifier, e.g. "agent-prompt", "commit", "note". */
  name: string
  /** Human-readable summary shown by `dictum doctor` / help. */
  description: string
  /** Target output language hint, e.g. "en", "ru", "auto". */
  language: string
  /** Instruction body sent to the polisher LLM (template-specific prompt). */
  instruction: string
}

/** Captures audio from a source (microphone, file, …). */
export interface Recorder {
  /**
   * Record until the provided signal aborts (push-to-talk / Enter / VAD) or
   * the underlying source ends (e.g. a finite input file).
   */
  record(signal: AbortSignal): Promise<AudioData>
}

/** Transcribes audio into text. */
export interface STTProvider {
  /** Transcribe audio to plain text. */
  transcribe(audio: AudioData): Promise<string>
  /** Liveness probe; true when the backend is reachable and ready. */
  health(): Promise<boolean>
}

/** Refines raw transcript text into a structured output using a template. */
export interface Polisher {
  /** Produce polished text from a raw transcript and a template. */
  polish(text: string, template: Template): Promise<string>
}

/** Delivers the final text somewhere (clipboard, stdout, …). */
export interface Sink {
  /** Emit the final text to the destination. */
  emit(text: string): Promise<void>
}

/**
 * Context handed to an interactive chooser: the user's own words, the latest
 * polished candidate, and a way to request a fresh polish. The chooser returns
 * the text to emit. Lets the user keep their original instead of a blind
 * replacement. Wired in only on an interactive terminal (see cli.ts).
 */
export type ChoiceContext = {
  /** The user's own words — the transcript or the typed/piped text. */
  original: string
  /** The latest polished candidate. */
  polished: string
  /** Re-run the polisher for a fresh alternative (used by "regenerate"). */
  regenerate: () => Promise<string>
  /** Whole-operation cancel. */
  signal: AbortSignal
  /**
   * Optional one-line annotation for a polished candidate (e.g. a score delta),
   * rendered under the preview. Called again after each regenerate so the note
   * always describes the candidate on screen. Supplied by the assembly layer.
   */
  annotate?: ((polished: string) => string) | undefined
}

/**
 * Interactive selection between the original and a polished candidate. Returns
 * the text to emit. When no chooser is supplied the pipeline emits the polished
 * text directly (auto mode — pipes and --auto).
 */
export type Chooser = (ctx: ChoiceContext) => Promise<string>

/** Stages of the record → transcribe → polish → emit pipeline. */
export type PipelineStage = "recording" | "transcribing" | "polishing" | "emitting" | "done"

/** Progress event emitted as the pipeline advances; the start event has no duration. */
export type StageEvent = {
  stage: PipelineStage
  /** Wall-clock duration of the stage that just finished, in milliseconds. */
  durationMs?: number
}
