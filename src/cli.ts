#!/usr/bin/env bun
/**
 * cli.ts — entry point. Parses argv with util.parseArgs and dispatches to a
 * command. Pipeline assembly lives here and in core/pipeline.ts; nothing else
 * imports sibling modules.
 */

import { parseArgs } from "node:util"
import pkg from "../package.json" with { type: "json" }
import { loadConfig, templatesDir } from "./config.ts"
import { runPipeline } from "./core/pipeline.ts"
import type { ChoiceContext, Recorder, Sink } from "./core/types.ts"
import { doctorExitCode, formatDoctorTable, runDoctorChecks } from "./doctor.ts"
import { startMcpServer } from "./mcp/server.ts"
import { createPolisher } from "./polisher/factory.ts"
import { type PromptDimension, analyzePrompt } from "./polisher/rules.ts"
import { resolveTemplate } from "./polisher/templates.ts"
import { FileRecorder } from "./recorder/file.ts"
import { SoxRecorder } from "./recorder/sox.ts"
import { createSink } from "./sink/factory.ts"
import { createSttProvider } from "./stt/factory.ts"
import { terminalChooser } from "./ui/choose.ts"
import { type StopController, createStopController } from "./ui/keys.ts"
import { StatusReporter } from "./ui/status.ts"

const VERSION: string = pkg.version

export type CliCommand = "run" | "doctor" | "mcp" | "help" | "version"

export type OutputFormat = "text" | "json"

export type CliOptions = {
  command: CliCommand
  /** Read audio from this WAV file instead of recording. */
  input: string | undefined
  /** Polish this text directly instead of recording (text input). */
  text: string | undefined
  /** Force stdout sink. */
  stdout: boolean
  /** Skip polishing, emit the raw transcript. */
  raw: boolean
  /** Skip the interactive choice; emit the polished text directly. */
  auto: boolean
  /** Template / mode name (-m / --mode / --template). */
  mode: string | undefined
  /** Output format: plain polished text (default) or a JSON envelope. */
  format: OutputFormat
  /** Unknown / error message produced while parsing, if any. */
  error: string | undefined
}

const HELP = `dictum — dictate (or type) a thought, get a polished prompt.

Usage:
  dictum [options]            Record (or read --input/--text/stdin), polish, emit
  dictum doctor               Check microphone, STT, polisher and clipboard
  dictum mcp                  Run as an MCP server (host-brain prompts + tools) over stdio
  dictum --help               Show this help
  dictum --version            Show version

Input (pick one; default is the microphone):
  -i, --input <file>          Transcribe a WAV file instead of recording
  -t, --text <text>           Polish this text instead of recording
                              (piped stdin is read as text too: echo … | dictum)

Options:
  -m, --mode <name>           Polishing template: agent-prompt | commit | note | spec | decompose
      --template <name>       Alias for --mode
      --raw                   Skip polishing; output the raw transcript
      --auto                  Skip the choice prompt; emit the polished text
      --stdout                Print result to stdout instead of the clipboard
      --format <text|json>    Output format. json emits a stable envelope:
                              {v, original, polished, template, score, rationale}
  -h, --help                  Show help
  -v, --version               Show version

On an interactive terminal Dictum shows the polished result and lets you keep it,
your original, or regenerate. In a pipe (or with --auto) it emits automatically.

Examples:
  dictum                      Push-to-talk, choose, polished prompt to clipboard
  dictum --text "fix the bug in auth" -m agent-prompt
  echo "draft commit message" | dictum -m commit --stdout
  dictum --input note.wav --stdout
  dictum -m commit --auto --stdout | git commit -F -
  dictum --text "draft" --auto --stdout --format json | jq .polished
`

/**
 * Pure argument parser — no side effects, safe to unit-test. Returns the
 * resolved command and options, or an `error` string for invalid input.
 */
export function parseCliArgs(argv: string[]): CliOptions {
  const base: CliOptions = {
    command: "run",
    input: undefined,
    text: undefined,
    stdout: false,
    raw: false,
    auto: false,
    mode: undefined,
    format: "text",
    error: undefined,
  }

  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
        input: { type: "string", short: "i" },
        text: { type: "string", short: "t" },
        mode: { type: "string", short: "m" },
        template: { type: "string" },
        raw: { type: "boolean" },
        auto: { type: "boolean" },
        stdout: { type: "boolean" },
        format: { type: "string" },
      },
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ...base, error: reason }
  }

  const { values, positionals } = parsed

  if (values.version === true) return { ...base, command: "version" }
  if (values.help === true) return { ...base, command: "help" }

  let command: CliCommand = "run"
  if (positionals.length > 0) {
    const cmd = positionals[0]
    if (cmd === "doctor") {
      command = "doctor"
    } else if (cmd === "mcp") {
      command = "mcp"
    } else if (cmd === "run") {
      command = "run"
    } else {
      return { ...base, error: `Unknown command: ${cmd}` }
    }
  }

  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

  const input = str(values.input)
  const text = str(values.text)
  if (input !== undefined && text !== undefined) {
    return { ...base, error: "Use either --input or --text, not both" }
  }

  const format = str(values.format) ?? "text"
  if (format !== "text" && format !== "json") {
    return { ...base, error: `Unknown format '${format}'. Valid: text, json` }
  }

  return {
    command,
    input,
    text,
    stdout: values.stdout === true,
    raw: values.raw === true,
    auto: values.auto === true,
    mode: str(values.mode) ?? str(values.template),
    format,
    error: undefined,
  }
}

/**
 * Stable machine-readable result envelope (`--format json`, v1). Consumed by
 * scripts and integrations (e.g. Hail's shell-out). Scores come from the
 * deterministic analyzer: `score.before`/`dimensions`/`rationale` describe the
 * original draft (why polishing was needed), `score.after` the emitted text.
 */
export type JsonEnvelope = {
  v: 1
  original: string
  polished: string
  template: string
  score: { before: number; after: number; dimensions: Record<PromptDimension, number> }
  rationale: string[]
}

/** Build the --format json envelope from a pipeline result. Pure, for testing. */
export function buildJsonEnvelope(
  original: string,
  polished: string,
  templateName: string,
): JsonEnvelope {
  const before = analyzePrompt(original)
  const after = analyzePrompt(polished)
  return {
    v: 1,
    original,
    polished,
    template: templateName,
    score: { before: before.score, after: after.score, dimensions: before.dimensions },
    rationale: before.issues,
  }
}

/**
 * One-line score annotation for the interactive chooser: total delta plus the
 * two most-improved dimensions, e.g. "score 34 → 78 · structure +5, clarity +4".
 */
export function scoreLine(original: string, polished: string): string {
  const before = analyzePrompt(original)
  const after = analyzePrompt(polished)
  const gains = (Object.keys(after.dimensions) as PromptDimension[])
    .map((d) => ({ d, delta: after.dimensions[d] - before.dimensions[d] }))
    .filter((g) => g.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 2)
    .map((g) => `${g.d} +${g.delta}`)
  const tail = gains.length > 0 ? ` · ${gains.join(", ")}` : ""
  return `score ${before.score} → ${after.score}${tail}`
}

/** Run environment diagnostics and print a report. */
async function runDoctor(): Promise<number> {
  const config = await loadConfig()
  const results = await runDoctorChecks(config)
  process.stdout.write(formatDoctorTable(results))
  return doctorExitCode(results)
}

/**
 * Resolve the text input, if any. Explicit --text wins; otherwise piped stdin
 * (non-TTY, and no --input) is read as text. Returns undefined for the mic/file
 * audio path. Reading stdin here is safe because an interactive terminal keeps
 * stdin a TTY (so `dictum | claude` still records from the mic).
 */
async function resolveTextInput(opts: CliOptions): Promise<string | undefined> {
  if (opts.text !== undefined) return opts.text
  if (!opts.input && !process.stdin.isTTY) return await Bun.stdin.text()
  return undefined
}

/** Assemble concrete stages from config + CLI options and run the pipeline. */
async function runCommand(opts: CliOptions): Promise<number> {
  const config = await loadConfig()
  const fail = (err: unknown): void => {
    process.stderr.write(`dictum: ${err instanceof Error ? err.message : String(err)}\n`)
  }

  // Input source: explicit --text / piped stdin take the text path (no STT).
  const textInput = await resolveTextInput(opts)

  // Polisher selected by config ([polisher].provider / DICTUM_POLISHER).
  let polisher: ReturnType<typeof createPolisher>
  try {
    polisher = createPolisher(config.polisher)
  } catch (err) {
    fail(err)
    return 2
  }

  // Sink: --stdout forces stdout (for pipes); otherwise the configured target.
  const sinkName = opts.stdout ? "stdout" : config.sink.target
  let sink: ReturnType<typeof createSink>
  try {
    sink = createSink(sinkName)
  } catch (err) {
    fail(err)
    return 2
  }

  // Template from -m/--mode or config; user overrides in ~/.config/dictum/templates.
  let template: Awaited<ReturnType<typeof resolveTemplate>>
  try {
    template = await resolveTemplate(opts.mode ?? config.polisher.template, templatesDir())
  } catch (err) {
    fail(err)
    return 2
  }

  // STT only on the audio path.
  let stt: ReturnType<typeof createSttProvider> | undefined
  if (textInput === undefined) {
    try {
      stt = createSttProvider(config.stt)
    } catch (err) {
      fail(err)
      return 2
    }
  }

  // Interactive choice: only on a fully-interactive terminal, never with --auto
  // or --raw (nothing to choose). Pipes (dictum | claude, echo | dictum) auto-emit.
  // The chooser is annotated with the analyzer's score delta so the user sees
  // *why* the polished candidate is (or is not) an improvement.
  const interactive =
    !opts.auto && Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY)
  const chooseBase = interactive && !opts.raw ? terminalChooser() : undefined
  const choose = chooseBase
    ? (ctx: ChoiceContext) =>
        chooseBase({ ...ctx, annotate: (polished) => scoreLine(ctx.original, polished) })
    : undefined

  // Whole-operation cancel (Ctrl-C).
  const cancel = new AbortController()
  const onSigint = () => cancel.abort()
  process.on("SIGINT", onSigint)

  // Recorder + recording-stop signal (audio path only). --input reads a file
  // (no keys); live capture stops via Enter / silence (VAD) / push-to-talk.
  let recorder: Recorder | undefined
  let stop: StopController | undefined
  if (textInput === undefined) {
    if (opts.input) {
      recorder = new FileRecorder(opts.input)
    } else {
      recorder = new SoxRecorder({
        maxDuration: config.recorder.maxDuration,
        vad: config.recorder.stopMode === "vad",
        vadOptions: {
          energyThreshold: config.recorder.energyThreshold,
          silenceTimeoutSec: config.recorder.silenceTimeout,
        },
      })
      stop = createStopController(config.recorder.stopMode, { parent: cancel.signal })
    }
  }

  // Status line (● recording / ◌ transcribing / ✦ polishing / ✓) → stderr.
  const status = new StatusReporter(process.stderr, {
    emitLabel: sinkName === "stdout" ? "emitted" : "copied",
  })

  // --format json: capture the pipeline's emit, then wrap the result in the
  // stable envelope and send *that* through the real sink (use with --stdout).
  let sinkForPipeline: Sink = sink
  if (opts.format === "json") {
    sinkForPipeline = { emit: async () => {} }
  }

  try {
    const result = await runPipeline({
      recorder,
      stt,
      text: textInput,
      polisher,
      sink: sinkForPipeline,
      template,
      raw: opts.raw,
      signal: stop ? stop.signal : cancel.signal,
      onStage: status.onStage,
      choose,
    })
    if (opts.format === "json") {
      const envelope = buildJsonEnvelope(result.transcript, result.output, template.name)
      await sink.emit(JSON.stringify(envelope))
    }
    return 0
  } catch (err) {
    fail(err)
    return 1
  } finally {
    stop?.dispose()
    process.off("SIGINT", onSigint)
  }
}

export async function main(argv: string[]): Promise<number> {
  const opts = parseCliArgs(argv)

  if (opts.error) {
    process.stderr.write(`dictum: ${opts.error}\n\nRun 'dictum --help' for usage.\n`)
    return 2
  }

  switch (opts.command) {
    case "version":
      process.stdout.write(`${VERSION}\n`)
      return 0
    case "help":
      process.stdout.write(HELP)
      return 0
    case "doctor":
      return runDoctor()
    case "mcp":
      await startMcpServer()
      return 0
    case "run":
      return runCommand(opts)
  }
}

// Only run when executed directly (not when imported by tests).
if (import.meta.main) {
  const code = await main(Bun.argv.slice(2))
  process.exit(code)
}
