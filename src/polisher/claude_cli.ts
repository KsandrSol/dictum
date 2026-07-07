/**
 * polisher/claude_cli.ts — Polisher that shells out to the `claude` CLI.
 *
 * Runs `claude -p "<instruction>\n<transcript>" --output-format text` with a
 * timeout. Uses the user's existing Claude Code auth (subscription), so no API
 * key is needed. The instruction comes from the selected Template.
 */

import type { Polisher, Template } from "../core/types.ts"

export type ClaudeCliOptions = {
  /** Binary name/path; defaults to "claude". */
  bin?: string
  /** Optional model override (empty = CLI default). */
  model?: string
  /** Timeout in milliseconds. */
  timeoutMs?: number
}

export class ClaudeCliPolisher implements Polisher {
  private readonly bin: string
  private readonly model: string
  private readonly timeoutMs: number

  constructor(opts: ClaudeCliOptions = {}) {
    this.bin = opts.bin ?? "claude"
    this.model = opts.model ?? ""
    this.timeoutMs = opts.timeoutMs ?? 60000
  }

  async polish(text: string, template: Template): Promise<string> {
    const prompt = `${template.instruction}\n${text}`
    const args = ["-p", prompt, "--output-format", "text"]
    if (this.model) args.push("--model", this.model)

    const spawn = () => {
      try {
        return Bun.spawn([this.bin, ...args], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(
          `Cannot launch '${this.bin}': ${reason}. Is the Claude CLI installed and on PATH?`,
        )
      }
    }
    const proc = spawn()

    // Manual timeout: SIGTERM at the deadline, SIGKILL after a grace, so a
    // child that holds the stdout/stderr pipes open can't make us hang. We
    // never block on pipe EOF past the process exit (bounded reads below).
    let timedOut = false
    const sigtermTimer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
    }, this.timeoutMs)
    const sigkillTimer = setTimeout(() => proc.kill("SIGKILL"), this.timeoutMs + 2000)

    const stdoutText = new Response(proc.stdout).text().catch(() => "")
    const stderrText = new Response(proc.stderr).text().catch(() => "")

    const code = await proc.exited
    clearTimeout(sigtermTimer)
    clearTimeout(sigkillTimer)

    // Don't let a lingering grandchild's open pipe hang us: cap the reads.
    const bounded = (p: Promise<string>): Promise<string> =>
      Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(""), 1000))])
    const stdout = await bounded(stdoutText)
    const stderr = await bounded(stderrText)

    if (timedOut) {
      throw new Error(`claude polishing timed out after ${this.timeoutMs / 1000}s`)
    }
    if (code !== 0) {
      throw new Error(
        `claude exited with code ${code}: ${stderr.trim() || stdout.trim() || "no output"}`,
      )
    }

    const result = stdout.trim()
    if (!result) throw new Error("claude returned an empty response")
    return result
  }
}
