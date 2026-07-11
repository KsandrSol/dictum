/**
 * sink/clipboard.ts — copy text to the system clipboard.
 *
 * Mechanism selection:
 *   - SSH session (SSH_CONNECTION / SSH_TTY)  → OSC52 escape sequence to the
 *     terminal (works through SSH; the local terminal emulator receives it).
 *   - Wayland (WAYLAND_DISPLAY + wl-copy)     → wl-copy
 *   - macOS (pbcopy)                          → pbcopy
 *   - X11 (xclip)                             → xclip -selection clipboard
 *   - otherwise                               → error with an actionable hint.
 *
 * tmux is handled by wrapping OSC52 in a DCS passthrough when $TMUX is set.
 */

import { closeSync, openSync, writeSync } from "node:fs"
import type { Sink } from "../core/types.ts"

type Which = (bin: string) => string | null

const ESC = "\x1b"
const BEL = "\x07"

export type ClipboardMechanism =
  | { kind: "osc52"; label: string }
  | { kind: "command"; label: string; argv: string[] }
  | { kind: "none"; label: string }

function isSshSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY)
}

/** Pick the clipboard mechanism for the current environment. */
export function detectClipboard(
  env: NodeJS.ProcessEnv = process.env,
  which: Which = (b) => Bun.which(b),
  hasTty: boolean = Boolean(process.stdout.isTTY || process.stderr.isTTY),
): ClipboardMechanism {
  // OSC52 writes an escape sequence to the terminal — without an interactive
  // TTY (cron, CI, `ssh host cmd`) there is nowhere to write. In that case
  // fall through: X11 forwarding / a local display may still provide a
  // clipboard tool that works.
  const ssh = isSshSession(env)
  if (ssh && hasTty) {
    return { kind: "osc52", label: "OSC52 (SSH session)" }
  }
  if (env.WAYLAND_DISPLAY && which("wl-copy")) {
    return { kind: "command", label: "wl-copy (wayland)", argv: ["wl-copy"] }
  }
  if (which("pbcopy")) {
    return { kind: "command", label: "pbcopy (macOS)", argv: ["pbcopy"] }
  }
  if (env.DISPLAY && which("xclip")) {
    return {
      kind: "command",
      label: "xclip (x11)",
      argv: ["xclip", "-selection", "clipboard"],
    }
  }
  if (ssh) {
    return {
      kind: "none",
      label: "SSH session without an interactive terminal (OSC52 unavailable)",
    }
  }
  // A display-bound tool on PATH without a display would fail at copy time
  // ("Can't open display") — report it as unavailable, not as ok.
  if (which("wl-copy") || which("xclip")) {
    return {
      kind: "none",
      label: "clipboard tool found, but no display (DISPLAY/WAYLAND_DISPLAY unset)",
    }
  }
  return { kind: "none", label: "no clipboard tool found" }
}

/**
 * Build an OSC52 clipboard escape sequence for `text`. When `tmux` is true the
 * sequence is wrapped in a tmux DCS passthrough so it reaches the outer terminal.
 * Format: ESC ] 52 ; c ; <base64> BEL
 */
export function buildOsc52(text: string, opts: { tmux?: boolean } = {}): string {
  const b64 = Buffer.from(text, "utf8").toString("base64")
  const seq = `${ESC}]52;c;${b64}${BEL}`
  if (opts.tmux) {
    // tmux passthrough: ESC P tmux; <payload with ESC doubled> ESC \
    const inner = seq.replaceAll(ESC, ESC + ESC)
    return `${ESC}Ptmux;${inner}${ESC}\\`
  }
  return seq
}

/**
 * Write an OSC52 sequence to the controlling terminal. Prefers /dev/tty; falls
 * back to stderr only when it's a TTY. Returns false when no real terminal is
 * reachable (a pipe / cron) so the caller can advise --stdout instead of
 * littering escape bytes into the output.
 */
function writeToTerminal(seq: string): boolean {
  try {
    const fd = openSync("/dev/tty", "w")
    try {
      writeSync(fd, seq)
    } finally {
      closeSync(fd)
    }
    return true
  } catch {
    if (process.stderr.isTTY) {
      process.stderr.write(seq)
      return true
    }
    return false
  }
}

export class ClipboardSink implements Sink {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly which: Which = (b) => Bun.which(b),
  ) {}

  async emit(text: string): Promise<void> {
    const mech = detectClipboard(this.env, this.which)
    if (mech.kind === "osc52") {
      const ok = writeToTerminal(buildOsc52(text, { tmux: Boolean(this.env.TMUX) }))
      if (!ok) {
        throw new Error(
          "Clipboard over SSH (OSC52) needs an interactive terminal. " +
            "Use --stdout to pipe the result (e.g. `dictum --stdout | claude`).",
        )
      }
      return
    }
    if (mech.kind === "command") {
      const proc = Bun.spawn(mech.argv, { stdin: "pipe", stdout: "ignore", stderr: "pipe" })
      proc.stdin.write(text)
      await proc.stdin.end()
      const code = await proc.exited
      if (code !== 0) {
        const err = (await new Response(proc.stderr).text()).trim()
        throw new Error(
          `clipboard command '${mech.argv[0]}' failed (exit ${code})${err ? `: ${err}` : ""}`,
        )
      }
      return
    }
    // Lead with the detector's diagnosis — "OSC52 needs an interactive
    // terminal" must not be answered with "OSC52 is automatic".
    throw new Error(
      `Clipboard unavailable: ${mech.label}. Use --stdout, or install xclip / wl-clipboard.`,
    )
  }
}
