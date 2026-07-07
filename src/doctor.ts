/**
 * doctor.ts — real environment diagnostics for `dictum doctor`.
 *
 * Assembly-layer module (like cli.ts/pipeline.ts): it may read config and use
 * the stt factory. Checks microphone (sox), STT backends (health probes),
 * the configured polisher, and the clipboard mechanism, then prints a table
 * with actionable hints. Clipboard detection is inlined here for step 1.3 and
 * will be shared with sink/clipboard.ts in step 1.5.
 */

import type { Config } from "./config.ts"
import { detectClipboard } from "./sink/clipboard.ts"
import { buildSttProviders } from "./stt/factory.ts"

export type CheckStatus = "ok" | "warn" | "fail"

export type CheckResult = {
  name: string
  status: CheckStatus
  detail: string
  hint?: string
}

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" }

function which(bin: string): string | null {
  return Bun.which(bin)
}

/** Check microphone capture availability (sox `rec`). */
function checkMicrophone(): CheckResult {
  const rec = which("rec") ?? which("sox")
  if (rec) {
    return { name: "microphone (sox)", status: "ok", detail: rec }
  }
  return {
    name: "microphone (sox)",
    status: "warn",
    detail: "sox/rec not found",
    hint: "live recording needs sox → apt install sox / brew install sox (file --input works without it)",
  }
}

/** Health-check each configured STT backend; ok if at least one is reachable. */
async function checkStt(config: Config): Promise<CheckResult> {
  let named: ReturnType<typeof buildSttProviders>
  try {
    named = buildSttProviders(config.stt)
  } catch (err) {
    return {
      name: "speech-to-text",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      hint: "fix [stt].providers in your config",
    }
  }

  const probes = await Promise.all(
    named.map(async (p) => ({ name: p.name, healthy: await p.provider.health() })),
  )
  const summary = probes.map((p) => `${p.name} ${p.healthy ? "✓" : "✗"}`).join(", ")
  const anyHealthy = probes.some((p) => p.healthy)
  if (anyHealthy) {
    return { name: "speech-to-text", status: "ok", detail: summary }
  }
  return {
    name: "speech-to-text",
    status: "fail",
    detail: summary,
    hint: "start the local STT server (default http://127.0.0.1:5500) or set an OpenAI-compatible key",
  }
}

/** Check that the configured polisher can run (mode-aware). */
function checkPolisher(config: Config): CheckResult {
  const mode = config.polisher.mode
  if (mode === "rules") {
    // Fully offline: deterministic cleanup + scoring, no LLM, no keys.
    return {
      name: "polisher (rules)",
      status: "ok",
      detail: "offline deterministic mode — no LLM required",
    }
  }

  // llm / layered both need the provider; layered notes its score gate.
  const p = config.polisher.provider
  const name =
    mode === "layered"
      ? `polisher (${p}, layered ≥${config.polisher.scoreThreshold})`
      : `polisher (${p})`
  if (p === "claude_cli") {
    const bin = config.polisher.claude_cli.bin
    const path = which(bin)
    if (path) return { name, status: "ok", detail: path }
    return {
      name,
      status: "fail",
      detail: `'${bin}' not on PATH`,
      hint: 'install the Claude CLI, set [polisher].provider to anthropic/openai_compat, or use mode = "rules" (offline)',
    }
  }
  if (p === "anthropic") {
    const ok = config.polisher.anthropic.apiKey.length > 0
    return ok
      ? { name, status: "ok", detail: "API key set" }
      : {
          name,
          status: "fail",
          detail: "no API key",
          hint: "set ANTHROPIC_API_KEY",
        }
  }
  const ok = config.polisher.openai_compat.apiKey.length > 0
  return ok
    ? { name, status: "ok", detail: "API key set" }
    : {
        name,
        status: "fail",
        detail: "no API key",
        hint: "set OPENAI_API_KEY",
      }
}

/** Detect the clipboard mechanism for the current environment (shared with the sink). */
function checkClipboard(env: NodeJS.ProcessEnv): CheckResult {
  const mech = detectClipboard(env)
  if (mech.kind === "none") {
    return {
      name: "clipboard",
      status: "warn",
      detail: mech.label,
      hint: "install xclip/wl-clipboard, or use --stdout (over SSH, OSC52 is used automatically)",
    }
  }
  return { name: "clipboard", status: "ok", detail: mech.label }
}

/** Run all diagnostic checks. */
export async function runDoctorChecks(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckResult[]> {
  const [stt] = await Promise.all([checkStt(config)])
  return [checkMicrophone(), stt, checkPolisher(config), checkClipboard(env)]
}

/** Render the checks as an aligned, human-readable table. */
export function formatDoctorTable(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length))
  const lines = ["dictum doctor", ""]
  for (const r of results) {
    lines.push(`  ${ICON[r.status]}  ${r.name.padEnd(width)}  ${r.detail}`)
    if (r.hint && r.status !== "ok") {
      lines.push(`     ${" ".repeat(width)}  → ${r.hint}`)
    }
  }
  const failed = results.filter((r) => r.status === "fail").length
  const warned = results.filter((r) => r.status === "warn").length
  lines.push("")
  lines.push(
    failed === 0
      ? warned === 0
        ? "All checks passed."
        : `Ready, with ${warned} warning(s).`
      : `${failed} check(s) failed.`,
  )
  return `${lines.join("\n")}\n`
}

/** 0 when nothing failed, 1 otherwise. */
export function doctorExitCode(results: CheckResult[]): number {
  return results.some((r) => r.status === "fail") ? 1 : 0
}
