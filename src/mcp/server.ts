/**
 * mcp/server.ts — expose Dictum's engine over MCP.
 *
 * Any MCP client (Claude Code, Cursor, Windsurf, Claude Desktop, Codex) can
 * use Dictum without installing the CLI. Text-only — voice has no place in
 * the MCP protocol (no microphone access).
 *
 * Prompts (the flagship, host-brain: the HOST model rewrites, using the
 * session's project context — see prompts.ts):
 *   - polish(draft?)    — draft → clear, structured prompt
 *   - spec(draft?)      — draft → task spec with acceptance criteria
 *   - decompose(draft?) — draft → ordered, dependency-tracked subtasks
 *
 * Tools:
 *   - polish_brief(text, mode?) — the same host-brain brief as a tool result,
 *                                 for hosts without MCP Prompts (Codex CLI)
 *   - present_prompt(original, proposed) — native review/confirm/revise panel
 *                                 via MCP elicitation (text fallback otherwise)
 *   - polish_prompt(text, mode?) — server-side polish with Dictum's own model
 *   - analyze_prompt(text)      — deterministic 0–100 score + weak spots (offline)
 *   - build_spec(text)          — server-side spec via the "spec" template
 *
 * This is an assembly-layer entry point (like cli.ts): it reuses createPolisher
 * + resolveTemplate and never touches recorder/stt/sink. Started via `dictum mcp`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type {
  CallToolResult,
  ElicitRequestFormParams,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js"
import { ErrorCode, GetPromptRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import pkg from "../../package.json" with { type: "json" }
import { type Config, loadConfig, templatesDir } from "../config.ts"
import { DICTUM_MCP_INSTRUCTIONS } from "../hosts/rule.ts"
import { createPolisher } from "../polisher/factory.ts"
import { analyzePrompt } from "../polisher/rules.ts"
import { availableTemplateNames, resolveTemplate } from "../polisher/templates.ts"
import {
  HOST_PROMPT_KINDS,
  HOST_PROMPT_META,
  PROVIDER_FAMILIES,
  type ProviderFamily,
  buildHostBrief,
  buildHostPrompt,
  detectProviderFamily,
  isHostPromptKind,
  isProviderFamily,
} from "./prompts.ts"

/**
 * Codex reads MCP initialization instructions when deciding whether and how to
 * use the server. Keep the explicit trigger and safety gate in the first 512
 * characters so `dictum:` cannot be mistaken for permission to start work.
 */
export { DICTUM_MCP_INSTRUCTIONS }

/** Refines `text` with the given template `mode`; resolves to the polished text. */
export type PolishFn = (text: string, mode?: string) => Promise<string>

export type McpDeps = {
  /** Polishing backend (real one from config, or a stub in tests). */
  polish: PolishFn
  /** Template names advertised in the tool description. */
  modes: string[]
}

/** Build a text CallToolResult. */
function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError }
}

// ── In-flight request tracking ──────────────────────────────────────────────
// stdin EOF must not kill responses still being computed (an async tool like
// polish_prompt awaits a subprocess). Handlers are wrapped in track(); the
// EOF path awaits waitForIdle() before letting the process exit.

let inflight = 0

/** Wrap a handler so the in-flight counter reflects it. */
export function track<A extends unknown[], R>(
  fn: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    inflight++
    try {
      return await fn(...args)
    } finally {
      inflight--
    }
  }
}

// The SDK hands a parsed request to its handler on a later microtask; on
// Bun 1.2 stdin 'end' lands inside that gap, when no handler has started yet
// and inflight is still 0. Idle is therefore also judged at the wire level:
// every request the transport parsed must get its response before exit.
const pendingWire = new Set<string | number>()

/** Record a client→server wire message; requests (id + method) become pending. */
export function noteWireMessage(message: unknown): void {
  const m = message as { id?: unknown; method?: unknown } | null
  if (m && typeof m.method === "string" && (typeof m.id === "string" || typeof m.id === "number")) {
    pendingWire.add(m.id)
  }
}

/** Record a server→client wire message; responses (id, no method) settle requests. */
export function noteWireReply(message: unknown): void {
  const m = message as { id?: unknown; method?: unknown } | null
  if (m && m.method === undefined && (typeof m.id === "string" || typeof m.id === "number")) {
    pendingWire.delete(m.id)
  }
}

/**
 * Wrap a connected transport so pendingWire mirrors the actual traffic.
 * Must run after connect() — that is when the protocol assigns onmessage.
 */
export function instrumentWireTracking(transport: Transport): void {
  const dispatch = transport.onmessage
  transport.onmessage = (message, extra) => {
    noteWireMessage(message)
    dispatch?.(message, extra)
  }
  const sendRaw = transport.send.bind(transport)
  // Settle only after send() resolves — the EOF drain must not count a
  // response as delivered while its bytes are still queued for stdout.
  transport.send = (message, options) =>
    sendRaw(message, options).finally(() => noteWireReply(message))
}

/** Resolve once no request is in flight or awaiting dispatch (or the drain timeout elapses). */
export async function waitForIdle(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while ((inflight > 0 || pendingWire.size > 0) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
}

/**
 * Core polish_prompt logic, decoupled from the transport for direct testing.
 * Validates input and maps provider failures to a human-readable error result
 * (isError) rather than throwing across the protocol boundary.
 */
export async function handlePolishPrompt(
  args: { text?: unknown; mode?: unknown },
  deps: McpDeps,
): Promise<CallToolResult> {
  const text = typeof args.text === "string" ? args.text.trim() : ""
  if (!text) {
    return textResult("Error: 'text' must be a non-empty string.", true)
  }
  const mode = typeof args.mode === "string" && args.mode.length > 0 ? args.mode : undefined
  // Defense in depth on top of resolveTemplate's name validation: MCP callers
  // may only pick from the advertised template list.
  if (mode !== undefined && !deps.modes.includes(mode)) {
    return textResult(`Error: unknown mode '${mode}'. Valid: ${deps.modes.join(", ")}.`, true)
  }
  try {
    const polished = await deps.polish(text, mode)
    return textResult(polished)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return textResult(`Polishing failed: ${reason}`, true)
  }
}

/**
 * analyze_prompt logic: deterministic offline scoring — no LLM call, so it
 * never fails on provider problems. Returns the analysis as a JSON string
 * ({score, dimensions, issues}) for the client to reason over.
 */
export function handleAnalyzePrompt(args: { text?: unknown }): CallToolResult {
  const text = typeof args.text === "string" ? args.text.trim() : ""
  if (!text) {
    return textResult("Error: 'text' must be a non-empty string.", true)
  }
  return textResult(JSON.stringify(analyzePrompt(text)))
}

/** build_spec logic: polish_prompt fixed to the "spec" template. */
export async function handleBuildSpec(
  args: { text?: unknown },
  deps: McpDeps,
): Promise<CallToolResult> {
  return handlePolishPrompt({ text: args.text, mode: "spec" }, deps)
}

/**
 * polish_brief logic: return the host-brain brief as a tool result, so hosts
 * without MCP Prompts (Codex CLI) still get the flagship flow — the HOST model
 * executes the brief with its own session context. Offline, no LLM call.
 */
export function handlePolishBrief(
  args: { text?: unknown; mode?: unknown; provider?: unknown },
  detected: ProviderFamily = "generic",
): CallToolResult {
  const text = typeof args.text === "string" ? args.text.trim() : ""
  if (!text) {
    return textResult("Error: 'text' must be a non-empty string.", true)
  }
  const mode = typeof args.mode === "string" && args.mode.length > 0 ? args.mode : "polish"
  if (!isHostPromptKind(mode)) {
    return textResult(
      `Error: unknown brief mode '${mode}'. Valid: ${HOST_PROMPT_KINDS.join(", ")}.`,
      true,
    )
  }
  const provider =
    typeof args.provider === "string" && args.provider.length > 0 ? args.provider : detected
  if (!isProviderFamily(provider)) {
    return textResult(
      `Error: unknown provider '${provider}'. Valid: ${PROVIDER_FAMILIES.join(", ")}.`,
      true,
    )
  }
  return textResult(buildHostBrief(mode, text, provider))
}

export type PromptDecision =
  | "act"
  | "keep"
  | "regenerate"
  | "tweak"
  | "feedback_required"
  | "fallback_required"
  | "cancel"

export type PromptDecisionPayload = Record<string, unknown> & {
  decision: PromptDecision
  feedback?: string
}

type ElicitFn = (params: ElicitRequestFormParams) => Promise<ElicitResult>

function decisionResult(payload: PromptDecisionPayload, instruction: string): CallToolResult {
  return {
    content: [{ type: "text", text: `${JSON.stringify(payload)}\n\n${instruction}` }],
    structuredContent: payload,
  }
}

/** Fence arbitrary prompt text without letting embedded backticks close the block. */
function fencedPrompt(proposed: string): string {
  let longestRun = 0
  let currentRun = 0
  for (const character of proposed) {
    if (character === "`") {
      currentRun += 1
      longestRun = Math.max(longestRun, currentRun)
    } else {
      currentRun = 0
    }
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1))
  return `${fence}\n${proposed}\n${fence}`
}

/** A self-contained text gate for clients whose native elicitation is unavailable or broken. */
function fallbackResult(proposed: string, reason: string): CallToolResult {
  return decisionResult(
    { decision: "fallback_required" },
    `${reason} Repeat the complete fallback review below in chat, including the entire proposed prompt and every choice, then wait for an explicit reply. Do not shorten or omit the prompt, and do not start the underlying work.\n\nProposed prompt:\n\n${fencedPrompt(proposed)}\n\n1. Act on the polished prompt\n2. Keep the original draft and stop\n3. Generate another version\n4. Enter my corrections\n\nAfter Regenerate or Corrections, show the complete new version and repeat the review. Ask the user to reply with 1, 2, 3, or 4, or type their corrections directly.`,
  )
}

/**
 * Show a host-native review form after the host model has produced the prompt.
 * The MCP server cannot create that proposal itself because only the host sees
 * the session/repository context, hence this deliberately follows polish_brief
 * as the second half of a two-tool handshake.
 */
export async function handlePresentPrompt(
  args: { original?: unknown; proposed?: unknown },
  elicit?: ElicitFn,
): Promise<CallToolResult> {
  const original = typeof args.original === "string" ? args.original.trim() : ""
  const proposed = typeof args.proposed === "string" ? args.proposed.trim() : ""
  if (!original) return textResult("Error: 'original' must be a non-empty string.", true)
  if (!proposed) return textResult("Error: 'proposed' must be a non-empty string.", true)

  if (!elicit) {
    return fallbackResult(proposed, "Native confirmation is unavailable.")
  }

  let choiceResult: ElicitResult
  try {
    choiceResult = await elicit({
      mode: "form",
      message: `Review Dictum's proposed prompt before any work starts:\n\n${proposed}`,
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            title: "Next step",
            description: "Choose what Dictum should do with the proposed prompt.",
            oneOf: [
              { const: "act", title: "1. Act on polished prompt" },
              { const: "keep", title: "2. Keep original and stop" },
              { const: "regenerate", title: "3. Generate another version" },
              { const: "tweak", title: "4. Enter my corrections…" },
            ],
          },
        },
        required: ["decision"],
      },
    })
  } catch {
    return fallbackResult(proposed, "The client could not open or process native confirmation.")
  }

  if (choiceResult.action !== "accept") {
    return decisionResult(
      { decision: "cancel" },
      "The user dismissed Dictum's confirmation. Stop without starting the underlying work.",
    )
  }

  if (!choiceResult.content) {
    return fallbackResult(
      proposed,
      "The client accepted native confirmation but did not deliver the selected choice.",
    )
  }

  const rawDecision = choiceResult.content.decision
  if (
    rawDecision !== "act" &&
    rawDecision !== "keep" &&
    rawDecision !== "regenerate" &&
    rawDecision !== "tweak"
  ) {
    return fallbackResult(proposed, "The client returned an unknown native confirmation choice.")
  }

  if (rawDecision === "act") {
    return decisionResult(
      { decision: "act" },
      "The user explicitly approved the proposed prompt. Act on it now.",
    )
  }
  if (rawDecision === "keep") {
    return decisionResult(
      { decision: "keep" },
      "Discard the rewrite and preserve the original draft. Do not start the underlying work.",
    )
  }
  if (rawDecision === "regenerate") {
    return decisionResult(
      { decision: "regenerate" },
      "Create a meaningfully different improved proposal without starting the underlying work. Show the complete new version, then call present_prompt again.",
    )
  }

  // Codex submits the four-choice form cleanly. Put the corrections editor in
  // a second, required form: an optional trailing text field currently traps
  // the Codex TUI because an empty final field cannot submit.
  let feedbackResult: ElicitResult
  try {
    feedbackResult = await elicit({
      mode: "form",
      message: "Enter what Dictum should add, remove, or correct in the proposed prompt:",
      requestedSchema: {
        type: "object",
        properties: {
          feedback: {
            type: "string",
            title: "My corrections",
            description: "Describe what to add, remove, or correct, then submit.",
            minLength: 1,
          },
        },
        required: ["feedback"],
      },
    })
  } catch {
    return decisionResult(
      { decision: "feedback_required" },
      "The native corrections field could not open. Ask the user in plain text what to add, remove, or correct. Apply only the corrections they provide, show the complete revision, and call present_prompt again. Do not start the underlying work.",
    )
  }

  if (feedbackResult.action !== "accept") {
    return decisionResult(
      { decision: "cancel" },
      "The user dismissed Dictum's corrections field. Stop without starting the underlying work.",
    )
  }

  if (!feedbackResult.content) {
    return decisionResult(
      { decision: "feedback_required" },
      "The client accepted the corrections form but did not deliver its contents. Ask the user in plain text what to add, remove, or correct. Apply only the corrections they provide, show the complete revision, and call present_prompt again. Do not start the underlying work.",
    )
  }

  const feedback =
    typeof feedbackResult.content.feedback === "string"
      ? feedbackResult.content.feedback.trim()
      : ""
  if (!feedback) {
    return decisionResult(
      { decision: "feedback_required" },
      "The client did not deliver any corrections. Ask the user in plain text what to add, remove, or correct. Apply only the corrections they provide, show the complete revision, and call present_prompt again. Do not start the underlying work.",
    )
  }

  return decisionResult(
    { decision: "tweak", feedback },
    "Revise the proposal using the user's feedback, show the complete new version, then call present_prompt again. Do not start the underlying work.",
  )
}

/**
 * Build a PolishFn from configuration. Constructs the polisher once and resolves
 * the template per call (so different `mode` values work). Reuses the exact same
 * createPolisher + resolveTemplate the CLI uses — no duplicated logic.
 */
export function polishFromConfig(config: Config): PolishFn {
  const polisher = createPolisher(config.polisher)
  return async (text, mode) => {
    const template = await resolveTemplate(mode ?? config.polisher.template, templatesDir())
    return polisher.polish(text, template)
  }
}

/**
 * Construct the MCP server: host-brain prompts (polish / spec / decompose,
 * the flagship surface) plus the polish_brief / polish_prompt / analyze_prompt
 * / build_spec tools.
 */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "dictum", version: pkg.version },
    { instructions: DICTUM_MCP_INSTRUCTIONS },
  )
  const modeList = deps.modes.join(", ")
  const modeHelp = `Polishing template (one of: ${modeList}). Defaults to the configured template.`

  // Model family of the connected host (known after `initialize`), so briefs
  // can carry that vendor's own prompting advice — the polished prompt will
  // be executed by the very model the client runs on.
  const clientFamily = () => detectProviderFamily(server.server.getClientVersion()?.name)

  // Host-brain prompts: the host model executes the brief with its own
  // context. Surfaced as e.g. /mcp__dictum__polish in Claude Code.
  for (const kind of HOST_PROMPT_KINDS) {
    server.registerPrompt(
      kind,
      {
        title: HOST_PROMPT_META[kind].title,
        description: HOST_PROMPT_META[kind].description,
        argsSchema: {
          draft: z
            .string()
            .optional()
            .describe("The rough draft to refine. If omitted, the host asks the user for it."),
        },
      },
      ({ draft }) => buildHostPrompt(kind, draft ?? "", clientFamily()),
    )
  }

  // The MCP spec makes `params.arguments` optional, but the SDK's generated
  // prompts/get handler rejects a request that omits it (-32602) — which
  // would kill our "no draft → ask the user" flow on spec-compliant clients.
  // Override just the get handler; registerPrompt above still owns
  // prompts/list (names, titles, argument advertising).
  server.server.setRequestHandler(GetPromptRequestSchema, (request) => {
    const { name } = request.params
    if (!isHostPromptKind(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Prompt ${name} not found`)
    }
    const draft = request.params.arguments?.draft
    return buildHostPrompt(name, typeof draft === "string" ? draft : "", clientFamily())
  })

  server.registerTool(
    "polish_brief",
    {
      title: "Get a polishing brief (host-executed)",
      description:
        "First step for `dictum:`, `dictum spec:`, or `dictum decompose:`. Returns a host-executed rewrite brief, not polished text or permission to act. After writing the proposal, call present_prompt. Offline; modes: polish (default), spec, decompose.",
      inputSchema: {
        text: z.string().describe("The rough draft to build the brief for."),
        mode: z.string().optional().describe("Brief kind: polish (default), spec, or decompose."),
        provider: z
          .string()
          .optional()
          .describe(
            "Model family for vendor prompting tips: anthropic, openai, or generic. Auto-detected from the connected client when omitted.",
          ),
      },
    },
    track((args) => handlePolishBrief(args, clientFamily())),
  )

  server.registerTool(
    "present_prompt",
    {
      title: "Review and confirm a Dictum prompt",
      description:
        "Second step after writing the proposal. Opens the review UI and returns a decision plus an exact next-step instruction. Follow it exactly; only `act` authorizes the underlying task.",
      inputSchema: {
        original: z
          .string()
          .describe("The user's complete rough draft, without the Dictum prefix."),
        proposed: z.string().describe("The complete polished prompt or spec to review."),
      },
    },
    track((args) => {
      const supportsForm = Boolean(server.server.getClientCapabilities()?.elicitation?.form)
      const elicit = supportsForm
        ? (params: ElicitRequestFormParams) => server.server.elicitInput(params)
        : undefined
      return handlePresentPrompt(args, elicit)
    }),
  )

  server.registerTool(
    "polish_prompt",
    {
      title: "Polish a prompt",
      description: `Server-side rewrite using Dictum's own model, which cannot see session context. Prefer polish_brief inside an agent. Available modes: ${modeList}.`,
      inputSchema: {
        text: z.string().describe("The rough thought or draft prompt to refine."),
        mode: z.string().optional().describe(modeHelp),
      },
    },
    track((args) => handlePolishPrompt(args, deps)),
  )

  server.registerTool(
    "analyze_prompt",
    {
      title: "Analyze a prompt",
      description:
        "Offline 0–100 prompt score across clarity, specificity, structure, actionability, and context. Returns JSON: {score, dimensions, issues}.",
      inputSchema: {
        text: z.string().describe("The prompt draft to analyze."),
      },
    },
    track((args) => handleAnalyzePrompt(args)),
  )

  server.registerTool(
    "build_spec",
    {
      title: "Build a task spec",
      description: "Server-side Markdown task spec with requirements and acceptance criteria.",
      inputSchema: {
        text: z.string().describe("The rough task description to expand into a spec."),
      },
    },
    track((args) => handleBuildSpec(args, deps)),
  )

  return server
}

/**
 * Load config, wire the real polisher, and serve over stdio. Stays alive until
 * the client disconnects (stdin EOF) or the process is signalled. stdout is the
 * protocol channel, so all logging goes to stderr.
 */
export async function startMcpServer(): Promise<void> {
  const config = await loadConfig()
  const modes = await availableTemplateNames(templatesDir())
  const server = createMcpServer({ polish: polishFromConfig(config), modes })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  instrumentWireTracking(transport)
  process.stderr.write("dictum mcp: host-brain prompts + tools ready on stdio\n")

  await new Promise<void>((resolve) => {
    const done = () => resolve()
    transport.onclose = done
    // The SDK transport does not surface stdin EOF as onclose — watch the
    // stream directly so `printf … | dictum mcp` exits when the pipe closes.
    // Drain in-flight requests first: killing a response mid-computation
    // would return exit 0 with no output.
    const drainThenDone = () => {
      waitForIdle().then(done)
    }
    process.stdin.once("end", drainThenDone)
    process.stdin.once("close", drainThenDone)
    process.once("SIGINT", done)
    process.once("SIGTERM", done)
  })
}
