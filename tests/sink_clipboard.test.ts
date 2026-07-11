import { describe, expect, test } from "bun:test"
import { ClipboardSink, buildOsc52, detectClipboard } from "../src/sink/clipboard.ts"

const ESC = "\x1b"
const BEL = "\x07"

/** which-stub: returns a fake path only for the listed binaries. */
function whichFor(...present: string[]): (b: string) => string | null {
  return (b) => (present.includes(b) ? `/usr/bin/${b}` : null)
}

describe("detectClipboard mechanism selection", () => {
  test("SSH session with a TTY → OSC52 (regardless of installed tools)", () => {
    const m = detectClipboard(
      { SSH_CONNECTION: "1 2 3 4" } as NodeJS.ProcessEnv,
      whichFor("xclip"),
      true,
    )
    expect(m.kind).toBe("osc52")
    expect(m.label).toMatch(/OSC52/)
  })

  test("SSH_TTY with a TTY also triggers OSC52", () => {
    expect(
      detectClipboard({ SSH_TTY: "/dev/pts/0" } as NodeJS.ProcessEnv, whichFor(), true).kind,
    ).toBe("osc52")
  })

  test("Wayland with wl-copy → wl-copy", () => {
    const m = detectClipboard(
      { WAYLAND_DISPLAY: "wayland-0" } as NodeJS.ProcessEnv,
      whichFor("wl-copy"),
    )
    expect(m).toEqual({ kind: "command", label: "wl-copy (wayland)", argv: ["wl-copy"] })
  })

  test("macOS pbcopy", () => {
    const m = detectClipboard({} as NodeJS.ProcessEnv, whichFor("pbcopy"))
    expect(m).toEqual({ kind: "command", label: "pbcopy (macOS)", argv: ["pbcopy"] })
  })

  test("X11 xclip with selection arg (needs DISPLAY)", () => {
    const m = detectClipboard({ DISPLAY: ":0" } as NodeJS.ProcessEnv, whichFor("xclip"))
    expect(m).toEqual({
      kind: "command",
      label: "xclip (x11)",
      argv: ["xclip", "-selection", "clipboard"],
    })
  })

  test("display-bound tool without a display → none, not a false ok", () => {
    // xclip on PATH but headless (no DISPLAY): copying would die with
    // "Can't open display", so detection must not report it as usable.
    for (const bin of ["xclip", "wl-copy"]) {
      const m = detectClipboard({} as NodeJS.ProcessEnv, whichFor(bin))
      expect(m.kind).toBe("none")
      expect(m.label).toContain("no display")
    }
  })

  test("nothing available → none", () => {
    expect(detectClipboard({} as NodeJS.ProcessEnv, whichFor()).kind).toBe("none")
  })

  test("pbcopy preferred over xclip when both present (non-SSH)", () => {
    const m = detectClipboard({} as NodeJS.ProcessEnv, whichFor("pbcopy", "xclip"))
    expect(m.kind).toBe("command")
    expect(m.label).toMatch(/pbcopy/)
  })
})

describe("buildOsc52", () => {
  test("plain sequence is ESC ]52;c;<base64> BEL", () => {
    const b64 = Buffer.from("hello", "utf8").toString("base64")
    expect(buildOsc52("hello")).toBe(`${ESC}]52;c;${b64}${BEL}`)
  })

  test("base64 encodes UTF-8 (Cyrillic) correctly", () => {
    const text = "привет"
    const seq = buildOsc52(text)
    const b64 = seq.slice(`${ESC}]52;c;`.length, -1)
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(text)
  })

  test("tmux passthrough wraps with DCS and doubles ESC", () => {
    const seq = buildOsc52("hi", { tmux: true })
    expect(seq.startsWith(`${ESC}Ptmux;`)).toBe(true)
    expect(seq.endsWith(`${ESC}\\`)).toBe(true)
    // inner ESCs are doubled
    expect(seq).toContain(`${ESC}${ESC}]52;c;`)
  })
})

describe("ClipboardSink", () => {
  test("throws an actionable error when no mechanism is available", async () => {
    const sink = new ClipboardSink({} as NodeJS.ProcessEnv, () => null)
    await expect(sink.emit("x")).rejects.toThrow(/Clipboard unavailable.*--stdout/s)
  })
})

describe("OSC52 needs an interactive terminal", () => {
  const sshEnv = { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" } as NodeJS.ProcessEnv

  test("SSH with a TTY → osc52", () => {
    const m = detectClipboard(sshEnv, whichFor(), true)
    expect(m.kind).toBe("osc52")
  })

  test("SSH without a TTY → none with an actionable label (doctor shows warn)", () => {
    const m = detectClipboard(sshEnv, whichFor(), false)
    expect(m.kind).toBe("none")
    expect(m.label).toContain("interactive terminal")
  })
})

describe("SSH without a TTY falls back to a local display clipboard", () => {
  const sshEnv = (extra: Record<string, string> = {}) =>
    ({ SSH_CONNECTION: "1 2 3 4", ...extra }) as NodeJS.ProcessEnv

  test("X11 forwarding (DISPLAY + xclip) still works", () => {
    const m = detectClipboard(sshEnv({ DISPLAY: "localhost:10.0" }), whichFor("xclip"), false)
    expect(m.kind).toBe("command")
    expect(m.label).toContain("xclip")
  })

  test("wayland display + wl-copy still works", () => {
    const m = detectClipboard(sshEnv({ WAYLAND_DISPLAY: "wayland-0" }), whichFor("wl-copy"), false)
    expect(m.kind).toBe("command")
  })

  test("no display, no TTY → the SSH-specific none label", () => {
    const m = detectClipboard(sshEnv(), whichFor("xclip"), false)
    expect(m.kind).toBe("none")
    expect(m.label).toContain("interactive terminal")
  })
})
