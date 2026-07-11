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
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { ErrorCode, GetPromptRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import pkg from "../../package.json" with { type: "json" }
import { type Config, loadConfig, templatesDir } from "../config.ts"
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
  transport.send = (message, options) => {
    noteWireReply(message)
    return sendRaw(message, options)
  }
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
  const server = new McpServer({ name: "dictum", version: pkg.version })
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
        "Return Dictum's rewriting brief for YOU to execute: canon rules plus a deterministic pre-analysis of the user's rough draft. Follow the brief yourself, using your session's project context — do not expect polished text back from this tool. Prefer this over polish_prompt when the user wants their draft refined and you have the context. Offline, no LLM call. Modes: polish (default), spec, decompose.",
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
    "polish_prompt",
    {
      title: "Polish a prompt",
      description: `Refine a rough thought or draft into a clear, well-structured prompt using Dictum's OWN model, server-side (it does not see this session's context — prefer polish_brief when you have context). Text in, polished text out (no voice). Available modes: ${modeList}.`,
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
        "Score a prompt draft 0–100 across five dimensions (clarity, specificity, structure, actionability, context) and list its weak spots. Deterministic and offline — no LLM call. Returns JSON: {score, dimensions, issues}. Use it to decide whether a draft needs polishing.",
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
      description:
        "Expand a rough thought into a compact task spec with requirements and acceptance criteria (Dictum's 'spec' template). Text in, Markdown spec out.",
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
