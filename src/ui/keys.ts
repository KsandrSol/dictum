/**
 * ui/keys.ts — produce a "stop recording" AbortSignal from the keyboard.
 *
 * Modes:
 *   - enter : press Enter to stop (reliable everywhere; the default).
 *   - vad   : recorder auto-stops on silence; Enter still stops early.
 *   - ptt   : hold Space to talk, release to stop (raw stdin; release is
 *             inferred from the auto-repeat gap — terminal-dependent, so it's
 *             best-effort and verified manually).
 *
 * Ctrl-C always stops. This module is imported only by cli.ts (assembly layer);
 * the recorder never depends on it — it just receives the AbortSignal.
 */

export type StopMode = "enter" | "vad" | "ptt"

export type StopController = {
  signal: AbortSignal
  dispose: () => void
}

/** Release is inferred when no Space byte arrives within this window (ms). */
const PTT_RELEASE_MS = 400

/** The instruction line shown while recording. Pure, for display + tests. */
export function stopHint(mode: StopMode): string {
  switch (mode) {
    case "enter":
      return "press Enter to stop"
    case "vad":
      return "speak — auto-stops on silence (Enter to stop now)"
    case "ptt":
      return "hold Space to talk, release to stop"
  }
}

export type StopControllerOptions = {
  /** Whole-operation cancel (SIGINT); aborting it also stops recording. */
  parent?: AbortSignal
  /** Where to print the instruction hint (default stderr, keeps stdout clean). */
  hintStream?: { write(s: string): unknown }
}

/**
 * Wire stdin to an AbortController for the given stop mode. Returns the signal
 * plus a dispose() that detaches listeners and restores the terminal. Safe to
 * call in a non-interactive environment (it simply won't receive key events).
 */
export function createStopController(
  mode: StopMode,
  opts: StopControllerOptions = {},
): StopController {
  const controller = new AbortController()
  const stdin = process.stdin
  const hint = opts.hintStream ?? process.stderr
  let releaseTimer: ReturnType<typeof setTimeout> | undefined

  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }

  if (opts.parent) {
    if (opts.parent.aborted) abort()
    else opts.parent.addEventListener("abort", abort, { once: true })
  }

  const onData = (chunk: Buffer) => {
    if (chunk.includes(0x03)) {
      abort() // Ctrl-C
      return
    }
    if (mode === "ptt") {
      if (chunk.includes(0x20)) {
        if (releaseTimer) clearTimeout(releaseTimer)
        releaseTimer = setTimeout(abort, PTT_RELEASE_MS)
      }
      return
    }
    // enter / vad: stop on Enter (LF or CR)
    if (chunk.includes(0x0a) || chunk.includes(0x0d)) abort()
  }

  let attached = false
  try {
    if (stdin.isTTY && mode === "ptt") stdin.setRawMode?.(true)
    stdin.resume()
    stdin.on("data", onData)
    attached = true
  } catch {
    // stdin unavailable (non-interactive) — recorder still stops via VAD/cap.
  }

  const dispose = () => {
    if (releaseTimer) clearTimeout(releaseTimer)
    if (attached) {
      stdin.off("data", onData)
      try {
        if (stdin.isTTY) stdin.setRawMode?.(false)
      } catch {
        // ignore
      }
      stdin.pause()
    }
    if (opts.parent) opts.parent.removeEventListener("abort", abort)
  }
  controller.signal.addEventListener("abort", dispose, { once: true })

  hint.write(`${stopHint(mode)}\n`)
  return { signal: controller.signal, dispose }
}
