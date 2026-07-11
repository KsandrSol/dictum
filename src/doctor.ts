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
import { CLAUDE_CLI_MIN_VERSION, versionAtLeast } from "./polisher/claude_cli.ts"
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

/**
 * Check microphone capture availability. The recorder invokes exactly `rec`
 * (sox's recording front-end), so a sox install without the `rec` shim must
 * not report ok. Exported logic is pure for testing.
 */
export function micCheck(rec: string | null, sox: string | null): CheckResult {
  if (rec) {
    return { name: "microphone (sox)", status: "ok", detail: rec }
  }
  if (sox) {
    return {
      name: "microphone (sox)",
      status: "warn",
      detail: "sox found, but the 'rec' front-end is missing",
      hint: "the recorder runs 'rec'; install the sox package that ships it or symlink rec → sox",
    }
  }
  return {
    name: "microphone (sox)",
    status: "warn",
    detail: "sox/rec not found",
    hint: "live recording needs sox → apt install sox / brew install sox (file --input works without it)",
  }
}

function checkMicrophone(): CheckResult {
  return micCheck(which("rec"), which("sox"))
}

/**
 * ffmpeg is required to transcode non-canonical WAV given via `--input`
 * (canonical PCM16/16k/mono plays without it). Pure for testing.
 */
export function ffmpegCheck(path: string | null): CheckResult {
  if (path) {
    return { name: "ffmpeg (file input)", status: "ok", detail: path }
  }
  return {
    name: "ffmpeg (file input)",
    status: "warn",
    detail: "ffmpeg not found",
    hint: "non-canonical WAV via --input needs ffmpeg; canonical PCM16/16k/mono works without it",
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

/**
 * Read `<bin> --version` and extract the Claude Code version. Returns null —
 * which the caller treats as a hard failure (fail closed) — on a non-zero
 * exit, timeout, read failure, unparsable output, or output that lacks the
 * "Claude Code" marker (any tool prints a dotted version; bash must not pass
 * as the polisher). Timeout escalates SIGTERM → SIGKILL and fails
 * unconditionally, even if the process produced output before dying; the
 * stdout read is bounded so a pipe-holding grandchild cannot stall doctor.
 * Exported (with an injectable deadline) for tests.
 */
export async function claudeCliVersion(bin: string, timeoutMs = 5000): Promise<string | null> {
  try {
    const started = performance.now()
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore" })
    let timedOut = false
    const term = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
    }, timeoutMs)
    const kill = setTimeout(() => proc.kill("SIGKILL"), timeoutMs + 1000)
    const outPromise = new Response(proc.stdout).text().catch(() => "")
    const code = await proc.exited
    clearTimeout(term)
    clearTimeout(kill)
    // Timers can't fire while the event loop is blocked, so the deadline is
    // also enforced against monotonic time — event-loop phase order after an
    // unblock is not guaranteed.
    if (timedOut || code !== 0 || performance.now() - started > timeoutMs) return null
    const out = await Promise.race([
      outPromise,
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 1000)),
    ])
    // One regex, version adjacent to the marker: "runtime 9.9.9; Claude Code
    // 2.0.0" must not pass off a foreign version as the CLI's.
    return /(\d+\.\d+\.\d+)\s*\(claude code\)/i.exec(out)?.[1] ?? null
  } catch {
    return null
  }
}

/** Check that the configured polisher can run (mode-aware). */
async function checkPolisher(config: Config): Promise<CheckResult> {
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
    if (!path) {
      return {
        name,
        status: "fail",
        detail: `'${bin}' not on PATH`,
        hint: 'install the Claude CLI, set [polisher].provider to anthropic/openai_compat, or use mode = "rules" (offline)',
      }
    }
    // The safety flags the polisher passes require a recent CLI — an old one
    // would pass a bare presence check here and then fail at polish time.
    // Fail closed: a binary whose version can't be determined (wrong tool,
    // crash, timeout) would not survive a real polish call either.
    const version = await claudeCliVersion(bin)
    if (!version) {
      return {
        name,
        status: "fail",
        detail: `${path} — could not determine the Claude CLI version`,
        hint: `'${bin} --version' must print a version; is this really the Claude CLI?`,
      }
    }
    if (!versionAtLeast(version, CLAUDE_CLI_MIN_VERSION)) {
      return {
        name,
        status: "fail",
        detail: `${path} (v${version})`,
        hint: `dictum needs Claude Code >= ${CLAUDE_CLI_MIN_VERSION} (--safe-mode); update the CLI`,
      }
    }
    return { name, status: "ok", detail: `${path} (v${version})` }
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
function checkClipboard(env: NodeJS.ProcessEnv, hasTty?: boolean): CheckResult {
  const mech = hasTty === undefined ? detectClipboard(env) : detectClipboard(env, undefined, hasTty)
  if (mech.kind === "none") {
    return {
      name: "clipboard",
      status: "warn",
      detail: mech.label,
      hint: "use --stdout, or install xclip/wl-clipboard; OSC52 needs an interactive SSH terminal",
    }
  }
  return { name: "clipboard", status: "ok", detail: mech.label }
}

/** Run all diagnostic checks. `hasTty` is injectable so tests don't depend on the runner's terminal. */
export async function runDoctorChecks(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  hasTty?: boolean,
): Promise<CheckResult[]> {
  const [stt, polisher] = await Promise.all([checkStt(config), checkPolisher(config)])
  return [
    checkMicrophone(),
    ffmpegCheck(which("ffmpeg")),
    stt,
    polisher,
    checkClipboard(env, hasTty),
  ]
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
